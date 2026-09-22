/**
 * Propone categorías adicionales para los proveedores que ya están en la base.
 *
 * Los proveedores cosechados de Google entraron con una sola categoría (la de la búsqueda) porque la
 * cosecha nunca llenó la columna de adicionales. Esto deduce las que se ven en el nombre y en el
 * tipo que Google les asigna, y las añade a las que ya tengan.
 *
 * Sin `--apply` solo enseña lo que haría. Con `--apply` escribe, y deja rastro en `audit_log`.
 *
 *   node --env-file=.env --experimental-strip-types --import ./scripts/ts-resolver.mjs \
 *     scripts/backfill-provider-categories.ts [--apply]
 */
import { pool, query } from '../src/lib/db.ts';
import { inferAdditionalCategories } from '../src/lib/category-inference.ts';

const apply = process.argv.includes('--apply');

if (!pool) {
  console.error('Sin DATABASE_URL: no hay base que revisar.');
  process.exit(1);
}

const { rows } = await query<{
  provider_id: string; display_name: string; category: string; additional_categories: string[] | null; reason: string | null;
}>(`
  SELECT p.provider_id, p.display_name, p.category, p.additional_categories,
         s.raw_payload->'normalized'->>'curationReason' AS reason
  FROM marketplace.providers p
  LEFT JOIN LATERAL (
    SELECT raw_payload FROM marketplace.provider_sources
    WHERE provider_id = p.provider_id AND raw_payload ? 'normalized'
    ORDER BY last_seen_at DESC LIMIT 1
  ) s ON true
  ORDER BY p.display_name
`);

let cambios = 0;
for (const row of rows) {
  const actuales = row.additional_categories ?? [];
  const propuestas = inferAdditionalCategories(
    { name: row.display_name, notes: row.reason },
    row.category,
    Math.max(0, 4 - actuales.length),
  ).filter((category) => !actuales.includes(category));
  if (!propuestas.length) continue;

  cambios += 1;
  console.log(`${row.display_name.trim()} [${row.category}] → + ${propuestas.join(', ')}`);

  if (apply) {
    await query(
      `UPDATE marketplace.providers
       SET additional_categories = additional_categories || $2::text[], updated_at = now()
       WHERE provider_id = $1`,
      [row.provider_id, propuestas],
    );
    await query(
      `INSERT INTO marketplace.audit_log (actor_id, action, entity_type, entity_id, before_state, after_state, metadata)
       VALUES ('backfill', 'provider.categories_inferred', 'provider', $1, $2::jsonb, $3::jsonb, '{"fuente":"nombre y tipo de Google"}'::jsonb)`,
      [row.provider_id, JSON.stringify({ additional_categories: actuales }), JSON.stringify({ additional_categories: [...actuales, ...propuestas] })],
    );
  }
}

console.log(`\n${cambios} de ${rows.length} proveedores ganarían categorías. ${apply ? 'Aplicado.' : 'Simulación: nada se escribió (usa --apply).'}`);
await pool.end();
