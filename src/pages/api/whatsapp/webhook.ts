import type { APIRoute } from 'astro';
import { extractInboundMessages, isWhatsappConfigured, markAsRead, resolveWebhookChallenge, sendText, verifySignature } from '../../../lib/whatsapp';
import { getConversation, isDuplicate, isSuppressed, recordOutboundMessage, saveInbound, saveState, suppress } from '../../../lib/whatsapp-store';
import { emptyState, runTurn } from '../../../lib/conversation-runner';
import { isOptOut } from '../../../lib/registration-chat';
import { SERVICE_WINDOW_MS } from '../../../lib/whatsapp-session';

/**
 * Webhook de WhatsApp Cloud API.
 *
 * GET  → verificación que hace Meta al guardar la URL.
 * POST → mensajes entrantes.
 *
 * Es una ruta PÚBLICA: la llama Meta, no un operador con sesión. Lo que la protege es la firma del
 * cuerpo, no el Basic Auth del panel.
 */

export const GET: APIRoute = async ({ url }) => {
  const result = resolveWebhookChallenge(url.searchParams);
  if (!result.ok) {
    console.error('whatsapp webhook verification rejected', result.reason);
    return new Response('Forbidden', { status: 403 });
  }
  // Meta espera el challenge tal cual, en texto plano.
  return new Response(result.challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
};

export const POST: APIRoute = async ({ request }) => {
  // El cuerpo crudo se lee ANTES de parsear: la firma se calcula sobre estos bytes exactos.
  const rawBody = await request.text();

  if (!verifySignature(rawBody, request.headers.get('x-hub-signature-256'))) {
    console.error('whatsapp webhook signature rejected');
    return new Response('Forbidden', { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const messages = extractInboundMessages(payload);

  // Se responde 200 de inmediato y el trabajo sigue aparte. Meta reintenta si el webhook tarda, y
  // un reintento con el modelo a medio pensar significa dos respuestas al proveedor y doble gasto.
  void handleMessages(messages);

  return new Response('EVENT_RECEIVED', { status: 200 });
};

async function handleMessages(messages: ReturnType<typeof extractInboundMessages>) {
  for (const message of messages) {
    try {
      // El control de duplicados va contra la base: Meta reintenta justo cuando algo falla, que es
      // cuando el registro en memoria se habría perdido al reiniciar.
      if (await isDuplicate(message.messageId, message.from, message.text)) continue;

      // Una baja se atiende antes que nada: ni se procesa el registro ni se le vuelve a escribir.
      if (isOptOut(message.text)) {
        await suppress(message.from, message.text.slice(0, 200), 'whatsapp-inbound');
        console.error('whatsapp: baja solicitada', { waId: message.from });
        if (isWhatsappConfigured()) {
          const despedida = 'Listo, no te volvemos a escribir. Gracias por tu tiempo.';
          await sendText(message.from, despedida).catch(() => {});
          await recordOutboundMessage(message.from, despedida);
        }
        continue;
      }

      const almacenada = await getConversation(message.from);
      const estadoPrevio = almacenada?.state ?? emptyState();

      // Guardar el entrante ANTES de contestar: abre la ventana de 24h y deja constancia aunque la
      // respuesta falle. Si se guardara después, un fallo del modelo perdería el mensaje del
      // proveedor y su avance.
      await saveInbound(message.from, message.profileName, message.timestampMs, estadoPrevio);

      if (!isWhatsappConfigured()) {
        console.error('whatsapp inbound guardado sin responder: faltan credenciales');
        continue;
      }

      // El mensaje acaba de entrar, así que la ventana está abierta salvo que Meta reenvíe algo muy
      // viejo. Se comprueba igual: fuera de la ventana un texto libre lo rechaza la API y hay que
      // resolverlo con plantilla, que es una decisión de negocio y no se toma sola aquí.
      if (Date.now() - message.timestampMs >= SERVICE_WINDOW_MS) {
        console.error('whatsapp: mensaje fuera de la ventana de 24h; hace falta una plantilla', { waId: message.from });
        continue;
      }

      await markAsRead(message.messageId).catch(() => {});

      // El mismo motor que usa el chat de prueba local: el bot rellena el formulario de registro.
      const turn = await runTurn(estadoPrevio, message.text, { channel: 'whatsapp', handle: message.from });
      await saveState(message.from, turn.state);

      // Si la conversación se cierra porque no le interesa, no se le vuelve a escribir.
      if (turn.outcome === 'declined') {
        await suppress(message.from, 'rechazó el registro en la conversación', 'whatsapp-declined');
      }

      await sendText(message.from, turn.reply);
      await recordOutboundMessage(message.from, turn.reply);
    } catch (error) {
      // El detalle crudo se queda en el log del servidor. Al proveedor no se le cuenta qué falló ni
      // con qué tecnología: solo que hubo un problema y que habrá una persona.
      console.error('whatsapp reply failed', message.from, error instanceof Error ? error.message : error);
      if (isWhatsappConfigured() && !(await isSuppressed(message.from))) {
        await sendText(message.from, 'Tuvimos un problema para responderte en este momento. Un miembro del equipo te escribe enseguida.').catch(() => {});
      }
    }
  }
}
