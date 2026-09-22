import { demoDashboard, demoProvider } from './demo';
import { query, pool } from './db';
import type { DashboardData, Provider, ProviderSource, Registration } from './types';
import type { Preregistered } from './contract';
import type { WhatsappStatus } from './conversation-status';
import { OFFICIAL_CATEGORIES } from './registration-fields';

export async function getDashboard(): Promise<DashboardData> {
  if (!pool) return demoDashboard();

  try {
    const [providers, registrations, counts] = await Promise.all([
      query<Provider>(`
        SELECT p.provider_id, p.display_name, p.category, p.additional_categories, p.city, p.rating, p.review_count, p.contact_channel, p.phone,
               p.status, p.discovery_source,
               c.email AS contact_email,
               to_char(GREATEST(p.updated_at, COALESCE(rs.created_at, p.updated_at)), 'DD Mon, HH24:MI') AS last_activity,
               COALESCE(src.platform_count, 0) AS platform_count,
               p.whatsapp_status, to_char(p.whatsapp_status_at, 'DD Mon, HH24:MI') AS whatsapp_status_at, p.whatsapp_status_reason
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
        -- El listado de proveedores trabaja sobre el lote entero (filtros, selección para enviar en
        -- lote): con el tope de 30 que tenía, los demás no existían para el panel.
        ORDER BY p.updated_at DESC LIMIT 1000
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
           p.status, p.discovery_source, c.email AS contact_email, NULL AS last_activity,
           p.whatsapp_status, to_char(p.whatsapp_status_at, 'DD Mon, HH24:MI') AS whatsapp_status_at, p.whatsapp_status_reason
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
 * Borra un proveedor y todo lo que dependía de él.
 *
 * `provider_sources` (la evidencia) tiene `ON DELETE CASCADE`; `contacts`, `campaign_sends` y
 * `registration_submissions` tienen `ON DELETE SET NULL` — el esquema ya resuelve la integridad
 * referencial, así que un solo DELETE basta. Devuelve `true` si de verdad borró una fila, para que
 * el endpoint pueda distinguir "ya no existía" de "se borró".
 */
export async function deleteProvider(id: string): Promise<boolean> {
  if (!pool || !UUID_PATTERN.test(id)) return false;
  const result = await query('DELETE FROM marketplace.providers WHERE provider_id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

/** Borra una respuesta de formulario. Nada más referencia `registration_submissions` por clave foránea. */
export async function deleteRegistration(id: string): Promise<boolean> {
  if (!pool || !UUID_PATTERN.test(id)) return false;
  const result = await query('DELETE FROM marketplace.registration_submissions WHERE submission_id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Quita a un proveedor de preregistrados: borra lo que envió y lo devuelve a candidato.
 *
 * No borra al proveedor: su evidencia de curaduría sigue valiendo, y lo que se descarta es el
 * registro (a menudo una prueba). Si tenía una conversación de WhatsApp que ya había guardado la
 * ficha, se le quita esa marca para que el agente no le diga que sigue registrado. Todo en una
 * transacción, con rastro en `audit_log`. Devuelve `false` si no estaba en preregistrados.
 */
export async function removePreregistration(providerId: string): Promise<boolean> {
  if (!pool || !UUID_PATTERN.test(providerId)) return false;
  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    const reverted = await client.query(
      `UPDATE marketplace.providers SET status = 'candidate', updated_at = now()
       WHERE provider_id = $1 AND status = 'unconfirmed'
       RETURNING provider_id`,
      [providerId],
    );
    if (!reverted.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    const deleted = await client.query('DELETE FROM marketplace.registration_submissions WHERE provider_id = $1', [providerId]);
    await client.query(
      // También se retira la autorización: con ella en el borrador, el siguiente mensaje volvería a
      // guardar la ficha sin volver a pedirla.
      `UPDATE marketplace.whatsapp_conversations
       SET state = jsonb_set(state - 'submissionId' - 'consent', '{draft,privacy_consent}', 'false'::jsonb, true),
           updated_at = now()
       WHERE provider_id = $1`,
      [providerId],
    );
    await client.query(
      `INSERT INTO marketplace.audit_log (actor_id, action, entity_type, entity_id, before_state, after_state, metadata)
       VALUES ('panel', 'provider.preregistration_removed', 'provider', $1, '{"status":"unconfirmed"}'::jsonb, '{"status":"candidate"}'::jsonb, $2::jsonb)`,
      [providerId, JSON.stringify({ submissions_deleted: deleted.rowCount ?? 0 })],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    if (began) { try { await client.query('ROLLBACK'); } catch { /* la conexión ya no sirve */ } }
    throw error;
  } finally {
    client.release();
  }
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

/**
 * Los proveedores a los que se va a escribir, buscados por id.
 *
 * Los datos salen de la base y no del navegador: quien llama elige A QUIÉN se escribe, nunca QUÉ se
 * le escribe ni a qué teléfono.
 */
export async function getOutreachSeeds(ids: string[]) {
  const valid = ids.filter((id) => UUID_PATTERN.test(id));
  if (!pool || !valid.length) return [];
  const result = await query<{
    provider_id: string; display_name: string; city: string | null; category: string | null;
    additional_categories: string[] | null; phone: string | null; contact_email: string | null; whatsapp_status: WhatsappStatus | null;
  }>(`
    SELECT p.provider_id, p.display_name, p.city, p.category, p.additional_categories, p.phone, c.email AS contact_email, p.whatsapp_status
    FROM marketplace.providers p
    LEFT JOIN LATERAL (
      SELECT email FROM marketplace.contacts WHERE provider_id = p.provider_id ORDER BY created_at DESC LIMIT 1
    ) c ON true
    WHERE p.provider_id = ANY($1::uuid[])
  `, [valid]);
  // En el orden en que se pidieron: "los primeros 10" del panel tienen que ser esos 10.
  const byId = new Map(result.rows.map((row) => [row.provider_id, row]));
  return valid.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
}

/**
 * Guarda el estado de contacto por WhatsApp de un proveedor, con rastro en `audit_log`.
 *
 * Solo escribe si el estado o el motivo cambian. `sent` marca además cuándo salió la invitación,
 * que es lo que cuenta para el cupo diario.
 */
export async function setProviderWhatsappStatus(
  providerId: string,
  change: { status: WhatsappStatus | null; reason: string | null },
  meta: { sent?: boolean; channel: string; handle?: string; test?: boolean },
): Promise<void> {
  if (!pool || !UUID_PATTERN.test(providerId)) return;
  const updated = await query<{ provider_id: string }>(
    `UPDATE marketplace.providers
     SET whatsapp_status = $2, whatsapp_status_reason = $3, whatsapp_status_at = now(),
         whatsapp_sent_at = CASE WHEN $4 THEN now() ELSE whatsapp_sent_at END
     WHERE provider_id = $1
       AND (whatsapp_status IS DISTINCT FROM $2 OR whatsapp_status_reason IS DISTINCT FROM $3 OR $4)
     RETURNING provider_id`,
    [providerId, change.status, change.reason, meta.sent === true],
  );
  if (!updated.rowCount) return;
  await query(
    `INSERT INTO marketplace.audit_log (actor_id, action, entity_type, entity_id, after_state, metadata)
     VALUES ($1, 'whatsapp.status_changed', 'provider', $2, $3::jsonb, $4::jsonb)`,
    [
      `${meta.channel}-bot`,
      providerId,
      JSON.stringify({ whatsapp_status: change.status, reason: change.reason }),
      JSON.stringify({ handle: meta.handle ?? null, test: meta.test === true }),
    ],
  );
}

export type ProviderConversation = {
  waId: string | null;
  status: WhatsappStatus | null;
  statusAt: string | null;
  statusReason: string | null;
  /** La conversación salió de una simulación del panel o del modo prueba. */
  esPrueba: boolean;
  messages: Array<{ direction: 'in' | 'out'; body: string; at: string }>;
};

/**
 * Lo que se habló con un proveedor por WhatsApp, en orden.
 *
 * El hilo se guarda por número (`whatsapp_messages`), y la conversación es quien lo ata al
 * proveedor. Devuelve `null` solo si el proveedor no existe: sin conversación, la lista va vacía y
 * la ficha lo dice.
 */
export async function getProviderConversation(providerId: string): Promise<ProviderConversation | null> {
  if (!pool || !UUID_PATTERN.test(providerId)) return null;

  const provider = await query<{
    whatsapp_status: WhatsappStatus | null; whatsapp_status_at: string | null; whatsapp_status_reason: string | null;
  }>(`
    SELECT whatsapp_status, to_char(whatsapp_status_at, 'DD Mon, HH24:MI') AS whatsapp_status_at, whatsapp_status_reason
    FROM marketplace.providers WHERE provider_id = $1
  `, [providerId]);
  if (!provider.rowCount) return null;

  const conversation = await query<{ wa_id: string; es_prueba: boolean }>(`
    SELECT wa_id, COALESCE((state ? 'simulation') OR (state ? 'testRedirect'), false) AS es_prueba
    FROM marketplace.whatsapp_conversations
    WHERE provider_id = $1
    ORDER BY updated_at DESC
    LIMIT 1
  `, [providerId]);

  const row = provider.rows[0];
  const base = {
    status: row.whatsapp_status,
    statusAt: row.whatsapp_status_at,
    statusReason: row.whatsapp_status_reason,
  };
  if (!conversation.rowCount) return { ...base, waId: null, esPrueba: false, messages: [] };

  const messages = await query<{ direction: 'in' | 'out'; body: string | null; at: string }>(`
    SELECT direction, body, to_char(occurred_at, 'DD Mon, HH24:MI') AS at
    FROM marketplace.whatsapp_messages
    WHERE wa_id = $1
    ORDER BY occurred_at
    LIMIT 200
  `, [conversation.rows[0].wa_id]);

  return {
    ...base,
    waId: conversation.rows[0].wa_id,
    esPrueba: conversation.rows[0].es_prueba,
    messages: messages.rows.filter((message) => message.body).map((message) => ({ ...message, body: message.body! })),
  };
}

/**
 * Cambia las categorías de un proveedor desde el panel.
 *
 * La principal define el ID de curaduría, el dedupe y el umbral de reputación, así que se puede
 * cambiar pero nunca queda vacía, y el total no pasa de cinco como en el formulario. Solo entran
 * categorías oficiales: una etiqueta libre rompería los cruces con el resto del sistema.
 */
export async function setProviderCategories(
  providerId: string,
  input: { category?: string; additionalCategories?: string[] },
): Promise<{ category: string; additional_categories: string[] } | null | 'INVALID'> {
  if (!pool || !UUID_PATTERN.test(providerId)) return null;

  const actual = await query<{ category: string; additional_categories: string[] | null }>(
    'SELECT category, additional_categories FROM marketplace.providers WHERE provider_id = $1',
    [providerId],
  );
  if (!actual.rowCount) return null;

  const principal = input.category?.trim() || actual.rows[0].category;
  if (!OFFICIAL_CATEGORIES.has(principal)) return 'INVALID';

  const adicionales = [...new Set(input.additionalCategories ?? actual.rows[0].additional_categories ?? [])]
    .map((category) => category.trim())
    .filter((category) => category && category !== principal);
  if (adicionales.some((category) => !OFFICIAL_CATEGORIES.has(category)) || adicionales.length > 4) return 'INVALID';

  const updated = await query<{ category: string; additional_categories: string[] }>(
    `UPDATE marketplace.providers SET category = $2, additional_categories = $3::text[], updated_at = now()
     WHERE provider_id = $1 RETURNING category, additional_categories`,
    [providerId, principal, adicionales],
  );
  await query(
    `INSERT INTO marketplace.audit_log (actor_id, action, entity_type, entity_id, before_state, after_state)
     VALUES ('panel', 'provider.categories_changed', 'provider', $1, $2::jsonb, $3::jsonb)`,
    [
      providerId,
      JSON.stringify({ category: actual.rows[0].category, additional_categories: actual.rows[0].additional_categories ?? [] }),
      JSON.stringify(updated.rows[0]),
    ],
  );
  return updated.rows[0];
}
