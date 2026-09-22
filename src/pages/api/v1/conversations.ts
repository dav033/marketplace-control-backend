import type { APIRoute } from 'astro';
import { getConversationByWaId, getProviderConversation, listConversations } from '../../../lib/data';
import { assertServiceAuth, json } from '../../../lib/api-auth';

/**
 * Las conversaciones de WhatsApp guardadas, para leerlas desde el panel.
 *
 * Sin parámetros devuelve la lista de hilos (el más reciente arriba). Con `provider` o `wa` devuelve
 * uno entero. Es solo lectura: desde aquí no se le escribe a nadie.
 */
export const GET: APIRoute = async ({ request, url }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;

  const providerId = url.searchParams.get('provider')?.trim();
  const waId = url.searchParams.get('wa')?.trim();

  try {
    if (providerId) {
      const conversation = await getProviderConversation(providerId);
      return conversation ? json({ ok: true, ...conversation }) : json({ ok: false, error: 'NOT_FOUND' }, 404);
    }
    if (waId) {
      const conversation = await getConversationByWaId(waId);
      return conversation ? json({ ok: true, ...conversation }) : json({ ok: false, error: 'NOT_FOUND' }, 404);
    }
    // `Number(null)` es 0, no NaN: sin este rodeo, no mandar `limit` pedía cero conversaciones y la
    // lista llegaba con una sola (el mínimo del propio rango).
    const pedido = url.searchParams.get('limit');
    const limit = pedido ? Number(pedido) : 100;
    return json({ ok: true, conversaciones: await listConversations(Number.isFinite(limit) && limit > 0 ? limit : 100) });
  } catch (error) {
    // Sin base el panel enseña el aviso en vez de romperse: es la misma regla que en la ficha.
    console.error('no se pudieron leer las conversaciones', error instanceof Error ? error.message : error);
    return json({ ok: false, error: 'DATABASE_UNAVAILABLE' }, 503);
  }
};
