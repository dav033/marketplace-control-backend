import { demoDashboard, demoProvider } from './demo';
import { query, pool } from './db';
import type { DashboardData, Provider, ProviderSource, Registration } from './types';
import type { Preregistered } from './contract';

export async function getDashboard(): Promise<DashboardData> {
  if (!pool) return demoDashboard();

  try {
    const [providers, registrations, counts] = await Promise.all([
      query<Provider>(`
        SELECT p.provider_id, p.display_name, p.category, p.additional_categories, p.city, p.rating, p.review_count, p.contact_channel, p.phone,
               p.status, p.discovery_source,
               c.email AS contact_email,
               to_char(GREATEST(p.updated_at, COALESCE(rs.created_at, p.updated_at)), 'DD Mon, HH24:MI') AS last_activity,
               COALESCE(src.platform_count, 0) AS platform_count
        FROM marketplace.providers p
        LEFT JOIN LATERAL (
          SELECT email FROM marketplace.contacts WHERE provider_id = p.provider_id ORDER BY created_at DESC LIMIT 1
        ) c ON true
        LEFT JOIN LATERAL (
          SELECT created_at FROM marketplace.registration_submissions WHERE provider_id = p.provider_id ORDER BY created_at DESC LIMIT 1
        ) rs ON true
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS platform_count FROM marketplace.provider_sources
          WHERE provider_id = p.provider_id AND observed_rating IS NOT NULL AND observed_reviews IS NOT NULL
        ) src ON true
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
          (SELECT count(*)::int FROM marketplace.providers WHERE status IN ('candidate','unconfirmed','under_review')) AS candidates,
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

/**
 * `provider_id` es una columna uuid: un identificador con otra forma hace que PostgreSQL lance
 * "invalid input syntax for type uuid" y la pagina devuelva 500 donde corresponde un 404.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getProvider(id: string) {
  if (!pool || id.startsWith('demo-')) return demoProvider(id);
  if (!UUID_PATTERN.test(id)) return null;
  const result = await query<Provider>(`
    SELECT p.provider_id, p.display_name, p.category, p.additional_categories, p.city, p.rating, p.review_count, p.contact_channel, p.phone,
           p.status, p.discovery_source, c.email AS contact_email, NULL AS last_activity
    FROM marketplace.providers p
    LEFT JOIN LATERAL (
      SELECT email FROM marketplace.contacts WHERE provider_id = p.provider_id ORDER BY created_at DESC LIMIT 1
    ) c ON true
    WHERE p.provider_id = $1
  `, [id]);
  const provider = result.rows[0] ?? null;
  if (!provider) return null;
  // Reputación por plataforma: cada fila de provider_sources con calificación y reseñas observadas
  // es una plataforma distinta donde el negocio tiene reseñas públicas, no solo Google.
  const sources = await query<ProviderSource>(`
    SELECT source_name, observed_rating, observed_reviews, source_url
    FROM marketplace.provider_sources
    WHERE provider_id = $1 AND observed_rating IS NOT NULL AND observed_reviews IS NOT NULL
    ORDER BY observed_reviews DESC NULLS LAST
  `, [id]);
  return { ...provider, sources: sources.rows };
}

/**
 * Una respuesta de formulario concreta.
 *
 * Se resuelve sobre el mismo lote que alimenta la bandeja en vez de con una consulta propia: así la
 * ficha y el listado no pueden discrepar, y el modo demostración sigue funcionando igual. Antes esta
 * búsqueda la hacía la página con un `find` sobre el lote completo; vive aquí para que el front no
 * tenga que conocer la forma de los datos.
 */
export async function getRegistration(id: string) {
  const data = await getDashboard();
  return data.registrations.find((entry) => entry.submission_id === id) ?? null;
}

/**
 * Candidatos a los que se les puede escribir, para el chat de prueba.
 *
 * Devuelve lo que el bot necesita saber antes de abrir la conversación. Es solo lectura: elegir un
 * candidato aquí no cambia su estado ni le manda nada.
 */
export async function getContactableCandidates(limit = 50) {
  if (!pool) return [];
  const result = await query<{
    provider_id: string; display_name: string; city: string | null; category: string | null;
    additional_categories: string[] | null; phone: string | null; contact_channel: string; contact_email: string | null;
  }>(`
    SELECT p.provider_id, p.display_name, p.city, p.category, p.additional_categories, p.phone, p.contact_channel,
           c.email AS contact_email
    FROM marketplace.providers p
    LEFT JOIN LATERAL (
      SELECT email FROM marketplace.contacts WHERE provider_id = p.provider_id ORDER BY created_at DESC LIMIT 1
    ) c ON true
    WHERE p.status = 'candidate'
    ORDER BY p.display_name
    LIMIT $1
  `, [limit]);
  return result.rows;
}


/**
 * Proveedores preregistrados: confirmaron sus datos y esperan aprobación humana.
 *
 * Son los que están en `unconfirmed`, el estado al que llegan tanto por el formulario del correo
 * como por la conversación del bot. Se trae también la respuesta que dieron, porque la pregunta que
 * se hace el operador aquí no es "quién es este proveedor" sino "¿lo que contó cuadra con la
 * evidencia que ya teníamos?".
 */
export async function getPreregistered(): Promise<Preregistered[]> {
  if (!pool) return [];
  const result = await query<Preregistered>(`
    SELECT p.provider_id, p.display_name, p.city, p.category, p.rating, p.review_count,
           s.submission_id, s.full_name, s.email, s.phone, s.company_name,
           COALESCE(s.products, '{}') AS products, COALESCE(s.services, '{}') AS services,
           s.volume_min, s.volume_max, COALESCE(s.marketing_consent, false) AS marketing_consent,
           s.consent_source, s.form_payload->>'description' AS description,
           to_char(s.created_at, 'DD Mon YYYY, HH24:MI') AS submitted_at
    FROM marketplace.providers p
    LEFT JOIN LATERAL (
      SELECT submission_id, full_name, email, phone, company_name, products, services,
             volume_min, volume_max, marketing_consent, consent_source, form_payload, created_at
      FROM marketplace.registration_submissions
      WHERE provider_id = p.provider_id
      ORDER BY created_at DESC
      LIMIT 1
    ) s ON true
    WHERE p.status = 'unconfirmed'
    ORDER BY s.created_at DESC NULLS LAST, p.display_name
    LIMIT 100
  `);
  return result.rows;
}
