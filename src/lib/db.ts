import pg from 'pg';

const { Pool } = pg;
const connectionString = import.meta.env.DATABASE_URL ?? process.env.DATABASE_URL;

export const pool = connectionString
  ? new Pool({ connectionString, max: 5, connectionTimeoutMillis: 4000 })
  : null;

export async function query<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  if (!pool) throw new Error('DATABASE_NOT_CONFIGURED');
  return pool.query<T>(text, values);
}
