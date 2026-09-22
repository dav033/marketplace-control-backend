import { isWhatsappConfigured, sendTemplate } from './whatsapp';
import { countOutreachToday, getConversation, isSuppressed, recordOutboundMessage, saveOutreach } from './whatsapp-store';
import { stateFromProvider } from './conversation-runner';
import type { SeedProvider } from './registration-chat';

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
 * Por ejemplo: "Hola, escribimos de Marketplace Control. Encontramos a {{1}} en {{2}} y nos
 * gustaría sumarte a nuestro catálogo de proveedores para eventos. ¿Te interesa?"
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
  | { ok: true; to: string; templateName: string }
  | {
      ok: false;
      reason: 'WHATSAPP_NOT_CONFIGURED' | 'TEMPLATE_NOT_CONFIGURED' | 'PHONE_MISSING'
        | 'ALREADY_CONTACTED' | 'SUPPRESSED' | 'DAILY_LIMIT_REACHED' | 'SEND_FAILED';
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
  const lugar = seed.city ? ` en ${seed.city}` : '';
  return `Hola, escribimos de Marketplace Control. Encontramos a ${seed.displayName}${lugar} y nos gustaría sumarte a nuestro catálogo de proveedores para eventos. ¿Te interesa?`;
}

export function dailyLimit(): number {
  const configured = Number(env('WHATSAPP_DAILY_OUTREACH_LIMIT'));
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_DAILY_LIMIT;
}

export async function startOutreach(seed: SeedProvider): Promise<OutreachResult> {
  if (!isWhatsappConfigured()) return { ok: false, reason: 'WHATSAPP_NOT_CONFIGURED' };

  const templateName = env('WHATSAPP_OUTREACH_TEMPLATE');
  if (!templateName) return { ok: false, reason: 'TEMPLATE_NOT_CONFIGURED' };

  const to = toWhatsappNumber(seed.phone);
  if (!to) return { ok: false, reason: 'PHONE_MISSING' };

  // Quien pidió que no le escribamos manda sobre todo lo demás, incluso sobre una campaña nueva.
  if (await isSuppressed(to)) return { ok: false, reason: 'SUPPRESSED' };

  // No se escribe dos veces al mismo número por iniciativa nuestra: insistir a quien no ha
  // contestado es justo lo que hace que a una cuenta le bajen la calidad y acabe bloqueada.
  if (await getConversation(to)) return { ok: false, reason: 'ALREADY_CONTACTED' };

  if (await countOutreachToday() >= dailyLimit()) return { ok: false, reason: 'DAILY_LIMIT_REACHED' };

  try {
    await sendTemplate(to, templateName, env('WHATSAPP_OUTREACH_LANGUAGE') || 'es', [
      seed.displayName,
      seed.city ?? 'tu ciudad',
    ]);
  } catch (error) {
    console.error('whatsapp outreach failed', to, error instanceof Error ? error.message : error);
    return { ok: false, reason: 'SEND_FAILED' };
  }

  // La conversación queda preparada con los datos del candidato y con lo que le dijimos: cuando
  // conteste, el agente sabe a quién le escribió y qué le propuso.
  const transcript = outreachTranscript(seed);
  await saveOutreach(to, seed, stateFromProvider(seed, transcript));
  await recordOutboundMessage(to, transcript);

  return { ok: true, to, templateName };
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
export async function startOutreachBatch(seeds: SeedProvider[]): Promise<BatchOutreachResult> {
  const results: BatchOutreachResult['results'] = [];
  let sent = 0;

  for (const seed of seeds) {
    const outcome = await startOutreach(seed);
    results.push({ providerId: seed.providerId, displayName: seed.displayName, outcome });
    if (outcome.ok) sent += 1;
    if (!outcome.ok && outcome.reason === 'DAILY_LIMIT_REACHED') break;
  }

  return { sent, results };
}
