import type { APIRoute } from 'astro';
import { pool } from '../../../lib/db';

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const clean = (value: string | undefined) => (value ?? '').trim();
const numberOrNull = (value: string) => {
  const parsed = Number(value.replace(',', '.').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

function findColumn(headers: string[], names: string[]) {
  const wanted = names.map(normalize);
  return headers.findIndex((header) => wanted.some((name) => header === name || header.includes(name)));
}

export const POST: APIRoute = async ({ request }) => {
  if (!pool) return new Response('DATABASE_NOT_CONFIGURED', { status: 503 });
  const contentType = request.headers.get('content-type') ?? '';
  const payload: Record<string, unknown> = contentType.includes('application/json')
    ? await request.json()
    : Object.fromEntries((await request.formData()).entries());
  const raw = typeof payload === 'object' && payload !== null && 'tsv' in payload ? String(payload.tsv) : JSON.stringify(payload);
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return new Response('El TSV necesita encabezados y al menos una fila.', { status: 400 });

  const headers = lines[0].split('\t').map(normalize);
  const index = {
    name: findColumn(headers, ['proveedor', 'nombre', 'nombre comercial']),
    category: findColumn(headers, ['categoria', 'categoría']),
    city: findColumn(headers, ['ciudad']),
    rating: findColumn(headers, ['calificacion', 'calificación', 'rating']),
    reviews: findColumn(headers, ['resenas', 'reseñas', 'reviews']),
    source: findColumn(headers, ['plataforma', 'fuente', 'source']),
    website: findColumn(headers, ['web', 'website', 'url']),
    phone: findColumn(headers, ['telefono', 'teléfono', 'phone']),
    address: findColumn(headers, ['direccion', 'dirección', 'address']),
  };
  if (index.name < 0 || index.city < 0 || index.category < 0) return new Response('Faltan columnas requeridas: Proveedor, Ciudad y Categoría.', { status: 400 });

  const client = await pool.connect();
  let imported = 0;
  try {
    await client.query('BEGIN');
    for (const line of lines.slice(1)) {
      const cells = line.split('\t').map(clean);
      const name = cells[index.name];
      const city = cells[index.city];
      const category = cells[index.category];
      if (!name || !city || !category) continue;
      const rating = index.rating >= 0 ? numberOrNull(cells[index.rating]) : null;
      const reviewCount = index.reviews >= 0 ? numberOrNull(cells[index.reviews]) : null;
      const source = index.source >= 0 ? cells[index.source] : 'Prompt v2.8';
      const dedupeKey = normalize(`${name}|${city}|${category}`);
      const provider = await client.query<{ provider_id: string }>(`INSERT INTO marketplace.providers (dedupe_key, display_name, category, city, website_url, phone, address, rating, review_count, discovery_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (dedupe_key) DO UPDATE SET website_url = COALESCE(EXCLUDED.website_url, marketplace.providers.website_url), phone = COALESCE(EXCLUDED.phone, marketplace.providers.phone), address = COALESCE(EXCLUDED.address, marketplace.providers.address), rating = COALESCE(EXCLUDED.rating, marketplace.providers.rating), review_count = COALESCE(EXCLUDED.review_count, marketplace.providers.review_count), updated_at = now() RETURNING provider_id`, [dedupeKey, name, category, city, index.website >= 0 ? cells[index.website] || null : null, index.phone >= 0 ? cells[index.phone] || null : null, index.address >= 0 ? cells[index.address] || null : null, rating, reviewCount, source]);
      const rawRow = Object.fromEntries(headers.map((header, position) => [header || `column_${position + 1}`, cells[position] ?? '']));
      await client.query(`INSERT INTO marketplace.provider_sources (provider_id, source_name, source_url, source_record_key, source_fingerprint, observed_name, observed_rating, observed_reviews, raw_payload) VALUES ($1,$2,$3,$4,encode(digest($5,'sha256'),'hex'),$6,$7,$8,$9) ON CONFLICT (source_fingerprint) DO UPDATE SET last_seen_at = now(), raw_payload = EXCLUDED.raw_payload`, [provider.rows[0].provider_id, source, index.website >= 0 ? cells[index.website] || null : null, dedupeKey, `${source}|${dedupeKey}`, name, rating, reviewCount, JSON.stringify(rawRow)]);
      imported += 1;
    }
    await client.query('COMMIT');
    return new Response(JSON.stringify({ ok: true, imported }), { status: 201, headers: { 'content-type': 'application/json' } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Provider import failed', error instanceof Error ? error.message : error);
    return new Response('No se pudo importar el lote.', { status: 500 });
  } finally { client.release(); }
};
