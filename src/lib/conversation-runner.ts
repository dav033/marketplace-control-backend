import { advance, openingMessage, seedDraft, type RegistrationDraft, type SeedProvider } from './registration-chat';
import { outreachTranscript } from './whatsapp-outreach';
import { saveConversationalRegistration } from './registration-intake';
import { FIELD_HINTS, isPlainYesNo, nextStep, splitItems, stripLeadingYesNo } from './registration-chat';
import { findProhibited } from './prohibited-items';
import { composeOffScriptReply, interpretAnswer, isChatAgentConfigured } from './chat-agent';

/**
 * El turno de conversación, compartido por WhatsApp y por el chat de prueba local.
 *
 * Que los dos pasen por aquí es el motivo de que el chat local sirva de algo: si probaras el bot
 * con otro código, estarías probando otro bot.
 */

export type ConversationState = {
  draft: RegistrationDraft;
  finished: boolean;
  submissionId?: string;
  /** El candidato del que salió la conversación, si se inició desde uno. */
  seed?: SeedProvider;
};

export type TurnResult = {
  reply: string;
  state: ConversationState;
  /** Para que quien llama pueda registrar el desenlace sin volver a deducirlo. */
  outcome: 'opening' | 'question' | 'retry' | 'declined' | 'submitted' | 'already-finished' | 'save-failed';
};

export function emptyState(): ConversationState {
  return { draft: {}, finished: false };
}

/** Arranca una conversación desde un candidato ya conocido, con sus datos precargados. */
export function stateFromProvider(seed: SeedProvider): ConversationState {
  return { draft: seedDraft(seed), finished: false, seed };
}

/**
 * El primer mensaje.
 *
 * Cuando escribimos nosotros, lo que el proveedor recibe es la PLANTILLA aprobada por Meta, no un
 * texto que redacte el bot: fuera de la ventana de 24h un texto libre lo rechaza la API. Aquí se
 * devuelve el reflejo de esa plantilla para que el chat de prueba enseñe lo mismo que verá él.
 */
export function greeting(seed?: SeedProvider): string {
  return seed ? outreachTranscript(seed) : openingMessage();
}

export async function runTurn(
  state: ConversationState,
  input: string,
  source: { channel: 'whatsapp' | 'chat-prueba'; handle: string },
): Promise<TurnResult> {
  if (state.finished) {
    return {
      reply: 'Ya tengo tu registro y está en revisión. Si necesitas cambiar algo, escríbeme y lo anoto para el equipo.',
      state,
      outcome: 'already-finished',
    };
  }

  const seed = state.seed;

  // En los pasos de texto abierto no hay formato que comprobar, asi que se le pregunta antes al
  // agente si esto responde a la pregunta. Lo que devuelva sigue pasando por `advance`, que es quien
  // valida: el agente decide SI es respuesta, el codigo decide si es VALIDA.
  const pendiente = nextStep(state.draft);
  let entrada = input;
  // Un "si" o un "no" pelados NO pasan por el agente: son respuestas a la pregunta pendiente y el
  // parser ya sabe que hacer con ellas (saltar un paso opcional, o repreguntar en uno obligatorio).
  // Mandarlas al agente hacia que leyera "no" como un rechazo del registro entero y cerrara la
  // conversacion de alguien que solo estaba contestando que no a una pregunta.
  // Lo vetado se comprueba sobre lo que ESCRIBIO el proveedor, antes de que el agente toque nada.
  // En pruebas, el agente quitaba "drogas" y "armas" del lote por su cuenta y seguia como si tal
  // cosa: el dato no entraba, pero ni el proveedor se enteraba ni quedaba rastro para quien revisa.
  const rechazarProductos = (vetados: string[]): TurnResult => {
    console.error('registro: contenido no admitido', { handle: source.handle, paso: pendiente?.key, vetados });
    return {
      reply: `No puedo registrar ${vetados.join(' ni ')} en el catálogo: solo listamos productos y servicios para eventos. `
        + 'Si el resto de lo que ofreces sí encaja, escríbemelo de nuevo sin eso.',
      state: { draft: state.draft, finished: false, seed },
      outcome: 'retry',
    };
  };

  // Primera barrera, instantanea, en CUALQUIER paso. Antes solo miraba productos, y en el paso de
  // categorias "lugar, invitacion digital, coito, menaje" pasaba entero: ese paso se queda con las
  // categorias oficiales que reconoce y tira el resto en silencio, asi que nadie veia el "coito".
  const vetadosEnMensaje = findProhibited(splitItems(input));
  if (vetadosEnMensaje.length) return rechazarProductos(vetadosEnMensaje);

  // Solo un si/no PELADO se salta al agente. "no quiero decirtelo" empieza por "no" pero es una
  // negativa con motivo: mandarla al camino deterministico repetia el mismo mensaje fijo en bucle.
  const siONo = isPlainYesNo(input);
  if (pendiente?.openText && !siONo && isChatAgentConfigured()) {
    const lectura = await interpretAnswer({
      userMessage: input,
      pendingQuestion: pendiente.question(state.draft),
      fieldHint: FIELD_HINTS[pendiente.key] ?? 'el dato que pide la pregunta',
      draft: state.draft,
    });
    if (lectura?.kind === 'answer') {
      // Segunda barrera, con criterio: una lista de palabras no cubre la semantica. "asesinar
      // perros" y "sexo" pasaron el filtro de terminos, y son justo lo que el agente si reconoce.
      // El veto del agente vale para cualquier campo de texto libre, no solo productos: una razon
      // social ofensiva tampoco puede entrar al catalogo.
      if (lectura.rejected?.length) {
        console.error('registro: contenido no admitido por el agente', { handle: source.handle, paso: pendiente.key, vetados: lectura.rejected });
        return {
          reply: pendiente.key === 'products'
            ? `No puedo registrar ${lectura.rejected.join(' ni ')} en el catálogo: solo listamos productos y servicios para eventos. `
              + 'Si el resto de lo que ofreces sí encaja, escríbemelo de nuevo sin eso.'
            : 'Eso no lo puedo registrar en el catálogo. Si es tu negocio de verdad, escríbeme el nombre tal como aparece en tu factura o en tus redes.',
          state: { draft: state.draft, finished: false, seed },
          outcome: 'retry',
        };
      }
      entrada = lectura.value;
    } else if (lectura?.kind === 'other') {
      if (lectura.ends) {
        return { reply: lectura.reply, state: { draft: state.draft, finished: true, seed }, outcome: 'declined' };
      }
      return { reply: lectura.reply, state: { draft: state.draft, finished: false, seed }, outcome: 'retry' };
    }
    // `undefined` = el CLI fallo. Se sigue con el parser determinista, que es peor pero no se cuelga.
  }

  const result = advance(state.draft, entrada);

  if (result.type === 'submit') {
    const saved = await saveConversationalRegistration(result.draft, { ...source, providerId: seed?.providerId });
    if (saved.ok) {
      return {
        reply: result.message,
        state: { draft: result.draft, finished: true, submissionId: saved.submissionId, seed },
        outcome: 'submitted',
      };
    }
    if (saved.reason === 'ALREADY_SUBMITTED') {
      return { reply: 'Ya tenía tu registro guardado, así que no lo duplico. Está en revisión.', state: { draft: result.draft, finished: true, seed }, outcome: 'submitted' };
    }
    // El detalle del fallo se queda en el log; al proveedor se le dice lo que le sirve.
    console.error('conversational registration not saved', saved.reason, source);
    return {
      reply: 'Tengo todos tus datos, pero no pude guardarlos en este momento. Ya avisé al equipo y te confirmamos en breve.',
      state: { draft: result.draft, finished: true, seed },
      outcome: 'save-failed',
    };
  }

  if (result.type === 'declined') {
    return { reply: result.message, state: { draft: result.draft, finished: true, seed }, outcome: 'declined' };
  }

  // Aquí es donde el bot dejaba de parecer una persona: `retry` significa que el parser no entendió,
  // y hasta ahora se soltaba una frase fija aunque el proveedor hubiera hecho una pregunta legítima
  // ("¿esto cuesta algo?", "¿quiénes son ustedes?"). El agente redacta una respuesta a eso y vuelve
  // a hacer la pregunta pendiente. Si falla o tarda, se usa la frase fija de siempre.
  // Un "si"/"no" pelado tampoco pasa por el agente aqui: el mensaje fijo de ese paso esta escrito
  // justo para ese caso ("esta si la necesito: sin saber que ofreces no puedo mostrarte") y es
  // mejor que lo que improvisa el agente, ademas de instantaneo.
  if (result.type === 'retry' && !siONo && isChatAgentConfigured()) {
    const pending = nextStep(result.draft);
    const redactada = await composeOffScriptReply({
      userMessage: input,
      pendingQuestion: pending ? pending.question(result.draft) : '',
      draft: result.draft,
    });
    if (redactada) {
      return { reply: redactada, state: { draft: result.draft, finished: false, seed }, outcome: 'retry' };
    }
  }

  // Un mensaje puede traer mas de un dato: "si, me llamo Julian" confirma Y da el nombre. Si solo se
  // leyera el "si", el bot preguntaria justo lo que le acaban de decir. Cuando el paso resuelto era
  // un si/no y queda texto detras, se sigue leyendo el mismo mensaje con el paso siguiente.
  if (result.type === 'question' && siONo) {
    const resto = stripLeadingYesNo(input);
    // Dos palabras minimo: un resto de una sola suele ser muletilla ("si claro"), no un dato.
    if (resto.split(/\s+/).filter(Boolean).length >= 2) {
      const continuacion = await runTurn({ ...state, draft: result.draft }, resto, source);
      // Solo se aprovecha si de verdad avanzo; si el resto no era un dato, se deja la pregunta.
      if (continuacion.state.draft !== result.draft) return continuacion;
    }
  }

  return { reply: result.message, state: { draft: result.draft, finished: false, seed }, outcome: result.type };
}
