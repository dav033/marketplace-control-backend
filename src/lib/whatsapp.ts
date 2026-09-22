import { createHmac, timingSafeEqual } from 'node:crypto';

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

const GRAPH_VERSION = () => env('WHATSAPP_GRAPH_VERSION') || 'v21.0';

export function isWhatsappConfigured() {
  return Boolean(env('WHATSAPP_ACCESS_TOKEN') && env('WHATSAPP_PHONE_NUMBER_ID'));
}

/**
 * Verificación del webhook (GET). Meta llama una vez al guardar la URL y espera que le devuelvas el
 * `hub.challenge` en texto plano, solo si el `hub.verify_token` coincide con el que configuraste.
 */
export function resolveWebhookChallenge(params: URLSearchParams): { ok: true; challenge: string } | { ok: false; reason: string } {
  const expected = env('WHATSAPP_VERIFY_TOKEN');
  if (!expected) return { ok: false, reason: 'WHATSAPP_VERIFY_TOKEN_NOT_CONFIGURED' };
  if (params.get('hub.mode') !== 'subscribe') return { ok: false, reason: 'MODE_NOT_SUBSCRIBE' };
  if (params.get('hub.verify_token') !== expected) return { ok: false, reason: 'VERIFY_TOKEN_MISMATCH' };
  const challenge = params.get('hub.challenge');
  if (!challenge) return { ok: false, reason: 'CHALLENGE_MISSING' };
  return { ok: true, challenge };
}

/**
 * Firma del cuerpo (POST). El webhook es una URL pública: sin esta comprobación, cualquiera que la
 * descubra puede inyectar mensajes falsos y hacer que el bot conteste (y gaste modelo) por él.
 *
 * Se calcula sobre el cuerpo EXACTO recibido, antes de parsear el JSON: volver a serializar cambia
 * espacios y orden, y la firma dejaría de cuadrar.
 */
export function verifySignature(rawBody: string, header: string | null): boolean {
  const secret = env('WHATSAPP_APP_SECRET');
  if (!secret) return false;
  if (!header?.startsWith('sha256=')) return false;
  const provided = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export type InboundMessage = {
  messageId: string;
  from: string;
  text: string;
  /** Marca de tiempo de Meta, en milisegundos. Es la que abre la ventana de 24h. */
  timestampMs: number;
  profileName: string | null;
};

/**
 * Extrae los mensajes de texto de un evento del webhook.
 *
 * El payload viene anidado en `entry[].changes[].value.messages[]` y mezcla cosas que no son
 * mensajes: acuses de entrega (`statuses`), reacciones, audio, ubicación. Aquí solo salen los de
 * texto; el resto se ignora en silencio porque responderlos no es trabajo de este esqueleto.
 */
export function extractInboundMessages(payload: unknown): InboundMessage[] {
  const root = payload as { entry?: Array<{ changes?: Array<{ value?: Record<string, unknown> }> }> };
  const messages: InboundMessage[] = [];

  for (const entry of root?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const contacts = (value.contacts ?? []) as Array<{ wa_id?: string; profile?: { name?: string } }>;
      const list = (value.messages ?? []) as Array<Record<string, unknown>>;

      for (const raw of list) {
        if (raw.type !== 'text') continue;
        const text = (raw.text as { body?: string } | undefined)?.body?.trim();
        const from = typeof raw.from === 'string' ? raw.from : '';
        const messageId = typeof raw.id === 'string' ? raw.id : '';
        if (!text || !from || !messageId) continue;

        // `timestamp` llega en segundos y como cadena.
        const seconds = Number(raw.timestamp);
        const profile = contacts.find((contact) => contact.wa_id === from)?.profile?.name ?? null;

        messages.push({
          messageId,
          from,
          text,
          timestampMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now(),
          profileName: profile,
        });
      }
    }
  }

  return messages;
}

async function graph(path: string, body: unknown) {
  const token = env('WHATSAPP_ACCESS_TOKEN');
  const phoneNumberId = env('WHATSAPP_PHONE_NUMBER_ID');
  if (!token || !phoneNumberId) throw new Error('WHATSAPP_NOT_CONFIGURED');

  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION()}/${phoneNumberId}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    console.error('whatsapp graph request failed', response.status, text.slice(0, 400));
    throw new Error(`WHATSAPP_REQUEST_${response.status}`);
  }
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

/**
 * Modo prueba: con `WHATSAPP_REDIRECT_ALL_TO` (uno o varios números separados por comas), ningún
 * mensaje llega a un proveedor real: todo lo que sale va a un teléfono de prueba. Sirve para probar
 * envíos en lote y conversaciones completas con proveedores reales sin escribirles de verdad. Se
 * aplica aquí, en el único punto por el que sale cualquier mensaje (invitaciones y respuestas del
 * agente), para que ningún camino se lo salte.
 */
export function testNumbers(): string[] {
  return String(env('WHATSAPP_REDIRECT_ALL_TO') ?? '')
    .split(',')
    .map((value) => value.replace(/\D/g, ''))
    .filter(Boolean)
    // Un móvil colombiano sin indicativo (10 dígitos que empiezan por 3) se completa con 57.
    .map((digits) => (digits.length === 10 && digits.startsWith('3') ? `57${digits}` : digits));
}

/** El número de prueba por defecto (el primero de la lista), o null si no hay modo prueba. */
export function redirectTarget(): string | null {
  return testNumbers()[0] ?? null;
}

/**
 * El teléfono de prueba al que debe salir un envío concreto.
 *
 * Sin modo prueba devuelve null y el mensaje va a su destinatario real. Con modo prueba, quien envía
 * puede escribir cualquier número (para probar con un teléfono que no esté en la lista del
 * servidor); si lo que escribe no parece un número, se usa el primero de la lista.
 */
export function normalizeTestNumber(raw: string | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  // Un móvil colombiano sin indicativo (10 dígitos que empiezan por 3) se completa con 57.
  const normalized = digits.length === 10 && digits.startsWith('3') ? `57${digits}` : digits;
  return normalized.length >= 10 && normalized.length <= 15 ? normalized : null;
}

export function resolveTestTarget(requested?: string, numbers = testNumbers()): string | null {
  if (!numbers.length) return null;
  return normalizeTestNumber(requested) ?? numbers[0];
}

/**
 * A dónde sale de verdad un mensaje. Si el destino ya es un teléfono de prueba se respeta: así el
 * agente le contesta a quien está probando desde el segundo número, en vez de al primero.
 */
function deliverTo(to: string) {
  const numbers = testNumbers();
  if (!numbers.length) return to;
  return numbers.includes(to.replace(/\D/g, '')) ? to : numbers[0];
}

/**
 * Mensaje libre. Solo es válido dentro de la ventana de servicio de 24h; fuera de ella Meta lo
 * rechaza y hay que usar una plantilla aprobada.
 */
export function sendText(to: string, body: string, options: { exact?: boolean } = {}) {
  return graph('/messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    // `exact` lo usa quien ya resolvió a qué teléfono de prueba va (`resolveTestTarget`): si no, un
    // número escrito a mano acabaría redirigido al primero de la lista.
    to: options.exact ? to : deliverTo(to),
    type: 'text',
    text: { preview_url: false, body: body.slice(0, 4096) },
  });
}

/**
 * Plantilla aprobada: la única vía para escribir primero o para retomar una conversación fuera de
 * las 24h. El nombre y el idioma tienen que existir aprobados en la cuenta.
 */
export function sendTemplate(to: string, templateName: string, languageCode = 'es', parameters: string[] = [], options: { exact?: boolean } = {}) {
  return graph('/messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: options.exact ? to : deliverTo(to),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(parameters.length
        ? { components: [{ type: 'body', parameters: parameters.map((text) => ({ type: 'text', text })) }] }
        : {}),
    },
  });
}

/** Marca el mensaje como leído: el proveedor ve la doble palomita azul mientras el bot piensa. */
export function markAsRead(messageId: string) {
  return graph('/messages', { messaging_product: 'whatsapp', status: 'read', message_id: messageId });
}
