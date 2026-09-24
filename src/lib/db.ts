import pg from 'pg';

const { Pool } = pg;
const connectionString = import.meta.env?.DATABASE_URL ?? process.env.DATABASE_URL;

// Las columnas son timestamptz y PostgreSQL corre en UTC: la sesión en hora de Colombia hace que
// cada to_char() salga con la hora que ve el operador, sin tocar lo guardado.
export const pool = connectionString
  ? new Pool({ connectionString, max: 5, connectionTimeoutMillis: 4000, options: '-c timezone=America/Bogota' })
  : null;

export async function query<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  if (!pool) throw new Error('DATABASE_NOT_CONFIGURED');
  return pool.query<T>(text, values);
}
