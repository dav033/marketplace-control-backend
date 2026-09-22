import { pool } from './db';
import { OFFICIAL_CATEGORIES } from './registration-fields';
import type { RegistrationDraft } from './registration-chat';
import type { PoolClient } from 'pg';

/**
 * Guarda una ficha recogida por conversación, no por el formulario web.
 *
 * DIFERENCIA IMPORTANTE con `/api/public/form-submit`: aquel exige un token de `campaign_sends`,
 * porque nace de un enlace enviado por correo. Una conversación de WhatsApp no tiene ese token —
 * el proveedor escribe desde su teléfono, sin enlace de por medio. Por eso este camino guarda la
 * ficha sin `send_id` y marca su origen como `whatsapp-bot`.
 *
 * El proveedor pasa a `unconfirmed` ("preregistrado"): confirmó sus datos por conversación y espera
 * que un operador lo apruebe. Es el mismo estado al que lo lleva el formulario del correo, y no se
 * salta a `approved`, que sigue siendo una decisión humana.
 *
 * Lo que sí sigue sin hacerse en automático es crear un contacto con consentimiento de marketing.
 * El formulario del correo puede porque el token prueba que quien responde controla esa dirección;
 * un correo dictado por WhatsApp no prueba nada equivalente, y dar por bueno ese consentimiento es
 * exactamente el error que no se puede deshacer si luego llega una queja.
 */

export type IntakeResult =
  | { ok: true; submissionId: string; providerPromoted: boolean }
  | { ok: false; reason: 'DATABASE_NOT_CONFIGURED' | 'INCOMPLETE_DRAFT' | 'ALREADY_SUBMITTED' | 'WRITE_FAILED' };

/**
 * Lo mínimo para guardar una ficha que nace de una conversación libre: saber de qué negocio se
 * trata y tener su autorización. El resto (correo, productos, asistentes) lo completa una persona
 * del equipo si el proveedor no lo contó; el número de WhatsApp ya es un canal de contacto.
 */
function isComplete(draft: RegistrationDraft): boolean {
  return Boolean(draft.company_name && draft.privacy_consent === true);
}


/**
 * Las categorías que el propio proveedor dijo en la conversación entran en su ficha.
 *
 * La curaduría le puso una categoría (la de la búsqueda) y, si acaso, alguna deducida del nombre.
 * Pero quien mejor sabe qué hace es él: si cuenta que además pone la música y la decoración, esas
 * categorías tienen que quedar en el proveedor, no solo en el formulario que envió.
 *
 * La principal no se toca —define el ID, el dedupe y el umbral de reputación— y el total no pasa de
 * 5 categorías, como el formulario web.
 */
async function mergeProviderCategories(client: PoolClient, providerId: string, services: string[] | undefined): Promise<string[] | null> {
  const declaradas = (services ?? []).filter((service) => OFFICIAL_CATEGORIES.has(service));
  if (!declaradas.length) return null;

  const actual = await client.query<{ category: string; additional_categories: string[] | null }>(
    'SELECT category, additional_categories FROM marketplace.providers WHERE provider_id = $1',
    [providerId],
  );
  const fila = actual.rows[0];
  if (!fila) return null;

  const previas = fila.additional_categories ?? [];
  const nuevas = [...new Set([...previas, ...declaradas])].filter((category) => category !== fila.category).slice(0, 4);
  if (nuevas.length === previas.length && nuevas.every((category) => previas.includes(category))) return null;

  await client.query(
    'UPDATE marketplace.providers SET additional_categories = $2::text[], updated_at = now() WHERE provider_id = $1',
    [providerId, nuevas],
  );
  return nuevas;
}

export async function saveConversationalRegistration(
  draft: RegistrationDraft,
  source: { channel: 'whatsapp' | 'chat-prueba'; handle: string; providerId?: string; simulationId?: string },
): Promise<IntakeResult> {
  if (!pool) return { ok: false, reason: 'DATABASE_NOT_CONFIGURED' };
  if (!isComplete(draft)) return { ok: false, reason: 'INCOMPLETE_DRAFT' };

  // `idempotency_key` es UNIQUE: una ficha por número y candidato. Si el mismo número vuelve a
  // autorizar (un reintento del webhook, o la conversación repetida), la segunda no duplica nada.
  // Los cambios posteriores van por `updateConversationalRegistration`.
  // Cada simulación del panel es una prueba nueva, aunque se repita con el mismo proveedor.
  const idempotencyKey = `${source.channel}:${source.handle}:${source.providerId ?? 'sin-candidato'}`
    + (source.simulationId ? `:simulacion-${source.simulationId}` : '');
  const consentSource = source.simulationId
    ? 'whatsapp-simulacion'
    : source.channel === 'whatsapp' ? 'whatsapp-bot' : 'chat-prueba';

  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;

    const result = await client.query<{ submission_id: string }>(
      `INSERT INTO marketplace.registration_submissions
         (provider_id, full_name, email, phone, company_name, products, services, volume_min, volume_max,
          privacy_consent, privacy_consent_at, marketing_consent, marketing_consent_at,
          consent_source, consent_text_version, form_version, idempotency_key, form_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,now(),$10,CASE WHEN $10 THEN now() ELSE NULL END,
               $11,'chat-v3','chat-agent-v1',$12,$13)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING submission_id`,
      [
        // La ficha queda atada al candidato cuando la conversación salió de uno: así el operador
        // ve la respuesta sobre el proveedor que ya tenía, en vez de como un registro suelto.
        source.providerId ?? null,
        draft.full_name ?? null, draft.email ?? null, draft.phone ?? source.handle, draft.company_name,
        draft.products ?? [], draft.services ?? [], draft.volume_min ?? null, draft.volume_max ?? null,
        draft.marketing_consent === true,
        consentSource,
        idempotencyKey,
        JSON.stringify({
          description: draft.description ?? null,
          channel: source.channel,
          handle: source.handle,
          ...(source.simulationId ? { simulacion: true } : {}),
        }),
      ],
    );

    const row = result.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'ALREADY_SUBMITTED' };
    }

    // El paso a `unconfirmed` solo aplica si la conversación salió de un candidato nuestro. El
    // guardia por `status = 'candidate'` evita que un registro tardío haga retroceder una ficha que
    // ya pasó por revisión humana, igual que en el formulario del correo.
    // El proveedor pasa a "registrado" también cuando la ficha vino de una prueba o una simulación:
    // el recorrido tiene que verse entero (Proveedores → Preregistrados) mientras se prueba. La ficha
    // queda marcada por su `consent_source`, y desde Preregistrados se puede quitar en un clic.
    let providerPromoted = false;
    if (source.providerId) {
      const promoted = await client.query<{ provider_id: string }>(
        `UPDATE marketplace.providers SET status = 'unconfirmed', updated_at = now()
         WHERE provider_id = $1 AND status = 'candidate'
         RETURNING provider_id`,
        [source.providerId],
      );
      providerPromoted = promoted.rows.length > 0;

      const categorias = await mergeProviderCategories(client, source.providerId, draft.services);
      await client.query(
        `INSERT INTO marketplace.audit_log (actor_id, action, entity_type, entity_id, after_state, metadata)
         VALUES ($1, 'provider.confirmed', 'provider', $2, $3::jsonb, $4::jsonb)`,
        [
          `${source.channel}-bot`,
          source.providerId,
          JSON.stringify({ status: providerPromoted ? 'unconfirmed' : null, ...(categorias ? { additional_categories: categorias } : {}) }),
          JSON.stringify({ submission_id: row.submission_id, channel: source.channel, handle: source.handle, status_changed: providerPromoted, test: Boolean(source.simulationId) }),
        ],
      );
    }

    await client.query('COMMIT');
    return { ok: true, submissionId: row.submission_id, providerPromoted };
  } catch (error) {
    // Sin este rollback la conexión vuelve al pool con la transacción abierta y contamina la
    // siguiente petición que la tome; es el mismo fallo que ya documenta el formulario del correo.
    if (began) { try { await client.query('ROLLBACK'); } catch { /* la conexión ya no sirve */ } }
    console.error('conversational registration write failed', error instanceof Error ? error.message : error);
    return { ok: false, reason: 'WRITE_FAILED' };
  } finally {
    client.release();
  }
}

/**
 * Aplica a una ficha ya guardada lo que el proveedor cambió después, en el seguimiento.
 *
 * Solo se reescribe mientras nadie la ha resuelto (`new` o `reviewing`): una ficha aprobada o
 * rechazada es una decisión humana y el agente no la toca. En ese caso el cambio queda solo en el
 * registro de auditoría para que el equipo lo vea. Siempre se deja el antes y el después.
 */
export async function updateConversationalRegistration(
  submissionId: string,
  before: RegistrationDraft,
  after: RegistrationDraft,
  source: { channel: 'whatsapp' | 'chat-prueba'; handle: string },
): Promise<boolean> {
  if (!pool) return false;
  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;

    const updated = await client.query<{ submission_id: string }>(
      `UPDATE marketplace.registration_submissions
       SET full_name = $2, email = $3, phone = COALESCE($4, phone), company_name = $5,
           products = $6, services = $7, volume_min = $8, volume_max = $9,
           form_payload = form_payload || jsonb_build_object('description', $10::text),
           updated_at = now()
       WHERE submission_id = $1 AND submission_status IN ('new', 'reviewing')
       RETURNING submission_id`,
      [
        submissionId,
        after.full_name ?? null, after.email ?? null, after.phone ?? null, after.company_name ?? null,
        after.products ?? [], after.services ?? [], after.volume_min ?? null, after.volume_max ?? null,
        after.description ?? null,
      ],
    );

    await client.query(
      `INSERT INTO marketplace.audit_log (actor_id, action, entity_type, entity_id, before_state, after_state, metadata)
       VALUES ($1, $2, 'registration_submission', $3, $4::jsonb, $5::jsonb, $6::jsonb)`,
      [
        `${source.channel}-bot`,
        updated.rows.length ? 'registration.updated_by_provider' : 'registration.change_requested',
        submissionId,
        JSON.stringify(before),
        JSON.stringify(after),
        JSON.stringify({ channel: source.channel, handle: source.handle }),
      ],
    );

    await client.query('COMMIT');
    return true;
  } catch (error) {
    if (began) { try { await client.query('ROLLBACK'); } catch { /* la conexión ya no sirve */ } }
    console.error('conversational registration update failed', error instanceof Error ? error.message : error);
    return false;
  } finally {
    client.release();
  }
}
