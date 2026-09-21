import { pool } from './db';
import type { RegistrationDraft } from './registration-chat';

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

function isComplete(draft: RegistrationDraft): boolean {
  return Boolean(
    draft.company_name && draft.full_name && draft.email
    && draft.services?.length && draft.products?.length
    && draft.volume_min !== undefined && draft.volume_max !== undefined
    && draft.privacy_consent === true,
  );
}

export async function saveConversationalRegistration(draft: RegistrationDraft, source: { channel: 'whatsapp' | 'chat-prueba'; handle: string; providerId?: string }): Promise<IntakeResult> {
  if (!pool) return { ok: false, reason: 'DATABASE_NOT_CONFIGURED' };
  if (!isComplete(draft)) return { ok: false, reason: 'INCOMPLETE_DRAFT' };

  // `idempotency_key` es UNIQUE: si el mismo número reenvía la misma ficha (por un reintento del
  // webhook o porque repite la conversación), la segunda no duplica nada.
  const idempotencyKey = `${source.channel}:${source.handle}:${draft.email}`;

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
               $11,'v1','chat-v1',$12,$13)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING submission_id`,
      [
        // La ficha queda atada al candidato cuando la conversación salió de uno: así el operador
        // ve la respuesta sobre el proveedor que ya tenía, en vez de como un registro suelto.
        source.providerId ?? null,
        draft.full_name, draft.email, draft.phone ?? source.handle, draft.company_name,
        draft.products, draft.services, draft.volume_min, draft.volume_max,
        draft.marketing_consent === true,
        source.channel === 'whatsapp' ? 'whatsapp-bot' : 'chat-prueba',
        idempotencyKey,
        JSON.stringify({ description: draft.description ?? null, channel: source.channel, handle: source.handle }),
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
    let providerPromoted = false;
    if (source.providerId) {
      const promoted = await client.query<{ provider_id: string }>(
        `UPDATE marketplace.providers SET status = 'unconfirmed', updated_at = now()
         WHERE provider_id = $1 AND status = 'candidate'
         RETURNING provider_id`,
        [source.providerId],
      );
      providerPromoted = promoted.rows.length > 0;

      await client.query(
        `INSERT INTO marketplace.audit_log (actor_id, action, entity_type, entity_id, after_state, metadata)
         VALUES ($1, 'provider.confirmed', 'provider', $2, $3::jsonb, $4::jsonb)`,
        [
          `${source.channel}-bot`,
          source.providerId,
          JSON.stringify({ status: providerPromoted ? 'unconfirmed' : null }),
          JSON.stringify({ submission_id: row.submission_id, channel: source.channel, handle: source.handle, status_changed: providerPromoted }),
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
