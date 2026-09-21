import { runCodexCli } from './gemini';
import { neutralizeAgentText } from './agent-identity';
import { CATEGORY_LIST, type RegistrationDraft } from './registration-chat';

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

/**
 * Redacta la respuesta cuando el proveedor se sale del guion.
 *
 * Usa el CLI de Codex, el mismo que ya mueve la curaduría: está instalado y autenticado en la
 * máquina, así que no hace falta ninguna API key aparte.
 *
 * LO QUE ESTE AGENTE **NO** HACE, y es deliberado: no decide qué se pregunta, no valida nada y no
 * rellena la ficha. Solo escribe texto. Los datos siguen entrando por el parser determinista de
 * `registration-chat.ts`, así que una alucinación del modelo no puede meter un correo inventado ni
 * saltarse el consentimiento — como mucho, escribe una frase poco afortunada.
 */

/** Un turno de chat no puede tardar lo que una curaduría: si no contesta pronto, no contesta. */
const MAX_RUNTIME_MS = 25_000;

/**
 * El chat NO comparte modelo con la curaduría.
 *
 * Son trabajos distintos y por eso la variable es propia, aunque hoy coincidan: la curaduría hace
 * decenas de turnos con búsqueda web, y un turno de chat son tres frases.
 *
 * MEDIDO, no supuesto: por este CLI no se puede pedir un modelo sin razonamiento. `gpt-4o-mini` lo
 * rechaza la cuenta ("not supported when using Codex with a ChatGPT account") y el esfuerzo
 * `minimal` lo rechaza la API ("'minimal' is not supported"), así que `low` es el suelo. Y el
 * razonamiento tampoco es lo que cuesta: en las medidas fueron 16-38 tokens. Lo que tarda es el
 * propio CLI, que arranca un proceso y mete ~13k tokens de andamiaje en cada llamada. Por eso aquí
 * va el modelo más rápido disponible y no uno más capaz: subir de escalón solo añadía segundos.
 */
const DEFAULT_CHAT_MODEL = 'gpt-5.6-luna';
const DEFAULT_CHAT_EFFORT = 'low';

/**
 * Señales de que la respuesta no es para un proveedor sino ruido del entorno del CLI.
 *
 * Codex arrastra instrucciones de agente de la máquina donde corre. Con `--ignore-user-config` se
 * corta buena parte, pero en pruebas todavía salió "Uso caveman full para responder breve" — una
 * frase sobre sí mismo que jamás debe llegarle a un proveedor. Cuando se detecta, se descarta la
 * redacción y se usa el mensaje fijo.
 */
const CONTAMINATED_WORDS = [
  'caveman', 'prompt', 'system', 'instrucciones', 'token', 'modelo', 'agente', 'cli',
  'responder breve', 'modo solicitado', 'asistente de ia', 'como ia',
];

function fold(value: string) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function looksContaminated(reply: string): boolean {
  const normalizado = fold(reply);
  return CONTAMINATED_WORDS.some((word) => normalizado.includes(word));
}

export function isChatAgentConfigured() {
  // El binario puede estar en el PATH o configurado a mano; ambos valen.
  return Boolean(env('CODEX_CLI_PATH') || env('CURATION_PROVIDER'));
}

const ROLE = `Eres el asistente de Marketplace Control, un marketplace colombiano de proveedores para eventos.
Hablas por WhatsApp con un proveedor mientras registras su negocio.

Contexto que SI puedes contar, porque es la duda mas frecuente ("de que trata esto", "quienes son",
"que gano yo"):
- Marketplace Control es un catalogo de proveedores para eventos (bodas, cumpleanos, eventos de
  empresa) en Colombia. Quien organiza un evento busca ahi proveedores y los contacta.
- Encontramos su negocio en fuentes publicas y le escribimos para invitarlo al catalogo.
- Estar en el catalogo no tiene costo para el proveedor.
- Le pedimos unos datos basicos; despues una persona del equipo revisa la ficha y lo contacta.
- Puede decir que no en cualquier momento y no se le vuelve a escribir.

Si se niega a dar un dato que hace falta (su nombre, su correo), no insistas con la misma frase:
explicale para que lo necesitamos y que solo lo ve el equipo. Si sigue sin querer, ofrecele que una
persona del equipo lo contacte por este mismo WhatsApp.

Reglas:
- Espanol de Colombia, cercano y profesional, tuteando.
- Muy breve: dos o tres frases como mucho. Es WhatsApp, no un correo.
- No prometas aprobacion, precios, plazos ni volumen de clientes: la revision la hace una persona.
- No inventes datos del marketplace que no esten en este mensaje.
- No pidas documentos, cuentas bancarias ni contrasenas.
- El catalogo es solo de productos y servicios para eventos. Si menciona algo ilegal (drogas, armas,
  municiones, explosivos, servicios sexuales, documentos falsos), no lo tomes como producto valido:
  dile que eso no se puede listar y pidele el resto.
- Nunca menciones que tecnologia o modelo de inteligencia artificial te hace funcionar.
- Termina SIEMPRE repitiendo la pregunta pendiente, para que la conversacion siga avanzando.`;

function describeDraft(draft: RegistrationDraft): string {
  const known: string[] = [];
  if (draft.company_name) known.push(`empresa: ${draft.company_name}`);
  if (draft.full_name) known.push(`contacto: ${draft.full_name}`);
  if (draft.email) known.push(`correo: ${draft.email}`);
  if (draft.services?.length) known.push(`categorías: ${draft.services.join(', ')}`);
  return known.length ? known.join(' · ') : 'todavía no hay datos recogidos';
}

/**
 * Devuelve la respuesta redactada, o `undefined` si el CLI falla o tarda demasiado.
 *
 * El `undefined` es parte del diseño: quien llama vuelve entonces al mensaje fijo de siempre. El
 * bot nunca se queda mudo porque el agente no esté disponible.
 */
export async function composeOffScriptReply(input: {
  userMessage: string;
  pendingQuestion: string;
  draft: RegistrationDraft;
}): Promise<string | undefined> {
  const prompt = `${ROLE}

Datos recogidos hasta ahora: ${describeDraft(input.draft)}.
Categorias oficiales del marketplace: ${CATEGORY_LIST.join(', ')}.

La pregunta que esta pendiente es:
"${input.pendingQuestion}"

El proveedor ha respondido algo que no contesta a esa pregunta:
"${input.userMessage}"

Atiende lo que dice en una o dos frases y vuelve a hacerle la pregunta pendiente.
Responde solo con el mensaje que le enviarias, sin comillas ni explicaciones.`;

  try {
    const run = await runCodexCli({
      prompt,
      role: 'verification',
      context: { jobId: 'chat', scanNumber: 1, role: 'verification' },
      // Una sola vuelta: no tiene que investigar nada, solo redactar.
      maxTurns: 1,
      maxRuntimeMs: MAX_RUNTIME_MS,
      maxIdleMs: MAX_RUNTIME_MS,
      model: env('CHAT_MODEL') || DEFAULT_CHAT_MODEL,
      reasoningEffort: env('CHAT_REASONING_EFFORT') || DEFAULT_CHAT_EFFORT,
      ignoreUserConfig: true,
    });
    const text = run.output.trim();
    if (!text) return undefined;
    if (looksContaminated(text)) {
      console.error('chat agent reply descartada por contaminación del entorno', text.slice(0, 160));
      return undefined;
    }
    // Mismo criterio que en el panel: la respuesta no nombra el motor que la escribió.
    return neutralizeAgentText(text).slice(0, 900);
  } catch (error) {
    console.error('chat agent off-script reply failed', error instanceof Error ? error.message : error);
    return undefined;
  }
}

export type Interpretation =
  /**
   * Es una respuesta: `value` es el dato limpio, que el código todavía tiene que validar.
   * `rejected` son los productos que el agente considera que no pueden ir al catálogo.
   */
  | { kind: 'answer'; value: string; rejected?: string[] }
  /** No es una respuesta: `reply` es qué contestarle, y `ends` si se despidió. */
  | { kind: 'other'; reply: string; ends: boolean };

/**
 * Decide si un mensaje responde a la pregunta pendiente.
 *
 * Existe porque la vía contraria no funciona: en un campo de texto abierto no hay formato que
 * comprobar, así que "hola", "adios", "antes de qué trata todo esto" o cualquier frase suelta
 * "caben" como nombre de empresa. Ir tapando casos con listas de exclusiones siempre deja fuera el
 * siguiente. Aquí se le pregunta al agente, que es lo que sabe hacer.
 *
 * Reparto que no cambia: el agente dice SI es una respuesta y la deja limpia; el código dice si esa
 * respuesta es VÁLIDA, con las mismas reglas del formulario web. Una alucinación puede hacer que se
 * repregunte de más, nunca que entre un dato inválido.
 *
 * Devuelve `undefined` si el CLI falla; quien llama vuelve entonces al parser determinista.
 */
export async function interpretAnswer(input: {
  userMessage: string;
  pendingQuestion: string;
  fieldHint: string;
  draft: RegistrationDraft;
}): Promise<Interpretation | undefined> {
  const prompt = `${ROLE}

Datos recogidos hasta ahora: ${describeDraft(input.draft)}.

La pregunta pendiente es: "${input.pendingQuestion}"
Lo que se espera recoger es: ${input.fieldHint}

El proveedor escribio: "${input.userMessage}"

Decide si ese mensaje RESPONDE a la pregunta pendiente.
- Un saludo ("hola"), una despedida ("adios", "gracias"), una pregunta o un comentario NO son respuestas.
- "ends" es true SOLO si se despide o rechaza TODO el registro ("adios", "no me interesa", "dejame
  en paz"). Contestar que no a la pregunta pendiente NO es rechazar el registro.
- Si responde, extrae solo el dato, sin frases de cortesia alrededor.
${input.fieldHint.includes('productos') ? `
IMPORTANTE para este campo: el catalogo es SOLO de productos y servicios para eventos. Pon en
"rejected" todo lo que no pueda ir al catalogo, tal como lo escribio el proveedor: cualquier cosa
ilegal (drogas, armas, explosivos), sexual, violenta o de dano a personas o animales, y cualquier
cosa que no tenga nada que ver con eventos. No lo corrijas ni lo omitas en silencio: listalo.
` : `
Pon en "rejected" el texto, tal como lo escribio, SOLO si es ofensivo, obsceno, de odio, o una
provocacion evidente en vez de un dato real. Un nombre poco convencional, informal, con faltas o con
referencias religiosas NO es motivo de rechazo: negocios reales se llaman de formas muy variadas y
rechazar a uno de verdad es peor que aceptar una broma, que ademas la revisa despues una persona.
`}
Responde UNICAMENTE con un objeto JSON, sin texto alrededor y sin markdown, con esta forma exacta:
{"answers": true, "value": "<el dato limpio>", "rejected": [<lo que no se puede listar, o vacio>]}
o bien
{"answers": false, "ends": <true si se esta despidiendo o rechazando, si no false>, "reply": "<que le dirias>"}

En "reply": si "ends" es true, despidete en una frase y NO repitas la pregunta pendiente, que la
conversacion se acaba ahi. Si "ends" es false, atiende lo que dice y vuelve a hacerle la pregunta.`;

  try {
    const run = await runCodexCli({
      prompt,
      role: 'verification',
      context: { jobId: 'chat-interpret', scanNumber: 1, role: 'verification' },
      maxTurns: 1,
      maxRuntimeMs: MAX_RUNTIME_MS,
      maxIdleMs: MAX_RUNTIME_MS,
      model: env('CHAT_MODEL') || DEFAULT_CHAT_MODEL,
      reasoningEffort: env('CHAT_REASONING_EFFORT') || DEFAULT_CHAT_EFFORT,
      ignoreUserConfig: true,
    });
    return parseInterpretation(run.output);
  } catch (error) {
    console.error('chat agent interpret failed', error instanceof Error ? error.message : error);
    return undefined;
  }
}

/**
 * El CLI suele devolver el JSON pelado, pero a veces lo envuelve en ```json o lo rodea de texto.
 * Se busca el primer objeto de la cadena en vez de exigir una respuesta perfecta.
 */
export function parseInterpretation(raw: string): Interpretation | undefined {
  const text = raw.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  if (parsed.answers === true) {
    const value = typeof parsed.value === 'string' ? parsed.value.trim() : '';
    if (!value) return undefined;
    const rejected = Array.isArray(parsed.rejected)
      ? parsed.rejected.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
      : [];
    return rejected.length ? { kind: 'answer', value, rejected } : { kind: 'answer', value };
  }
  if (parsed.answers === false) {
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
    if (!reply || looksContaminated(reply)) return undefined;
    return { kind: 'other', reply: reply.slice(0, 900), ends: parsed.ends === true };
  }
  return undefined;
}
