const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

/**
 * Cliente mínimo de Gemini para el chat de WhatsApp.
 *
 * Vive aparte de `gemini.ts` a propósito: aquel mueve la curaduría (streams largos, búsqueda web,
 * lanzadores de CLI) y un turno de chat no necesita nada de eso. Es una llamada HTTP a
 * `generateContent` con herramientas, y nada más.
 *
 * Por qué API y no el CLI de Codex que usaba antes el chat: el CLI arrancaba un proceso por turno,
 * metía ~13k tokens de andamiaje, tardaba hasta 25 s y arrastraba instrucciones de la máquina donde
 * corría. Además leía el disco del servidor con el texto de un desconocido en el prompt. La API
 * responde en ~1.5 s y el modelo solo puede tocar las herramientas que le damos aquí.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Un modelo rápido y barato: un turno de chat son un par de frases, no una investigación. */
const DEFAULT_CHAT_MODEL = 'gemini-3.5-flash-lite';

/** Si el modelo no contesta en este tiempo, el proveedor recibe el mensaje de respaldo. */
const REQUEST_TIMEOUT_MS = 15_000;

export type GeminiPart = {
  text?: string;
  /** Razonamiento interno del modelo: nunca se muestra al proveedor. */
  thought?: boolean;
  /** Firma que Gemini exige de vuelta, intacta, en el siguiente turno de una llamada a herramienta. */
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
};

export type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

export type FunctionDeclaration = {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
};

export type GenerateRequest = {
  systemInstruction: string;
  contents: GeminiContent[];
  tools: FunctionDeclaration[];
};

/** La forma de la llamada al modelo; las pruebas pasan una falsa con la misma firma. */
export type GenerateFn = (request: GenerateRequest) => Promise<GeminiContent>;

export function chatModel() {
  return env('GEMINI_CHAT_MODEL') || DEFAULT_CHAT_MODEL;
}

export function isGeminiChatConfigured() {
  return Boolean(env('GEMINI_API_KEY'));
}

export const geminiGenerate: GenerateFn = async (request) => {
  const apiKey = env('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_NOT_CONFIGURED');

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: request.systemInstruction }] },
    contents: request.contents,
    tools: request.tools.length ? [{ functionDeclarations: request.tools }] : undefined,
    generationConfig: { temperature: 0.8, maxOutputTokens: 1024 },
  });

  // Un solo reintento, y solo para lo que suele ser pasajero (cupo o caída del servicio). Más
  // reintentos harían esperar al proveedor más de lo que tarda en irse.
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${API_BASE}/${encodeURIComponent(chatModel())}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      const payload = await response.json() as { candidates?: Array<{ content?: GeminiContent; finishReason?: string }> };
      const content = payload.candidates?.[0]?.content;
      if (!content?.parts?.length) {
        throw new Error(`GEMINI_CHAT_EMPTY_RESPONSE ${payload.candidates?.[0]?.finishReason ?? ''}`.trim());
      }
      return { role: 'model', parts: content.parts };
    }

    const transient = response.status === 429 || response.status >= 500;
    if (!transient || attempt >= 1) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`GEMINI_CHAT_HTTP_${response.status} ${detail}`);
    }
  }
};

/** El texto visible de una respuesta del modelo, sin su razonamiento interno. */
export function visibleText(content: GeminiContent): string {
  return content.parts
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('')
    .trim();
}
