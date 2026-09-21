import type { APIRoute } from 'astro';
import { createEmailCampaignDraft, importEmailTemplate, isOmnisendConfigured, QA_TEST_RECIPIENTS, sendEmailCampaignTest } from '../../../lib/omnisend';

const env = (name: string) => import.meta.env[name as keyof ImportMetaEnv] ?? process.env[name];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const escapeHtml = (value: string) => value.replace(/[&<>\"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[character] ?? character);

function requiredEmail(value: string, label: string) {
  const email = value.trim().toLowerCase();
  if (!emailPattern.test(email) || email.length > 320) throw new Error(`${label}_INVALID`);
  return email;
}

function renderQaBody(bodyText: string, origin: string) {
  // `/registro/*` lo sirve el frontend desde la separación, no este backend: a diferencia de
  // `/t/:token` (que campaigns.ts sí arma con APP_URL porque esa ruta sigue siendo del backend),
  // este enlace tiene que resolver contra FRONTEND_URL o el correo de prueba apunta a un 404.
  const qaRegistrationUrl = `${(env('FRONTEND_URL') || env('APP_URL') || origin).replace(/\/$/, '')}/registro/qa-prueba`;
  const text = bodyText
    .replaceAll('{{nombre}}', 'David')
    .replaceAll('{{enlace_registro}}', qaRegistrationUrl)
    .replaceAll('{{registro_url}}', qaRegistrationUrl);
  return {
    // [[unsubscribe_link]]/[[preference_link]] son merge tags de Omnisend: solo se resuelven en un
    // envío real a una audiencia, no en test-email. Aquí llegarían literales, así que se omiten.
    html: `<div style="white-space:pre-line;font-family:Arial,sans-serif;font-size:16px;line-height:1.55;color:#202124">${escapeHtml(text)}</div><p><a href="${qaRegistrationUrl}">Abrir enlace de prueba</a></p><hr><p style="font-size:12px;color:#666">Correo de prueba QA — no es un envío real a un contacto suscrito.</p>`,
  };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    if (!isOmnisendConfigured()) throw new Error('OMNISEND_NOT_CONFIGURED');
    const contentType = request.headers.get('content-type') ?? '';
    const payload: Record<string, unknown> = contentType.includes('application/json') ? await request.json() : Object.fromEntries((await request.formData()).entries());
    if (!(payload.confirm === true || payload.confirm === 'true' || payload.confirm === 'on')) throw new Error('CONFIRMATION_REQUIRED');

    const name = String(payload.name ?? '').trim();
    const subject = String(payload.subject ?? '').trim();
    const bodyText = String(payload.body_text ?? '').trim();
    if (!name || !subject || !bodyText) throw new Error('CAMPAIGN_FIELDS_REQUIRED');
    const senderEmail = requiredEmail(String(payload.sender_email ?? env('OMNISEND_SENDER_EMAIL') ?? ''), 'OMNISEND_SENDER_EMAIL');
    const template = await importEmailTemplate({ name: `QA · ${name}`.slice(0, 250), html: `<html><body>${renderQaBody(bodyText, new URL(request.url).origin).html}</body></html>` });
    const templateId = typeof template.id === 'string' ? template.id : typeof template.templateID === 'string' ? template.templateID : '';
    if (!templateId) throw new Error('OMNISEND_TEMPLATE_ID_MISSING');
    const campaign = await createEmailCampaignDraft({
      name: `QA · ${name}`.slice(0, 250),
      subject,
      senderName: env('OMNISEND_SENDER_NAME') || 'Happia',
      senderEmail,
      templateId,
    });
    const campaignId = typeof campaign.id === 'string' ? campaign.id : '';
    if (!campaignId) throw new Error('OMNISEND_CAMPAIGN_ID_MISSING');
    await sendEmailCampaignTest(campaignId, QA_TEST_RECIPIENTS);
    return new Response(JSON.stringify({ ok: true, recipients: QA_TEST_RECIPIENTS, campaignId }), { status: 201, headers: { 'content-type': 'application/json' } });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'QA_TEST_FAILED';
    const status = ['CONFIRMATION_REQUIRED', 'CAMPAIGN_FIELDS_REQUIRED', 'OMNISEND_SENDER_EMAIL_INVALID', 'OMNISEND_TEST_RECIPIENTS_INVALID'].includes(code) ? 400 : code === 'OMNISEND_NOT_CONFIGURED' ? 503 : 500;
    return new Response(JSON.stringify({ ok: false, error: code }), { status, headers: { 'content-type': 'application/json' } });
  }
};
