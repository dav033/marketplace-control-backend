import { demoDashboard, demoProvider } from './demo';
import { query, pool } from './db';
import type { DashboardData, Provider, Registration } from './types';

export async function getDashboard(): Promise<DashboardData> {
  if (!pool) return demoDashboard();

  try {
    const [providers, registrations, counts] = await Promise.all([
      query<Provider>(`
        SELECT p.provider_id, p.display_name, p.category, p.city, p.rating, p.review_count,
               p.status, p.discovery_source,
               c.email AS contact_email,
               to_char(GREATEST(p.updated_at, COALESCE(rs.created_at, p.updated_at)), 'DD Mon, HH24:MI') AS last_activity
        FROM marketplace.providers p
        LEFT JOIN LATERAL (
          SELECT email FROM marketplace.contacts WHERE provider_id = p.provider_id ORDER BY created_at DESC LIMIT 1
        ) c ON true
        LEFT JOIN LATERAL (
          SELECT created_at FROM marketplace.registration_submissions WHERE provider_id = p.provider_id ORDER BY created_at DESC LIMIT 1
        ) rs ON true
        ORDER BY p.updated_at DESC LIMIT 30
      `),
      query<Registration>(`
        SELECT submission_id, provider_id, company_name, full_name, email, submission_status,
               to_char(created_at, 'DD Mon, HH24:MI') AS created_at
        FROM marketplace.registration_submissions
        ORDER BY created_at DESC LIMIT 8
      `),
      query<{ candidates: number; contacted: number; interested: number; submissions: number }>(`
        SELECT
          (SELECT count(*)::int FROM marketplace.providers WHERE status IN ('candidate','under_review')) AS candidates,
          (SELECT count(DISTINCT provider_id)::int FROM marketplace.campaign_sends WHERE status IN ('sent','delivered')) AS contacted,
          (SELECT count(DISTINCT cs.provider_id)::int FROM marketplace.campaign_sends cs JOIN marketplace.email_clicks ec ON ec.send_id = cs.send_id) AS interested,
          (SELECT count(*)::int FROM marketplace.registration_submissions WHERE submission_status NOT IN ('spam','rejected')) AS submissions
      `),
    ]);

    return { providers: providers.rows, registrations: registrations.rows, counts: counts.rows[0], connected: true };
  } catch (error) {
    console.error('Database read failed; using demo mode.', error instanceof Error ? error.message : error);
    return demoDashboard();
  }
}

export async function getProvider(id: string) {
  if (!pool || id.startsWith('demo-')) return demoProvider(id);
  const result = await query<Provider>(`
    SELECT p.provider_id, p.display_name, p.category, p.city, p.rating, p.review_count,
           p.status, p.discovery_source, c.email AS contact_email, NULL AS last_activity
    FROM marketplace.providers p
    LEFT JOIN LATERAL (
      SELECT email FROM marketplace.contacts WHERE provider_id = p.provider_id ORDER BY created_at DESC LIMIT 1
    ) c ON true
    WHERE p.provider_id = $1
  `, [id]);
  return result.rows[0] ?? null;
}
