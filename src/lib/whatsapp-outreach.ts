import { fillTemplate, getTemplateInfo, isWhatsappConfigured, resolveTestTarget, sendTemplate } from './whatsapp';
import { countOutreachToday, getConversation, isSuppressed, recordOutboundMessage, startConversation } from './whatsapp-store';
import { stateFromProvider } from './conversation-runner';
import { setProviderWhatsappStatus } from './data';
import type { SeedProvider } from './registration-chat';
import type { WhatsappStatus } from './conversation-status';

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

/**
 * Nosotros escribimos primero: contacto saliente a un candidato de la curaduría.
 *
 * LA REGLA QUE MANDA AQUÍ: cuando la conversación la iniciamos nosotros, la ventana de servicio de
 * 24h está cerrada, y Meta solo acepta una PLANTILLA APROBADA. Un texto libre —por bueno que sea—
 * lo rechaza la API. Por eso este camino no usa el saludo redactado del bot: ese solo sirve una vez
 * que el proveedor ha contestado.
 *
 * La plantilla hay que crearla y aprobarla en el panel de Meta antes de usarla; su nombre va en
 * `WHATSAPP_OUTREACH_TEMPLATE`. El texto aprobado debe tener dos huecos, en este orden:
 *   {{1}} nombre del negocio      {{2}} ciudad
 * La aprobada hoy es `invitacion_happia_2`, cuyo texto reproduce `outreachTranscript`.
 */

/**
 * Cuántos contactos nuevos se permiten al día.
 *
 * Meta asigna un cupo que sube o baja según la calidad de la cuenta, y la calidad baja cuando la
 * gente bloquea o reporta. Gastar el cupo de golpe el primer día es la forma rápida de que lo
 * recorten, así que el límite por defecto es conservador y se sube cuando la cuenta lo aguante.
 */
const DEFAULT_DAILY_LIMIT = 20;

export type OutreachResult =
  | { ok: true; to: string; deliveredTo: string; templateName: string }
  | {
      ok: false;
      reason: 'WHATSAPP_NOT_CONFIGURED' | 'TEMPLATE_NOT_CONFIGURED' | 'PHONE_MISSING'
        | 'ALREADY_CONTACTED' | 'SUPPRESSED' | 'DAILY_LIMIT_REACHED' | 'SEND_FAILED' | 'NOT_FOUND';
    };

/** Meta espera el número sin `+`, espacios ni guiones: solo dígitos con indicativo de país. */
export function toWhatsappNumber(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return undefined;
  // Un móvil colombiano escrito sin indicativo (10 dígitos, empieza por 3) se completa con 57.
  if (digits.length === 10 && digits.startsWith('3')) return `57${digits}`;
  return digits;
}

/**
 * El texto que se guarda en el historial de la conversación.
 *
 * No es lo que Meta envía —eso lo compone su plantilla aprobada—, sino el reflejo de lo que el
 * proveedor va a leer, para que el hilo guardado tenga sentido al revisarlo.
 */
export function outreachTranscript(seed: SeedProvider): string {
  // Idéntico a la plantilla aprobada `invitacion_happia_2`, con los mismos valores que envía
  // `startOutreach` (incluido "tu ciudad" cuando no se conoce): si cambia la plantilla en Meta,
  // este texto tiene que cambiar con ella.
  return `Hola 👋 Te escribimos de Happia. Encontramos a ${seed.displayName.trim()} en ${seed.city ?? 'tu ciudad'} y nos encantaría sumarte a nuestro catálogo de proveedores para eventos (bodas, cumpleaños y eventos de empresa). Estar en el catálogo no tiene costo. ¿Te gustaría saber más?`;
}

export function dailyLimit(): number {
  const configured = Number(env('WHATSAPP_DAILY_OUTREACH_LIMIT'));
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_DAILY_LIMIT;
}

export async function startOutreach(
  seed: SeedProvider,
  options: { whatsappStatus?: WhatsappStatus | null; testNumber?: string } = {},
): Promise<OutreachResult> {
  if (!isWhatsappConfigured()) return { ok: false, reason: 'WHATSAPP_NOT_CONFIGURED' };

  const templateName = env('WHATSAPP_OUTREACH_TEMPLATE');
  if (!templateName) return { ok: false, reason: 'TEMPLATE_NOT_CONFIGURED' };

  const realTo = toWhatsappNumber(seed.phone);
  if (!realTo) return { ok: false, reason: 'PHONE_MISSING' };

  // No se escribe dos veces a quien ya se le escribió: insistir a quien no ha contestado es justo
  // lo que hace que a una cuenta le bajen la calidad y acabe bloqueada.
  if (options.whatsappStatus) return { ok: false, reason: 'ALREADY_CONTACTED' };

  // En modo prueba el mensaje le llega a quien prueba, no al proveedor: la conversación se guarda con
  // su número, que es desde donde contestará, y no se miran las bajas ni las conversaciones del
  // número real, porque a ese número no se le escribe.
  // Con modo prueba, quien envía elige el teléfono: uno de los del servidor o uno escrito a mano.
  const redirect = resolveTestTarget(options.testNumber);
  const to = redirect ?? realTo;
  if (!redirect) {
    // Quien pidió que no le escribamos manda sobre todo lo demás, incluso sobre una campaña nueva.
    if (await isSuppressed(realTo)) return { ok: false, reason: 'SUPPRESSED' };
    // El mismo teléfono puede estar en dos fichas: si ya hay conversación con él, no se repite.
    if (await getConversation(realTo)) return { ok: false, reason: 'ALREADY_CONTACTED' };
  }

  if (await countOutreachToday() >= dailyLimit()) return { ok: false, reason: 'DAILY_LIMIT_REACHED' };

  // Cada plantilla trae lo suyo: la de invitación lleva dos huecos (negocio y ciudad) y otras, como la
  // de presentación, ninguno. Mandar parámetros de más hace que Meta rechace el envío entero, así que
  // se manda solo los que la plantilla aprobada espera. Si no se puede consultar, se asumen los dos.
  const templateInfo = await getTemplateInfo(templateName);
  const parameters = [seed.displayName.trim(), seed.city ?? 'tu ciudad'].slice(0, templateInfo?.variables ?? 2);
  try {
    // En modo prueba se envía directo al teléfono de prueba elegido (`sendTemplate` lo respeta).
    await sendTemplate(redirect ?? realTo, templateName, env('WHATSAPP_OUTREACH_LANGUAGE') || 'es', parameters, { exact: Boolean(redirect) });
  } catch (error) {
    console.error('whatsapp outreach failed', realTo, error instanceof Error ? error.message : error);
    return { ok: false, reason: 'SEND_FAILED' };
  }

  // La conversación queda preparada con los datos del candidato y con lo que le dijimos: cuando
  // conteste, el agente sabe a quién le escribió y qué le propuso.
  // Con la plantilla en mano se guarda su texto real, no el de la invitación: el agente tiene que saber
  // qué le dijimos de verdad al proveedor.
  const transcript = templateInfo ? fillTemplate(templateInfo.body, parameters) : outreachTranscript(seed);
  const status = { status: 'mensaje_enviado' as const, reason: redirect ? `Modo prueba: enviado a +${redirect}` : null };
  await startConversation(to, seed, {
    ...stateFromProvider(seed, transcript),
    whatsapp: status,
    ...(redirect ? { testRedirect: { realPhone: realTo } } : {}),
  });
  await recordOutboundMessage(to, transcript, seed.providerId);
  await setProviderWhatsappStatus(seed.providerId, status, { sent: true, channel: 'whatsapp', handle: to, test: Boolean(redirect) })
    .catch((error) => console.error('no se pudo guardar el estado de WhatsApp', seed.providerId, error instanceof Error ? error.message : error));

  return { ok: true, to: realTo, deliveredTo: to, templateName };
}

export type BatchOutreachResult = {
  sent: number;
  results: Array<{ providerId: string; displayName: string; outcome: OutreachResult }>;
};

/**
 * Contacta varios candidatos respetando el cupo.
 *
 * Se para en cuanto el cupo se agota en vez de seguir intentando: cada rechazo por límite es una
 * llamada a Meta que no aporta nada y ensucia las métricas de la cuenta.
 */
export async function startOutreachBatch(
  seeds: Array<SeedProvider & { whatsappStatus?: WhatsappStatus | null }>,
  options: { testNumber?: string } = {},
): Promise<BatchOutreachResult> {
  const results: BatchOutreachResult['results'] = [];
  let sent = 0;

  for (const seed of seeds) {
    const outcome = await startOutreach(seed, { whatsappStatus: seed.whatsappStatus, testNumber: options.testNumber });
    results.push({ providerId: seed.providerId, displayName: seed.displayName, outcome });
    if (outcome.ok) sent += 1;
    if (!outcome.ok && outcome.reason === 'DAILY_LIMIT_REACHED') break;
  }

  return { sent, results };
}
