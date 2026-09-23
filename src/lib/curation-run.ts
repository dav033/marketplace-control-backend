import { randomUUID } from 'node:crypto';
import { CURATION_HEADERS, normalizeCurationThreshold, parseCurationTsv, summarizeContactChannels, validateCurationBatch, type CurationThreshold } from './curation';
import { buildLivePreviewRows, curateProviders, hasContactForDiscovery, type CurationLivePreview, type CurationPhaseReporter, type GeminiCurationResult } from './gemini';
import { saveCurationScan } from './curation-history';
import { logCurationEvent } from './curation-log';
import { curateWithSerper } from './serper-curation';

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

/**
 * Con `CURATION_PROVIDER=serper` los negocios salen de Google Maps vía Serper y el agente solo los
 * verifica; con cualquier otro valor, el agente los busca en la web como hasta ahora.
 */
function discoversWithSerper(): boolean {
  return String(env('CURATION_PROVIDER') || '').trim().toLowerCase() === 'serper';
}

const MAX_SCAN_ATTEMPTS = 12;
const MAX_CONSECUTIVE_FAILURES = 3;
/** Escaneos seguidos sin un solo negocio nuevo que cumpla el mínimo antes de dar la ciudad por agotada. */
const MAX_STAGNANT_SCANS = 3;

/** Vista previa de lo acumulado hasta ahora, para que la interfaz muestre resultados parciales. */
function buildPreview(merged: GeminiCurationResult, threshold: CurationThreshold): CurationLivePreview {
  return {
    tsv: merged.tsv,
    discovered: merged.discovered,
    contactable: merged.contactable,
    model: merged.model,
    rejectedRows: merged.rejectedRows.map(row => ({
      line: row.line,
      issues: row.issues.map(item => ({ message: item.message })),
    })),
    rows: buildLivePreviewRows(parseCurationTsv(merged.tsv, threshold)),
  };
}

function normalizeKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function candidateKey(rawLine: string): string {
  const cells = rawLine.split('\t').map(value => value.trim());
  // Sin la URL: la verificación y la vía de respaldo devuelven el mismo negocio con rutas
  // distintas, y cotejar por URL dejaba pasar el mismo proveedor varias veces en el lote.
  return [cells[1], cells[4], cells[2]].map(value => normalizeKey(value ?? '')).join('|');
}

/**
 * Consolida los escaneos de una corrida. Primero van los negocios que CUMPLEN el mínimo pedido
 * (hasta el objetivo) y detrás los que quedan en revisión o rechazados, para que la vista previa
 * los muestre sin que le roben el sitio a un candidato válido de un escaneo posterior. Antes se
 * cortaba en el objetivo contando cualquier fila, y una corrida podía "llegar a 20" con 3 válidos.
 */
function mergeBatchResults(batches: GeminiCurationResult[], targetCount: number, threshold: CurationThreshold): GeminiCurationResult {
  const seen = new Set<string>();
  const rawRows: string[] = [];
  for (const batch of batches) {
    const lines = batch.tsv.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim()).slice(1);
    for (const line of lines) {
      const key = candidateKey(line);
      if (seen.has(key)) continue;
      seen.add(key);
      rawRows.push(line);
    }
  }
  const header = CURATION_HEADERS.join('\t');
  const all = validateCurationBatch(parseCurationTsv([header, ...rawRows].join('\n'), threshold));
  const acceptedLines = all.accepted.slice(0, targetCount).map(row => row.rawLine);
  const otherLines = all.rejected.slice(0, targetCount).map(row => row.rawLine);

  const tsv = [header, ...acceptedLines, ...otherLines].join('\n');
  const parsed = parseCurationTsv(tsv, threshold);
  const validation = rawRows.length ? validateCurationBatch(parsed) : { accepted: [], rejected: [] };
  const contactable = parsed.rows.filter(row => hasContactForDiscovery(row.rawCells)).length;
  const last = batches.at(-1);
  return {
    tsv,
    researchSummary: batches.map((batch, index) => `Escaneo ${index + 1}: ${batch.researchSummary}`).join('\n'),
    provider: last?.provider ?? 'gemini',
    model: last?.model ?? 'gemini-3.8-flash',
    accepted: validation.accepted.length,
    rejected: validation.rejected.length,
    discovered: parsed.rows.length,
    contactable,
    acceptedRows: validation.accepted,
    rejectedRows: validation.rejected,
    contactSummary: summarizeContactChannels(validation.accepted),
    historySaved: batches.every(batch => batch.historySaved !== false),
  };
}

export async function runCurationGoal(input: {
  city: string;
  category: string;
  instructions?: string;
  targetCount: number;
  jobId?: string;
  /** Umbral de reputación que pide el operador; por defecto, el estándar de curaduría. */
  minRating?: number;
  minReviews?: number;
  onPhase?: CurationPhaseReporter;
}): Promise<GeminiCurationResult> {
  const targetCount = Math.max(1, Math.min(100, Math.trunc(input.targetCount)));
  const contactTarget = Math.min(15, targetCount);
  const threshold = normalizeCurationThreshold({ minRating: input.minRating, minReviews: input.minReviews });
  const runId = randomUUID();
  const batches: GeminiCurationResult[] = [];
  // El objetivo se mide en negocios que CUMPLEN el mínimo pedido (calificación, reseñas y contacto),
  // no en filas devueltas: una fila en revisión se muestra, pero no cuenta.
  let previousAccepted = 0;
  let stagnantScans = 0;
  let stoppedReason: GeminiCurationResult['stoppedReason'] = 'max_scans';
  let targetReached = false;
  let attemptsUsed = 0;
  let lastError = '';
  let consecutiveFailures = 0;

  for (let attempt = 1; attempt <= MAX_SCAN_ATTEMPTS; attempt += 1) {
    attemptsUsed = attempt;
    const remaining = Math.max(targetCount - previousAccepted, 0);
    const iterationInstructions = [
      input.instructions?.trim(),
      `Objetivo total de esta ejecución: ${targetCount} candidatos que cumplan calificación mínima ${threshold.minRating.toFixed(1)} y ${threshold.minReviews} reseñas con contacto público; faltan ${remaining}.`,
      `Este es el escaneo ${attempt} de ${MAX_SCAN_ATTEMPTS}. Cada escaneo puede devolver como máximo 20 prospectos.`,
      'Busca alternativas nuevas y no repitas ningún candidato aprobado, rechazado o ya descubierto en escaneos anteriores.',
    ].filter(Boolean).join('\n');
    input.onPhase?.('preparing', `Objetivo ${targetCount}: iniciando escaneo ${attempt}.`);
    let batch: GeminiCurationResult;
    try {
      batch = await (discoversWithSerper() ? curateWithSerper : curateProviders)({
        city: input.city,
        category: input.category,
        instructions: iterationInstructions,
        targetCount,
        remainingCount: remaining,
        scanAttempt: attempt,
        jobId: input.jobId,
        runId,
        minRating: threshold.minRating,
        minReviews: threshold.minReviews,
        onPhase: (phase, detail, progress, preview) => input.onPhase?.(phase, `Escaneo ${attempt}: ${detail}`, progress, preview),
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'El agente no devolvió un lote válido.';
      consecutiveFailures += 1;
      logCurationEvent('scan_failed', { jobId: input.jobId ?? 'sin-job', scanNumber: attempt, consecutiveFailures, reason: lastError });
      input.onPhase?.('researching', `Escaneo ${attempt} falló: ${lastError}`, { current: 4, total: 4, label: 'Reintentando búsqueda' });
      if (attempt < MAX_SCAN_ATTEMPTS && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) continue;
      stoppedReason = 'agent_failed';
      break;
    }
    consecutiveFailures = 0;
    // El lote entra al acumulado ANTES de intentar guardarlo: si la base de datos falla, los
    // proveedores ya encontrados no se pierden.
    batches.push(batch);
    const saved = await saveCurationScan({
      city: input.city,
      category: input.category,
      instructions: iterationInstructions,
      result: batch,
      runId,
      attempt,
      targetCount,
    });
    batch.historySaved = saved;
    const merged = mergeBatchResults(batches, targetCount, threshold);
    const relevantCount = merged.discovered;
    const contactableCount = merged.contactable;
    const acceptedCount = merged.accepted;
    targetReached = acceptedCount >= targetCount;
    logCurationEvent('scan_done', {
      jobId: input.jobId ?? 'sin-job',
      scanNumber: attempt,
      discovered: batch.discovered,
      accepted: batch.accepted,
      rejected: batch.rejected,
      contactable: batch.contactable,
      acumuladoRelevantes: relevantCount,
      acumuladoContactables: contactableCount,
      acumuladoCumplen: acceptedCount,
      historySaved: saved,
    });
    // El avance parcial se publica siempre, con lote o sin él.
    input.onPhase?.('researching', targetReached
      ? `Objetivo alcanzado: ${acceptedCount} negocios cumplen el mínimo (${relevantCount - acceptedCount} más en revisión).`
      : `Acumulado: ${acceptedCount}/${targetCount} cumplen el mínimo · ${relevantCount - acceptedCount} en revisión.`,
      { current: targetReached ? 4 : 3, total: 4, label: 'Consolidando resultados' },
      buildPreview(merged, threshold));

    if (targetReached) {
      stoppedReason = 'target_reached';
      break;
    }
    // Sin historial no se puede evitar repetir candidatos, así que no se lanzan más escaneos;
    // el lote ya acumulado sí se conserva y se devuelve.
    if (!saved) {
      stoppedReason = 'history_save_failed';
      break;
    }
    // Se sigue mientras haya escaneos y la ciudad dé de sí: solo tras varios escaneos seguidos sin
    // un solo negocio nuevo que cumpla se da por agotada. Un escaneo flojo no cierra la búsqueda.
    if (acceptedCount <= previousAccepted) {
      stagnantScans += 1;
      if (stagnantScans >= MAX_STAGNANT_SCANS) {
        stoppedReason = 'no_relevant_candidates';
        break;
      }
    } else {
      stagnantScans = 0;
    }
    previousAccepted = acceptedCount;
  }

  const result = mergeBatchResults(batches, targetCount, threshold);
  const relevantCount = result.discovered;
  const contactableCount = result.contactable;
  const conteo = `Cumplen el mínimo ${result.accepted} de ${targetCount}; ${relevantCount - result.accepted} más quedan en revisión, en ${attemptsUsed} escaneo(s).`;
  const alert = targetReached
    ? undefined
    : stoppedReason === 'history_save_failed'
      ? `No se pudo guardar el historial en la base de datos, así que la búsqueda se detuvo para no repetir candidatos. ${conteo}`
      : stoppedReason === 'agent_failed'
        ? `El agente de investigación no pudo entregar un lote válido. Motivo del último intento: ${lastError} ${conteo}`
      : stoppedReason === 'max_scans'
        ? `La búsqueda usó los ${MAX_SCAN_ATTEMPTS} escaneos disponibles sin llegar al objetivo. ${conteo}`
        : `La búsqueda se detuvo tras ${MAX_STAGNANT_SCANS} escaneos seguidos sin un negocio nuevo que cumpla el mínimo. ${conteo}`;
  logCurationEvent('run_done', {
    jobId: input.jobId ?? 'sin-job',
    attempts: attemptsUsed,
    stoppedReason,
    targetReached,
    relevantCount,
    contactableCount,
    accepted: result.accepted,
    rejected: result.rejected,
  });
  return {
    ...result,
    historySaved: result.historySaved !== false,
    targetCount,
    contactTarget,
    relevantCount,
    attempts: attemptsUsed,
    targetReached,
    stoppedReason,
    alert,
  };
}
