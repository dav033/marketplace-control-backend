import { fillTemplate, getTemplateInfo, isWhatsappConfigured, resolveTestTarget, sendTemplate } from './whatsapp';
import { countOutreachWindows, getConversation, isSuppressed, recordOutboundMessage, startConversation } from './whatsapp-store';
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
 * EL CUPO: un ritmo diario y un pool semanal del que un día puntual puede tomar prestado.
 *
 * Meta asigna un cupo que sube o baja según la calidad de la cuenta, y la calidad baja cuando la
 * gente bloquea o reporta. Gastarlo de golpe el primer día es la forma rápida de que lo recorten.
 * Pero atarse a un número fijo por día desperdicia la semana: los días sin candidatos listos no se
 * recuperan nunca.
 *
 * De ahí los tres topes, cada uno con un trabajo distinto:
 *   - `dailyLimit()` es el RITMO: lo que sale en un día sin tocar el pool.
 *   - `weeklyLimit()` es el PRESUPUESTO real: nada puede pasarse de aquí.
 *   - `dailyBurstLimit()` es el TECHO de un día: hasta aquí puede estirarse tomando prestado, y ni
 *     uno más, para que un día con el pool intacto no dispare la semana entera de una sentada.
 *
 * Las dos ventanas son móviles —últimas 24 horas y últimos 7 días—, igual que el cupo diario de
 * antes: el pool se recupera solo y no hay día de reinicio en el que se pierda lo que no se usó.
 */
const DEFAULT_DAILY_LIMIT = 30;
const WEEKLY_POOL_DAYS = 7;
const DEFAULT_BURST_MULTIPLIER = 2;

export type OutreachResult =
  | { ok: true; to: string; deliveredTo: string; templateName: string }
  | {
      ok: false;
      reason: 'WHATSAPP_NOT_CONFIGURED' | 'TEMPLATE_NOT_CONFIGURED' | 'PHONE_MISSING'
        | 'ALREADY_CONTACTED' | 'SUPPRESSED' | 'DAILY_LIMIT_REACHED' | 'WEEKLY_LIMIT_REACHED'
        | 'SEND_FAILED' | 'NOT_FOUND';
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

/** Un entero positivo, o el de respaldo: un valor ilegible no puede ensanchar el cupo. */
function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** El ritmo: lo que sale en 24 horas sin tocar el pool de la semana. */
export function dailyLimit(): number {
  return positiveInt(env('WHATSAPP_DAILY_OUTREACH_LIMIT'), DEFAULT_DAILY_LIMIT);
}

/** El presupuesto de los últimos 7 días. Por defecto, la semana entera al ritmo diario. */
export function weeklyLimit(): number {
  return positiveInt(env('WHATSAPP_WEEKLY_OUTREACH_LIMIT'), dailyLimit() * WEEKLY_POOL_DAYS);
}

/**
 * El techo de un día, prestado incluido.
 *
 * Nunca por debajo del ritmo diario —un techo más bajo que el ritmo lo dejaría sin sentido— ni por
 * encima del presupuesto semanal, que es el que manda sobre todo lo demás.
 */
export function dailyBurstLimit(): number {
  const configured = positiveInt(env('WHATSAPP_DAILY_OUTREACH_BURST'), dailyLimit() * DEFAULT_BURST_MULTIPLIER);
  return Math.min(weeklyLimit(), Math.max(dailyLimit(), configured));
}

/**
 * Desde cuándo cuenta el cupo. Sin valor, cuenta todo lo que caiga en las dos ventanas.
 *
 * Existe para poder empezar de cero —subir el ritmo y no arrastrar lo que ya salió con el anterior—
 * sin borrar `whatsapp_sent_at`, que es el historial de cuándo se contactó a cada proveedor. Se
 * apaga solo: pasados 7 días queda por detrás de las dos ventanas y deja de restar nada.
 *
 * Un valor ilegible o en el futuro se ignora. Este es el único ajuste del cupo que lo ENSANCHA, así
 * que equivocarse aquí tiene que contar de más, nunca de menos.
 */
export function quotaEpoch(): Date | undefined {
  const raw = String(env('WHATSAPP_QUOTA_EPOCH') ?? '').trim();
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() > Date.now()) return undefined;
  return parsed;
}

export type OutreachBlockReason = 'DAILY_LIMIT_REACHED' | 'WEEKLY_LIMIT_REACHED';

export type OutreachAllowance = {
  dailyLimit: number;
  weeklyLimit: number;
  burstLimit: number;
  sentToday: number;
  sentThisWeek: number;
  /** Lo que queda del pool de la semana. */
  weeklyRemaining: number;
  /** Cuántos se pueden enviar ahora mismo, contando lo prestado. */
  available: number;
  /** De esos, cuántos caben en el ritmo diario sin tocar el pool. */
  base: number;
  /** Y cuántos saldrían prestados de la semana. */
  borrowed: number;
  /** Cuál de los dos topes se agota primero; es el motivo con el que se rechaza al llegar a cero. */
  exhaustedReason: OutreachBlockReason;
  /** Solo cuando ya no cabe ni un envío más. */
  blocked?: OutreachBlockReason;
  /** Desde cuándo cuenta, si se puso a cero a mano. Sin esto, cuentan las dos ventanas enteras. */
  countingSince?: string;
};

/**
 * La aritmética del cupo, aparte de la base para poder probarla sin ella.
 *
 * `available` es lo único que decide si se envía: el mínimo entre lo que le queda al día y lo que le
 * queda a la semana. `base` y `borrowed` solo parten esa cifra en dos para poder decir en el panel
 * cuánto se está tomando prestado.
 */
export function computeAllowance(input: {
  sentToday: number; sentThisWeek: number; daily: number; weekly: number; burst: number;
}): OutreachAllowance {
  const weeklyRemaining = Math.max(0, input.weekly - input.sentThisWeek);
  const burstRemaining = Math.max(0, input.burst - input.sentToday);
  const available = Math.min(burstRemaining, weeklyRemaining);
  const base = Math.min(Math.max(0, input.daily - input.sentToday), available);
  // En empate manda la semana: esperar a mañana devuelve cupo del día, pero no devuelve pool.
  const exhaustedReason: OutreachBlockReason = weeklyRemaining <= burstRemaining ? 'WEEKLY_LIMIT_REACHED' : 'DAILY_LIMIT_REACHED';
  return {
    dailyLimit: input.daily,
    weeklyLimit: input.weekly,
    burstLimit: input.burst,
    sentToday: input.sentToday,
    sentThisWeek: input.sentThisWeek,
    weeklyRemaining,
    available,
    base,
    borrowed: available - base,
    exhaustedReason,
    ...(available === 0 ? { blocked: exhaustedReason } : {}),
  };
}

/** El cupo ahora mismo: lo enviado en 24 horas y en 7 días, contra los tres topes. */
export async function outreachAllowance(): Promise<OutreachAllowance> {
  const epoch = quotaEpoch();
  const { day, week } = await countOutreachWindows(epoch);
  return {
    ...(epoch ? { countingSince: epoch.toISOString() } : {}),
    ...computeAllowance({
      sentToday: day, sentThisWeek: week,
      daily: dailyLimit(), weekly: weeklyLimit(), burst: dailyBurstLimit(),
    }),
  };
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

  const cupo = await outreachAllowance();
  if (cupo.blocked) return { ok: false, reason: cupo.blocked };

  // Cada plantilla trae lo suyo: la de invitación lleva dos huecos (negocio y ciudad) y otras, como la
  // de presentación, ninguno. Mandar parámetros de más hace que Meta rechace el envío entero, así que
  // se manda solo los que la plantilla aprobada espera. Si no se puede consultar, se asumen los dos.
  const templateInfo = await getTemplateInfo(templateName);
  const parameters = [seed.displayName.trim(), seed.city ?? 'tu ciudad'].slice(0, templateInfo?.variables ?? 2);
  try {
    // En modo prueba se envía directo al teléfono de prueba elegido (`sendTemplate` lo respeta).
    await sendTemplate(redirect ?? realTo, templateName, templateInfo?.language ?? (env('WHATSAPP_OUTREACH_LANGUAGE') || 'es'), parameters, { exact: Boolean(redirect) });
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
 * Se para en cuanto el cupo se agota —por el día o por la semana— en vez de seguir intentando: cada
 * rechazo por límite es una llamada a Meta que no aporta nada y ensucia las métricas de la cuenta.
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
    if (!outcome.ok && (outcome.reason === 'DAILY_LIMIT_REACHED' || outcome.reason === 'WEEKLY_LIMIT_REACHED')) break;
  }

  return { sent, results };
}
