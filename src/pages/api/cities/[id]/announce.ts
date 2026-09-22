import type { APIRoute } from 'astro';
import { announceCity, announcementPlan, cityTemplateName } from '../../../../lib/cities';
import { dailyLimit } from '../../../../lib/whatsapp-outreach';
import { countOutreachToday } from '../../../../lib/whatsapp-store';
import { isWhatsappConfigured, redirectTarget, testNumbers } from '../../../../lib/whatsapp';

/**
 * El anuncio de apertura de una ciudad.
 *
 * GET devuelve la vista previa (a cuántos y por qué canal) y POST lo envía con `confirm: true`. Va
 * detrás del Basic Auth del panel, como el contacto saliente: manda mensajes reales.
 */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export const GET: APIRoute = async ({ params }) => {
  const plan = await announcementPlan(params.id ?? '');
  if (!plan) return json({ ok: false, error: 'NOT_FOUND' }, 404);

  const motivos = new Map<string, number>();
  for (const item of plan.skipped) motivos.set(item.reason, (motivos.get(item.reason) ?? 0) + 1);

  const limite = dailyLimit();
  const template = cityTemplateName();
  return json({
    ok: true,
    ciudad: plan.city.name,
    estado: plan.city.status,
    total: plan.targets.length,
    whatsapp: plan.targets.filter((target) => target.channel === 'whatsapp').length,
    email: plan.targets.filter((target) => target.channel === 'email').length,
    omitidos: [...motivos].map(([motivo, n]) => ({ motivo, n })),
    plantilla: template,
    // Que la plantilla exista no garantiza que Meta la haya aprobado ya; si no lo está, esos envíos
    // fallan con SEND_FAILED y se ven en el resumen.
    plantillaLista: isWhatsappConfigured() && Boolean(template),
    cupoDisponible: Math.max(0, limite - await countOutreachToday()),
    redirigidoA: redirectTarget(),
    numerosPrueba: testNumbers(),
  });
};

export const POST: APIRoute = async ({ request, params }) => {
  let payload: { confirm?: unknown; testNumber?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return json({ ok: false, error: 'BODY_NOT_JSON' }, 400);
  }

  if (payload.confirm !== true) return json({ ok: false, error: 'CONFIRMATION_REQUIRED' }, 400);

  const testNumber = typeof payload.testNumber === 'string' ? payload.testNumber.replace(/\D/g, '') : undefined;
  if (testNumber && !testNumbers().includes(testNumber)) return json({ ok: false, error: 'INVALID_TEST_NUMBER' }, 400);

  const result = await announceCity(params.id ?? '', { testNumber });
  if (result === 'NOT_FOUND') return json({ ok: false, error: 'NOT_FOUND' }, 404);
  if (result === 'CITY_CLOSED') return json({ ok: false, error: 'CITY_CLOSED' }, 409);
  return json({ ok: true, ...result }, 201);
};
