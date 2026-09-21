import { pool } from './db';
import { parseCurationTsv, summarizeContactChannels, validateCurationBatch } from './curation';

export type CurationImportResult = {
  ok: boolean;
  imported: number;
  accepted: number;
  rejected: number;
  contactSummary: ReturnType<typeof summarizeContactChannels>;
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
      body: { ok: false, imported: 0, accepted: 0, rejected: 0, contactSummary: { email: 0, whatsapp: 0, emailProviders: [], whatsappProviders: [] }, rejectedRows: [], errors: parsed.fatalErrors },
    };
  }

  const batch = validateCurationBatch(parsed);
  const rejectedRows = rejectedCurationRows(batch.rejected);
  const contactSummary = summarizeContactChannels(batch.accepted);
  if (!pool) {
    return {
      status: 503,
      body: { ok: false, imported: 0, accepted: 0, rejected: batch.rejected.length, contactSummary, rejectedRows, error: 'DATABASE_NOT_CONFIGURED' },
    };
  }
  if (batch.accepted.length === 0) {
    return {
      status: 422,
      body: { ok: false, imported: 0, accepted: 0, rejected: batch.rejected.length, contactSummary, rejectedRows },
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of batch.accepted) {
      const fields = row.fields;
      const provider = await client.query<{ provider_id: string }>(`INSERT INTO marketplace.providers (dedupe_key, display_name, category, additional_categories, city, website_url, phone, rating, review_count, discovery_source, contact_channel) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (dedupe_key) DO UPDATE SET display_name = EXCLUDED.display_name, category = EXCLUDED.category, additional_categories = EXCLUDED.additional_categories, city = EXCLUDED.city, website_url = EXCLUDED.website_url, phone = EXCLUDED.phone, rating = EXCLUDED.rating, review_count = EXCLUDED.review_count, discovery_source = EXCLUDED.discovery_source, contact_channel = EXCLUDED.contact_channel, updated_at = now() RETURNING provider_id`, [row.dedupeKey, fields.displayName, fields.category, fields.additionalCategories, fields.city, fields.sourceUrl, fields.phone === 'Sin dato' ? null : fields.phone, fields.rating, fields.reviewCount, fields.platform, row.contactChannel]);
      if (row.contactChannel === 'email' && fields.email !== 'Sin dato') {
        await client.query(`INSERT INTO marketplace.contacts (provider_id, email, phone, consent_status, consent_source) VALUES ($1,$2,$3,'unknown','public-provider-source') ON CONFLICT (lower(email)) DO UPDATE SET provider_id = EXCLUDED.provider_id, phone = COALESCE(EXCLUDED.phone, marketplace.contacts.phone), updated_at = now()`, [provider.rows[0].provider_id, fields.email, fields.phone === 'Sin dato' ? null : fields.phone]);
      }
      const sourceFingerprintSeed = `${fields.platform}|${fields.sourceUrl}`;
      await client.query(`INSERT INTO marketplace.provider_sources (provider_id, source_name, source_url, source_record_key, source_fingerprint, observed_name, observed_rating, observed_reviews, raw_payload) VALUES ($1,$2,$3,$4,encode(digest($5,'sha256'),'hex'),$6,$7,$8,$9) ON CONFLICT (source_fingerprint) DO UPDATE SET provider_id = EXCLUDED.provider_id, source_name = EXCLUDED.source_name, source_url = EXCLUDED.source_url, source_record_key = EXCLUDED.source_record_key, observed_name = EXCLUDED.observed_name, observed_rating = EXCLUDED.observed_rating, observed_reviews = EXCLUDED.observed_reviews, raw_payload = EXCLUDED.raw_payload, last_seen_at = now()`, [provider.rows[0].provider_id, fields.platform, fields.sourceUrl, fields.id, sourceFingerprintSeed, fields.displayName, fields.rating, fields.reviewCount, JSON.stringify(row.rawEvidence)]);

      // Reputación de otras plataformas (Reputación Multiplataforma): mismo Fuente URL porque el TSV
      // solo trae una URL por candidato, pero cada plataforma tiene su propio fingerprint, así que no
      // pisa la fuente principal. Se salta la que ya coincide con la plataforma principal para no
      // hacer un upsert redundante sobre la misma fila.
      for (const entry of fields.multiPlatformReputation) {
        if (entry.platform.toLowerCase() === fields.platform.toLowerCase()) continue;
        const entryFingerprintSeed = `${entry.platform}|${fields.sourceUrl}`;
        await client.query(`INSERT INTO marketplace.provider_sources (provider_id, source_name, source_url, source_record_key, source_fingerprint, observed_name, observed_rating, observed_reviews, raw_payload) VALUES ($1,$2,$3,$4,encode(digest($5,'sha256'),'hex'),$6,$7,$8,$9) ON CONFLICT (source_fingerprint) DO UPDATE SET provider_id = EXCLUDED.provider_id, source_name = EXCLUDED.source_name, source_url = EXCLUDED.source_url, source_record_key = EXCLUDED.source_record_key, observed_name = EXCLUDED.observed_name, observed_rating = EXCLUDED.observed_rating, observed_reviews = EXCLUDED.observed_reviews, raw_payload = EXCLUDED.raw_payload, last_seen_at = now()`, [provider.rows[0].provider_id, entry.platform, fields.sourceUrl, fields.id, entryFingerprintSeed, fields.displayName, entry.rating, entry.reviews, JSON.stringify({ source: 'multiplatform_reputation' })]);
      }
    }
    await client.query('COMMIT');
    return { status: 201, body: { ok: true, imported: batch.accepted.length, accepted: batch.accepted.length, rejected: batch.rejected.length, contactSummary, rejectedRows } };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Provider import failed', error instanceof Error ? error.message : error);
    return { status: 500, body: { ok: false, imported: 0, accepted: 0, rejected: batch.rejected.length, contactSummary, rejectedRows, error: 'No se pudo importar el lote.' } };
  } finally {
    client.release();
  }
}
