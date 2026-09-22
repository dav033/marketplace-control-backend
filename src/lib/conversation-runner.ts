import { seedDraft, type RegistrationDraft, type SeedProvider } from './registration-chat';
import { outreachTranscript } from './whatsapp-outreach';
import { saveConversationalRegistration, updateConversationalRegistration } from './registration-intake';
import { converse, HISTORY_LIMIT, type AgentResult, type ChatTurn } from './conversation-agent';
import { geminiGenerate, isGeminiChatConfigured, type GenerateFn } from './gemini-chat';
import { loadProviderProfile, loadRegistrationStatus, type ProviderProfile, type RegistrationStatus } from './provider-profile';

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
export const CONSENT_TEXT = 'Para guardar tu ficha necesito tu autorización para tratar estos datos con el fin de evaluarte como proveedor del marketplace. ¿Me la das? Responde "sí" o "no".';

const FALLBACK_REPLY = 'Perdona, tuve un problema para responderte. ¿Me escribes de nuevo en un momento?';
const UNAVAILABLE_REPLY = 'Gracias por escribirnos. En este momento no puedo responderte, pero una persona del equipo te contesta pronto por aquí.';

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

  if (!deps.agentAvailable()) {
    console.error('chat agent no configurado: falta GEMINI_API_KEY', { handle: source.handle });
    return {
      reply: UNAVAILABLE_REPLY,
      state: { ...state, history: remember(history, { role: 'user', text: input }, { role: 'model', text: UNAVAILABLE_REPLY }) },
      outcome: 'unavailable',
    };
  }

  // 1. La autorización se decide aquí, sobre lo que escribió, antes de que el modelo lo lea.
  const notes: string[] = [];
  let outcome: TurnResult['outcome'] = 'reply';
  if (state.consent === 'pending' && !state.submissionId) {
    const answer = readConsentReply(input);
    if (answer === 'yes') {
      state = { ...state, consent: 'granted', draft: { ...state.draft, privacy_consent: true } };
    } else if (answer === 'no') {
      state = { ...state, consent: 'denied' };
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
      simulationId: state.simulation ? String(state.simulation.startedAt) : undefined,
    });
    if (saved.ok) {
      state = { ...state, submissionId: saved.submissionId };
      outcome = 'submitted';
      notes.push('el proveedor autorizó y su ficha quedó guardada. Agradécele y cuéntale que una persona del equipo la revisa y lo contacta.');
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
  try {
    const registration = state.submissionId ? await deps.loadRegistration(state.submissionId) : null;
    const profile = state.seed?.providerId ? await deps.loadProfile(state.seed.providerId) : null;
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
    }, deps.generate);
  } catch (error) {
    console.error('chat agent turn failed', source.handle, error instanceof Error ? error.message : error);
    return {
      reply: FALLBACK_REPLY,
      state: { ...state, history: remember(history, { role: 'user', text: input }) },
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

  let reply = result.reply;
  let consent = state.consent;
  if (result.askedConsent && !state.submissionId) {
    reply = `${reply}\n\n${CONSENT_TEXT}`;
    consent = 'pending';
  }

  const nextState: ConversationState = {
    ...state,
    draft: result.draft,
    consent,
    finished: result.declined,
    history: remember(history, { role: 'user', text: input }, { role: 'model', text: reply }),
  };

  return { reply, state: nextState, outcome: result.declined ? 'declined' : outcome };
}
