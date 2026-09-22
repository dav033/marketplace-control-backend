import type { APIRoute } from 'astro';
import { getProviderConversation } from '../../../../../lib/data';
import { assertServiceAuth, json } from '../../../../../lib/api-auth';

/**
 * La conversación de WhatsApp que se tuvo con un proveedor, para leerla desde su ficha.
 *
 * Los mensajes salen de `whatsapp_messages`, que guarda cada entrante y cada saliente. Es solo
 * lectura: desde el panel no se escribe al proveedor por aquí.
 */
export const GET: APIRoute = async ({ request, params }) => {
  const denied = assertServiceAuth(request);
  if (denied) return denied;

  try {
    const conversation = await getProviderConversation(params.id ?? '');
    return conversation ? json({ ok: true, ...conversation }) : json({ ok: false, error: 'NOT_FOUND' }, 404);
  } catch (error) {
    // Sin base (por ejemplo, en local sin túnel) la ficha tiene que seguir abriéndose: el panel
    // enseña el aviso en vez de romperse entera.
    console.error('no se pudo leer la conversación', params.id, error instanceof Error ? error.message : error);
    return json({ ok: false, error: 'DATABASE_UNAVAILABLE' }, 503);
  }
};
