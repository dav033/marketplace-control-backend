import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { pool, query } from '../../../lib/db';
import { hashToken } from '../../../lib/tracking';

function hash(value: string) { return createHash('sha256').update(value).digest(); }

const MAX_PRODUCTS = 10;
const MAX_SERVICES = 5;

/** Las 10 categorías oficiales de curaduría; nada fuera de esta lista entra como servicio. */
export const OFFICIAL_CATEGORIES = new Set([
  'Lugar', 'Comida y Bebida', 'Música', 'Servicios Especializados', 'Entretenimiento',
  'Decoración temática', 'Fotografía y Video', 'Invitación digital', 'Menaje y mantelería', 'Carpas y mobiliario',
]);

/**
 * El formulario manda productos y servicios como JSON dentro de un campo oculto. Se sanea aquí y no
 * se confía en los límites del navegador: el envío puede venir de cualquier cliente.
 */
export function parseList(raw: string, max: number, allowed?: Set<string>): string[] | undefined {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(parsed)) return undefined;
  const clean: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') return undefined;
    const value = entry.replace(/\s+/g, ' ').trim();
    if (!value || value.length > 60) return undefined;
    if (allowed && !allowed.has(value)) return undefined;
    if (!clean.includes(value)) clean.push(value);
  }
  return clean.length > max ? undefined : clean;
}

export function parseVolume(rawMin: string, rawMax: string): { min: number; max: number } | undefined {
  const min = Number(rawMin);
  const max = Number(rawMax);
  if (!Number.isInteger(min) || !Number.isInteger(max)) return undefined;
  if (min < 1 || max < min || max > 100000) return undefined;
  return { min, max };
}

export const POST: APIRoute = async ({ request, redirect }) => {
  // `formData()` lanza cuando el content-type no es de formulario. Fuera del try devolvía un 500 sin
  // manejar en un endpoint público, así que el parseo entra en el guardado de errores.
  let body: FormData;
  try {
    body = await request.formData();
  } catch {
    return new Response('Formato de envío no válido.', { status: 400 });
  }

  const token = String(body.get('token') ?? '');
  const email = String(body.get('email') ?? '').trim().toLowerCase();
  const privacy = body.get('privacy_consent') === 'true';
  if (!token || !email || !privacy || !email.includes('@')) return new Response('Datos incompletos o inválidos.', { status: 400 });

  if (pool) {
    try {
      const tokenHash = hashToken(token);
      const send = await query<{ provider_id: string | null; token_expires_at: Date | null; form_submitted_at: Date | null }>(
        `SELECT provider_id, token_expires_at, form_submitted_at
         FROM marketplace.campaign_sends
         WHERE tracking_token_hash = $1 AND status NOT IN ('suppressed','opted_out')
         LIMIT 1`,
        [tokenHash],
      );
      const sendRow = send.rows[0];
      if (!sendRow) return new Response('Enlace inválido o vencido.', { status: 404 });
      // Envío único: una segunda entrega ya no sobrescribe la primera.
      if (sendRow.form_submitted_at) return new Response('Este formulario ya fue enviado.', { status: 409 });
      // `token_expires_at` nulo es un envío anterior a la migración y se considera vigente.
      if (sendRow.token_expires_at && sendRow.token_expires_at.getTime() < Date.now()) {
        return new Response('Este enlace ya caducó.', { status: 410 });
      }

      const fullName = String(body.get('full_name') ?? '').trim();
      const phone = String(body.get('phone') ?? '').trim() || null;
      const companyName = String(body.get('company_name') ?? '').trim();
      const description = String(body.get('description') ?? '').trim();
      if (fullName.length < 2 || companyName.length < 2 || fullName.length > 160 || companyName.length > 200 || description.length > 4000) {
        return new Response('Datos incompletos o demasiado largos.', { status: 400 });
      }

      const products = parseList(String(body.get('products') ?? ''), MAX_PRODUCTS);
      const services = parseList(String(body.get('services') ?? ''), MAX_SERVICES, OFFICIAL_CATEGORIES);
      const volume = parseVolume(String(body.get('volume_min') ?? ''), String(body.get('volume_max') ?? ''));
      if (!products || !products.length) return new Response(`Indica entre 1 y ${MAX_PRODUCTS} productos.`, { status: 400 });
      if (!services || !services.length) return new Response(`Marca entre 1 y ${MAX_SERVICES} categorías oficiales.`, { status: 400 });
      if (!volume) return new Response('El rango de asistentes no es válido.', { status: 400 });

      const marketingConsent = body.get('marketing_consent') === 'true';
      await query(
        `INSERT INTO marketplace.registration_submissions
           (provider_id, full_name, email, phone, company_name, products, services, volume_min, volume_max,
            privacy_consent, privacy_consent_at, marketing_consent, marketing_consent_at, consent_source,
            consent_text_version, consent_user_agent_hash, form_version, idempotency_key, form_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,now(),$10,CASE WHEN $10 THEN now() ELSE NULL END,'email-link','v1',$11,'v2',$12,$13)`,
        [
          sendRow.provider_id, fullName, email, phone, companyName,
          products, services, volume.min, volume.max,
          marketingConsent, hash(request.headers.get('user-agent') ?? ''),
          `${tokenHash}:${email}`, JSON.stringify({ description }),
        ],
      );

      // Marca el envío para que el enlace no vuelva a mostrar el formulario.
      await query(
        `UPDATE marketplace.campaign_sends SET form_submitted_at = now(), updated_at = now() WHERE tracking_token_hash = $1`,
        [tokenHash],
      );

      if (marketingConsent) {
        await query(
          `INSERT INTO marketplace.contacts (provider_id, full_name, email, phone, consent_status, consent_at, consent_source, consent_text_version)
           VALUES ($1,$2,$3,$4,'granted',now(),'registration-form','v1')
           ON CONFLICT (lower(email)) DO UPDATE SET
             provider_id = COALESCE(EXCLUDED.provider_id, marketplace.contacts.provider_id),
             full_name = COALESCE(EXCLUDED.full_name, marketplace.contacts.full_name),
             phone = COALESCE(EXCLUDED.phone, marketplace.contacts.phone),
             consent_status = 'granted', consent_at = now(), consent_source = 'registration-form',
             consent_text_version = 'v1', suppressed_at = NULL, updated_at = now()`,
          [sendRow.provider_id ?? null, fullName, email, phone],
        );
      }
    } catch (error) {
      // Una clave de idempotencia repetida es el mismo envío llegando dos veces, no un fallo.
      const code = (error as { code?: string })?.code;
      if (code === '23505') return new Response('Este formulario ya fue enviado.', { status: 409 });
      console.error('Registration submission failed', error instanceof Error ? error.message : error);
      return new Response('No pudimos guardar tus datos. Intenta de nuevo.', { status: 503 });
    }
  }
  return redirect(`/registro/${encodeURIComponent(token)}?sent=1`, 303);
};
