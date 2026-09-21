import { randomBytes } from 'node:crypto';
import { pool, query } from './db';
import { hashToken } from './tracking';
import { createEmailCampaignDraft, createTagSegment, importEmailTemplate, sendEmailCampaign, upsertConsentedContact, waitForSegmentReady } from './omnisend';

type Recipient = { contact_id: string; provider_id: string | null; email: string; full_name: string | null; display_name: string | null };

const env = (name: string) => import.meta.env[name as keyof ImportMetaEnv] ?? process.env[name];
const escapeHtml = (value: string) => value.replace(/[&<>\"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[character] ?? character);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requiredEmail(value: string, label: string) {
  const email = value.trim().toLowerCase();
  if (!emailPattern.test(email) || email.length > 320) throw new Error(`${label}_INVALID`);
  return email;
}

/**
 * Traduce los placeholders propios de la app ({{nombre}}, {{enlace_registro}}) a merge tags reales de
 * Omnisend ([[ ]]), que Omnisend resuelve por contacto en el envío real a la audiencia — no antes.
 * `registration_url` es distinto por destinatario y Omnisend no lo conoce de forma nativa, así que se
 * sube como customProperty en `upsertConsentedContact` antes de crear la campaña.
 */
function toOmnisendHtml(bodyText: string): string {
  const text = bodyText
    .replaceAll('{{nombre}}', "[[ contact.first_name | default: 'equipo' ]]")
    .replaceAll('{{enlace_registro}}', '[[ contact.custom_properties.registration_url ]]')
    .replaceAll('{{registro_url}}', '[[ contact.custom_properties.registration_url ]]');
  return `<div style="white-space:pre-line;font-family:Arial,sans-serif;font-size:16px;line-height:1.55;color:#202124">${escapeHtml(text)}</div><hr><p style="font-size:12px;color:#666"><a href="[[ unsubscribe_link ]]">Cancelar suscripción</a> · <a href="[[ preference_link ]]">Preferencias</a></p>`;
}

export async function sendCampaign(input: { name: string; subject: string; bodyText: string; senderEmail?: string; replyToEmail?: string; contactIds: string[]; origin: string; confirm: boolean }) {
  if (!pool) throw new Error('DATABASE_NOT_CONFIGURED');
  if (!input.confirm) throw new Error('CONFIRMATION_REQUIRED');
  if (!input.name.trim() || !input.subject.trim() || !input.bodyText.trim()) throw new Error('CAMPAIGN_FIELDS_REQUIRED');
  if (!input.contactIds.length) throw new Error('NO_CONTACTS_SELECTED');
  if (input.contactIds.length > 100) throw new Error('TOO_MANY_CONTACTS');
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const contactIds = [...new Set(input.contactIds)];
  if (contactIds.length !== input.contactIds.length || contactIds.some((contactId) => !uuidPattern.test(contactId))) throw new Error('INVALID_CONTACT_IDS');

  const sender = requiredEmail(input.senderEmail || env('OMNISEND_SENDER_EMAIL') || '', 'OMNISEND_SENDER_EMAIL');
  const senderName = env('OMNISEND_SENDER_NAME') || 'Happia';
  const configuredReplyTo = env('OMNISEND_REPLY_TO_EMAIL');
  const replyTo = input.replyToEmail ? requiredEmail(input.replyToEmail, 'OMNISEND_REPLY_TO_EMAIL') : configuredReplyTo ? requiredEmail(String(configuredReplyTo), 'OMNISEND_REPLY_TO_EMAIL') : undefined;
  const baseUrl = (env('APP_URL') || input.origin).replace(/\/$/, '');
  // Vigencia del enlace de registro. Sin esto los enlaces repartidos por correo no caducan
  // nunca, que es como estaba antes de la fase 2.
  const tokenTtlDays = (() => {
    const configured = Number(env('REGISTRATION_TOKEN_TTL_DAYS'));
    return Number.isFinite(configured) && configured >= 1 && configured <= 365 ? Math.trunc(configured) : 30;
  })();
  const client = await pool.connect();
  const queued: Array<Recipient & { send_id: string; token: string }> = [];
  let campaignId = '';

  try {
    await client.query('BEGIN');
    const recipients = await client.query<Recipient>(`SELECT c.contact_id, c.provider_id, c.email, c.full_name, p.display_name FROM marketplace.contacts c LEFT JOIN marketplace.providers p ON p.provider_id = c.provider_id WHERE c.contact_id = ANY($1::uuid[]) AND c.consent_status = 'granted' AND c.suppressed_at IS NULL ORDER BY c.email`, [contactIds]);
    if (!recipients.rows.length) throw new Error('NO_ELIGIBLE_CONTACTS');
    const campaign = await client.query<{ campaign_id: string }>(`INSERT INTO marketplace.campaigns (name, campaign_type, status, subject, body_text, sender_email, reply_to_email, created_by) VALUES ($1,'marketing','sending',$2,$3,$4,$5,'operator') RETURNING campaign_id`, [input.name.trim(), input.subject.trim(), input.bodyText.trim(), sender, replyTo ?? null]);
    campaignId = campaign.rows[0].campaign_id;
    for (const recipient of recipients.rows) {
      const token = randomBytes(32).toString('hex');
      const inserted = await client.query<{ send_id: string }>(`INSERT INTO marketplace.campaign_sends (campaign_id, contact_id, provider_id, status, tracking_token_hash, token_expires_at) VALUES ($1,$2,$3,'sending',$4, now() + ($5 || ' days')::interval) ON CONFLICT (campaign_id, contact_id) DO NOTHING RETURNING send_id`, [campaignId, recipient.contact_id, recipient.provider_id, hashToken(token), String(tokenTtlDays)]);
      if (inserted.rows[0]) queued.push({ ...recipient, send_id: inserted.rows[0].send_id, token });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    client.release();
    throw error;
  }
  client.release();
  if (!queued.length) throw new Error('NO_ELIGIBLE_CONTACTS');

  // A partir de aquí el lote es atómico: un segmento y una campaña real de Omnisend para todo el
  // lote, no una por destinatario. Un fallo en cualquier paso marca el lote completo como fallido en
  // vez de dejarlo a medias, porque ya no hay una unidad de envío por destinatario que aislar.
  try {
    const sendTag = `send-${campaignId}`;
    // POST /contacts es síncrono (no 202): al terminar Promise.all, el tag ya quedó aplicado.
    await Promise.all(queued.map((recipient) => upsertConsentedContact({
      consentGranted: true,
      email: recipient.email,
      firstName: recipient.full_name || recipient.display_name || undefined,
      customProperties: { registration_url: `${baseUrl}/t/${recipient.token}` },
      tags: [sendTag],
    })));

    const segment = await createTagSegment({ name: `Envío · ${input.name}`.slice(0, 256), tag: sendTag });
    // El segmento nace en "building"; hay que esperar a "ready" o la campaña podría lanzarse a una
    // audiencia vacía o incompleta.
    await waitForSegmentReady(segment.segmentID);

    const template = await importEmailTemplate({ name: input.name.slice(0, 250), html: `<html><body>${toOmnisendHtml(input.bodyText)}</body></html>` });
    const templateId = typeof template.id === 'string' ? template.id : typeof template.templateID === 'string' ? template.templateID : '';
    if (!templateId) throw new Error('OMNISEND_TEMPLATE_ID_MISSING');

    const draft = await createEmailCampaignDraft({ name: input.name.slice(0, 250), subject: input.subject.trim(), senderName, senderEmail: sender, templateId, segmentIds: [segment.segmentID] });
    const omnisendCampaignId = typeof draft.id === 'string' ? draft.id : '';
    if (!omnisendCampaignId) throw new Error('OMNISEND_CAMPAIGN_ID_MISSING');

    await sendEmailCampaign(omnisendCampaignId);

    await query(`UPDATE marketplace.campaign_sends SET status = 'sent', provider_message_id = $1, sent_at = now(), last_event_at = now(), updated_at = now() WHERE campaign_id = $2`, [omnisendCampaignId, campaignId]);
    await query(`UPDATE marketplace.campaigns SET status = 'completed', completed_at = now(), updated_at = now() WHERE campaign_id = $1`, [campaignId]);
    return { campaignId, omnisendCampaignId, attempted: queued.length, sent: queued.length, failed: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'OMNISEND_SEND_FAILED';
    await query(`UPDATE marketplace.campaign_sends SET status = 'failed', error_message = $1, last_event_at = now(), updated_at = now() WHERE campaign_id = $2`, [message, campaignId]);
    await query(`UPDATE marketplace.campaigns SET status = 'cancelled', updated_at = now() WHERE campaign_id = $1`, [campaignId]);
    throw error instanceof Error ? error : new Error(message);
  }
}
