import type { APIRoute } from 'astro';
import { pool, query } from '../../../lib/db';
import { sendCampaign } from '../../../lib/campaigns';

export const GET: APIRoute = async () => {
  if (!pool) return new Response(JSON.stringify({ campaigns: [], contacts: [], connected: false }), { headers: { 'content-type': 'application/json' } });
  const [campaigns, contacts] = await Promise.all([
    query(`SELECT c.campaign_id, c.name, c.subject, c.status, c.sender_email, c.created_at, count(cs.send_id)::int AS recipients, count(cs.send_id) FILTER (WHERE cs.status = 'sent')::int AS sent, count(cs.send_id) FILTER (WHERE cs.status = 'failed')::int AS failed FROM marketplace.campaigns c LEFT JOIN marketplace.campaign_sends cs ON cs.campaign_id = c.campaign_id GROUP BY c.campaign_id ORDER BY c.created_at DESC LIMIT 30`),
    query(`SELECT c.contact_id, c.email, c.full_name, p.display_name FROM marketplace.contacts c LEFT JOIN marketplace.providers p ON p.provider_id = c.provider_id WHERE c.consent_status = 'granted' AND c.suppressed_at IS NULL ORDER BY COALESCE(p.display_name, c.email), c.email LIMIT 100`),
  ]);
  return new Response(JSON.stringify({ campaigns: campaigns.rows, contacts: contacts.rows, connected: true }), { headers: { 'content-type': 'application/json' } });
};

export const POST: APIRoute = async ({ request }) => {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    const payload: Record<string, unknown> = contentType.includes('application/json') ? await request.json() : Object.fromEntries((await request.formData()).entries());
    const contactIds = Array.isArray(payload.contact_ids) ? payload.contact_ids.map(String) : String(payload.contact_ids ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    const result = await sendCampaign({ name: String(payload.name ?? ''), subject: String(payload.subject ?? ''), bodyText: String(payload.body_text ?? ''), senderEmail: String(payload.sender_email ?? '') || undefined, replyToEmail: String(payload.reply_to_email ?? '') || undefined, contactIds, origin: new URL(request.url).origin, confirm: payload.confirm === true || payload.confirm === 'true' || payload.confirm === 'on' });
    return new Response(JSON.stringify({ ok: true, ...result }), { status: 201, headers: { 'content-type': 'application/json' } });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'CAMPAIGN_FAILED';
    const status = ['CONFIRMATION_REQUIRED', 'CAMPAIGN_FIELDS_REQUIRED', 'NO_CONTACTS_SELECTED', 'NO_ELIGIBLE_CONTACTS', 'TOO_MANY_CONTACTS', 'INVALID_CONTACT_IDS', 'OMNISEND_SENDER_EMAIL_INVALID', 'OMNISEND_REPLY_TO_EMAIL_INVALID'].includes(code) ? 400 : code === 'DATABASE_NOT_CONFIGURED' ? 503 : 500;
    return new Response(JSON.stringify({ ok: false, error: code }), { status, headers: { 'content-type': 'application/json' } });
  }
};
