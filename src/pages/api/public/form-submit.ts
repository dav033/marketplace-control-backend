import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { pool, query } from '../../../lib/db';
import { hashToken } from '../../../lib/tracking';

function hash(value: string) { return createHash('sha256').update(value).digest(); }

export const POST: APIRoute = async ({ request, redirect }) => {
  const body = await request.formData();
  const token = String(body.get('token') ?? '');
  const email = String(body.get('email') ?? '').trim().toLowerCase();
  const privacy = body.get('privacy_consent') === 'true';
  if (!token || !email || !privacy || !email.includes('@')) return new Response('Datos incompletos o inválidos.', { status: 400 });

  if (pool) {
    try {
      const send = await query<{ provider_id: string | null }>(`SELECT provider_id FROM marketplace.campaign_sends WHERE tracking_token_hash = $1 AND status NOT IN ('suppressed','opted_out') LIMIT 1`, [hashToken(token)]);
      if (!send.rows[0]) return new Response('Enlace inválido o vencido.', { status: 404 });
      const fullName = String(body.get('full_name') ?? '').trim();
      const phone = String(body.get('phone') ?? '').trim() || null;
      const companyName = String(body.get('company_name') ?? '').trim();
      const description = String(body.get('description') ?? '').trim();
      if (fullName.length < 2 || companyName.length < 2 || description.length < 10 || fullName.length > 160 || companyName.length > 200 || description.length > 4000) return new Response('Datos incompletos o demasiado largos.', { status: 400 });
      const marketingConsent = body.get('marketing_consent') === 'true';
      await query(`INSERT INTO marketplace.registration_submissions (provider_id, full_name, email, phone, company_name, privacy_consent, privacy_consent_at, marketing_consent, marketing_consent_at, consent_source, consent_text_version, consent_user_agent_hash, form_version, idempotency_key, form_payload) VALUES ($1,$2,$3,$4,$5,true,now(),$6,CASE WHEN $6 THEN now() ELSE NULL END,'email-link','v1',$7,'v1',$8,$9) ON CONFLICT (idempotency_key) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, company_name = EXCLUDED.company_name, marketing_consent = EXCLUDED.marketing_consent, marketing_consent_at = EXCLUDED.marketing_consent_at, updated_at = now()`, [send.rows[0].provider_id, fullName, email, phone, companyName, marketingConsent, hash(request.headers.get('user-agent') ?? ''), `${hashToken(token)}:${email}`, JSON.stringify({ description })]);
      if (marketingConsent) await query(`INSERT INTO marketplace.contacts (provider_id, full_name, email, phone, consent_status, consent_at, consent_source, consent_text_version) VALUES ($1,$2,$3,$4,'granted',now(),'registration-form','v1') ON CONFLICT (lower(email)) DO UPDATE SET provider_id = COALESCE(EXCLUDED.provider_id, marketplace.contacts.provider_id), full_name = COALESCE(EXCLUDED.full_name, marketplace.contacts.full_name), phone = COALESCE(EXCLUDED.phone, marketplace.contacts.phone), consent_status = 'granted', consent_at = now(), consent_source = 'registration-form', consent_text_version = 'v1', suppressed_at = NULL, updated_at = now()`, [send.rows[0]?.provider_id ?? null, fullName, email, phone]);
    } catch (error) {
      console.error('Registration submission failed', error instanceof Error ? error.message : error);
      return new Response('No pudimos guardar tus datos. Intenta de nuevo.', { status: 503 });
    }
  }
  return redirect(`/registro/${encodeURIComponent(token)}?sent=1`, 303);
};
