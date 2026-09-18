// Libera candidatos que quedaron bloqueados por un fallo de validación ya corregido.
//
// Uso:
//   node --env-file=.env --experimental-strip-types --import ./scripts/ts-resolver.mjs \
//     scripts/release-curation-blacklist.ts "Barranquilla" "Comida y Bebida"          # solo informa
//   ... scripts/release-curation-blacklist.ts "Barranquilla" "Comida y Bebida" --apply # libera
//
// No borra nada: el historial es un registro de auditoría. Escribe filas nuevas de tipo
// 'curation.blacklist_release' que la lista negra consulta para volver a permitir esos negocios.
import { randomUUID } from 'node:crypto';
import { pool } from '../src/lib/db.ts';

/**
 * Motivos que dejaron de ser válidos tras corregir la validación: un prospecto real sin reputación
 * pública se rechazaba con un error de formato en vez de marcarse para revisión.
 */
const OBSOLETE_REASON_CODES = new Set(['invalid_curation_reason', 'invalid_curation_level_for_threshold']);

const city = process.argv[2];
const category = process.argv[3];
const apply = process.argv.includes('--apply');

if (!city || !category) {
  console.error('Faltan argumentos: <ciudad> <categoría> [--apply]');
  process.exit(1);
}
if (!pool) {
  console.error('DATABASE_URL no está configurada.');
  process.exit(1);
}

const candidates = await pool.query<{ candidate_key: string; display_name: string; reason_codes: unknown }>(
  `SELECT DISTINCT ON (metadata->>'candidate_key')
          metadata->>'candidate_key' AS candidate_key,
          metadata->>'display_name'  AS display_name,
          COALESCE(metadata->'reason_codes', '[]'::jsonb) AS reason_codes
     FROM marketplace.audit_log
    WHERE action = 'curation.scan_candidate'
      AND metadata->>'status' = 'rejected'
      AND lower(metadata->>'city') = lower($1)
      AND lower(metadata->>'category') = lower($2)
    ORDER BY metadata->>'candidate_key', occurred_at DESC`, [city, category]);

const alreadyReleased = await pool.query<{ candidate_key: string }>(
  `SELECT metadata->>'candidate_key' AS candidate_key
     FROM marketplace.audit_log
    WHERE action = 'curation.blacklist_release'
      AND lower(metadata->>'city') = lower($1)
      AND lower(metadata->>'category') = lower($2)`, [city, category]);
const releasedKeys = new Set(alreadyReleased.rows.map(row => row.candidate_key));

// Solo se libera un candidato cuyos motivos de rechazo sean TODOS obsoletos: si además falló por
// contacto, URL o datos inventados, sigue bloqueado con razón.
const toRelease = candidates.rows.filter(row => {
  if (releasedKeys.has(row.candidate_key)) return false;
  const codes = Array.isArray(row.reason_codes) ? row.reason_codes.filter((item): item is string => typeof item === 'string') : [];
  return codes.length > 0 && codes.every(code => OBSOLETE_REASON_CODES.has(code));
});

console.log(`Rechazados únicos en ${city} · ${category}: ${candidates.rows.length}`);
console.log(`Ya liberados antes: ${releasedKeys.size}`);
console.log(`Liberables por la corrección de validación: ${toRelease.length}`);
for (const row of toRelease.slice(0, 40)) console.log(`  - ${row.display_name}`);
if (toRelease.length > 40) console.log(`  … y ${toRelease.length - 40} más`);

if (!apply) {
  console.log('\nSimulación. Vuelve a ejecutarlo con --apply para liberarlos.');
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const row of toRelease) {
    await client.query(
      `INSERT INTO marketplace.audit_log (actor_id, action, entity_type, entity_id, after_state, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      ['mantenimiento', 'curation.blacklist_release', 'curation_candidate', randomUUID(),
        JSON.stringify({ released_reason: 'La validación rechazaba prospectos sin reputación pública con un error de formato.' }),
        JSON.stringify({ candidate_key: row.candidate_key, display_name: row.display_name, city, category })],
    );
  }
  await client.query('COMMIT');
  console.log(`\nLiberados ${toRelease.length} candidatos. Volverán a aparecer en el próximo escaneo.`);
} catch (error) {
  await client.query('ROLLBACK');
  console.error('No se pudo liberar:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
