import { randomUUID } from 'node:crypto';
import { CURATION_HEADERS, parseCurationTsv, summarizeContactChannels, validateCurationBatch } from './curation';
import { buildLivePreviewRows, curateProviders, hasContactForDiscovery, type CurationLivePreview, type CurationPhaseReporter, type GeminiCurationResult } from './gemini';
import { saveCurationScan } from './curation-history';
import { logCurationEvent } from './curation-log';

const MAX_SCAN_ATTEMPTS = 10;
const MAX_CONSECUTIVE_FAILURES = 3;

/** Vista previa de lo acumulado hasta ahora, para que la interfaz muestre resultados parciales. */
function buildPreview(merged: GeminiCurationResult): CurationLivePreview {
  return {
    tsv: merged.tsv,
    discovered: merged.discovered,
    contactable: merged.contactable,
    model: merged.model,
    rejectedRows: merged.rejectedRows.map(row => ({
      line: row.line,
      issues: row.issues.map(item => ({ message: item.message })),
    })),
    rows: buildLivePreviewRows(parseCurationTsv(merged.tsv)),
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

function mergeBatchResults(batches: GeminiCurationResult[], targetCount: number): GeminiCurationResult {
  const seen = new Set<string>();
  const rawRows: string[] = [];
  for (const batch of batches) {
    const lines = batch.tsv.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim()).slice(1);
    for (const line of lines) {
      const key = candidateKey(line);
      if (seen.has(key)) continue;
      seen.add(key);
      rawRows.push(line);
      if (rawRows.length >= targetCount) break;
    }
    if (rawRows.length >= targetCount) break;
  }

  const tsv = [CURATION_HEADERS.join('\t'), ...rawRows].join('\n');
  const parsed = parseCurationTsv(tsv);
  const validation = validateCurationBatch(parsed);
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
  const runId = randomUUID();
  const batches: GeminiCurationResult[] = [];
  let previousRelevant = 0;
  let previousContactable = 0;
  let stoppedReason: GeminiCurationResult['stoppedReason'] = 'max_scans';
  let targetReached = false;
  let attemptsUsed = 0;
  let lastError = '';
  let consecutiveFailures = 0;

  for (let attempt = 1; attempt <= MAX_SCAN_ATTEMPTS; attempt += 1) {
    attemptsUsed = attempt;
    const remaining = Math.max(targetCount - previousRelevant, 0);
    const iterationInstructions = [
      input.instructions?.trim(),
      `Objetivo total de esta ejecución: ${targetCount} candidatos relevantes; faltan aproximadamente ${remaining}.`,
      `Este es el escaneo ${attempt} de ${MAX_SCAN_ATTEMPTS}. Cada escaneo puede devolver como máximo 20 prospectos.`,
      'Busca alternativas nuevas y no repitas ningún candidato aprobado, rechazado o ya descubierto en escaneos anteriores.',
    ].filter(Boolean).join('\n');
    input.onPhase?.('preparing', `Objetivo ${targetCount}: iniciando escaneo ${attempt}.`);
    let batch: GeminiCurationResult;
    try {
      batch = await curateProviders({
        city: input.city,
        category: input.category,
        instructions: iterationInstructions,
        targetCount,
        scanAttempt: attempt,
        jobId: input.jobId,
        runId,
        minRating: input.minRating,
        minReviews: input.minReviews,
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
    const merged = mergeBatchResults(batches, targetCount);
    const relevantCount = merged.discovered;
    const contactableCount = merged.contactable;
    targetReached = relevantCount >= targetCount && contactableCount >= contactTarget;
    logCurationEvent('scan_done', {
      jobId: input.jobId ?? 'sin-job',
      scanNumber: attempt,
      discovered: batch.discovered,
      accepted: batch.accepted,
      rejected: batch.rejected,
      contactable: batch.contactable,
      acumuladoRelevantes: relevantCount,
      acumuladoContactables: contactableCount,
      historySaved: saved,
    });
    // El avance parcial se publica siempre, con lote o sin él.
    input.onPhase?.('researching', targetReached
      ? `Objetivo alcanzado: ${relevantCount} candidatos y ${contactableCount} contactables.`
      : `Acumulado: ${relevantCount}/${targetCount} candidatos · ${contactableCount}/${contactTarget} contactables.`,
      { current: targetReached ? 4 : 3, total: 4, label: 'Consolidando resultados' },
      buildPreview(merged));

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
    // Se continúa mientras crezca cualquiera de las dos métricas: más contactos vale por sí mismo.
    if (relevantCount <= previousRelevant && contactableCount <= previousContactable) {
      stoppedReason = 'no_relevant_candidates';
      break;
    }
    previousRelevant = relevantCount;
    previousContactable = contactableCount;
  }

  const result = mergeBatchResults(batches, targetCount);
  const relevantCount = result.discovered;
  const contactableCount = result.contactable;
  const conteo = `Se conservaron ${relevantCount} de ${targetCount} candidatos y ${contactableCount} de ${contactTarget} contactables en ${attemptsUsed} escaneo(s).`;
  const alert = targetReached
    ? undefined
    : stoppedReason === 'history_save_failed'
      ? `No se pudo guardar el historial en la base de datos, así que la búsqueda se detuvo para no repetir candidatos. ${conteo}`
      : stoppedReason === 'agent_failed'
        ? `El agente de investigación no pudo entregar un lote válido. Motivo del último intento: ${lastError} ${conteo}`
      : stoppedReason === 'max_scans'
        ? `La búsqueda usó los ${MAX_SCAN_ATTEMPTS} escaneos disponibles sin llegar al objetivo. ${conteo}`
        : `La búsqueda se detuvo porque el último escaneo no aportó candidatos nuevos y verificables. ${conteo}`;
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
