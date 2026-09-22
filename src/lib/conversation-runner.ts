import { isPlainYesNo, seedDraft, type RegistrationDraft, type SeedProvider } from './registration-chat';
import { REGISTER_URL } from './registration-fields';
import { outreachTranscript } from './whatsapp-outreach';
import { saveConversationalRegistration, updateConversationalRegistration } from './registration-intake';
import { converse, HISTORY_LIMIT, type AgentResult, type ChatTurn } from './conversation-agent';
import { geminiGenerate, isGeminiChatConfigured, type GenerateFn } from './gemini-chat';
import { loadProviderProfile, loadRegistrationStatus, type ProviderProfile, type RegistrationStatus } from './provider-profile';
import { applyStatusEvents, type StatusChange, type StatusEvent } from './conversation-status';

/**
 * El turno de conversación, compartido por WhatsApp y por el chat de prueba local.
 *
 * Que los dos pasen por aquí es el motivo de que el chat local sirva de algo: si probaras el agente
 * con otro código, estarías probando otro agente.
 *
 * Quién decide qué:
 * - El agente (`conversation-agent.ts`) lleva la conversación y propone datos.
 * - Este archivo decide la autorización de datos, guarda la ficha y la actualiza. Son las dos cosas
 *   que no se pueden dejar a un modelo: una autorización inventada no se puede deshacer.
 */

export type ConversationState = {
  draft: RegistrationDraft;
  /** Cerrada porque no le interesa. Si vuelve a escribir, la conversación se reabre. */
  finished: boolean;
  /** La ficha ya está guardada: a partir de aquí el agente hace seguimiento. */
  submissionId?: string;
  /** El candidato del que salió la conversación, si se inició desde uno. */
  seed?: SeedProvider;
  /** Memoria del agente: los últimos mensajes. El historial completo está en `whatsapp_messages`. */
  history?: ChatTurn[];
  /** Autorización de tratamiento de datos. La decide el código a partir del mensaje literal. */
  consent?: 'pending' | 'granted' | 'denied';
  /**
   * La conversación es una simulación lanzada desde el panel (`whatsapp-simulation.ts`): quien
   * escribe hace de proveedor. La ficha se guarda marcada y no cambia el estado del proveedor real.
   */
  simulation?: { startedAt: number };
  /**
   * La invitación salió en modo prueba (`WHATSAPP_REDIRECT_ALL_TO`): quien contesta es alguien del
   * equipo con el teléfono de pruebas, no el proveedor. El estado de contacto se guarda igual (es lo
   * que se está probando), pero la ficha que resulte va marcada como prueba y no lo inscribe.
   */
  testRedirect?: { realPhone: string };
  /**
   * En qué punto está el contacto (`conversation-status.ts`). Se calcula en cada turno; quien llama
   * lo guarda en el proveedor solo si la conversación es real (no simulación ni chat de prueba).
   */
  whatsapp?: StatusChange;
  /** Ya se le pasó el enlace de registro (solo se manda una vez, y solo si su ciudad está abierta). */
  registerLinkSent?: boolean;
};

export type TurnResult = {
  reply: string;
  state: ConversationState;
  /** Para que quien llama pueda registrar el desenlace sin volver a deducirlo. */
  outcome: 'reply' | 'submitted' | 'declined' | 'save-failed' | 'unavailable' | 'error';
};

export type TurnSource = {
  channel: 'whatsapp' | 'chat-prueba';
  handle: string;
  profileName?: string | null;
};

/** Lo que el turno necesita del exterior. Las pruebas lo sustituyen para no tocar red ni base. */
export type TurnDeps = {
  generate: GenerateFn;
  agentAvailable: () => boolean;
  loadProfile: (providerId: string) => Promise<ProviderProfile | null>;
  loadRegistration: (submissionId: string) => Promise<RegistrationStatus | null>;
  save: typeof saveConversationalRegistration;
  update: typeof updateConversationalRegistration;
};

const defaultDeps: TurnDeps = {
  generate: geminiGenerate,
  agentAvailable: isGeminiChatConfigured,
  loadProfile: loadProviderProfile,
  loadRegistration: loadRegistrationStatus,
  save: saveConversationalRegistration,
  update: updateConversationalRegistration,
};

/**
 * El texto legal de la autorización. Lo añade el código, nunca lo redacta el agente: tiene que ser
 * siempre el mismo para que la versión que se guarda (`consent_text_version`) diga la verdad.
 */
/**
 * El enlace de registro, cuando su ciudad ya está abierta.
 *
 * Lo añade el código y no el agente: pedírselo al modelo salía unas veces sí y otras no, y el
 * enlace es justo lo que el proveedor necesita para quedar listo sin esperar a nadie. Va una sola
 * vez, en cuanto muestra interés, y nunca donde todavía no hemos abierto.
 */
export function registerInvitation(city: string): string {
  return `Y si quieres dejarlo listo tú mismo: Happia ya está abierto en ${city} y puedes completar tu registro en pocos minutos aquí 👉 ${REGISTER_URL}`;
}

export const CONSENT_TEXT = 'Para guardar tu ficha necesito tu autorización para tratar estos datos con el fin de evaluarte como proveedor de Happia. ¿Me la das? Responde "sí" o "no".';

/**
 * La confirmación de que quedó registrado. La escribe el código y no el agente: es el momento que
 * el proveedor tiene que leer sin ambigüedad, y un modelo lo redacta distinto cada vez ("ya
 * guardamos tu información", "quedó todo listo"...).
 */
export function registrationConfirmation(draft: RegistrationDraft): string {
  const nombre = draft.full_name?.split(/\s+/)[0];
  return `¡Listo${nombre ? `, ${nombre}` : ''}! Te hemos registrado en nuestro sistema. Una persona del equipo revisará tu información y se pondrá en contacto contigo más adelante. Si quieres cambiar o agregar algo, escríbeme cuando quieras.`;
}

const FALLBACK_REPLY = 'Perdona, tuve un problema para responderte. ¿Me escribes de nuevo en un momento?';
const UNAVAILABLE_REPLY = 'Gracias por escribirnos. En este momento no puedo responderte, pero una persona del equipo se pondrá en contacto contigo más adelante.';

export function emptyState(): ConversationState {
  return { draft: {}, finished: false, history: [] };
}

/**
 * Arranca una conversación desde un candidato ya conocido, con sus datos precargados.
 *
 * `opening` es lo que le escribimos primero (el reflejo de la plantilla de Meta), si fuimos
 * nosotros: el agente tiene que saber qué le dijimos para que su primera respuesta tenga sentido.
 */
export function stateFromProvider(seed: SeedProvider, opening?: string): ConversationState {
  return {
    draft: seedDraft(seed),
    finished: false,
    seed,
    history: opening ? [{ role: 'model', text: opening }] : [],
  };
}

/**
 * El primer mensaje que se muestra en el chat de prueba.
 *
 * Cuando escribimos nosotros, lo que el proveedor recibe es la PLANTILLA aprobada por Meta, no un
 * texto del agente: fuera de la ventana de 24h un texto libre lo rechaza la API.
 */
export function greeting(seed?: SeedProvider): string {
  return seed ? outreachTranscript(seed) : '';
}

/**
 * Estados guardados por el bot anterior: allí `finished` también significaba "ficha guardada", y
 * ahora una ficha guardada sigue conversando. Se traducen al leerlos en vez de migrar la tabla.
 */
function normalize(state: ConversationState): ConversationState {
  return {
    ...state,
    finished: state.finished && !state.submissionId,
    history: state.history ?? [],
    consent: state.consent ?? (state.submissionId || state.draft.privacy_consent ? 'granted' : undefined),
  };
}

const CONSENT_YES = /^(?:(?:bueno|pues|ok|okay|listo|ah|ahh|claro)[\s,.!]+)?(?:s[ií]+|claro|dale|acepto|autorizo|de acuerdo|de una|h[aá]gale|ok|okay|vale|listo|confirmo|por supuesto|con gusto|perfecto)(?!\p{L})/iu;
const CONSENT_NO = /^(?:no|nop|nel|no autorizo|prefiero que no|mejor no)(?!\p{L})/iu;
/** "si" sin tilde seguido de otra palabra suele ser condicional ("si tengo una duda..."), no un sí. */
const CONDITIONAL_SI = /^si\s+(?!(?:claro|se[ñn]or|se[ñn]ora|autorizo|acepto|dale|listo|de acuerdo|por supuesto|gracias|perfecto|ok|okay|con gusto)(?!\p{L}))\p{L}/iu;

/**
 * Lee la respuesta a la autorización sin modelo de por medio.
 *
 * Solo un sí o un no claros cuentan. Una pregunta ("¿para qué es?") o un "no sé" dejan la
 * autorización pendiente: el agente la explica y la vuelve a pedir. Preferimos repreguntar a
 * guardar datos de alguien que no dijo que sí.
 */
export function readConsentReply(input: string): 'yes' | 'no' | undefined {
  const text = input.trim();
  if (!text || text.includes('?') || /^no s[eé](?!\p{L})/iu.test(text)) return undefined;
  if (CONSENT_NO.test(text)) return 'no';
  if (CONSENT_YES.test(text) && !CONDITIONAL_SI.test(text)) return 'yes';
  return undefined;
}

function remember(history: ChatTurn[], ...turns: ChatTurn[]): ChatTurn[] {
  return [...history, ...turns].slice(-HISTORY_LIMIT);
}

function draftChanged(before: RegistrationDraft, after: RegistrationDraft) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export async function runTurn(
  initial: ConversationState,
  input: string,
  source: TurnSource,
  overrides: Partial<TurnDeps> = {},
): Promise<TurnResult> {
  const deps = { ...defaultDeps, ...overrides };
  // Si vuelve a escribir alguien que había dicho que no, se le atiende: nos escribe él.
  let state: ConversationState = { ...normalize(initial), finished: false };
  const history = state.history ?? [];

  // El estado del contacto se va construyendo con los eventos del turno y se resuelve al final
  // (o en cada salida temprana), siempre con las mismas reglas de `nextStatus`.
  const initialStatus: StatusChange = state.whatsapp ?? { status: null, reason: null };
  const events: StatusEvent[] = [{ type: 'inbound' }];
  const withStatus = (next: ConversationState, extra: StatusEvent[] = []): ConversationState => ({
    ...next,
    whatsapp: applyStatusEvents(initialStatus, [...events, ...extra]),
  });

  if (!deps.agentAvailable()) {
    console.error('chat agent no configurado: falta GEMINI_API_KEY', { handle: source.handle });
    return {
      reply: UNAVAILABLE_REPLY,
      state: withStatus({ ...state, history: remember(history, { role: 'user', text: input }, { role: 'model', text: UNAVAILABLE_REPLY }) }),
      outcome: 'unavailable',
    };
  }

  // 1. La autorización se decide aquí, sobre lo que escribió, antes de que el modelo lo lea.
  const notes: string[] = [];
  let outcome: TurnResult['outcome'] = 'reply';
  let confirmation: string | undefined;
  if (state.consent === 'pending' && !state.submissionId) {
    const answer = readConsentReply(input);
    if (answer === 'yes') {
      state = { ...state, consent: 'granted', draft: { ...state.draft, privacy_consent: true } };
    } else if (answer === 'no') {
      state = { ...state, consent: 'denied' };
      events.push({ type: 'consent_denied' });
      notes.push('el proveedor NO autorizó guardar su ficha; no se guardó nada. Respeta su decisión sin insistir.');
    } else {
      notes.push('la autorización sigue pendiente: su mensaje no fue un sí o un no claro.');
    }
  }

  // 2. Con la autorización recién dada, la ficha se guarda con lo que haya: una persona del equipo
  //    completa lo que falte. Se guarda ANTES de contestar para que el agente sepa si quedó o no.
  if (state.consent === 'granted' && !state.submissionId) {
    const saved = await deps.save(state.draft, {
      ...source,
      providerId: state.seed?.providerId,
      simulationId: state.simulation
        ? String(state.simulation.startedAt)
        : state.testRedirect ? `redirect-${Date.now()}` : undefined,
    });
    if (saved.ok) {
      state = { ...state, submissionId: saved.submissionId };
      outcome = 'submitted';
      events.push({ type: 'registered' });
      confirmation = registrationConfirmation(state.draft);
      // Un "sí" pelado no necesita al agente: la respuesta es la confirmación y nada más.
      if (isPlainYesNo(input)) {
        return {
          reply: confirmation,
          state: withStatus({ ...state, history: remember(history, { role: 'user', text: input }, { role: 'model', text: confirmation }) }),
          outcome,
        };
      }
      notes.push('el proveedor autorizó y su ficha YA quedó registrada. El sistema le envía la confirmación del registro justo antes de tu mensaje: no la repitas ni agradezcas el registro. Atiende solo lo demás que dijo en su mensaje, en una o dos frases.');
    } else if (saved.reason === 'ALREADY_SUBMITTED') {
      notes.push('el proveedor autorizó; su ficha ya estaba guardada de antes y está en revisión.');
    } else {
      console.error('conversational registration not saved', saved.reason, source);
      outcome = 'save-failed';
      notes.push('el proveedor autorizó, pero la ficha NO se pudo guardar por un problema técnico. Dile que el equipo ya está avisado y lo contacta pronto. No digas que quedó guardada.');
    }
  }

  // 3. El agente conversa.
  let result: AgentResult;
  let profile: ProviderProfile | null = null;
  try {
    const registration = state.submissionId ? await deps.loadRegistration(state.submissionId) : null;
    profile = state.seed?.providerId ? await deps.loadProfile(state.seed.providerId) : null;
    result = await converse({
      userMessage: input,
      draft: state.draft,
      history,
      profile,
      profileName: source.profileName,
      consent: state.consent,
      // Recién guardada, la consulta puede no traer nada si no hay base (chat de prueba sin
      // PostgreSQL); el agente igual tiene que saber que ya está guardada.
      registration: registration ?? (state.submissionId ? { submissionStatus: 'new', providerStatus: null, receivedOn: 'hoy' } : null),
      systemNote: notes.join(' ') || undefined,
      status: applyStatusEvents(initialStatus, events),
    }, deps.generate);
  } catch (error) {
    console.error('chat agent turn failed', source.handle, error instanceof Error ? error.message : error);
    // Si la ficha acababa de guardarse, la confirmación sale igual: es lo que el proveedor necesita saber.
    const reply = confirmation ?? FALLBACK_REPLY;
    return {
      reply,
      state: withStatus({ ...state, history: remember(history, { role: 'user', text: input }, ...(confirmation ? [{ role: 'model' as const, text: confirmation }] : [])) }),
      outcome: outcome === 'reply' ? 'error' : outcome,
    };
  }

  if (result.rejected.length) {
    console.error('registro: el agente propuso datos no admitidos', { handle: source.handle, rechazados: result.rejected });
  }

  // 4. Seguimiento: si la ficha ya estaba guardada y el proveedor cambió algo, se actualiza.
  if (state.submissionId && draftChanged(state.draft, result.draft)) {
    const updated = await deps.update(state.submissionId, state.draft, result.draft, source);
    if (!updated) console.error('registro: no se pudo actualizar la ficha guardada', { handle: source.handle, submissionId: state.submissionId });
  }

  let reply = confirmation ? `${confirmation}\n\n${result.reply}` : result.reply;
  let consent = state.consent;
  if (result.askedConsent && !state.submissionId) {
    reply = `${reply}\n\n${CONSENT_TEXT}`;
    consent = 'pending';
  }

  // Ciudad abierta e interés: el registro no tiene que esperar a la conversación. Se le pasa el
  // enlace una sola vez, y no en el turno de la autorización para no mezclar dos peticiones.
  let registerLinkSent = state.registerLinkSent;
  if (profile?.cityOpen && result.interest && !result.declined && !registerLinkSent
      && !state.submissionId && !state.consent && !result.askedConsent) {
    reply = `${reply}\n\n${registerInvitation(profile.city)}`;
    registerLinkSent = true;
  }

  // Lo que el agente clasificó en este turno. El interés va primero: quien cuenta de su negocio y
  // luego se echa atrás pasa por "aceptada" y termina en "rechazado", no en "conversación rechazada".
  const agentEvents: StatusEvent[] = [];
  if (result.interest) agentEvents.push({ type: 'interest' });
  if (result.inappropriate) agentEvents.push({ type: 'inappropriate', reason: result.inappropriate });
  else if (result.declined) agentEvents.push({ type: 'decline', reason: result.declineReason ?? 'Dijo que no le interesa' });

  const nextState: ConversationState = withStatus({
    ...state,
    draft: result.draft,
    consent,
    registerLinkSent,
    finished: result.declined,
    history: remember(history, { role: 'user', text: input }, { role: 'model', text: reply }),
  }, agentEvents);

  return { reply, state: nextState, outcome: result.declined ? 'declined' : outcome };
}
