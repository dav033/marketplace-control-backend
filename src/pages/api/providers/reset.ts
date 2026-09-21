import type { APIRoute } from 'astro';
import { pool, query } from '../../../lib/db';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/**
 * Borrado de los datos de operación. Es irreversible y por eso pide una confirmación explícita:
 * el cuerpo debe traer `confirm: "BORRAR TODO"`. Un `confirm: true` sería demasiado fácil de
 * enviar por accidente desde una consola o un cliente mal configurado.
 *
 * `audit_log` no se toca: es el registro de lo que pasó, y borrarlo dejaría la operación sin
 * rastro justo cuando más falta hace saber qué se borró y cuándo.
 */

const CONFIRMATION = 'BORRAR TODO';

/**
 * Orden de borrado: de las dependencias hacia las tablas raíz. Algunas pueden no existir en una
 * base concreta — `campaign_personalizations` está en el esquema pero nunca se aplicó en
 * producción — así que la lista se cruza con las tablas reales antes de tocar nada.
 */
const TABLES = [
  'email_clicks',
  'campaign_sends',
  'campaign_personalizations',
  'registration_submissions',
  'provider_sources',
  'campaigns',
  'contacts',
  'providers',
] as const;

async function existingTables(): Promise<string[]> {
  const result = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'marketplace'`,
  );
  const present = new Set(result.rows.map(row => row.table_name));
  return TABLES.filter(table => present.has(table));
}

export const GET: APIRoute = async () => {
  if (!pool) return json({ ok: false, error: 'Sin conexión a la base de datos.' }, 503);
  try {
    const counts: Record<string, number> = {};
    for (const table of await existingTables()) {
      const result = await query<{ n: number }>(`SELECT count(*)::int AS n FROM marketplace.${table}`);
      counts[table] = result.rows[0]?.n ?? 0;
    }
    return json({ ok: true, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
  } catch (error) {
    console.error('Reset preview failed', error instanceof Error ? error.message : error);
    return json({ ok: false, error: 'No se pudieron contar los registros.' }, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (!pool) return json({ ok: false, error: 'Sin conexión a la base de datos.' }, 503);

  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'El cuerpo de la solicitud no es válido.' }, 400);
  }
  if (payload.confirm !== CONFIRMATION) {
    return json({ ok: false, error: `Para borrar hay que enviar confirm: "${CONFIRMATION}".` }, 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deleted: Record<string, number> = {};
    for (const table of await existingTables()) {
      const result = await client.query(`DELETE FROM marketplace.${table}`);
      deleted[table] = result.rowCount ?? 0;
    }
    // Queda constancia de la limpieza en el historial, que sobrevive al borrado.
    await client.query(
      `INSERT INTO marketplace.audit_log (actor_id, action, entity_type, metadata)
       VALUES ('panel', 'data.reset', 'marketplace', $1::jsonb)`,
      [JSON.stringify(deleted)],
    );
    await client.query('COMMIT');
    return json({ ok: true, deleted, total: Object.values(deleted).reduce((a, b) => a + b, 0) });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Reset failed', error instanceof Error ? error.message : error);
    return json({ ok: false, error: 'No se pudo borrar. No se cambió nada.' }, 500);
  } finally {
    client.release();
  }
};
