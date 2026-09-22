import type { APIRoute } from 'astro';
import { extractInboundMessages, isWhatsappConfigured, markAsRead, resolveWebhookChallenge, sendText, verifySignature } from '../../../lib/whatsapp';
import { getConversation, isDuplicate, isSuppressed, recordOutboundMessage, saveInbound, saveState, suppress } from '../../../lib/whatsapp-store';
import { emptyState, runTurn } from '../../../lib/conversation-runner';
import { isOptOut } from '../../../lib/registration-chat';
import { SERVICE_WINDOW_MS } from '../../../lib/whatsapp-session';
import { parseSimulationTrigger } from '../../../lib/contract';
import { startSimulation } from '../../../lib/whatsapp-simulation';
import { setProviderWhatsappStatus } from '../../../lib/data';
import { nextStatus, type StatusChange } from '../../../lib/conversation-status';
import type { ConversationState } from '../../../lib/conversation-runner';

/**
 * Guarda en el proveedor el estado de contacto si cambió. Solo en conversaciones reales: una
 * simulación del panel no dice nada del proveedor de verdad. El modo prueba sí se guarda (es lo que
 * se está probando), marcado como prueba en la auditoría.
 */
async function persistStatus(before: StatusChange | undefined, state: ConversationState, handle: string) {
  const after = state.whatsapp;
  const providerId = state.seed?.providerId;
  if (!after || !providerId || state.simulation) return;
  if (before?.status === after.status && before?.reason === after.reason) return;
  await setProviderWhatsappStatus(providerId, after, { channel: 'whatsapp', handle, test: Boolean(state.testRedirect) })
    .catch((error) => console.error('no se pudo guardar el estado de WhatsApp', providerId, error instanceof Error ? error.message : error));
}

/** En una prueba, quien habla es alguien del equipo: su número nunca se bloquea. */
function isTest(state: ConversationState | undefined) {
  return Boolean(state?.simulation || state?.testRedirect);
}

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

/**
 * Los mensajes de un mismo número se atienden de uno en uno.
 *
 * Quien escribe por WhatsApp suele mandar dos o tres mensajes seguidos, y cada uno llega en su
 * propia llamada al webhook. En paralelo, los dos turnos leían el mismo estado y el segundo en
 * guardar borraba lo que había anotado el primero. Una cola por número en el proceso basta: la app
 * corre en un solo proceso.
 */
const queues = new Map<string, Promise<void>>();

function serialize(key: string, task: () => Promise<void>): Promise<void> {
  const current = (queues.get(key) ?? Promise.resolve()).then(task, task);
  queues.set(key, current);
  const cleanup = () => { if (queues.get(key) === current) queues.delete(key); };
  current.then(cleanup, cleanup);
  return current;
}

type InboundMessage = ReturnType<typeof extractInboundMessages>[number];

async function handleMessages(messages: InboundMessage[]) {
  for (const message of messages) {
    await serialize(message.from, () => handleMessage(message));
  }
}

async function handleMessage(message: InboundMessage) {
  try {
    // El control de duplicados va contra la base: Meta reintenta justo cuando algo falla, que es
    // cuando el registro en memoria se habría perdido al reiniciar.
    if (await isDuplicate(message.messageId, message.from, message.text)) return;

    // Una baja se atiende antes que nada y sin modelo de por medio: ni se procesa el registro ni se
    // le vuelve a escribir.
    if (isOptOut(message.text)) {
      const conversacion = await getConversation(message.from);
      if (!isTest(conversacion?.state)) await suppress(message.from, message.text.slice(0, 200), 'whatsapp-inbound');
      console.error('whatsapp: baja solicitada', { waId: message.from });
      if (conversacion) {
        const before = conversacion.state.whatsapp;
        const after = nextStatus(nextStatus(before ?? { status: null, reason: null }, { type: 'inbound' }), { type: 'decline', reason: 'Pidió no ser contactado' });
        const state = { ...conversacion.state, whatsapp: after, finished: true };
        await saveState(message.from, state);
        await persistStatus(before, state, message.from);
      }
      if (isWhatsappConfigured()) {
        const despedida = 'Listo, no te volvemos a escribir. Gracias por tu tiempo.';
        await sendText(message.from, despedida).catch(() => {});
        await recordOutboundMessage(message.from, despedida);
      }
      return;
    }

    // Simulación desde el panel: `id: <proveedor>` no es un mensaje del proveedor, es la orden de
    // arrancar una prueba en la que el sistema le escribe primero a ese proveedor.
    const simulatedProvider = parseSimulationTrigger(message.text);
    if (simulatedProvider) {
      await handleSimulation(message, simulatedProvider);
      return;
    }

    const almacenada = await getConversation(message.from);
    const estadoPrevio = almacenada?.state ?? emptyState();

    // Guardar el entrante ANTES de contestar: abre la ventana de 24h y deja constancia aunque la
    // respuesta falle. Si se guardara después, un fallo del modelo perdería el mensaje del
    // proveedor y su avance.
    await saveInbound(message.from, message.profileName, message.timestampMs, estadoPrevio);

    if (!isWhatsappConfigured()) {
      console.error('whatsapp inbound guardado sin responder: faltan credenciales');
      return;
    }

    // El mensaje acaba de entrar, así que la ventana está abierta salvo que Meta reenvíe algo muy
    // viejo. Se comprueba igual: fuera de la ventana un texto libre lo rechaza la API y hay que
    // resolverlo con plantilla, que es una decisión de negocio y no se toma sola aquí.
    if (Date.now() - message.timestampMs >= SERVICE_WINDOW_MS) {
      console.error('whatsapp: mensaje fuera de la ventana de 24h; hace falta una plantilla', { waId: message.from });
      return;
    }

    await markAsRead(message.messageId).catch(() => {});

    // El mismo motor que usa el chat de prueba local.
    const turn = await runTurn(estadoPrevio, message.text, {
      channel: 'whatsapp',
      handle: message.from,
      profileName: message.profileName,
    });
    await saveState(message.from, turn.state);
    await persistStatus(estadoPrevio.whatsapp, turn.state, message.from);

    // Si la conversación se cierra porque no le interesa, no se le vuelve a escribir por iniciativa
    // nuestra. Si él vuelve a escribir, el agente lo atiende. En una simulación o en modo prueba,
    // quien dijo que no es alguien del equipo probando: su número no se bloquea.
    if (turn.outcome === 'declined' && !isTest(turn.state)) {
      await suppress(message.from, 'rechazó el registro en la conversación', 'whatsapp-declined');
    }

    await sendText(message.from, turn.reply);
    await recordOutboundMessage(message.from, turn.reply);
  } catch (error) {
    // El detalle crudo se queda en el log del servidor. Al proveedor no se le cuenta qué falló ni
    // con qué tecnología: solo que hubo un problema y que habrá una persona.
    console.error('whatsapp reply failed', message.from, error instanceof Error ? error.message : error);
    if (isWhatsappConfigured() && !(await isSuppressed(message.from))) {
      await sendText(message.from, 'Tuvimos un problema para responderte en este momento. Una persona del equipo se pondrá en contacto contigo más adelante.').catch(() => {});
    }
  }
}

/**
 * Arranca una simulación: el sistema responde como si le hubiera escrito primero al proveedor.
 *
 * La conversación de este número se reinicia con ese proveedor, aunque viniera de otra prueba, y
 * recibe la misma invitación que recibiría el proveedor real. Lo que conteste quien prueba lo
 * atiende el agente con la ficha del negocio delante. Ver `whatsapp-simulation.ts`.
 */
async function handleSimulation(message: InboundMessage, providerId: string) {
  const start = await startSimulation(message.from, providerId);

  if (!start.ok) {
    console.error('whatsapp: simulación rechazada', { waId: message.from, providerId, reason: start.reason });
    if (!isWhatsappConfigured()) return;
    const aviso = start.reason === 'NOT_ALLOWED'
      ? 'Este número no está habilitado para simular conversaciones.'
      : 'No encontré ese proveedor. Vuelve a lanzar la simulación desde el panel.';
    await sendText(message.from, aviso).catch(() => {});
    await recordOutboundMessage(message.from, aviso);
    return;
  }

  // El entrante abre la ventana de 24h, así que la invitación puede salir como texto libre: aquí no
  // hace falta la plantilla de Meta que exige el contacto real.
  await saveInbound(message.from, message.profileName, message.timestampMs, start.state);
  console.error('whatsapp: simulación iniciada', { waId: message.from, providerId: start.seed.providerId });

  if (!isWhatsappConfigured()) return;
  if (Date.now() - message.timestampMs >= SERVICE_WINDOW_MS) return;

  await markAsRead(message.messageId).catch(() => {});
  await sendText(message.from, start.opening);
  await saveState(message.from, start.state);
  await recordOutboundMessage(message.from, start.opening);
}
