// Registro estructurado de cada ejecución del CLI de Claude Code.
// Se escribe en consola como una línea JSON para poder auditar tiempos, PIDs y motivos de fallo.

export type ClaudeRunRole = 'discovery' | 'verification' | 'single';

export type ClaudeRunContext = {
  jobId: string;
  scanNumber: number;
  role: ClaudeRunRole;
  subagent?: number;
  subagentTotal?: number;
};

export type ClaudeRunLog = ClaudeRunContext & {
  runId: string;
  pid?: number;
  command: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  webSearchCalls: number;
  webFetchCalls: number;
  otherToolCalls: string[];
  lastEvent: string;
  numTurns?: number;
  resultSubtype?: string;
  stderrBytes: number;
  stderrSample: string;
  stdoutBytes: number;
  outcome: 'ok' | 'failed';
  failureReason?: string;
  discovered?: number;
  accepted?: number;
  rejected?: number;
  contactable?: number;
};

const EMPTY_CONTEXT: ClaudeRunContext = { jobId: 'sin-job', scanNumber: 0, role: 'single' };

// El contexto se propaga por argumento; este valor solo cubre llamadas sueltas (pruebas, scripts).
let fallbackContext: ClaudeRunContext = EMPTY_CONTEXT;

export function setFallbackCurationContext(context: ClaudeRunContext | undefined) {
  fallbackContext = context ?? EMPTY_CONTEXT;
}

export function currentCurationContext(context?: ClaudeRunContext): ClaudeRunContext {
  return context ?? fallbackContext;
}

/** Oculta cualquier valor que parezca un secreto antes de registrar el comando. */
export function redactCommand(command: string, args: string[]): string {
  const safeArgs = args.map((arg, index) => {
    if (args[index - 1] === '-p') return `<prompt:${arg.length} chars>`;
    if (/(key|token|secret|password)/i.test(arg)) return '<redacted>';
    return arg;
  });
  return [command, ...safeArgs].join(' ');
}

export function logClaudeRun(entry: ClaudeRunLog) {
  const line = JSON.stringify({ event: 'curation.claude_run', ...entry });
  if (entry.outcome === 'failed') console.error(line);
  else console.info(line);
}

export function logCurationEvent(event: string, payload: Record<string, unknown>) {
  console.info(JSON.stringify({ event: `curation.${event}`, ...payload }));
}
