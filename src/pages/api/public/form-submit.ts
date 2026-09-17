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
      const send = await query<{ provider_id: string | null }>(`SELECT provider_id FROM marketplace.campaign_sends WHERE tracking_token_hash = $1 LIMIT 1`, [hashToken(token)]);
      await query(`INSERT INTO marketplace.registration_submissions (provider_id, full_name, email, phone, company_name, privacy_consent, privacy_consent_at, marketing_consent, marketing_consent_at, consent_source, consent_text_version, consent_user_agent_hash, form_version, idempotency_key, form_payload) VALUES ($1,$2,$3,$4,$5,true,now(),$6,CASE WHEN $6 THEN now() ELSE NULL END,'email-link','v1',$7,'v1',$8,$9) ON CONFLICT (idempotency_key) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, company_name = EXCLUDED.company_name, form_payload = EXCLUDED.form_payload, updated_at = now()`, [send.rows[0]?.provider_id ?? null, String(body.get('full_name') ?? '').trim(), email, String(body.get('phone') ?? '').trim() || null, String(body.get('company_name') ?? '').trim(), body.get('marketing_consent') === 'true', hash(request.headers.get('user-agent') ?? ''), `${hashToken(token)}:${email}`, JSON.stringify({ description: String(body.get('description') ?? '').trim() })]);
    } catch (error) {
      console.error('Registration submission failed', error instanceof Error ? error.message : error);
      return new Response('No pudimos guardar tus datos. Intenta de nuevo.', { status: 503 });
    }
  }
  return redirect(`/registro/${encodeURIComponent(token)}?sent=1`, 303);
};
