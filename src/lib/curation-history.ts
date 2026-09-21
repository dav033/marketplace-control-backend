import { randomUUID } from 'node:crypto';
import { pool } from './db';
import type { CurationDiscoveredCandidate, GeminiCurationResult } from './gemini';
import type { ParsedCurationRow } from './curation';

let schemaReady: Promise<boolean> | undefined;

async function ensureSchema(): Promise<boolean> {
  if (!pool) return false;
  if (!schemaReady) {
    schemaReady = pool.query(`SELECT to_regclass('marketplace.audit_log') AS audit_table`).then(result => {
      if (!result.rows[0]?.audit_table) throw new Error('AUDIT_LOG_NOT_AVAILABLE');
      return true;
    }).catch(error => {
      console.error('Curation history schema unavailable', error instanceof Error ? error.message : error);
      return false;
    });
  }
  return schemaReady;
}

function normalizeKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function rowValue(row: ParsedCurationRow, index: number): string {
  return (row.rawCells[index] ?? '').trim();
}

export function curationCandidateKey(name: string, city: string, category: string): string {
  return `${normalizeKey(name)}|${normalizeKey(city)}|${normalizeKey(category)}`;
}

export type CurationBlacklistEntry = {
  candidateKey: string;
  displayName: string;
  category: string;
  city: string;
  sourceUrl: string;
  status: 'accepted' | 'rejected';
  reasonCodes: string[];
  reasons: unknown[];
  runId?: string | null;
};

/**
 * Motivos de rechazo que NO describen al negocio, sino un fallo del propio agente o de su
 * herramienta de búsqueda: fue descubierto bien y se perdió por un límite de la investigación, no
 * porque el negocio no califique. `pending_reputation_review` y `missing_review_disclosure` entran
 * aquí porque Google Maps no expone su calificación como texto rastreable por búsqueda web general
 * (confirmado: ni una búsqueda web genérica ni un fetch directo a Google Maps la muestran, aunque la
 * calificación exista y sea visible para una persona en el navegador) — un negocio real puede quedar
 * marcado "Sin dato" solo por esa limitación de la herramienta, en un escaneo y no en otro. Bloquearlo
 * para siempre vacía el mercado, así que solo se respeta dentro de la misma ejecución, para no repetir
 * trabajo en el escaneo siguiente.
 */
const RETRYABLE_REASON_CODES = new Set(['not_returned_by_verification', 'pending_reputation_review', 'missing_review_disclosure']);

export function isReleasedForRetry(
  entry: Pick<CurationBlacklistEntry, 'status' | 'reasonCodes' | 'runId'>,
  currentRunId?: string,
): boolean {
  if (entry.status !== 'rejected') return false;
  if (!entry.reasonCodes.length) return false;
  if (!entry.reasonCodes.every(code => RETRYABLE_REASON_CODES.has(code))) return false;
  // Dentro de la misma ejecución sigue bloqueado; en una ejecución nueva se puede reintentar.
  return !currentRunId || entry.runId !== currentRunId;
}

export async function getCurationBlacklist(city: string, category: string, runId?: string): Promise<CurationBlacklistEntry[]> {
  if (!(await ensureSchema())) return [];
  try {
    const result = await pool!.query<{
      candidate_key: string;
      display_name: string;
      category: string;
      city: string;
      source_url: string | null;
      status: 'accepted' | 'rejected';
      reason_codes: unknown;
      reasons: unknown;
      run_id: string | null;
    }>(`SELECT metadata->>'candidate_key' AS candidate_key,
          metadata->>'display_name' AS display_name,
          metadata->>'category' AS category,
          metadata->>'city' AS city,
          metadata->>'source_url' AS source_url,
          metadata->>'status' AS status,
          COALESCE(metadata->'reason_codes', '[]'::jsonb) AS reason_codes,
          COALESCE(metadata->'reasons', '[]'::jsonb) AS reasons,
          metadata->>'run_id' AS run_id
        FROM marketplace.audit_log
        WHERE action = 'curation.scan_candidate'
          AND entity_type = 'curation_candidate'
          AND lower(metadata->>'city') = lower($1)
          AND lower(metadata->>'category') = lower($2)
        ORDER BY occurred_at DESC
        LIMIT 1000`, [city, category]);
    // Candidatos liberados a mano tras corregir un fallo de validación: vuelven a estar disponibles.
    const released = await pool!.query<{ candidate_key: string }>(
      `SELECT metadata->>'candidate_key' AS candidate_key
         FROM marketplace.audit_log
        WHERE action = 'curation.blacklist_release'
          AND lower(metadata->>'city') = lower($1)
          AND lower(metadata->>'category') = lower($2)`, [city, category]);
    const releasedKeys = new Set(released.rows.map(row => row.candidate_key).filter(Boolean));
    return result.rows.map(row => ({
      candidateKey: row.candidate_key,
      displayName: row.display_name,
      category: row.category,
      city: row.city,
      sourceUrl: row.source_url ?? '',
      status: row.status,
      reasonCodes: Array.isArray(row.reason_codes) ? row.reason_codes.filter((item): item is string => typeof item === 'string') : [],
      reasons: Array.isArray(row.reasons) ? row.reasons : [],
      runId: row.run_id,
    })).filter(entry => !releasedKeys.has(entry.candidateKey) && !isReleasedForRetry(entry, runId));
  } catch (error) {
    console.error('Curation blacklist read failed', error instanceof Error ? error.message : error);
    return [];
  }
}

function rowReasonData(row: ParsedCurationRow) {
  return row.issues.map(item => ({ code: item.code, message: item.message }));
}

function discoveredReason(candidate: CurationDiscoveredCandidate) {
  return [{ code: 'not_returned_by_verification', message: `${candidate.name} fue descubierto, pero la verificación no lo devolvió. Queda fuera del resto de esta ejecución y se puede reintentar en la siguiente.` }];
}

export async function saveCurationScan(input: {
  city: string;
  category: string;
  instructions?: string;
  result: GeminiCurationResult;
  runId?: string;
  attempt?: number;
  targetCount?: number;
}): Promise<boolean> {
  if (!(await ensureSchema())) return false;
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    const scanId = randomUUID();
    const discoveredCount = input.result.discovered;
    const rosterCount = input.result.discoveredCandidates?.length ?? 0;
    const rejectedCount = Math.max(input.result.rejected, discoveredCount - input.result.accepted);
    await client.query(`INSERT INTO marketplace.audit_log
      (actor_id, action, entity_type, entity_id, after_state, metadata)
      VALUES ($1,$2,$3,$4,$5,$6)`, [
      input.result.provider,
      'curation.scan',
      'curation_scan',
      scanId,
      JSON.stringify({ city: input.city, category: input.category, instructions: input.instructions?.trim() || null, provider: input.result.provider, model: input.result.model, researchSummary: input.result.researchSummary }),
      JSON.stringify({ scan_id: scanId, run_id: input.runId ?? null, attempt: input.attempt ?? 1, target_count: input.targetCount ?? null, city: input.city, category: input.category, discovered: discoveredCount, roster: rosterCount, accepted: input.result.accepted, rejected: rejectedCount, contactable: input.result.contactable }),
    ]);
    const rows = [
      ...(input.result.acceptedRows ?? []).map(row => ({ row, status: 'accepted' as const, reasons: [{ code: 'accepted', message: row.fields.curationReason }] })),
      ...input.result.rejectedRows.map(row => ({ row, status: 'rejected' as const, reasons: rowReasonData(row) })),
    ];
    const seenKeys = new Set<string>();
    for (const entry of rows) {
      const row = entry.row;
      const displayName = row.fields?.displayName ?? (rowValue(row, 1) || 'Sin dato');
      const rowCategory = row.fields?.category ?? (rowValue(row, 2) || input.category);
      const rowCity = row.fields?.city ?? (rowValue(row, 4) || input.city);
      const sourceUrl = row.fields?.sourceUrl ?? (rowValue(row, 16) || null);
      const candidateKey = 'dedupeKey' in row && typeof row.dedupeKey === 'string'
        ? row.dedupeKey
        : curationCandidateKey(displayName, rowCity, rowCategory);
      if (seenKeys.has(candidateKey)) continue;
      seenKeys.add(candidateKey);
      const reasonCodes = row.issues.map(item => item.code);
      await client.query(`INSERT INTO marketplace.audit_log
        (actor_id, action, entity_type, entity_id, after_state, metadata)
        VALUES ($1,$2,$3,$4,$5,$6)`, [
        input.result.provider,
        'curation.scan_candidate',
        'curation_candidate',
        randomUUID(),
        JSON.stringify({ rawTsv: row.rawLine, rawColumns: row.rawRecord }),
        JSON.stringify({
          scan_id: scanId,
          run_id: input.runId ?? null,
          attempt: input.attempt ?? 1,
          candidate_key: candidateKey,
          display_name: displayName,
          category: rowCategory,
          city: rowCity,
          source_url: sourceUrl,
          status: entry.status,
          reason_codes: reasonCodes,
          reasons: entry.reasons,
          phone: row.fields?.phone ?? (rowValue(row, 13) || 'Sin dato'),
          email: row.fields?.email ?? (rowValue(row, 15) || 'Sin dato'),
          platform: row.fields?.platform ?? (rowValue(row, 10) || 'Sin dato'),
        }),
      ]);
    }
    for (const candidate of input.result.discoveredCandidates ?? []) {
      const candidateKey = curationCandidateKey(candidate.name, input.city, input.category);
      if (!candidate.name || seenKeys.has(candidateKey)) continue;
      seenKeys.add(candidateKey);
      await client.query(`INSERT INTO marketplace.audit_log
        (actor_id, action, entity_type, entity_id, after_state, metadata)
        VALUES ($1,$2,$3,$4,$5,$6)`, [
        input.result.provider,
        'curation.scan_candidate',
        'curation_candidate',
        randomUUID(),
        JSON.stringify({ discovery: candidate.payload }),
        JSON.stringify({
          scan_id: scanId,
          // El run_id permite reintentar en una ejecución futura lo que solo se perdió por un fallo.
          run_id: input.runId ?? null,
          candidate_key: candidateKey,
          display_name: candidate.name,
          category: input.category,
          city: input.city,
          source_url: candidate.directUrl || null,
          status: 'rejected',
          reason_codes: ['not_returned_by_verification'],
          reasons: discoveredReason(candidate),
        }),
      ]);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Curation history save failed', error instanceof Error ? error.message : error);
    return false;
  } finally {
    client.release();
  }
}
