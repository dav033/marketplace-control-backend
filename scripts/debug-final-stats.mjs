import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const scans = await client.query(`SELECT count(*)::int AS total_scans FROM marketplace.audit_log WHERE action='curation.scan' AND occurred_at > now() - interval '3 hours'`);
console.log('Total scan runs (last 3h):', scans.rows[0].total_scans);

const byCategory = await client.query(`
  SELECT metadata->>'category' AS category,
    count(*) FILTER (WHERE metadata->>'status'='accepted')::int AS accepted,
    count(*) FILTER (WHERE metadata->>'status'='rejected')::int AS rejected
  FROM marketplace.audit_log
  WHERE action='curation.scan_candidate' AND occurred_at > now() - interval '3 hours'
  GROUP BY category ORDER BY category
`);
console.table(byCategory.rows);

const totals = await client.query(`
  SELECT
    count(*) FILTER (WHERE metadata->>'status'='accepted')::int AS total_accepted,
    count(*) FILTER (WHERE metadata->>'status'='rejected')::int AS total_rejected
  FROM marketplace.audit_log
  WHERE action='curation.scan_candidate' AND occurred_at > now() - interval '3 hours'
`);
console.log('Totals:', totals.rows[0]);

await client.end();
