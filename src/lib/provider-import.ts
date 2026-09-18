import { pool } from './db';
import { parseCurationTsv, validateCurationBatch } from './curation';

export type CurationImportResult = {
  ok: boolean;
  imported: number;
  accepted: number;
  rejected: number;
  rejectedRows: Array<{
    line: number;
    id: string | null;
    issues: Array<{ code: string; message: string }>;
  }>;
  errors?: unknown;
  error?: string;
};

export function rejectedCurationRows(rows: ReturnType<typeof validateCurationBatch>['rejected']) {
  return rows.map(row => ({
    line: row.line,
    id: row.rawCells[0] ?? null,
    issues: row.issues.map(({ code, message }) => ({ code, message })),
  }));
}

export async function importCurationTsv(raw: string): Promise<{ status: number; body: CurationImportResult }> {
  const parsed = parseCurationTsv(raw);
  if (parsed.fatalErrors.length > 0) {
    return {
      status: 400,
      body: { ok: false, imported: 0, accepted: 0, rejected: 0, rejectedRows: [], errors: parsed.fatalErrors },
    };
  }

  const batch = validateCurationBatch(parsed);
  const rejectedRows = rejectedCurationRows(batch.rejected);
  if (!pool) {
    return {
      status: 503,
      body: { ok: false, imported: 0, accepted: 0, rejected: batch.rejected.length, rejectedRows, error: 'DATABASE_NOT_CONFIGURED' },
    };
  }
  if (batch.accepted.length === 0) {
    return {
      status: 422,
      body: { ok: false, imported: 0, accepted: 0, rejected: batch.rejected.length, rejectedRows },
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of batch.accepted) {
      const fields = row.fields;
      const provider = await client.query<{ provider_id: string }>(`INSERT INTO marketplace.providers (dedupe_key, display_name, category, city, website_url, phone, rating, review_count, discovery_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO UPDATE SET display_name = EXCLUDED.display_name, category = EXCLUDED.category, city = EXCLUDED.city, website_url = EXCLUDED.website_url, phone = EXCLUDED.phone, rating = EXCLUDED.rating, review_count = EXCLUDED.review_count, discovery_source = EXCLUDED.discovery_source, updated_at = now() RETURNING provider_id`, [row.dedupeKey, fields.displayName, fields.category, fields.city, fields.sourceUrl, fields.phone === 'Sin dato' ? null : fields.phone, fields.rating, fields.reviewCount, fields.platform]);
      const sourceFingerprintSeed = `${fields.platform}|${fields.sourceUrl}`;
      await client.query(`INSERT INTO marketplace.provider_sources (provider_id, source_name, source_url, source_record_key, source_fingerprint, observed_name, observed_rating, observed_reviews, raw_payload) VALUES ($1,$2,$3,$4,encode(digest($5,'sha256'),'hex'),$6,$7,$8,$9) ON CONFLICT (source_fingerprint) DO UPDATE SET provider_id = EXCLUDED.provider_id, source_name = EXCLUDED.source_name, source_url = EXCLUDED.source_url, source_record_key = EXCLUDED.source_record_key, observed_name = EXCLUDED.observed_name, observed_rating = EXCLUDED.observed_rating, observed_reviews = EXCLUDED.observed_reviews, raw_payload = EXCLUDED.raw_payload, last_seen_at = now()`, [provider.rows[0].provider_id, fields.platform, fields.sourceUrl, fields.id, sourceFingerprintSeed, fields.displayName, fields.rating, fields.reviewCount, JSON.stringify(row.rawEvidence)]);
    }
    await client.query('COMMIT');
    return { status: 201, body: { ok: true, imported: batch.accepted.length, accepted: batch.accepted.length, rejected: batch.rejected.length, rejectedRows } };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Provider import failed', error instanceof Error ? error.message : error);
    return { status: 500, body: { ok: false, imported: 0, accepted: 0, rejected: batch.rejected.length, rejectedRows, error: 'No se pudo importar el lote.' } };
  } finally {
    client.release();
  }
}
