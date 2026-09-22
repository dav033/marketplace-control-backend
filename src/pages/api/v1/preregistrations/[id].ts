import type { APIRoute } from 'astro';
import { removePreregistration } from '../../../../lib/data';
import { assertServiceAuth, json } from '../../../../lib/api-auth';

/** Quita a un proveedor de preregistrados: borra lo que envió y lo devuelve a candidato. */
export const DELETE: APIRoute = async ({ request, params }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;
  try {
    const removed = await removePreregistration(params.id ?? '');
    return removed ? json({ ok: true }) : json({ ok: false, error: 'NOT_FOUND' }, 404);
  } catch (error) {
    console.error('no se pudo quitar de preregistrados', params.id, error instanceof Error ? error.message : error);
    return json({ ok: false, error: 'REMOVE_FAILED' }, 500);
  }
};
