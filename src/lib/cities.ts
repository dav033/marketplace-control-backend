import { pool, query } from './db';
import { REGISTER_URL } from './registration-fields';
import { fillTemplate, getTemplateInfo, isWhatsappConfigured, resolveTestTarget, sendTemplate } from './whatsapp';
import { countOutreachToday, isSuppressed, recordOutboundMessage, startConversation } from './whatsapp-store';
import { dailyLimit, toWhatsappNumber } from './whatsapp-outreach';
import { stateFromProvider } from './conversation-runner';
import { setProviderWhatsappStatus } from './data';
import { applyStatusEvents } from './conversation-status';
import { createTagSegment, createEmailCampaignDraft, importEmailTemplate, isOmnisendConfigured, sendEmailCampaign, upsertConsentedContact, waitForSegmentReady } from './omnisend';
import type { SeedProvider } from './registration-chat';

/**
 * Ciudades del marketplace y el anuncio de apertura.
 *
 * Una ciudad cerrada es una en la que todavía no operamos. Al abrirla, a sus proveedores se les
 * anuncia que ya pueden registrarse. Abrir y anunciar están separados a propósito: abrir es un
 * cambio de estado reversible, anunciar manda mensajes reales que no se pueden retirar.
 *
 * Quién recibe: los proveedores de esa ciudad que no estén ya inscritos, rechazados ni archivados, y
 * a los que no se les haya anunciado ya esta ciudad (`city_announcements` tiene UNIQUE por ciudad y
 * proveedor). El canal sale de la ficha: correo si el proveedor es de correo corporativo con
 * consentimiento, WhatsApp si no.
 */

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

export type CityStatus = 'cerrada' | 'abierta';

export type City = {
  city_id: string;
  name: string;
  status: CityStatus;
  opened_at: string | null;
  announced_at: string | null;
  providers: number;
  elegibles: number;
  anunciados: number;
};

/** Por qué un proveedor de la ciudad no recibe el anuncio. */
export type SkipReason = 'ALREADY_ANNOUNCED' | 'ALREADY_REGISTERED' | 'REJECTED' | 'PHONE_MISSING' | 'EMAIL_MISSING' | 'EMAIL_NOT_CONSENTED';

type CandidateRow = {
  provider_id: string; display_name: string; city: string; category: string | null;
  additional_categories: string[] | null; phone: string | null; contact_channel: 'email' | 'whatsapp';
  status: string; whatsapp_status: string | null; rating: string | null; review_count: number | null;
  email: string | null; email_consented: boolean;
  full_name: string | null; announced: boolean;
};

export type AnnouncementTarget = { providerId: string; displayName: string; channel: 'whatsapp' | 'email'; phone?: string; email?: string; firstName?: string | null };

export type AnnouncementPlan = {
  city: { city_id: string; name: string; status: CityStatus };
  targets: AnnouncementTarget[];
  skipped: Array<{ providerId: string; displayName: string; reason: SkipReason }>;
};

export async function listCities(): Promise<City[]> {
  if (!pool) return [];
  // Los proveedores se cruzan por nombre de ciudad: es lo que escribe la curaduría, y una ciudad sin
  // fila propia todavía puede tener proveedores (el esquema siembra las que existen).
  const result = await query<City>(`
    SELECT c.city_id, c.name, c.status,
           to_char(c.opened_at, 'DD Mon YYYY, HH24:MI') AS opened_at,
           to_char(c.announced_at, 'DD Mon YYYY, HH24:MI') AS announced_at,
           COALESCE(p.total, 0) AS providers,
           COALESCE(p.elegibles, 0) AS elegibles,
           COALESCE(a.anunciados, 0) AS anunciados
    FROM marketplace.cities c
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS total,
             count(*) FILTER (
               WHERE p.status NOT IN ('unconfirmed', 'approved', 'rejected', 'archived')
                 AND (p.whatsapp_status IS NULL OR p.whatsapp_status NOT IN ('inscrito', 'rechazado', 'conversacion_rechazada'))
                 AND NOT EXISTS (SELECT 1 FROM marketplace.city_announcements ca WHERE ca.city_id = c.city_id AND ca.provider_id = p.provider_id)
             )::int AS elegibles
      FROM marketplace.providers p
      WHERE lower(trim(p.city)) = lower(c.name)
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS anunciados FROM marketplace.city_announcements ca
      WHERE ca.city_id = c.city_id AND ca.status = 'sent'
    ) a ON true
    ORDER BY c.name
  `);
  return result.rows;
}

export async function createCity(name: string): Promise<City | 'ALREADY_EXISTS'> {
  if (!pool) return 'ALREADY_EXISTS';
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 120);
  const inserted = await query<{ city_id: string }>(
    `INSERT INTO marketplace.cities (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING city_id`,
    [clean],
  );
  if (!inserted.rowCount) return 'ALREADY_EXISTS';
  const cities = await listCities();
  return cities.find((city) => city.city_id === inserted.rows[0].city_id) ?? 'ALREADY_EXISTS';
}

/** Abrir o cerrar. No envía nada: el anuncio se confirma aparte. */
export async function setCityStatus(cityId: string, status: CityStatus): Promise<City | null> {
  if (!pool) return null;
  const updated = await query<{ city_id: string }>(
    `UPDATE marketplace.cities
     SET status = $2, opened_at = CASE WHEN $2 = 'abierta' AND opened_at IS NULL THEN now() ELSE opened_at END, updated_at = now()
     WHERE city_id = $1
     RETURNING city_id`,
    [cityId, status],
  );
  if (!updated.rowCount) return null;
  return (await listCities()).find((city) => city.city_id === cityId) ?? null;
}

/**
 * Filtros del anuncio: se puede abrir una ciudad entera o anunciar solo a una categoría y a los que
 * lleguen a cierta reputación, para no gastar el cupo de WhatsApp con quien no interesa todavía.
 */
export type AnnouncementFilters = { category?: string; minRating?: number; minReviews?: number };

/** A quién le tocaría el anuncio y por qué canal, sin enviar nada. */
export async function announcementPlan(cityId: string, filters: AnnouncementFilters = {}): Promise<AnnouncementPlan | null> {
  if (!pool) return null;
  const city = await query<{ city_id: string; name: string; status: CityStatus }>(
    `SELECT city_id, name, status FROM marketplace.cities WHERE city_id = $1`,
    [cityId],
  );
  if (!city.rowCount) return null;

  const rows = await query<CandidateRow>(`
    SELECT p.provider_id, p.display_name, p.city, p.category, p.additional_categories, p.phone, p.contact_channel,
           p.status, p.whatsapp_status, p.rating, p.review_count,
           c.email, c.full_name,
           COALESCE(c.consent_status = 'granted' AND c.suppressed_at IS NULL, false) AS email_consented,
           EXISTS (SELECT 1 FROM marketplace.city_announcements ca WHERE ca.city_id = $1 AND ca.provider_id = p.provider_id) AS announced
    FROM marketplace.providers p
    LEFT JOIN LATERAL (
      SELECT email, full_name, consent_status, suppressed_at FROM marketplace.contacts
      WHERE provider_id = p.provider_id ORDER BY created_at DESC LIMIT 1
    ) c ON true
    WHERE lower(trim(p.city)) = lower($2)
      -- La categoría cuenta también si es una de las adicionales: un salón que además hace catering
      -- entra en los dos anuncios.
      AND ($3::text IS NULL OR p.category = $3 OR $3 = ANY(p.additional_categories))
      AND ($4::numeric IS NULL OR p.rating >= $4)
      AND ($5::int IS NULL OR p.review_count >= $5)
    ORDER BY p.display_name
  `, [cityId, city.rows[0].name, filters.category ?? null, filters.minRating ?? null, filters.minReviews ?? null]);

  const targets: AnnouncementTarget[] = [];
  const skipped: AnnouncementPlan['skipped'] = [];
  for (const row of rows.rows) {
    const base = { providerId: row.provider_id, displayName: row.display_name.trim() };
    if (row.announced) { skipped.push({ ...base, reason: 'ALREADY_ANNOUNCED' }); continue; }
    if (row.status === 'unconfirmed' || row.status === 'approved' || row.whatsapp_status === 'inscrito') {
      skipped.push({ ...base, reason: 'ALREADY_REGISTERED' });
      continue;
    }
    if (row.status === 'rejected' || row.status === 'archived' || row.whatsapp_status === 'rechazado' || row.whatsapp_status === 'conversacion_rechazada') {
      skipped.push({ ...base, reason: 'REJECTED' });
      continue;
    }

    if (row.contact_channel === 'email') {
      // Un correo público no es permiso de marketing: esa regla es de todo el proyecto, y aquí
      // también manda. Sin consentimiento, el proveedor queda fuera y se ve en la vista previa.
      if (!row.email) { skipped.push({ ...base, reason: 'EMAIL_MISSING' }); continue; }
      if (!row.email_consented) { skipped.push({ ...base, reason: 'EMAIL_NOT_CONSENTED' }); continue; }
      targets.push({ ...base, channel: 'email', email: row.email, firstName: row.full_name });
      continue;
    }

    const phone = toWhatsappNumber(row.phone);
    if (!phone) { skipped.push({ ...base, reason: 'PHONE_MISSING' }); continue; }
    targets.push({ ...base, channel: 'whatsapp', phone });
  }

  return { city: city.rows[0], targets, skipped };
}

export function cityTemplateName(): string | null {
  return env('WHATSAPP_CITY_TEMPLATE') || 'ciudad_disponible';
}

/**
 * El texto que refleja la plantilla aprobada, para el historial de la conversación.
 *
 * Si se puede leer la plantilla en Meta, se usa la suya con los huecos rellenos: así el hilo guardado
 * dice exactamente lo que recibió el proveedor, aunque se cambie de plantilla desde el servidor.
 */
export function announcementTranscript(displayName: string, city: string, template?: { body: string; variables: number } | null): string {
  if (template) return `${fillTemplate(template.body, [displayName, city].slice(0, template.variables))}
${REGISTER_URL}`;
  return `¡Buenas noticias, ${displayName}! 🎉 Happia ya está disponible en ${city}. Somos el catálogo donde quienes organizan bodas, cumpleaños y eventos de empresa buscan proveedores como tú. Registrarte no tiene costo y toma pocos minutos: ${REGISTER_URL}`;
}

export type AnnouncementResult = {
  sent: number;
  results: Array<{ providerId: string; displayName: string; channel: 'whatsapp' | 'email'; ok: boolean; reason?: string }>;
};

/**
 * Envía el anuncio de apertura. Cada envío se registra antes de seguir con el siguiente, para que un
 * fallo a mitad no haga que alguien reciba el anuncio dos veces en el próximo intento.
 */
export async function announceCity(
  cityId: string,
  options: { testNumber?: string } & AnnouncementFilters = {},
): Promise<AnnouncementResult | 'NOT_FOUND' | 'CITY_CLOSED'> {
  const plan = await announcementPlan(cityId, options);
  if (!plan) return 'NOT_FOUND';
  if (plan.city.status !== 'abierta') return 'CITY_CLOSED';

  const results: AnnouncementResult['results'] = [];
  const whatsappTargets = plan.targets.filter((target) => target.channel === 'whatsapp');
  const emailTargets = plan.targets.filter((target) => target.channel === 'email');

  // --- WhatsApp: una plantilla por proveedor, respetando cupo, bajas y modo prueba ---
  const redirect = resolveTestTarget(options.testNumber);
  const templateName = cityTemplateName();
  // Cuántos huecos espera la plantilla configurada: la de apertura genérica no lleva ninguno, y
  // mandarle parámetros de más hace que Meta rechace el envío.
  const templateInfo = templateName ? await getTemplateInfo(templateName) : null;
  let enviadosHoy = await countOutreachToday();

  for (const target of whatsappTargets) {
    const fail = (reason: string) => results.push({ providerId: target.providerId, displayName: target.displayName, channel: 'whatsapp', ok: false, reason });
    if (!isWhatsappConfigured()) { fail('WHATSAPP_NOT_CONFIGURED'); continue; }
    if (!templateName) { fail('TEMPLATE_NOT_CONFIGURED'); continue; }
    if (!redirect && await isSuppressed(target.phone!)) { fail('SUPPRESSED'); continue; }
    if (enviadosHoy >= dailyLimit()) { fail('DAILY_LIMIT_REACHED'); continue; }

    const transcript = announcementTranscript(target.displayName, plan.city.name, templateInfo);
    const parametros = [target.displayName, plan.city.name].slice(0, templateInfo?.variables ?? 2);
    try {
      await sendTemplate(redirect ?? target.phone!, templateName, env('WHATSAPP_OUTREACH_LANGUAGE') || 'es', parametros, { exact: Boolean(redirect) });
    } catch (error) {
      console.error('anuncio de ciudad falló', target.providerId, error instanceof Error ? error.message : error);
      await recordAnnouncement(cityId, target.providerId, 'whatsapp', 'failed', 'SEND_FAILED');
      fail('SEND_FAILED');
      continue;
    }
    enviadosHoy += 1;

    // La conversación queda lista con la ficha del proveedor: si contesta al anuncio, el agente sabe
    // con quién habla y qué se le dijo.
    const seed: SeedProvider = { providerId: target.providerId, displayName: target.displayName, city: plan.city.name, category: null, phone: target.phone };
    const waId = redirect ?? target.phone!;
    const status = applyStatusEvents({ status: null, reason: null }, [{ type: 'sent' }]);
    await startConversation(waId, seed, {
      ...stateFromProvider(seed, transcript),
      whatsapp: status,
      ...(redirect ? { testRedirect: { realPhone: target.phone! } } : {}),
    });
    await recordOutboundMessage(waId, transcript, target.providerId);
    await setProviderWhatsappStatus(target.providerId, status, { sent: true, channel: 'whatsapp', handle: waId, test: Boolean(redirect) }).catch(() => {});
    await recordAnnouncement(cityId, target.providerId, 'whatsapp', 'sent', null);
    results.push({ providerId: target.providerId, displayName: target.displayName, channel: 'whatsapp', ok: true });
  }

  // --- Correo: una sola campaña de Omnisend para todo el lote ---
  if (emailTargets.length) {
    if (!isOmnisendConfigured()) {
      for (const target of emailTargets) results.push({ providerId: target.providerId, displayName: target.displayName, channel: 'email', ok: false, reason: 'EMAIL_FAILED' });
    } else {
      try {
        await sendAnnouncementEmails(plan.city.name, emailTargets);
        for (const target of emailTargets) {
          await recordAnnouncement(cityId, target.providerId, 'email', 'sent', null);
          results.push({ providerId: target.providerId, displayName: target.displayName, channel: 'email', ok: true });
        }
      } catch (error) {
        const detalle = error instanceof Error ? error.message.slice(0, 200) : 'EMAIL_FAILED';
        console.error('anuncio por correo falló', plan.city.name, detalle);
        for (const target of emailTargets) {
          await recordAnnouncement(cityId, target.providerId, 'email', 'failed', detalle);
          results.push({ providerId: target.providerId, displayName: target.displayName, channel: 'email', ok: false, reason: 'EMAIL_FAILED' });
        }
      }
    }
  }

  const sent = results.filter((result) => result.ok).length;
  if (sent) await query(`UPDATE marketplace.cities SET announced_at = now(), updated_at = now() WHERE city_id = $1`, [cityId]);
  return { sent, results };
}

async function recordAnnouncement(cityId: string, providerId: string, channel: 'whatsapp' | 'email', status: 'sent' | 'failed', detail: string | null) {
  await query(
    `INSERT INTO marketplace.city_announcements (city_id, provider_id, channel, status, detail)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (city_id, provider_id) DO UPDATE SET channel = EXCLUDED.channel, status = EXCLUDED.status, detail = EXCLUDED.detail`,
    [cityId, providerId, channel, status, detail],
  ).catch((error) => console.error('no se pudo registrar el anuncio', providerId, error instanceof Error ? error.message : error));
}

/**
 * El anuncio por correo va por la misma maquinaria que las campañas: contactos con tag, segmento y
 * campaña. Solo entran contactos que ya dieron consentimiento, así que marcarlos como suscritos en
 * Omnisend dice la verdad.
 */
async function sendAnnouncementEmails(cityName: string, targets: AnnouncementTarget[]) {
  const tag = `ciudad-${cityName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`.slice(0, 60);
  for (const target of targets) {
    await upsertConsentedContact({
      consentGranted: true,
      email: target.email!,
      firstName: target.firstName || target.displayName,
      tags: [tag],
    });
  }

  const segment = await createTagSegment({ name: `Apertura · ${cityName}`.slice(0, 256), tag });
  await waitForSegmentReady(segment.segmentID);

  const texto = `Happia ya está disponible en ${cityName}.\n\n`
    + 'Somos el catálogo donde quienes organizan bodas, cumpleaños y eventos de empresa buscan proveedores. '
    + 'Registrar tu negocio no tiene costo y toma pocos minutos.\n\n'
    + `Regístrate aquí: ${REGISTER_URL}`;
  const template = await importEmailTemplate({
    name: `Apertura ${cityName}`.slice(0, 250),
    html: `<html><body><div style="white-space:pre-line;font-family:Arial,sans-serif;font-size:16px;line-height:1.55;color:#202124">${texto}</div>`
      + `<p><a href="${REGISTER_URL}" style="display:inline-block;padding:12px 18px;background:#2450e0;color:#fff;border-radius:8px;text-decoration:none">Registrar mi negocio</a></p>`
      + '<hr><p style="font-size:12px;color:#666"><a href="[[ unsubscribe_link ]]">Cancelar suscripción</a> · <a href="[[ preference_link ]]">Preferencias</a></p></body></html>',
  });
  const templateId = typeof template.id === 'string' ? template.id : typeof template.templateID === 'string' ? template.templateID : '';
  if (!templateId) throw new Error('OMNISEND_TEMPLATE_ID_MISSING');

  const draft = await createEmailCampaignDraft({
    name: `Apertura ${cityName}`.slice(0, 250),
    subject: `Happia ya está disponible en ${cityName}`,
    senderName: env('OMNISEND_SENDER_NAME') || 'Happia',
    senderEmail: env('OMNISEND_SENDER_EMAIL') || '',
    templateId,
    segmentIds: [segment.segmentID],
  });
  const campaignId = typeof draft.id === 'string' ? draft.id : '';
  if (!campaignId) throw new Error('OMNISEND_CAMPAIGN_ID_MISSING');
  await sendEmailCampaign(campaignId);
}
