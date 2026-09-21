/**
 * La interfaz no nombra al proveedor de IA.
 *
 * Qué motor hace la investigación (Gemini, Codex, Claude Code) es una decisión de operación que se
 * cambia con una variable de entorno, y el operador del panel no debería verla ni tener que
 * entenderla: para él siempre es «el agente de búsqueda». Además evita que un cambio de proveedor
 * deje textos mintiendo en pantalla.
 *
 * Los registros del servidor (`curation.claude_run`, `console.error`) SÍ conservan el detalle
 * crudo: ahí es donde se diagnostica, y ahí no lo ve nadie de fuera.
 */

/** Cómo se llama el agente en la interfaz, pase lo que pase por debajo. */
export const AGENT_LABEL = 'agente de búsqueda';

const PROVIDER_PATTERN = /\b(gemini|codex|claude(?:\s+code)?|openai|anthropic|google\s+search)\b/gi;

/**
 * Mensajes de fallo en términos del operador, no del proveedor.
 *
 * Se mapea por código porque los códigos son estables; lo que venga sin mapear pasa por el filtro
 * genérico, que es lo que impide que un mensaje nuevo del CLI se cuele con su marca.
 */
const FAILURE_MESSAGES: Array<{ match: RegExp; message: string }> = [
  { match: /^(GEMINI_NOT_CONFIGURED|CODEX_NOT_FOUND|CLAUDE_CODE_NOT_FOUND)/, message: 'El agente de búsqueda no está disponible en el servidor. Avisa a quien administra el panel.' },
  { match: /^(GEMINI_RATE_LIMITED)/, message: 'El agente de búsqueda alcanzó su límite de uso. Inténtalo de nuevo en unos minutos.' },
  { match: /_MAX_TURNS/, message: 'El agente de búsqueda se quedó sin margen antes de terminar. Prueba con menos proveedores objetivo.' },
  { match: /_TIMEOUT/, message: 'El agente de búsqueda tardó demasiado y se detuvo. Inténtalo de nuevo.' },
  { match: /_EMPTY_RESPONSE|_EMPTY_STREAM/, message: 'El agente de búsqueda terminó sin entregar resultados. Inténtalo de nuevo.' },
];

/**
 * Deja un texto listo para mostrarse: mensaje conocido si se reconoce el código, y si no, el texto
 * original con cualquier marca de proveedor sustituida.
 */
export function neutralizeAgentText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const known = FAILURE_MESSAGES.find((entry) => entry.match.test(trimmed));
  if (known) return known.message;
  return trimmed.replace(PROVIDER_PATTERN, AGENT_LABEL);
}
