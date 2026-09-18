import type { APIRoute } from 'astro';
import { pool } from '../../../lib/db';
import { parseCurationTsv, validateCurationBatch } from '../../../lib/curation';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function rejectedRows(rows: ReturnType<typeof validateCurationBatch>['rejected']) {
  return rows.map(row => ({
    line: row.line,
    id: row.rawCells[0] ?? null,
    issues: row.issues.map(({ code, message }) => ({ code, message })),
  }));
}

export const POST: APIRoute = async ({ request }) => {
  const contentType = request.headers.get('content-type') ?? '';
  let payload: Record<string, unknown>;
  try {
    payload = contentType.includes('application/json')
      ? await request.json() as Record<string, unknown>
      : Object.fromEntries((await request.formData()).entries());
  } catch {
    return json({ ok: false, accepted: 0, rejected: 0, error: 'El cuerpo de la solicitud no es válido.' }, 400);
  }
  const raw = typeof payload === 'object' && payload !== null && typeof payload.tsv === 'string' ? payload.tsv : '';
  const parsed = parseCurationTsv(raw);
  if (parsed.fatalErrors.length > 0) return json({ ok: false, accepted: 0, rejected: 0, errors: parsed.fatalErrors }, 400);

  const batch = validateCurationBatch(parsed);
  const rejected = rejectedRows(batch.rejected);
  if (!pool) {
    return json({ ok: false, imported: 0, accepted: 0, rejected: batch.rejected.length, rejectedRows: rejected, error: 'DATABASE_NOT_CONFIGURED' }, 503);
  }
  if (batch.accepted.length === 0) {
    return json({ ok: false, imported: 0, accepted: 0, rejected: batch.rejected.length, rejectedRows: rejected }, 422);
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
    return json({ ok: true, imported: batch.accepted.length, accepted: batch.accepted.length, rejected: batch.rejected.length, rejectedRows: rejected }, 201);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Provider import failed', error instanceof Error ? error.message : error);
    return json({ ok: false, imported: 0, accepted: 0, rejected: batch.rejected.length, rejectedRows: rejected, error: 'No se pudo importar el lote.' }, 500);
  } finally { client.release(); }
};
