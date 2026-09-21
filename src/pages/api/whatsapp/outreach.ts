import type { APIRoute } from 'astro';
import { getContactableCandidates } from '../../../lib/data';
import { dailyLimit, startOutreachBatch } from '../../../lib/whatsapp-outreach';
import { countOutreachToday } from '../../../lib/whatsapp-store';
import type { SeedProvider } from '../../../lib/registration-chat';

/**
 * Dispara el contacto saliente por WhatsApp.
 *
 * Va detrás del Basic Auth del panel (no está en las rutas públicas del middleware) y exige
 * `confirm: true`, igual que el envío de campañas por correo: esto manda mensajes reales a
 * proveedores reales y no puede salir por un clic accidental ni por una petición perdida.
 */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/** Cuántos quedan hoy, para que el panel lo enseñe antes de disparar nada. */
export const GET: APIRoute = async () => {
  const limite = dailyLimit();
  const enviados = await countOutreachToday();
  return json({ ok: true, limite, enviados, disponibles: Math.max(0, limite - enviados) });
};

export const POST: APIRoute = async ({ request }) => {
  let payload: { providerIds?: unknown; confirm?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return json({ ok: false, error: 'BODY_NOT_JSON' }, 400);
  }

  if (payload.confirm !== true) return json({ ok: false, error: 'CONFIRMATION_REQUIRED' }, 400);

  const ids = Array.isArray(payload.providerIds)
    ? payload.providerIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (!ids.length) return json({ ok: false, error: 'PROVIDERS_REQUIRED' }, 400);

  // Los datos del candidato salen de la base, no del navegador: quien llama elige A QUIÉN se
  // escribe, nunca QUÉ se le escribe ni con qué teléfono.
  const candidatos = await getContactableCandidates(200);
  const elegidos: SeedProvider[] = candidatos
    .filter((fila) => ids.includes(fila.provider_id))
    .map((fila) => ({
      providerId: fila.provider_id,
      displayName: fila.display_name,
      city: fila.city,
      category: fila.category,
      additionalCategories: fila.additional_categories ?? [],
      phone: fila.phone,
      email: fila.contact_email,
    }));

  if (!elegidos.length) return json({ ok: false, error: 'NO_CANDIDATES_MATCHED' }, 404);

  const resultado = await startOutreachBatch(elegidos);
  return json({ ok: true, ...resultado }, 201);
};
