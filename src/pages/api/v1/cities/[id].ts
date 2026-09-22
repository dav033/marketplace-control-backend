import type { APIRoute } from 'astro';
import { setCityStatus } from '../../../../lib/cities';
import { assertServiceAuth, json } from '../../../../lib/api-auth';

/**
 * Abre o cierra una ciudad. No envía nada: el anuncio de apertura se confirma aparte
 * (`/api/cities/:id/announce`), porque manda mensajes reales que no se pueden retirar.
 */
export const PATCH: APIRoute = async ({ request, params }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;

  let payload: { status?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch {
    return json({ ok: false, error: 'BODY_NOT_JSON' }, 400);
  }

  const status = payload.status === 'abierta' || payload.status === 'cerrada' ? payload.status : null;
  if (!status) return json({ ok: false, error: 'STATUS_INVALID' }, 400);

  const city = await setCityStatus(params.id ?? '', status);
  return city ? json({ ok: true, city }) : json({ ok: false, error: 'NOT_FOUND' }, 404);
};
