import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { CURATION_HEADERS, isCorporateEmail, parseCurationTsv, parseMultiPlatformReputation, summarizeContactChannels, validateCurationBatch } from './curation';
import { curationCandidateKey, getCurationBlacklist, type CurationBlacklistEntry } from './curation-history';
import { currentCurationContext, logClaudeRun, logCurationEvent, redactCommand, type ClaudeRunContext, type ClaudeRunRole } from './curation-log';
import { isGooglePlacesConfigured, lookupGooglePlaceReputation, toDomain, toE164Colombia } from './google-places';
import { formatHarvestForPrompt, harvestCategoryCandidates, hasHarvestQueries, isContactable, type HarvestedPlace } from './places-harvest';
import { harvestedPlaceToRow } from './harvest-import';
import { scrapeProviderContact } from './contact-scrape';

const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const MAX_CURATION_CANDIDATES = 20;

const responseSchema = {
  type: 'object',
  properties: {
    tsv: { type: 'string', description: 'TSV con el encabezado y filas de curaduría.' },
    research_summary: { type: 'string' },
  },
  required: ['tsv', 'research_summary'],
};

function env(name: string): string | undefined {
  // import.meta.env no existe fuera del build de Astro (por ejemplo, en las pruebas con node).
  return import.meta.env?.[name] ?? process.env[name];
}

export function extractOutputText(body: Record<string, unknown>): string | undefined {
  if (typeof body.output_text === 'string') return body.output_text;
  if (typeof body.outputText === 'string') return body.outputText;
  if (Array.isArray(body.outputs)) {
    for (const output of [...body.outputs].reverse()) {
      if (typeof output === 'object' && output !== null && typeof (output as Record<string, unknown>).text === 'string') return (output as Record<string, string>).text;
    }
  }
  if (Array.isArray(body.steps)) {
    for (const step of [...body.steps].reverse()) {
      const record = step as Record<string, unknown>;
      if (Array.isArray(record.content)) {
        const textPart = record.content.find(part => typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>).text === 'string');
        if (textPart && typeof (textPart as Record<string, unknown>).text === 'string') return (textPart as Record<string, string>).text;
      }
    }
  }
  return undefined;
}

export type CurationDiscoveredCandidate = {
  name: string;
  directUrl: string;
  payload: Record<string, unknown>;
};

export type GeminiCurationResult = {
  tsv: string;
  researchSummary: string;
  provider: 'gemini' | 'claude-code' | 'codex';
  model: string;
  accepted: number;
  rejected: number;
  discovered: number;
  contactable: number;
  discoveredCandidates?: CurationDiscoveredCandidate[];
  acceptedRows?: ReturnType<typeof validateCurationBatch>['accepted'];
  rejectedRows: ReturnType<typeof validateCurationBatch>['rejected'];
  contactSummary: ReturnType<typeof summarizeContactChannels>;
  historySaved?: boolean;
  historyError?: string;
  targetCount?: number;
  contactTarget?: number;
  relevantCount?: number;
  attempts?: number;
  targetReached?: boolean;
  stoppedReason?: 'target_reached' | 'no_relevant_candidates' | 'max_scans' | 'history_save_failed' | 'agent_failed';
  alert?: string;
};

export type CurationPhaseProgress = { current: number; total: number; label?: string };
export type CurationLivePreviewRow = {
  line: number;
  name: string;
  accepted: boolean;
  rating: number | null;
  reviewCount: number | null;
  platform: string;
  /** Reputación en otras plataformas además de `platform`; ver `parseMultiPlatformReputation`. */
  multiPlatformReputation: Array<{ platform: string; rating: number; reviews: number }>;
  issues: Array<{ message: string }>;
};

export type CurationLivePreview = {
  tsv: string;
  discovered: number;
  contactable: number;
  model: string;
  rejectedRows: Array<{ line: number; issues: Array<{ message: string }> }>;
  rows: CurationLivePreviewRow[];
};
export type CurationPhaseReporter = (phase: 'preparing' | 'researching', detail: string, progress?: CurationPhaseProgress, preview?: CurationLivePreview) => void;

const RETRYABLE_GEMINI_STATUSES = new Set([400, 408, 425, 429, 500, 502, 503, 504]);

function wait(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** Herramientas que jamás debe usar el agente de curaduría: evitan subagentes propios, edición de código y ejecución local. */
const CURATION_DENIED_TOOLS = [
  'Task', 'Bash', 'PowerShell', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit',
  'Skill', 'ToolSearch', 'Artifact', 'ArtifactComments', 'ArtifactData', 'SendMessage',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'PushNotification', 'Workflow',
];

/** stderr que el CLI emite de forma informativa y que nunca debe convertirse en fallo. */
const INFORMATIONAL_STDERR = [
  /no stdin data received/i,
  /stdin is unreadable/i,
  /^\s*\(node:\d+\)/,
  /DeprecationWarning/i,
  /ExperimentalWarning/i,
  /punycode/i,
];

export function isInformationalStderr(stderr: string): boolean {
  const meaningful = stderr
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !INFORMATIONAL_STDERR.some(pattern => pattern.test(line)));
  return meaningful.length === 0;
}

/** Procesos vivos: garantiza que ningún timeout deje un claude huérfano. */
const activeClaudeChildren = new Set<ChildProcess>();
let exitHooksInstalled = false;

function killClaudeTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { child.kill('SIGKILL'); } catch { /* el proceso ya terminó */ } });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* el proceso ya terminó */ }
    }
  } else {
    try { child.kill('SIGKILL'); } catch { /* el proceso ya terminó */ }
  }
}

export function killAllClaudeChildren(): number {
  const count = activeClaudeChildren.size;
  for (const child of activeClaudeChildren) killClaudeTree(child);
  activeClaudeChildren.clear();
  return count;
}

export function activeClaudeChildCount(): number {
  return activeClaudeChildren.size;
}

function installExitHooks() {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  for (const signal of ['exit', 'SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { killAllClaudeChildren(); });
  }
}

export type ClaudeRunOptions = {
  prompt: string;
  onPhase?: CurationPhaseReporter;
  maxTurns?: number;
  /** Herramientas realmente necesarias; el resto queda denegado de forma explícita. */
  tools?: string[];
  role: ClaudeRunRole;
  context: ClaudeRunContext;
  maxRuntimeMs?: number;
  maxIdleMs?: number;
};

export type ClaudeRunResult = {
  output: string;
  /** true cuando el CLI se quedó sin turnos o sin tiempo y solo se pudo rescatar texto parcial. */
  partial: boolean;
  failureReason?: string;
  webSearchCalls: number;
  webFetchCalls: number;
  durationMs: number;
};

export function buildClaudeArgs(prompt: string, maxTurns: number, tools: string[], model: string): string[] {
  const denied = CURATION_DENIED_TOOLS.filter(tool => !tools.includes(tool))
    .concat(['WebSearch', 'WebFetch'].filter(tool => !tools.includes(tool)));
  return [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(maxTurns),
    '--model', model,
    // Sin servidores MCP: baja el arranque de ~3.4s a ~1.7s y el catálogo de 197 a 30 herramientas.
    '--strict-mcp-config',
    // Nada que requiera permiso puede colgar una ejecución no interactiva.
    '--permission-prompts', 'none',
    ...(tools.length ? ['--allowedTools', ...tools] : []),
    '--disallowedTools', ...denied,
  ];
}

export function runClaudeCode(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  installExitHooks();
  const { prompt, onPhase, role, context } = options;
  const maxTurns = options.maxTurns ?? 24;
  const tools = options.tools ?? ['WebSearch', 'WebFetch'];
  // Descubrimiento y verificación tienen presupuestos distintos: una fuente lenta no debe matar
  // el escaneo completo, pero tampoco puede bloquearlo indefinidamente.
  const maxRuntime = options.maxRuntimeMs ?? (role === 'discovery' ? 6 * 60 * 1000 : 8 * 60 * 1000);
  const maxIdle = options.maxIdleMs ?? 120 * 1000;

  return new Promise((resolve, reject) => {
    const command = env('CLAUDE_CODE_PATH') || 'claude';
    const model = env('CLAUDE_CODE_MODEL') || 'sonnet';
    const args = buildClaudeArgs(prompt, maxTurns, tools, model);

    const runId = randomUUID();
    const startedAt = new Date();
    const t0 = Date.now();
    // stdin en 'ignore' (NUL). Cerrarlo con .end() depende de un turno libre del event loop y,
    // cuando el servidor está ocupado, el CLI alcanza a emitir "no stdin data received in 3s".
    const child = spawn(command, args, { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeClaudeChildren.add(child);

    let stdoutBuffer = '';
    let stdoutBytes = 0;
    let finalOutput = '';
    let assistantText = '';
    let stderrOutput = '';
    let webSearchCalls = 0;
    let webFetchCalls = 0;
    const otherToolCalls: string[] = [];
    let lastEvent = 'sin eventos';
    let numTurns: number | undefined;
    let resultSubtype: string | undefined;
    let resultFailure = '';
    let settled = false;
    let highestProgress = 0;
    let lastWebFetchUrl = '';
    let lastWebFetchChangedAt = 0;
    let repeatedWebFetches = 0;
    let lastActivityAt = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let idleWatchdog: ReturnType<typeof setInterval> | undefined;

    const clearRunTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (idleWatchdog) clearInterval(idleWatchdog);
    };

    const writeLog = (outcome: 'ok' | 'failed', exitCode: number | null, failureReason?: string) => {
      logClaudeRun({
        ...context,
        role,
        runId,
        pid: child.pid,
        command: redactCommand(command, args),
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        exitCode,
        webSearchCalls,
        webFetchCalls,
        otherToolCalls,
        lastEvent,
        numTurns,
        resultSubtype,
        stderrBytes: stderrOutput.length,
        stderrSample: stderrOutput.trim().slice(0, 300),
        stdoutBytes,
        outcome,
        failureReason,
      });
    };

    /** Rescata texto parcial cuando el CLI se corta: un lote incompleto vale más que un fallo seco. */
    const salvage = (reason: string) => {
      const candidate = finalOutput.trim() || assistantText.trim();
      if (!candidate) return undefined;
      const hasEnvelope = candidate.includes('"tsv"') || candidate.includes('"candidates"') || candidate.includes(CURATION_HEADERS[0]);
      return hasEnvelope ? { output: candidate, partial: true, failureReason: reason } : undefined;
    };

    const finish = (outcome: 'ok' | 'failed', exitCode: number | null, failureReason?: string) => {
      settled = true;
      clearRunTimers();
      activeClaudeChildren.delete(child);
      writeLog(outcome, exitCode, failureReason);
    };

    const abortRun = (reason: string) => {
      if (settled) return;
      const rescued = salvage(reason);
      finish(rescued ? 'ok' : 'failed', null, reason);
      killClaudeTree(child);
      if (rescued) {
        resolve({ ...rescued, webSearchCalls, webFetchCalls, durationMs: Date.now() - t0 });
        return;
      }
      reject(new Error(reason));
    };

    timeout = setTimeout(
      () => abortRun(`CLAUDE_CODE_TIMEOUT: el agente superó ${Math.round(maxRuntime / 1000)}s sin terminar (último evento: ${lastEvent}).`),
      maxRuntime,
    );
    idleWatchdog = setInterval(() => {
      if (!settled && Date.now() - lastActivityAt >= maxIdle) {
        abortRun(`CLAUDE_CODE_IDLE_TIMEOUT: el agente estuvo ${Math.round(maxIdle / 1000)}s sin actividad (último evento: ${lastEvent}).`);
      }
    }, 5_000);

    const report = (detail: string, current: number, label: string) => {
      highestProgress = Math.max(highestProgress, current);
      onPhase?.('researching', detail, { current: highestProgress, total: 4, label });
    };

    const handleEvent = (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      lastActivityAt = Date.now();
      lastEvent = typeof event.type === 'string' ? event.type : 'desconocido';

      if (event.type === 'assistant' && event.message && typeof event.message === 'object') {
        const message = event.message as Record<string, unknown>;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const item = block as Record<string, unknown>;
          if (item.type === 'text' && typeof item.text === 'string') assistantText += item.text;
          if (item.type !== 'tool_use') continue;
          const input = item.input && typeof item.input === 'object' ? item.input as Record<string, unknown> : {};
          if (item.name === 'WebSearch') {
            webSearchCalls += 1;
            const query = typeof input.query === 'string' ? cleanProgressText(input.query) : '';
            report(query ? `Buscando: ${query}` : 'Buscando candidatos y fuentes públicas.', 1, 'Buscando candidatos');
            continue;
          }
          if (item.name === 'WebFetch') {
            webFetchCalls += 1;
            const url = typeof input.url === 'string' ? cleanProgressText(input.url) : '';
            const urlKey = url ? normalizeCandidateUrl(url) : '';
            if (urlKey && urlKey === lastWebFetchUrl) repeatedWebFetches += 1;
            else if (url) {
              lastWebFetchUrl = urlKey;
              lastWebFetchChangedAt = Date.now();
              repeatedWebFetches = 1;
            }
            // Una fuente que se repite es una fuente atascada: se abandona sin matar el escaneo.
            if (urlKey && repeatedWebFetches >= 4 && Date.now() - lastWebFetchChangedAt > 60_000) {
              abortRun(`CLAUDE_CODE_STALLED_SOURCE: la fuente ${urlKey} se repitió ${repeatedWebFetches} veces sin avanzar.`);
              return;
            }
            report(url ? `Revisando contacto y evidencia: ${url}` : 'Extrayendo contacto y verificando páginas fuente.', 3, 'Extrayendo contacto');
            continue;
          }
          if (typeof item.name === 'string' && !otherToolCalls.includes(item.name)) otherToolCalls.push(item.name);
        }
      }

      if (event.type === 'user') report('Comparando calificaciones, reseñas y evidencia.', 2, 'Evaluando reseñas y evidencia');

      if (event.type === 'result') {
        resultSubtype = typeof event.subtype === 'string' ? event.subtype : undefined;
        numTurns = typeof event.num_turns === 'number' ? event.num_turns : undefined;
        if (typeof event.result === 'string' && event.is_error !== true) {
          report('Validando candidatos y preparando el lote.', 4, 'Validando candidatos');
          finalOutput = event.result;
          return;
        }
        // error_max_turns llega SIN campo `result`: antes se perdía y el fallo se atribuía a stderr.
        resultFailure = resultSubtype === 'error_max_turns'
          ? `CLAUDE_CODE_MAX_TURNS: el agente agotó los ${maxTurns} turnos disponibles antes de entregar el lote.`
          : `CLAUDE_CODE_FAILED: ${typeof event.result === 'string' ? cleanProgressText(event.result) : resultSubtype || 'el agente terminó sin resultado'}`;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += chunk.length;
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        handleEvent(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderrOutput += chunk; });

    child.on('error', error => {
      if (settled) return;
      const reason = error.message.includes('ENOENT')
        ? 'CLAUDE_CODE_NOT_FOUND: no se encontró el ejecutable de Claude Code.'
        : `CLAUDE_CODE_SPAWN_ERROR: ${error.message}`;
      finish('failed', null, reason);
      reject(new Error(reason));
    });

    child.on('close', code => {
      if (settled) return;
      if (stdoutBuffer.trim()) handleEvent(stdoutBuffer);

      if (finalOutput.trim()) {
        finish('ok', code);
        resolve({ output: finalOutput, partial: false, webSearchCalls, webFetchCalls, durationMs: Date.now() - t0 });
        return;
      }

      // El motivo real viene del evento `result`; stderr solo se usa si aporta algo no informativo.
      const stderrDetail = isInformationalStderr(stderrOutput) ? '' : stderrOutput.trim().slice(0, 300);
      const reason = resultFailure
        || (code === 127 ? 'CLAUDE_CODE_NOT_FOUND: no se encontró el ejecutable de Claude Code.' : '')
        || (stderrDetail ? `CLAUDE_CODE_FAILED: ${stderrDetail}` : '')
        || `CLAUDE_CODE_EMPTY_RESPONSE: el agente terminó con código ${code} sin entregar resultado (último evento: ${lastEvent}).`;

      const rescued = salvage(reason);
      if (rescued) {
        finish('ok', code, reason);
        resolve({ ...rescued, webSearchCalls, webFetchCalls, durationMs: Date.now() - t0 });
        return;
      }
      finish('failed', code, reason);
      reject(new Error(reason));
    });
  });
}

/**
 * `model` y `reasoningEffort` vienen de variables de entorno, no de una petición web, pero igual se
 * validan contra una lista blanca: son los únicos valores dinámicos que entran al argv y, en
 * Windows, ese argv se ejecuta a través de `cmd.exe` (ver comentario en `runCodexCli`), donde un
 * carácter especial sin escapar cambiaría el comando ejecutado.
 */
const SAFE_CODEX_TOKEN = /^[A-Za-z0-9_.:-]+$/;

function assertSafeCodexToken(value: string, label: string): string {
  if (!SAFE_CODEX_TOKEN.test(value)) throw new Error(`CODEX_CONFIG_INVALID: ${label} contiene caracteres no permitidos ("${value}").`);
  return value;
}

/** El prompt viaja por stdin, nunca por argv: así el argv de Codex solo contiene literales fijos. */
export function buildCodexArgs(model: string, reasoningEffort: string): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    // Codex no tiene un equivalente a --disallowedTools: el sandbox de solo lectura es lo que le
    // impide escribir archivos o ejecutar comandos, igual que --disallowedTools hace para Claude.
    '--sandbox', 'read-only',
    '--ephemeral',
    '-m', assertSafeCodexToken(model, 'CODEX_MODEL'),
    '-c', `model_reasoning_effort="${assertSafeCodexToken(reasoningEffort, 'CODEX_REASONING_EFFORT')}"`,
  ];
}

/**
 * Analogía de `runClaudeCode` para el CLI de Codex. El formato de eventos es más simple:
 * `item.completed` con `item.type: "web_search"` (acción `search` u `open_page`) y
 * `item.type: "agent_message"` con el texto final; el fallo real llega en `turn.failed` o en un
 * evento `error` de nivel superior, ambos con el detalle anidado en JSON dentro de `message`.
 */
export function runCodexCli(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  installExitHooks();
  const { prompt, onPhase, role, context } = options;
  const maxRuntime = options.maxRuntimeMs ?? (role === 'discovery' ? 6 * 60 * 1000 : 8 * 60 * 1000);
  const maxIdle = options.maxIdleMs ?? 120 * 1000;

  return new Promise((resolve, reject) => {
    const command = env('CODEX_CLI_PATH') || 'codex';
    const model = env('CODEX_MODEL') || 'gpt-5.6-luna';
    const reasoningEffort = env('CODEX_REASONING_EFFORT') || 'medium';
    const args = buildCodexArgs(model, reasoningEffort);

    const runId = randomUUID();
    const startedAt = new Date();
    const t0 = Date.now();
    // En Windows, `codex` se instala como shim `.cmd`: Node no puede ejecutarlo directamente
    // (EINVAL) y necesita pasar por cmd.exe (`shell: true`). Node no escapa esos argumentos, así
    // que solo es seguro porque `args` no contiene nada dinámico salvo `model`/`reasoningEffort`,
    // ya validados arriba contra SAFE_CODEX_TOKEN. El prompt real, con texto libre, va por stdin.
    const child = spawn(command, args, {
      cwd: process.cwd(),
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    activeClaudeChildren.add(child);
    child.stdin.write(prompt);
    child.stdin.end();

    let stdoutBuffer = '';
    let stdoutBytes = 0;
    let finalOutput = '';
    let stderrOutput = '';
    let webSearchCalls = 0;
    let webFetchCalls = 0;
    const otherToolCalls: string[] = [];
    let lastEvent = 'sin eventos';
    let resultFailure = '';
    let settled = false;
    let highestProgress = 0;
    let lastActivityAt = Date.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let idleWatchdog: ReturnType<typeof setInterval> | undefined;

    const clearRunTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (idleWatchdog) clearInterval(idleWatchdog);
    };

    const writeLog = (outcome: 'ok' | 'failed', exitCode: number | null, failureReason?: string) => {
      logClaudeRun({
        ...context,
        role,
        runId,
        pid: child.pid,
        command: `${redactCommand(command, args)} <stdin:${prompt.length} chars>`,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        exitCode,
        webSearchCalls,
        webFetchCalls,
        otherToolCalls,
        lastEvent,
        stderrBytes: stderrOutput.length,
        stderrSample: stderrOutput.trim().slice(0, 300),
        stdoutBytes,
        outcome,
        failureReason,
      });
    };

    const salvage = (reason: string) => {
      const candidate = finalOutput.trim();
      if (!candidate) return undefined;
      const hasEnvelope = candidate.includes('"tsv"') || candidate.includes('"candidates"') || candidate.includes(CURATION_HEADERS[0]);
      return hasEnvelope ? { output: candidate, partial: true, failureReason: reason } : undefined;
    };

    const finish = (outcome: 'ok' | 'failed', exitCode: number | null, failureReason?: string) => {
      settled = true;
      clearRunTimers();
      activeClaudeChildren.delete(child);
      writeLog(outcome, exitCode, failureReason);
    };

    const abortRun = (reason: string) => {
      if (settled) return;
      const rescued = salvage(reason);
      finish(rescued ? 'ok' : 'failed', null, reason);
      killClaudeTree(child);
      if (rescued) {
        resolve({ ...rescued, webSearchCalls, webFetchCalls, durationMs: Date.now() - t0 });
        return;
      }
      reject(new Error(reason));
    };

    timeout = setTimeout(
      () => abortRun(`CODEX_TIMEOUT: el agente superó ${Math.round(maxRuntime / 1000)}s sin terminar (último evento: ${lastEvent}).`),
      maxRuntime,
    );
    idleWatchdog = setInterval(() => {
      if (!settled && Date.now() - lastActivityAt >= maxIdle) {
        abortRun(`CODEX_IDLE_TIMEOUT: el agente estuvo ${Math.round(maxIdle / 1000)}s sin actividad (último evento: ${lastEvent}).`);
      }
    }, 5_000);

    const report = (detail: string, current: number, label: string) => {
      highestProgress = Math.max(highestProgress, current);
      onPhase?.('researching', detail, { current: highestProgress, total: 4, label });
    };

    /** `turn.failed`/`error` traen el detalle real como una cadena JSON anidada, no como objeto. */
    const extractErrorMessage = (raw: unknown): string => {
      if (typeof raw !== 'string') return 'el agente terminó sin detalle de error';
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const nested = parsed.error && typeof parsed.error === 'object' ? parsed.error as Record<string, unknown> : undefined;
        if (typeof nested?.message === 'string') return nested.message;
        if (typeof parsed.message === 'string') return parsed.message;
      } catch { /* no era JSON anidado: se usa el texto tal cual */ }
      return raw;
    };

    const handleEvent = (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      lastActivityAt = Date.now();
      lastEvent = typeof event.type === 'string' ? event.type : 'desconocido';

      if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
        const item = event.item as Record<string, unknown>;
        if (item.type === 'web_search') {
          const action = item.action && typeof item.action === 'object' ? item.action as Record<string, unknown> : {};
          const actionType = typeof action.type === 'string' ? action.type : '';
          if (actionType === 'search') {
            webSearchCalls += 1;
            const query = typeof action.query === 'string' ? cleanProgressText(action.query) : '';
            report(query ? `Buscando: ${query}` : 'Buscando candidatos y fuentes públicas.', 1, 'Buscando candidatos');
          } else if (actionType === 'open_page' || actionType === 'find_in_page') {
            webFetchCalls += 1;
            const url = typeof action.url === 'string' ? cleanProgressText(action.url) : '';
            report(url ? `Revisando contacto y evidencia: ${url}` : 'Extrayendo contacto y verificando páginas fuente.', 3, 'Extrayendo contacto');
          } else if (!otherToolCalls.includes('web_search')) {
            otherToolCalls.push('web_search');
          }
          return;
        }
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          report('Validando candidatos y preparando el lote.', 4, 'Validando candidatos');
          finalOutput = item.text;
          return;
        }
        if (item.type === 'error') {
          resultFailure = `CODEX_WARNING: ${typeof item.message === 'string' ? cleanProgressText(item.message) : 'advertencia sin detalle'}`;
          return;
        }
        if (typeof item.type === 'string' && !otherToolCalls.includes(item.type)) otherToolCalls.push(item.type);
        return;
      }

      if (event.type === 'error') {
        resultFailure = `CODEX_FAILED: ${cleanProgressText(extractErrorMessage(event.message))}`;
        return;
      }
      if (event.type === 'turn.failed') {
        const errorField = event.error && typeof event.error === 'object' ? (event.error as Record<string, unknown>).message : undefined;
        resultFailure = `CODEX_FAILED: ${cleanProgressText(extractErrorMessage(errorField))}`;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += chunk.length;
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        handleEvent(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderrOutput += chunk; });

    child.on('error', error => {
      if (settled) return;
      const reason = error.message.includes('ENOENT')
        ? 'CODEX_NOT_FOUND: no se encontró el ejecutable de Codex CLI.'
        : `CODEX_SPAWN_ERROR: ${error.message}`;
      finish('failed', null, reason);
      reject(new Error(reason));
    });

    child.on('close', code => {
      if (settled) return;
      if (stdoutBuffer.trim()) handleEvent(stdoutBuffer);

      if (finalOutput.trim()) {
        finish('ok', code);
        resolve({ output: finalOutput, partial: false, webSearchCalls, webFetchCalls, durationMs: Date.now() - t0 });
        return;
      }

      const stderrDetail = isInformationalStderr(stderrOutput) ? '' : stderrOutput.trim().slice(0, 300);
      const reason = resultFailure
        || (code === 127 ? 'CODEX_NOT_FOUND: no se encontró el ejecutable de Codex CLI.' : '')
        || (stderrDetail ? `CODEX_FAILED: ${stderrDetail}` : '')
        || `CODEX_EMPTY_RESPONSE: el agente terminó con código ${code} sin entregar resultado (último evento: ${lastEvent}).`;

      const rescued = salvage(reason);
      if (rescued) {
        finish('ok', code, reason);
        resolve({ ...rescued, webSearchCalls, webFetchCalls, durationMs: Date.now() - t0 });
        return;
      }
      finish('failed', code, reason);
      reject(new Error(reason));
    });
  });
}

/** Elige el CLI de investigación según `CURATION_PROVIDER`; ambos devuelven la misma forma. */
export function runResearchAgent(provider: 'claude-code' | 'codex', options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  return provider === 'codex' ? runCodexCli(options) : runClaudeCode(options);
}

type GeminiRequestError = Error & {
  status?: number;
  apiMessage?: string;
  streamFailure?: boolean;
};

function createGeminiRequestError(message: string, metadata: Partial<GeminiRequestError> = {}): GeminiRequestError {
  return Object.assign(new Error(message), metadata);
}

function cleanProgressText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 140);
}

function extractSearchQueries(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const argumentsValue = record.arguments;
  if (typeof argumentsValue === 'string') {
    try {
      return extractSearchQueries(JSON.parse(argumentsValue));
    } catch {
      return [];
    }
  }
  if (argumentsValue && typeof argumentsValue === 'object') {
    const nestedQueries = extractSearchQueries(argumentsValue);
    if (nestedQueries.length) return nestedQueries;
  }
  for (const key of ['queries', 'query']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return [cleanProgressText(candidate)];
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(cleanProgressText).slice(0, 3);
    }
  }
  return [];
}

function reportGeminiStreamStep(onPhase: CurationPhaseReporter | undefined, type: string, source: unknown) {
  const normalizedType = type.toLowerCase();
  const queries = extractSearchQueries(source);
  const report = (detail: string, current: number, label: string) => onPhase?.('researching', detail, { current, total: 4, label });
  if (normalizedType.includes('google_search_call')) {
    report(queries.length ? `Buscando: ${queries.join(' · ')}` : 'Buscando candidatos y fuentes públicas.', 1, 'Buscando candidatos');
    return;
  }
  if (normalizedType.includes('google_search_result')) {
    report('Comparando calificaciones, reseñas y evidencia de servicios.', 2, 'Evaluando reseñas y evidencia');
    return;
  }
  if (normalizedType.includes('url_context_call')) {
    report('Revisando páginas de contacto, reservas, WhatsApp, correo y teléfono.', 3, 'Extrayendo contacto');
    return;
  }
  if (normalizedType.includes('url_context_result')) {
    report('Contacto y páginas fuente revisados; descartando negocios incompletos.', 3, 'Extrayendo contacto');
    return;
  }
  if (normalizedType === 'thought' || normalizedType === 'thought_summary') {
    report('Revisando coincidencias y descartando resultados débiles.', 4, 'Validando candidatos');
    return;
  }
  if (normalizedType === 'model_output') {
    report('Organizando candidatos verificados y sus fuentes.', 4, 'Validando candidatos');
  }
}

async function readGeminiStream(response: Response, onPhase?: CurationPhaseReporter): Promise<string> {
  if (!response.body) throw createGeminiRequestError('GEMINI_EMPTY_STREAM', { streamFailure: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outputText = '';
  let streamError: string | undefined;
  let highestResearchProgress = 0;
  const reportPhase: CurationPhaseReporter | undefined = onPhase
    ? (phase, detail, progress) => {
      if (phase !== 'researching' || !progress) {
        onPhase(phase, detail, progress);
        return;
      }
      highestResearchProgress = Math.max(highestResearchProgress, progress.current);
      onPhase(phase, detail, { ...progress, current: highestResearchProgress });
    }
    : undefined;

  const handleFrame = (frame: string) => {
    const data = frame.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const eventType = typeof event.event_type === 'string' ? event.event_type : '';
    if (eventType === 'error') {
      const errorPayload = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : {};
      streamError = typeof errorPayload.message === 'string' ? cleanProgressText(errorPayload.message) : 'Gemini stream error';
      return;
    }
    if (eventType === 'step.start') {
      const step = event.step && typeof event.step === 'object' ? event.step as Record<string, unknown> : {};
      if (typeof step.type === 'string') reportGeminiStreamStep(reportPhase, step.type, step);
      return;
    }
    if (eventType === 'step.delta') {
      const delta = event.delta && typeof event.delta === 'object' ? event.delta as Record<string, unknown> : {};
      if (delta.type === 'text' && typeof delta.text === 'string') {
        outputText += delta.text;
        return;
      }
      if (typeof delta.type === 'string') reportGeminiStreamStep(reportPhase, delta.type, delta);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let separator = buffer.indexOf('\n\n');
    while (separator >= 0) {
      handleFrame(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf('\n\n');
    }
    if (done) {
      if (buffer.trim()) handleFrame(buffer);
      break;
    }
  }

  if (streamError) throw createGeminiRequestError(`GEMINI_STREAM_ERROR: ${streamError}`, { streamFailure: true, apiMessage: streamError });
  if (!outputText.trim()) throw createGeminiRequestError('GEMINI_EMPTY_STREAM', { streamFailure: true });
  return outputText;
}

function normalizeKnownSourceUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'serenatas.co' && url.pathname.toLowerCase().startsWith('/agrupacion/')) {
      url.pathname = url.pathname.replace(/^\/agrupacion\//i, '/grupo/');
    }
    if (host === 'djdiegosanchez.com' && (url.pathname === '' || url.pathname === '/')) {
      url.pathname = '/nosotros/';
    }
    return url.toString();
  } catch {
    return value;
  }
}

function normalizeKnownSourceUrls(tsv: string): string {
  return tsv.split(/\r?\n/).map(line => {
    const cells = line.split('\t');
    if (cells.length > 16) cells[16] = normalizeKnownSourceUrl(cells[16]);
    return cells.join('\t');
  }).join('\n');
}

function normalizePromptKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeCandidateUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return normalizePromptKey(value);
  }
}

function candidateIsBlacklisted(candidate: Record<string, unknown>, blacklist: CurationBlacklistEntry[], city: string, category: string): boolean {
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const directUrl = typeof candidate.direct_url === 'string' ? candidate.direct_url : '';
  if (!name && !directUrl) return false;
  const candidateKey = curationCandidateKey(name, city, category);
  const sourceKey = directUrl ? normalizeCandidateUrl(directUrl) : '';
  return blacklist.some(item => item.candidateKey === candidateKey || (sourceKey && normalizeCandidateUrl(item.sourceUrl) === sourceKey));
}

export function compactBlacklistForPrompt(blacklist: CurationBlacklistEntry[]): string {
  const selected: string[] = [];
  const seen = new Set<string>();
  let size = 2;
  for (const item of blacklist) {
    const name = item.displayName.trim();
    const key = normalizePromptKey(name);
    if (!name || seen.has(key)) continue;
    const serialized = JSON.stringify(name);
    if (size + serialized.length + 1 > 8000) break;
    selected.push(name);
    seen.add(key);
    size += serialized.length + 1;
  }
  return JSON.stringify(selected);
}

function limitCurationTsvRows(tsv: string, limit = MAX_CURATION_CANDIDATES): string {
  const lines = tsv.replace(/\r\n?/g, '\n').split('\n');
  const header = lines[0] ?? '';
  const rows = lines.slice(1).filter(line => line.trim()).slice(0, limit);
  return [header, ...rows].join('\n');
}

function parseJsonEnvelope<T>(outputText: string): T | undefined {
  const fenced = outputText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] ?? outputText).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  try {
    return JSON.parse(start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate) as T;
  } catch {
    return undefined;
  }
}

function extractTsvFallback(outputText: string): string | undefined {
  const header = CURATION_HEADERS.join('\t');
  const headerIndex = outputText.indexOf(header);
  if (headerIndex < 0) return undefined;
  const lines = outputText.slice(headerIndex).replace(/\r\n?/g, '\n').split('\n');
  const rows = lines.slice(1)
    .map(line => line.replace(/["}]+\s*,?\s*$/, ''))
    .filter(line => line.split('\t').length === CURATION_HEADERS.length);
  return rows.length ? [header, ...rows].join('\n') : undefined;
}

export function buildLivePreviewRows(parsed: ReturnType<typeof parseCurationTsv>): CurationLivePreviewRow[] {
  return parsed.rows.map(row => ({
    line: row.line,
    name: row.fields?.displayName ?? row.rawCells[1] ?? 'Sin dato',
    accepted: row.issues.length === 0,
    rating: row.fields?.rating ?? null,
    reviewCount: row.fields?.reviewCount ?? null,
    platform: row.fields?.platform ?? row.rawCells[10] ?? 'Sin dato',
    multiPlatformReputation: row.fields?.multiPlatformReputation ?? [],
    issues: row.issues.map(item => ({ message: item.message })),
  }));
}

function buildLivePreview(tsv: string, model: string): CurationLivePreview {
  const parsed = parseCurationTsv(tsv);
  const validation = validateCurationBatch(parsed);
  return {
    tsv,
    discovered: parsed.rows.length,
    contactable: parsed.rows.filter(row => hasContactForDiscovery(row.rawCells)).length,
    model,
    rejectedRows: validation.rejected.map(row => ({
      line: row.line,
      issues: row.issues.map(item => ({ message: item.message })),
    })),
    rows: buildLivePreviewRows(parsed),
  };
}

/** Divide el roster en dos mitades disjuntas: cada subagente verifica proveedores distintos. */
export function splitRosterForSubagents<T>(roster: T[]): T[][] {
  return [
    roster.filter((_, index) => index % 2 === 0),
    roster.filter((_, index) => index % 2 === 1),
  ].filter(chunk => chunk.length > 0);
}

async function runVerificationSubagents(
  basePrompt: string,
  roster: Array<Record<string, string>>,
  onPhase: CurationPhaseReporter | undefined,
  maxTurns: number,
  model: string,
  context: ClaudeRunContext,
): Promise<string> {
  const chunks = splitRosterForSubagents(roster);
  const results: Array<{ tsv: string; summary: string } | undefined> = [];
  const tasks = chunks.map((chunk, index) => (async () => {
    const prompt = basePrompt
      + '\n\nEres subagente ' + (index + 1) + ' de ' + chunks.length
      + '. Verifica únicamente el roster que aparece abajo; ningún otro subagente lo está revisando. Usa como máximo 2 WebFetch por proveedor: uno para la URL directa y, solo si falta contacto, uno para una única ruta de contacto del mismo dominio. No pruebes variantes adicionales ni esperes una web bloqueada; pasa al siguiente proveedor. Con '
      + chunk.length + ' proveedores tu presupuesto total es de ' + (chunk.length * 2) + ' WebFetch. Devuelve JSON válido con "tsv" y "research_summary".\n\nROSTER DEL SUBAGENTE '
      + (index + 1) + ':\n' + JSON.stringify(chunk);
    const reporter: CurationPhaseReporter | undefined = onPhase
      ? (phase, detail, progress, preview) => onPhase(phase, 'Subagente ' + (index + 1) + '/' + chunks.length + ': ' + detail, progress, preview)
      : undefined;
    // Presupuesto de turnos proporcional al roster: 2 WebFetch por proveedor más margen de cierre.
    const subagentTurns = Math.max(12, Math.min(maxTurns, chunk.length * 4 + 8));
    const run = await runClaudeCode({
      prompt,
      onPhase: reporter,
      maxTurns: subagentTurns,
      tools: ['WebFetch'],
      role: 'verification',
      context: { ...context, subagent: index + 1, subagentTotal: chunks.length },
    });
    const rawOutput = run.output;
    const parsed = parseJsonEnvelope<{ tsv?: string; research_summary?: string }>(rawOutput);
    const fallback = typeof parsed?.tsv === 'string' && parsed.tsv.trim() ? undefined : extractTsvFallback(rawOutput);
    const tsv = typeof parsed?.tsv === 'string' && parsed.tsv.trim() ? parsed.tsv : fallback;
    if (!tsv) throw new Error('CLAUDE_CODE_SUBAGENTE_' + (index + 1) + '_SIN_FILAS: el subagente respondió sin ninguna fila utilizable.');
    results[index] = {
      tsv: limitCurationTsvRows(normalizeKnownSourceUrls(tsv)),
      summary: (parsed?.research_summary || 'Subagente ' + (index + 1) + ' completó verificación.')
        + (run.partial ? ' Resultado parcial: ' + run.failureReason : ''),
    };
    logCurationEvent('subagent_done', {
      ...context,
      subagent: index + 1,
      subagentTotal: chunks.length,
      roster: chunk.length,
      webFetchCalls: run.webFetchCalls,
      durationMs: run.durationMs,
      partial: run.partial,
      rows: results[index]!.tsv.split('\n').length - 1,
    });
    const partialTsv = [
      CURATION_HEADERS.join('\t'),
      ...results.filter((result): result is { tsv: string; summary: string } => Boolean(result)).flatMap(result => result.tsv.split('\n').slice(1)),
    ].join('\n');
    onPhase?.('researching', 'Subagente ' + (index + 1) + '/' + chunks.length + ' resolvió candidatos.', { current: 3, total: 4, label: 'Extrayendo contacto' }, buildLivePreview(partialTsv, model));
    return results[index]!;
  })());
  const settled = await Promise.allSettled(tasks);
  const successful = settled
    .filter((result): result is PromiseFulfilledResult<{ tsv: string; summary: string }> => result.status === 'fulfilled')
    .map(result => result.value);
  logCurationEvent('subagents_settled', {
    ...context,
    chunks: chunks.length,
    ok: successful.length,
    failed: settled.filter(result => result.status === 'rejected').length,
  });
  // Un subagente caído no invalida al otro: solo fallamos cuando ninguno entregó filas.
  if (!successful.length) {
    const firstFailure = settled.find(result => result.status === 'rejected');
    throw firstFailure?.reason instanceof Error
      ? firstFailure.reason
      : new Error('CLAUDE_CODE_SUBAGENTES_SIN_RESULTADO: ningún subagente de verificación entregó filas.');
  }
  return JSON.stringify({
    tsv: [CURATION_HEADERS.join('\t'), ...successful.flatMap(result => result.tsv.split('\n').slice(1))].join('\n'),
    research_summary: successful.map(result => result.summary).join(' '),
  });
}

export function hasContactForDiscovery(cells: string[]): boolean {
  const rawPhone = cells[13]?.trim() ?? '';
  const phoneDigits = rawPhone.replace(/\D/g, '');
  const localPhone = phoneDigits.startsWith('57') ? phoneDigits.slice(2) : phoneDigits;
  const hasWhatsapp = /^3\d{9}$/.test(localPhone);
  const email = cells[15]?.trim() ?? 'Sin dato';
  return hasWhatsapp || isCorporateEmail({ email });
}

function fallbackPhone(value: unknown): string {
  if (typeof value !== 'string') return 'Sin dato';
  const digits = value.replace(/\D/g, '');
  const local = digits.startsWith('57') ? digits.slice(2) : digits;
  return /^3\d{9}$/.test(local) ? `+57 ${local.slice(0, 3)} ${local.slice(3)}` : 'Sin dato';
}

function fallbackEmail(value: unknown): string {
  if (typeof value !== 'string') return 'Sin dato';
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && isCorporateEmail({ email }) ? email : 'Sin dato';
}

/**
 * Páginas que WebFetch no puede leer (redes sociales) o que no son del negocio (agregadores).
 * Se separan porque merecen tratos distintos: la red social sí identifica al negocio, el
 * directorio no.
 */
const SOCIAL_PROFILE_HOSTS = /(instagram\.com|facebook\.com|fb\.com|threads\.com|linktr\.ee|tiktok\.com)/i;
const AGGREGATOR_OR_SHORTLINK_HOSTS = /(wa\.link|whatsapp\.com|ineventos\.com|planetacolombia\.com|informacolombia\.com|banquete\.com\.co|ueniweb\.com)/i;

export function isSocialProfileUrl(value: string): boolean {
  return SOCIAL_PROFILE_HOSTS.test(value);
}

/**
 * Una URL sirve como fuente de respaldo si identifica al negocio. Un perfil de Instagram o Facebook
 * sí lo identifica: en Barranquilla es la única presencia web de buena parte del sector de comida,
 * y excluirla dejaba fuera a 10 de cada 13 candidatos descubiertos. Lo que no sirve es un directorio
 * de terceros ni un enlace corto de WhatsApp.
 */
function isFallbackSourceUrl(value: string): boolean {
  if (!value || AGGREGATOR_OR_SHORTLINK_HOSTS.test(value)) return false;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return false;
    // Un perfil social vale, pero solo si apunta a una cuenta concreta, no a la portada de la red.
    if (isSocialProfileUrl(value)) return url.pathname.replace(/\/+$/, '').length > 1;
    return true;
  } catch {
    return false;
  }
}

const FALLBACK_REPUTATION_PLATFORMS = new Map([
  ['google', 'Google'],
  ['tripadvisor', 'TripAdvisor'],
  ['booking', 'Booking'],
  ['booking.com', 'Booking'],
  ['facebook', 'Facebook'],
  ['rappi', 'Rappi'],
  ['didi', 'DiDi'],
  ['didi food', 'DiDi'],
]);

/**
 * Reputación traída del descubrimiento. Se exige el trío completo y bien formado (calificación,
 * reseñas y plataforma reconocida); si falta cualquiera de los tres, no se usa ninguno. Así un dato
 * a medias nunca se convierte en una calificación aparentemente verificada.
 */
export function fallbackReputation(payload: Record<string, unknown>): { rating: string; reviews: string; platform: string } | undefined {
  const rawRating = typeof payload.rating === 'string' ? payload.rating.trim().replace(',', '.') : '';
  const rawReviews = typeof payload.reviews === 'string' ? payload.reviews.trim().replace(/[.\s]/g, '') : '';
  const rawPlatform = typeof payload.platform === 'string' ? payload.platform.trim().toLowerCase() : '';
  if (!/^\d{1,7}$/.test(rawReviews) || Number(rawReviews) === 0) return undefined;
  const platform = FALLBACK_REPUTATION_PLATFORMS.get(rawPlatform);
  if (!platform) return undefined;
  // Booking.com publica su puntuación sobre 10, no sobre 5 como el resto de plataformas; se
  // convierte en vez de descartar un dato real por un problema de escala.
  let rating = rawRating;
  if (!/^[0-5]\.\d$/.test(rawRating)) {
    if (platform !== 'Booking') return undefined;
    const numeric = Number(rawRating);
    if (!Number.isFinite(numeric) || numeric <= 5 || numeric > 10) return undefined;
    rating = (Math.round((numeric / 2) * 10) / 10).toFixed(1);
  }
  return { rating, reviews: rawReviews, platform };
}

function fallbackCandidateRow(candidate: CurationDiscoveredCandidate, city: string, category: string, index: number): string | undefined {
  const sourceUrl = normalizeKnownSourceUrl(candidate.directUrl);
  if (!candidate.name || !isFallbackSourceUrl(sourceUrl)) return undefined;
  const phone = fallbackPhone(candidate.payload.phone);
  const email = fallbackEmail(candidate.payload.email);
  if (phone === 'Sin dato' && email === 'Sin dato') return undefined;
  const evidence = typeof candidate.payload.evidence === 'string' ? candidate.payload.evidence.trim() : 'Contacto y servicio detectados en la búsqueda pública.';
  const type = typeof candidate.payload.type === 'string' ? candidate.payload.type : 'proveedor para eventos';
  const fuente = isSocialProfileUrl(sourceUrl) ? 'perfil oficial en redes sociales' : 'página del negocio';
  const reputation = fallbackReputation(candidate.payload);
  const reputationText = reputation
    ? `Reputación publicada: ${reputation.rating} con ${reputation.reviews} reseñas en ${reputation.platform}.`
    : 'Requiere revisión: la reputación no aparece publicada en la búsqueda; calificación y reseñas quedan en Sin dato y no se inventan.';
  const reason = `Prospecto descubierto por WebSearch como ${type}. Contacto público: ${email !== 'Sin dato' ? email : phone}. ${evidence}. Fuente: ${fuente}. ${reputationText}`;
  return [
    `PRO-02-${String(index).padStart(3, '0')}`,
    candidate.name,
    category,
    'Sin clasificar',
    city,
    'Sin dato',
    'Sin dato',
    'No verificado',
    reputation?.rating ?? 'Sin dato',
    reputation?.reviews ?? 'Sin dato',
    reputation?.platform ?? 'Sin dato',
    reputation && Number(reputation.reviews) >= 50 ? 'A' : 'B',
    reason,
    phone,
    'Sin Redes',
    email,
    sourceUrl,
    new Date().toISOString().slice(0, 10),
    reputation ? `${reputation.platform}:${reputation.rating}:${reputation.reviews}` : 'Sin dato',
    'Sin dato',
  ].join('\t');
}

function appendFallbackCandidates(
  tsv: string,
  candidates: CurationDiscoveredCandidate[],
  city: string,
  category: string,
  context?: ClaudeRunContext,
): string {
  const lines = tsv.replace(/\r\n?/g, '\n').split('\n').filter(line => line.trim());
  // La deduplicación usa solo el nombre: la verificación suele devolver una URL más específica que
  // la del descubrimiento, y cotejar por URL volvía a meter el mismo negocio dos veces.
  const seen = new Set(lines.slice(1).map(line => normalizePromptKey(line.split('\t')[1] ?? '')));
  let yaEnLote = 0;
  let sinFuenteUtil = 0;
  let sinContacto = 0;
  let agregados = 0;
  for (let index = 0; index < candidates.length && lines.length - 1 < MAX_CURATION_CANDIDATES; index += 1) {
    const candidate = candidates[index];
    const key = normalizePromptKey(candidate.name);
    if (seen.has(key)) { yaEnLote += 1; continue; }
    const row = fallbackCandidateRow(candidate, city, category, index + 1);
    if (!row) { sinFuenteUtil += 1; continue; }
    if (!hasContactForDiscovery(row.split('\t'))) { sinContacto += 1; continue; }
    seen.add(key);
    lines.push(row);
    agregados += 1;
  }
  if (context) {
    logCurationEvent('fallback_rows', {
      ...context,
      candidatos: candidates.length,
      agregados,
      yaEnLote,
      sinFuenteUtil,
      sinContactoAccionable: sinContacto,
    });
  }
  return limitCurationTsvRows(lines.join('\n'));
}

const MISSING_REPUTATION_DISCLOSURE = /no se pudo encontrar calificaci[oó]n p[uú]blica tras una b[uú]squeda dedicada\.?/i;

/**
 * Reemplaza el paso ciego de "que el LLM busque la calificación" por una consulta directa a la API
 * oficial de Google Places para las filas que quedaron en "Sin dato". Ningún prompt soluciona que
 * Google Maps no exponga su calificación como texto rastreable; la API sí la devuelve como dato
 * estructurado. Reescribe calificación, reseñas, plataforma, nivel y justificación de la fila para
 * que la fila quede consistente con `validateCurationBatch` (que exige que la justificación mencione
 * los mismos números). No-op si `GOOGLE_PLACES_API_KEY` no está configurada.
 */
async function enrichMissingReputationWithGooglePlaces(tsv: string, city: string, context?: ClaudeRunContext): Promise<string> {
  if (!isGooglePlacesConfigured()) return tsv;
  const lines = tsv.replace(/\r\n?/g, '\n').split('\n');
  const header = lines[0] ?? '';
  const rows = lines.slice(1).filter(line => line.trim());
  let enriched = 0;
  const matchedBy = { phone: 0, website: 0, name: 0 };
  // Cuántas filas traían siquiera un identificador utilizable. Sin esto no se puede distinguir
  // "la búsqueda por teléfono falló" de "ninguna fila traía teléfono".
  const available = { withPhone: 0, withDomain: 0 };
  const updatedRows = await Promise.all(rows.map(async line => {
    const cells = line.split('\t');
    const ratingCell = (cells[8] ?? '').trim();
    const reviewsCell = (cells[9] ?? '').trim();
    if (normalizePromptKey(ratingCell) !== 'sin dato' && normalizePromptKey(reviewsCell) !== 'sin dato') return line;
    const displayName = (cells[1] ?? '').trim();
    const rowCity = (cells[4] ?? '').trim() || city;
    if (!displayName) return line;
    // El teléfono y la URL de la fila identifican el negocio mucho mejor que su nombre comercial,
    // que es texto libre y rara vez coincide con el rótulo exacto de Google.
    const rowPhone = (cells[13] ?? '').trim();
    const rowWebsite = (cells[16] ?? '').trim();
    if (toE164Colombia(rowPhone)) available.withPhone += 1;
    if (toDomain(rowWebsite)) available.withDomain += 1;
    const found = await lookupGooglePlaceReputation(displayName, rowCity, { phone: rowPhone, websiteUrl: rowWebsite });
    if (!found) return line;
    enriched += 1;
    matchedBy[found.matchedBy] += 1;
    cells[8] = found.rating;
    cells[9] = found.reviews;
    cells[10] = found.platform;
    cells[11] = Number(found.reviews) >= 50 ? 'A' : 'B';
    const baseReason = (cells[12] ?? '').trim().replace(MISSING_REPUTATION_DISCLOSURE, '').trim();
    cells[12] = `${baseReason ? `${baseReason} ` : ''}Calificación verificada con Google Places API: ${found.rating} con ${found.reviews} reseñas en Google.`.slice(0, 900);
    // Suma (o reemplaza) la entrada de Google en la lista multiplataforma, sin perder otras
    // plataformas que el agente ya hubiera encontrado para esta fila.
    const existingMultiPlatform = parseMultiPlatformReputation(cells[18] ?? 'Sin dato') ?? [];
    const withoutGoogle = existingMultiPlatform.filter(entry => normalizePromptKey(entry.platform) !== 'google');
    cells[18] = [...withoutGoogle, { platform: found.platform, rating: Number(found.rating), reviews: Number(found.reviews) }]
      .map(entry => `${entry.platform}:${entry.rating.toFixed(1)}:${entry.reviews}`)
      .join(';');
    return cells.join('\t');
  }));
  if (context) logCurationEvent('google_places_enrichment', { ...context, attempted: rows.length, enriched, ...matchedBy, ...available });
  return [header, ...updatedRows].join('\n');
}

/**
 * Deja fuera del lote lo que no alcanza el umbral que pidio el operador.
 *
 * El prompt ya lleva el umbral, pero orientar al agente no es lo mismo que garantizarlo: vuelve con
 * negocios por debajo igualmente. Se filtra tambien lo que no tiene reputacion comprobable, porque
 * un "Sin dato" no puede demostrar que cumple, y el operador pidio no ver nada fuera del rango.
 * Se devuelven los conteos por separado para poder decirle cuantos se fueron y por que.
 */
/**
 * Completa el lote del agente con negocios del registro oficial que el agente no alcanzo.
 *
 * Medido en Barranquilla, Comida y Bebida con umbral 4.5 y 50 resenas: el agente devolvia 8
 * proveedores y el registro conocia 24 que cumplian, todos contactables. El agente llega a
 * negocios sin ficha publica, que es su valor, pero se queda corto en los que si la tienen.
 *
 * Lo encontrado por el agente manda: sus filas van primero y solo se anaden las que faltan,
 * deduplicando por nombre y por telefono para no repetir el mismo negocio con otro rotulo.
 */
export async function completeBatchFromHarvest(input: {
  tsv: string;
  places: HarvestedPlace[];
  city: string;
  category: string;
  minRating: number;
  minReviews: number;
  targetCount: number;
}): Promise<{ tsv: string; added: number; withEmail: number }> {
  const lines = input.tsv.replace(/\r\n?/g, '\n').split('\n');
  const header = lines[0] ?? '';
  const rows = lines.slice(1).filter(line => line.trim());
  const missing = input.targetCount - rows.length;
  if (missing <= 0 || !input.places.length) return { tsv: input.tsv, added: 0, withEmail: 0 };

  const seenNames = new Set<string>();
  const seenPhones = new Set<string>();
  for (const line of rows) {
    const cells = line.split('\t');
    seenNames.add(normalizePromptKey(cells[1] ?? ''));
    const digits = (cells[13] ?? '').replace(/\D/g, '');
    if (digits.length >= 10) seenPhones.add(digits.slice(-10));
  }

  const chosen: HarvestedPlace[] = [];
  for (const place of input.places) {
    if (chosen.length >= missing) break;
    if (typeof place.rating !== 'number' || typeof place.reviews !== 'number') continue;
    if (place.rating < input.minRating || place.reviews < input.minReviews) continue;
    const nameKey = normalizePromptKey(place.name);
    if (seenNames.has(nameKey)) continue;
    const phoneDigits = (place.phone ?? '').replace(/\D/g, '');
    const phoneKey = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : '';
    if (phoneKey && seenPhones.has(phoneKey)) continue;
    chosen.push(place);
    seenNames.add(nameKey);
    if (phoneKey) seenPhones.add(phoneKey);
  }
  if (!chosen.length) return { tsv: input.tsv, added: 0, withEmail: 0 };

  // El canal de contacto lo decide el correo: con correo corporativo se escribe, sin el queda
  // WhatsApp. El registro oficial no da correo, asi que sin leer el sitio TODO lo anadido caia
  // a WhatsApp por descarte, no porque el negocio no tenga correo.
  const contacts = new Map<string, { email?: string; instagram?: string }>();
  const CONCURRENCY = 4;
  const withSite = chosen.filter(place => place.website);
  for (let start = 0; start < withSite.length; start += CONCURRENCY) {
    const batch = withSite.slice(start, start + CONCURRENCY);
    const found = await Promise.all(batch.map(async place => ({
      placeId: place.placeId,
      contact: await scrapeProviderContact(place.website as string).catch(() => ({})),
    })));
    for (const entry of found) contacts.set(entry.placeId, entry.contact);
  }

  const extra: string[] = [];
  let index = rows.length + 1;
  let withEmail = 0;
  for (const place of chosen) {
    const contact = contacts.get(place.placeId);
    const verification = contact && (contact.email || contact.instagram)
      ? new Map([[place.placeId, { relevant: true, email: contact.email, instagram: contact.instagram }]])
      : undefined;
    const row = harvestedPlaceToRow(place, input.city, input.category, index, { verification });
    if (!row) continue;
    if (contact?.email) withEmail += 1;
    extra.push(row.join('\t'));
    index += 1;
  }
  if (!extra.length) return { tsv: input.tsv, added: 0, withEmail: 0 };
  return { tsv: [header, ...rows, ...extra].join('\n'), added: extra.length, withEmail };
}

export function filterByReputationThreshold(
  tsv: string,
  minRating: number,
  minReviews: number,
): { tsv: string; removed: number; belowThreshold: number; withoutReputation: number } {
  const lines = tsv.replace(/\r\n?/g, '\n').split('\n');
  const header = lines[0] ?? '';
  const rows = lines.slice(1).filter(line => line.trim());
  // Sin umbral efectivo no se toca el lote: filtrar seria quitar filas sin que nadie lo pidiera.
  if (minRating <= 0 && minReviews <= 0) {
    return { tsv, removed: 0, belowThreshold: 0, withoutReputation: 0 };
  }
  // La curaduria acepta reputacion repartida: si ninguna plataforma llega al minimo por si sola,
  // dos o mas que si alcancen la calificacion y sumen el doble de resenas tambien califican.
  // Mirar solo las columnas principales tiraba esos proveedores, que son legitimos.
  const combinedMinPlatforms = 2;
  const combinedMinReviews = minReviews * 2;
  let belowThreshold = 0;
  let withoutReputation = 0;
  const kept = rows.filter(line => {
    const cells = line.split('\t');
    const rating = Number((cells[8] ?? '').trim().replace(',', '.'));
    const reviews = Number((cells[9] ?? '').trim());
    const platforms = parseMultiPlatformReputation(cells[18] ?? 'Sin dato') ?? [];
    const qualifying = platforms.filter(entry => entry.rating >= minRating);
    const combinedReviews = qualifying.reduce((sum, entry) => sum + entry.reviews, 0);
    if (qualifying.length >= combinedMinPlatforms && combinedReviews >= combinedMinReviews) return true;
    if (!Number.isFinite(rating) || !Number.isFinite(reviews)) { withoutReputation += 1; return false; }
    if (rating < minRating || reviews < minReviews) { belowThreshold += 1; return false; }
    return true;
  });
  return {
    tsv: [header, ...kept].join('\n'),
    removed: rows.length - kept.length,
    belowThreshold,
    withoutReputation,
  };
}

export async function curateProviders(input: { city: string; category: string; instructions?: string; targetCount?: number; scanAttempt?: number; jobId?: string; runId?: string; minRating?: number; minReviews?: number; onPhase?: CurationPhaseReporter }): Promise<GeminiCurationResult> {
  const configuredProvider = String(env('CURATION_PROVIDER') || 'gemini').trim().toLowerCase();
  const provider: 'gemini' | 'claude-code' | 'codex' = configuredProvider === 'claude-code'
    ? 'claude-code'
    : configuredProvider === 'codex'
      ? 'codex'
      : 'gemini';
  const apiKey = env('GEMINI_API_KEY');
  if (provider === 'gemini' && !apiKey) throw new Error('GEMINI_NOT_CONFIGURED');
  const model = provider === 'claude-code'
    ? 'sonnet'
    : provider === 'codex'
      ? env('CODEX_MODEL') || 'gpt-5.6-luna'
      : env('GEMINI_AGENT_MODEL') || 'gemini-3.8-flash';
  // Umbral de reputacion que pide el operador. Se usa en dos sitios: en el prompt, para que el
  // agente no gaste escaneos en negocios que van a caer, y al filtrar el lote, porque el prompt
  // orienta pero no garantiza. Los valores por defecto son el estandar de curaduria.
  const minRating = Number.isFinite(input.minRating)
    ? Math.min(5, Math.max(0, Math.round((input.minRating as number) * 10) / 10))
    : 4.5;
  const minReviews = Number.isFinite(input.minReviews)
    ? Math.max(0, Math.min(100000, Math.trunc(input.minReviews as number)))
    : 30;
  const minRatingText = minRating.toFixed(1);
  const city = input.city.trim();
  const category = input.category.trim();
  if (!city || !category) throw new Error('CITY_AND_CATEGORY_REQUIRED');
  const isBroadFoodDiscovery = normalizePromptKey(city) === 'barranquilla' && normalizePromptKey(category) === 'comida y bebida';
  const maxTurns = isBroadFoodDiscovery ? 60 : 32;
  const targetCount = Math.max(1, Math.min(100, Math.trunc(input.targetCount ?? 20)));
  const scanAttempt = input.scanAttempt ?? 1;
  const runContext: ClaudeRunContext = currentCurationContext(
    input.jobId ? { jobId: input.jobId, scanNumber: scanAttempt, role: 'single' } : undefined,
  );
  const historicalBlacklist = await getCurationBlacklist(city, category, input.runId);
  const blacklistInstruction = historicalBlacklist.length
    ? `\nLISTA DE NOMBRES YA PROCESADOS (aprobados y rechazados en escaneos anteriores para esta ciudad/categoría). No los vuelvas a buscar ni incluir; busca alternativas nuevas. Solo se envían nombres para reducir ruido; el servidor aplica la lista completa, incluidos URLs y motivos, antes de verificar:\n${compactBlacklistForPrompt(historicalBlacklist)}\n`
    : '\nNo hay candidatos históricos en la base de datos para esta ciudad y categoría; todos los resultados deben ser nuevos.\n';
  input.onPhase?.('preparing', `Preparando búsqueda para ${city} · ${category}.`);
  const researchToolInstruction = provider === 'claude-code'
    ? (isBroadFoodDiscovery
      ? 'Haz una exploración amplia y sistemática: usa consultas WebSearch por subtipos como restaurantes para eventos, catering, banquetes, repostería, brunch, comida empresarial y salones con servicio de alimentos en Barranquilla. No te detengas al encontrar 3; recorre los subtipos y fuentes hasta construir un lote amplio basado en evidencia real. Prioriza fuentes oficiales, perfiles directos y páginas con teléfono, WhatsApp o correo; no descartes un negocio solo porque no tenga reseñas. Usa WebFetch en la ficha o sitio oficial y, cuando haga falta, en una página de contacto del mismo dominio. Las redes sociales y enlaces cortos de WhatsApp sirven para descubrir nombres o contactos, pero no los abras con WebFetch ni los uses como única Fuente URL final: prioriza siempre un sitio oficial o ficha directa legible. No abras listados generales como fuente final; si una fuente devuelve 403, 404, 410, 526 o está vacía, busca otra fuente directa para ese negocio. Si la misma URL falla o se repite dos veces, abandónala y continúa con otro candidato. El límite es estricto: máximo 2 WebFetch por candidato, sin excepciones. Devuelve todos los negocios verificables encontrados tras la exploración, sin fabricar una cuota.'
      : 'Haz la investigación por triage, no por volumen: empieza con 2 o 3 consultas WebSearch muy específicas para la ciudad y categoría y selecciona como máximo 6 candidatos prometedores por identidad, servicio y contacto público. La reputación visible es prioritaria para los candidatos listos, pero no descartes todavía un negocio real solo porque sus reseñas no aparecen: si el sitio o perfil está vivo, confirma el servicio y encuentras contacto público, inclúyelo como candidato que requiere revisión. Después usa WebFetch solo sobre la ficha directa o sitio oficial de cada candidato y, cuando haga falta, sobre una página de contacto del mismo dominio. No abras listados generales, directorios, páginas de resultados ni rutas alternativas repetidas; si una fuente devuelve 403, 404, 410, 526 o está vacía, descártala y sigue con otro candidato. Máximo 2 WebFetch por candidato. Usa como Fuente URL la página específica que realmente pudiste leer; prioriza servicios, nosotros, contacto o perfil sobre el dominio raíz.')
    : 'Antes de incluir un candidato, búscalo con Google Search y abre la fuente con url_context. Usa como Fuente URL la página que realmente pudiste leer; prioriza una página específica de servicios, nosotros, contacto o perfil sobre el dominio raíz cuando exista.';

  const discoveryInstruction = isBroadFoodDiscovery
    ? `Esta es una búsqueda amplia, escaneo ${scanAttempt}. Recorre de forma sistemática restaurantes, catering, banquetes, repostería, brunch y alimentación empresarial. No confundas "candidato listo" con "prospecto descubierto": los prospectos con contacto y servicio confirmado deben salir aunque requieran revisión de reputación. No inventes datos ni fuerces una cantidad; devuelve todos los negocios reales que puedas sostener con fuentes vivas, hasta 20 en este escaneo.`
    : 'Entrega entre 3 y 8 prospectos verificables, no solo los que pasan la curaduría. El objetivo es encontrar hasta 3 candidatos listos y conservar también los prospectos reales que requieren revisión.';

  // Presupuesto de herramientas. Se elimina del prompt compartido de verificación porque describe
  // el descubrimiento: los subagentes solo tienen WebFetch y reciben su propio límite por roster.
  const budgetInstruction = isBroadFoodDiscovery
    ? 'Para esta búsqueda amplia recorre los subtipos sin detenerte al encontrar 3, y respeta el límite estricto de 2 WebFetch por candidato.'
    : 'Trabaja con un presupuesto estricto de máximo 8 consultas WebSearch y 2 WebFetch por candidato, pero no intentes agotarlo; cuando tengas suficientes prospectos verificables, detente.';

  // Cosecha previa desde Google Places. Le entrega al agente una lista del rubro que ya trae
  // calificación, reseñas y contacto verificados por la API, para que gaste sus búsquedas en
  // confirmar pertinencia y completar correo en vez de en descubrir nombres a ciegas.
  let harvestBlock = '';
  let harvestedPlaces: HarvestedPlace[] = [];
  // CURATION_DISABLE_HARVEST=1 apaga la cosecha para poder medir el brazo de control del benchmark.
  const harvestEnabled = String(env('CURATION_DISABLE_HARVEST') || '').trim() !== '1';
  if (harvestEnabled && isGooglePlacesConfigured() && hasHarvestQueries(category)) {
    try {
      const harvest = await harvestCategoryCandidates(city, category);
      const usable = harvest.candidates.filter(isContactable);
      harvestedPlaces = usable;
      logCurationEvent('places_harvest', {
        jobId: input.jobId, runId: input.runId, scanNumber: scanAttempt,
        category, apiCalls: harvest.apiCalls, durationMs: harvest.durationMs,
        candidates: harvest.candidates.length, contactables: usable.length, ready: harvest.ready.length,
      } as never);
      const listado = formatHarvestForPrompt(harvest);
      if (listado) {
        harvestBlock = `
PUNTO DE PARTIDA VERIFICADO — ${usable.length} negocios de "${category}" en ${city} obtenidos de la API oficial de Google Places. Calificación, reseñas, teléfono y web de esta lista YA están verificados: cópialos tal cual, no los vuelvas a buscar y no los alteres.
${listado}

Trabaja sobre esta lista primero. Tu tarea con ellos NO es descubrirlos sino verificarlos: confirma en una fuente viva que el negocio realmente presta el servicio de "${category}" para eventos (un rótulo de Google puede ser genérico), y completa lo que la API no da — correo electrónico e Instagram. Descarta el que no preste el servicio y dilo en la justificación. Cuando la lista no alcance el objetivo, o no cubra bien la categoría, complétala con investigación web propia como harías normalmente.
`;
      }
    } catch (error) {
      console.error('Places harvest failed; se continúa sin lista previa.', error instanceof Error ? error.message : error);
    }
  }

  const prompt = `Actúa como agente de investigación y curaduría de proveedores para eventos en Colombia.
Investiga en la web proveedores reales de la ciudad "${city}" para la categoría "${category}".${harvestBlock}
${input.instructions?.trim() ? `Instrucciones adicionales del operador: ${input.instructions.trim()}` : ''}

  ${discoveryInstruction} Un candidato listo debe cumplir calificación mínima ${minRatingText}, al menos ${minReviews} reseñas, evidencia reciente y contacto público. Un prospecto para revisión debe tener identidad, servicio y contacto público confirmados en una fuente viva, pero puede tener calificación menor, menos reseñas o reputación sin confirmar: conserva "Sin dato" cuando corresponda, explica exactamente qué falta y no inventes valores. La aplicación lo mostrará como "Requiere revisión" y no lo importará como válido hasta corregirlo. No incluyas negocios sin contacto público o con todas sus fuentes inaccesibles. ${budgetInstruction} Si no hay suficientes fuentes, devuelve solo negocios reales y explica el déficit; no inventes datos.
Usa exactamente estos valores controlados y no inventes etiquetas: Segmento = "Bajo Costo", "Premium" o "Sin clasificar"; Zona Estandarizada = "Zona Norte / Comercial Alta", "Zona Centro / Tradicional", "Zona Sur / Occidente Comercial", "Zona Campestre / Periferia", "Área Metropolitana", "Cobertura Nacional" o "Sin dato"; Escala = "Pequeño (Hasta 50 pers.)", "Mediano (50 a 200 pers.)", "Masivo (Más de 200 pers.)" o "Sin dato"; Formalidad = "Formalizado (NIT - Empresa)", "Independiente (RUT - Persona Natural)" o "No verificado"; Nivel Curaduría = "A" o "B".
Usa únicamente negocios existentes y no inventes teléfonos, correos, calificaciones, reseñas o URLs.
El objetivo global solicitado es ${targetCount} candidatos relevantes, pero este escaneo está limitado a 20. Si faltan candidatos, el sistema lanzará otro escaneo con la blacklist actualizada; no repitas candidatos históricos.
El resultado de este escaneo puede contener como máximo ${MAX_CURATION_CANDIDATES} prospectos; no rellenes el límite con negocios débiles ni inventes una cuota.
${blacklistInstruction}
La URL debe ser la ficha o perfil directo del negocio, no una página de resultados de búsqueda.
${researchToolInstruction}
Si una URL no abre, redirige a una página inexistente, devuelve un error o no contiene evidencia del negocio, descarta ese candidato y busca otra fuente. No inventes una URL alternativa ni uses una página de resultados.
Cruza la evidencia: confirma identidad y servicio en una fuente oficial o perfil directo, y contrasta reputación, calificación y reseñas en la plataforma indicada. La fecha de verificación debe ser la fecha actual de la investigación, no una fecha antigua de la página, y SIEMPRE en formato AAAA-MM-DD (año-mes-día, ej. "2026-09-19"); nunca DD/MM/AAAA ni ningún otro formato.
Para un candidato listo cumple: calificación mínima ${minRatingText} y mínimo ${minReviews} reseñas exactas, sin importar el tipo de proveedor. Los prospectos en revisión pueden quedar por debajo o usar "Sin dato", pero deben tener identidad, servicio, fuente viva y contacto comprobados.
Nivel A corresponde a 50 o más reseñas. Nivel B se usa para 30 a 49 reseñas y también para cualquier prospecto en revisión cuya reputación no pudo confirmarse.
La reputación visible es obligatoria cuando existe: no te limites a Google. Busca activamente en Google, Tripadvisor, Booking, Rappi, DiDi (o DiDi Food) y Facebook — cualquier plataforma donde el negocio tenga reseñas públicas cuenta igual. Registra la calificación exacta, la cantidad de reseñas y la plataforma exacta donde las encontraste. Solo usa "Sin dato" en calificación y reseñas cuando realmente no haya reputación pública localizable en ninguna de estas plataformas, y explícalo en la justificación. No inventes ni aproximes estos valores.
Solo esas 6 plataformas cuentan como reputación verificable. NUNCA cites un directorio agregador (Cybo, TodosNegocios, PaginasAmarillas, Guía Local o similares) como "Plataforma Reputación" o dentro de "Reputación Multiplataforma": esos sitios scrapean datos de otras fuentes y no son confiables. Si solo encuentras el dato en un agregador, trátalo como si no lo hubieras encontrado y usa "Sin dato".
Booking.com publica su puntuación sobre 10 (por ejemplo "8.3"), no sobre 5 como las demás plataformas: conviértela a escala 0-5 dividiéndola entre 2 (8.3 → 4.2) antes de usarla como Calificación o dentro de "Reputación Multiplataforma"; nunca dejes un valor de Booking sin convertir.
En la columna "Reputación Multiplataforma" (columna 19) registra TODAS las plataformas donde encontraste calificación y reseñas reales, en formato "Plataforma:Calificación:Reseñas" separadas por ";" (por ejemplo "TripAdvisor:4.6:35;Facebook:4.5:30"); usa exactamente "Sin dato" si no encontraste ninguna. Un candidato sin 30 reseñas en una sola plataforma también pasa si la suma de reseñas de 2 o más plataformas con calificación 4.5 o más llega a 60 o más; en ese caso, la justificación debe decir explícitamente "reputación combinada" e incluir el total exacto sumado.
Muchos negocios ofrecen servicios de más de una categoría oficial: un hotel puede ser "Lugar" (salón de eventos) y ADEMÁS ofrecer catering real ("Comida y Bebida") o entretenimiento en vivo. Revisa la evidencia (menú propio, salones, actividades) antes de decidir. En la columna "Categorías Adicionales" (la última, columna 20) lista, separadas por ";", las categorías oficiales adicionales que el negocio realmente cumple según servicios evidenciados (no supuestos); usa exactamente "Sin dato" si solo aplica su categoría principal. Nunca repitas ahí la categoría principal de la columna 3.
Si un dato no es público usa exactamente "Sin dato"; para Instagram ausente usa "Sin Redes".
El contacto es obligatorio: una empresa sin correo corporativo verificable ni móvil colombiano público para WhatsApp no sirve y debes descartarla. Para encontrarlo, abre y revisa de forma explícita enlaces y rutas como /contacto, /contactanos, /contact, /contact-us, /contactus, /contact-us.html, /nosotros, /about, /reservas, /cotizar, /agendar, /book y sus variantes con o sin guiones, plural o idioma inglés. Busca también el pie de página, botones de WhatsApp, mailto: y tel:. No infieras un correo o teléfono desde el nombre del negocio.
La justificación debe incluir la calificación, cantidad de reseñas y plataforma cuando existan; además evidencia publicada de servicios para eventos, actividad publicada dentro de los últimos 12 meses y, para un prospecto en revisión, una frase clara con el dato que falta o el umbral que no cumple. IMPORTANTE: escribe SIEMPRE los números exactos que TÚ encontraste (ej. si encontraste 4.7 y 5628 reseñas, escribe literalmente "4.7" y "5628"); no basta con decir que "cumple el umbral de 4.5 y 30 reseñas" sin repetir la cifra real que verificaste, porque el sistema exige encontrar tu calificación y tus reseñas exactas en el texto.
Separa el canal de contacto de forma conservadora: prioriza CORREO para empresas medianas o masivas cuando exista un correo válido, o para cualquier empresa que tenga un dominio/correo corporativo propio verificable (no Gmail, Hotmail, Outlook, Yahoo ni similares). Para empresas pequeñas o con correo gratuito, usa WHATSAPP solo si hay un número móvil colombiano público y verificable. Si no existe correo corporativo ni móvil para WhatsApp, no incluyas el candidato.
Cuando el canal sea CORREO, rellena el correo corporativo real y, si existe, también el teléfono. Cuando el canal sea WHATSAPP, prioriza el número móvil real y usa "Sin dato" en correo si el correo no es corporativo; nunca inventes datos ni conviertas un teléfono fijo en WhatsApp.
Los IDs deben tener formato ABC-CC-###, donde CC es el código: Lugar 01, Comida y Bebida 02, Música 03, Servicios Especializados 04, Entretenimiento 05, Decoración temática 06, Fotografía y Video 07, Invitación digital 08, Menaje y mantelería 09, Carpas y mobiliario 10.
Devuelve un objeto JSON válido con exactamente dos campos: "tsv" y "research_summary". En "tsv" incluye la línea de encabezados exacta ${JSON.stringify(CURATION_HEADERS.join('\t'))}, seguida de una fila por candidato con las ${CURATION_HEADERS.length} columnas separadas por tabulaciones. Dentro del JSON escapa siempre los saltos de línea como \\n y las tabulaciones como \\t; no pongas saltos de línea literales dentro del valor de "tsv". No uses tablas Markdown; no uses barras verticales dentro de las celdas. No incluyas explicaciones fuera del JSON solicitado.`;

  // Prompt propio para Codex, en inglés y explícito: el fallo observado con esfuerzo medio/alto no
  // era falta de instrucción sobre reputación (el prompt en español ya la pedía), sino que el agente
  // no hacía una búsqueda dedicada de reputación por cada candidato final antes de responder. Este
  // protocolo lo vuelve un paso obligatorio y numerado en vez de una recomendación entre párrafos.
  const codexBlacklistInstruction = historicalBlacklist.length
    ? `\nALREADY-PROCESSED NAMES (accepted or rejected in previous scans for this city/category). Do not search for or include them again; find new alternatives. Only names are sent here to reduce noise; the server applies the full list, including URLs and reasons, before verifying:\n${compactBlacklistForPrompt(historicalBlacklist)}\n`
    : '\nThere are no historical candidates in the database yet for this city and category; every result must be new.\n';
  const codexDiscoveryInstruction = isBroadFoodDiscovery
    ? `This is a broad scan, scan number ${scanAttempt}. Systematically cover restaurants for events, catering, banquet halls, bakeries/pastry, brunch spots, and corporate catering. Do not confuse a "ready candidate" with a "discovered prospect": prospects with confirmed contact and service must be returned even if their reputation still needs review. Do not invent data or force a quota; return every real business you can support with live sources, up to 20 in this scan.`
    : 'Deliver between 3 and 8 verifiable prospects, not only the ones that pass full curation. The goal is to find up to 3 ready candidates and also keep real prospects that require review.';
  const codexPrompt = `You are a research and curation agent for event vendors ("proveedores para eventos") in Colombia.

TASK: Research REAL, currently operating businesses in the city "${city}" for the category "${category}", using your built-in web_search tool.
${input.instructions?.trim() ? `Additional operator instructions: ${input.instructions.trim()}` : ''}

${codexDiscoveryInstruction} A "ready" candidate must meet: minimum rating ${minRatingText}, at least ${minReviews} reviews, recent public evidence, and public contact info. A "review" prospect must have confirmed identity, service, a live source, and public contact, but may have a lower rating, fewer reviews, or unconfirmed reputation: keep "Sin dato" when that applies, explain exactly what is missing, and never invent values. The application will show it as "Requiere revisión" and will not import it until it is fixed. Do not include any business without public contact info or with only unreachable sources. If you cannot find enough sources, return only real businesses and explain the shortfall; never invent data.

MANDATORY REPUTATION VERIFICATION PROTOCOL — follow this for every business before deciding to include it in your final answer. No exceptions, regardless of how confident you already are:
1. Once you have a candidate business (name + evidence of service + public contact), run ONE ADDITIONAL, DEDICATED web_search query just for its reputation, for example: "<business name>" ${city} reseñas Google, or "<business name>" opiniones, or "<business name>" rating reviews. Do this even if an earlier, more general search already showed a rating — confirm it with a targeted query before you finalize the candidate.
2. Do not limit this search to Google, and do not spend more than one query specifically trying to find a Google rating. Google Maps renders its star rating with JavaScript and does not expose it as crawlable text, so your web_search tool frequently cannot see it even when it is real and visible to a human browsing Google directly — this is an expected tool limitation, not a sign the business lacks reviews. After at most one Google-focused attempt, actively check other platforms: TripAdvisor, Booking, Rappi, DiDi (or DiDi Food), and Facebook — these usually have real, crawlable review pages. Any platform where the business has public reviews counts equally; read the results carefully and extract the exact rating (one decimal, e.g. "4.7") and the exact review count (integer, e.g. "128") from whichever platform actually has it. Never estimate, round, or guess these numbers. IMPORTANT: Booking.com publishes its score out of 10 (e.g. "8.3"), not out of 5 like every other platform — convert it to a 0-5 scale by dividing by 2 (8.3 → 4.2) before writing it anywhere; never leave a Booking value unconverted. Only these 6 platforms count as verifiable reputation. NEVER cite an aggregator directory (Cybo, TodosNegocios, PaginasAmarillas, or similar scraped listing sites) as "Plataforma Reputación" or inside "Reputación Multiplataforma" — those sites scrape data from other sources and are not reliable. If you only find the number on an aggregator, treat it as not found and use "Sin dato".
3. If, after checking Google plus at least one other platform, you still find no public rating or review count, you may still include the business as a "review" prospect, but you MUST write "Sin dato" for both fields, and the justification (in Spanish) must end with exactly this sentence, unedited: "No se pudo encontrar calificación pública tras una búsqueda dedicada." Do not paraphrase this sentence — copy it exactly, word for word, so the app's automated check recognizes it.
4. Do NOT include any business in your final "tsv" for which you skipped step 1. If your search budget is running low, return fewer candidates rather than skipping this verification for any of them.
5. Never use Instagram as the reputation platform.
6. Record EVERY platform where you found a real rating and review count — not just the best one — in column 19, "Reputación Multiplataforma", formatted "Platform:Rating:Reviews" separated by ";" (e.g. "TripAdvisor:4.6:35;Facebook:4.5:30"); use exactly "Sin dato" if you found none. A business without 30 reviews on any single platform can still qualify if 2 or more platforms with rating 4.5+ add up to 60 or more combined reviews — when that is the only reason a business qualifies, the justification (in Spanish) must say so explicitly ("reputación combinada") and state the exact combined total.
7. Many businesses genuinely offer services spanning more than one official category — a hotel can be "Lugar" (event venue) and ALSO run real catering ("Comida y Bebida") or live entertainment. Check the actual evidence (own menu, event halls, scheduled activities) before deciding, never assume. In the last column, "Categorías Adicionales" (column 20), list — separated by ";" — any other official categories the business genuinely qualifies for based on evidenced services; use exactly "Sin dato" if only its primary category applies. Never repeat the primary category (column 3) here.

Use exactly these controlled values, in Spanish, and never invent new labels — these are literal data values the app validates, not prose to translate:
- Segmento: "Bajo Costo", "Premium", or "Sin clasificar".
- Zona Estandarizada: "Zona Norte / Comercial Alta", "Zona Centro / Tradicional", "Zona Sur / Occidente Comercial", "Zona Campestre / Periferia", "Área Metropolitana", "Cobertura Nacional", or "Sin dato".
- Escala: "Pequeño (Hasta 50 pers.)", "Mediano (50 a 200 pers.)", "Masivo (Más de 200 pers.)", or "Sin dato".
- Formalidad: "Formalizado (NIT - Empresa)", "Independiente (RUT - Persona Natural)", or "No verificado".
- Nivel Curaduría: "A" or "B".

Only use businesses that actually exist; never invent phone numbers, emails, ratings, review counts, or URLs.
The overall requested goal is ${targetCount} relevant candidates, but this scan is capped at 20. If more are still needed, the system will run another scan with an updated blacklist; do not repeat historical candidates.
This scan's result can contain at most ${MAX_CURATION_CANDIDATES} prospects; do not pad the list with weak businesses or invent a quota.
${codexBlacklistInstruction}
The URL must be the business's own direct page or listing, never a search-results page. Before including a candidate, search for it and open its official page or direct listing to confirm it. Use as "Fuente URL" the specific page you actually read; prefer a services, about, contact, or profile page over the bare root domain. Never invent a URL you did not open. If a URL fails to open, redirects to a nonexistent page, returns an error, or shows no evidence of the business, discard that candidate and look for another source.
Cross-check the evidence: confirm identity and service from an official source or direct profile, and confirm reputation, rating, and reviews on the platform you cite — this is exactly what the mandatory protocol above is for. The verification date must be today's date, not an old date found on the page, and it MUST use the format YYYY-MM-DD (year-month-day, e.g. "2026-09-19") — never DD/MM/YYYY or any other format.
For a "ready" candidate: minimum rating 4.5 and at least 30 reviews, exact count — this single standard applies to every business type, no exceptions by category. Review prospects may fall below this threshold or use "Sin dato", but must have confirmed identity, service, a live source, and contact.
Nivel A = 50 or more reviews. Nivel B is used for 30-49 reviews, and also for any review prospect whose reputation could not be confirmed.
Public contact is mandatory: a business without a verifiable corporate email or a public Colombian mobile number for WhatsApp is not usable and must be discarded. To find it, explicitly check links and paths like /contacto, /contactanos, /contact, /contact-us, /contactus, /contact-us.html, /nosotros, /about, /reservas, /cotizar, /agendar, /book, and their hyphenated/plural/English variants. Also check the page footer, WhatsApp buttons, mailto:, and tel:. Never infer an email or phone number from the business name.
The justification (in Spanish) must include the rating, review count, and platform when they exist, plus published evidence of event-related services, evidence of activity in the last 12 months, and, for a review prospect, a clear sentence naming exactly what is missing or which threshold is not met. IMPORTANT: always write the exact numbers YOU actually found (e.g. if you found 4.7 and 5628 reviews, write "4.7" and "5628" literally in the justification) — saying it "meets the 4.5 and 30 review threshold" without repeating your own real verified figures is not enough, because the system requires your exact rating and review count to appear in the text.
Separate the contact channel conservatively: prefer CORREO for medium/large businesses with a valid email, or for any business with its own verifiable corporate domain/email (not Gmail, Hotmail, Outlook, Yahoo, or similar). For small businesses or free-email businesses, use WHATSAPP only if there is a public, verifiable Colombian mobile number. If there is neither a corporate email nor a WhatsApp-eligible mobile number, do not include the candidate.
When the channel is CORREO, fill in the real corporate email and, if it exists, the phone too. When the channel is WHATSAPP, prioritize the real mobile number and use "Sin dato" for email if it is not corporate; never invent data or turn a landline into a WhatsApp number.
Each ID must follow the pattern LLL-CC-###, where: LLL is a 3-letter code YOU derive from the business name (uppercase letters, e.g. "HWB" for "Hotel Windsor Barranquilla" or "AMC" for "Amalfi Cucina") — never the literal text "ABC"; CC is the fixed 2-digit category code: Lugar 01, Comida y Bebida 02, Música 03, Servicios Especializados 04, Entretenimiento 05, Decoración temática 06, Fotografía y Video 07, Invitación digital 08, Menaje y mantelería 09, Carpas y mobiliario 10; and ### is a 3-digit sequence starting at 001 for this response, incrementing per row (001, 002, 003, ...). Example for a Comida y Bebida candidate: "AMC-02-001", not "ABC-02-001".

Return a valid JSON object with exactly two fields: "tsv" and "research_summary" (research_summary may be in English or Spanish). In "tsv", include the exact header line ${JSON.stringify(CURATION_HEADERS.join('\t'))}, followed by one row per candidate with all ${CURATION_HEADERS.length} tab-separated columns — the controlled field values, "Sin dato", "Sin Redes", and the justification text must be in Spanish, exactly as specified above. Inside the JSON, always escape newlines as \\n and tabs as \\t; never put a literal newline inside the "tsv" value. Do not use Markdown tables; do not use pipe characters inside cells. Do not include any explanation outside the requested JSON.`;

  input.onPhase?.('researching', provider === 'claude-code'
    ? 'Conectando con Claude Code y WebSearch.'
    : provider === 'codex'
      ? 'Conectando con Codex CLI y búsqueda web.'
      : 'Conectando con Google Search y contexto de URLs.', { current: 0, total: 4, label: 'Buscando candidatos' });
  let response: Response | undefined;
  let outputText: string | undefined;
  let discoveredCandidates: CurationDiscoveredCandidate[] = [];
  if (provider === 'claude-code' || provider === 'codex') {
    // El descubrimiento amplio en dos fases (con subagentes de verificación) usa nombres de
    // herramientas propios de Claude Code (WebSearch/WebFetch por separado); Codex solo tiene una
    // herramienta unificada de búsqueda web, así que siempre usa la investigación de un solo turno.
    if (isBroadFoodDiscovery && provider === 'claude-code') {
      const discoveryPrompt = `Actúa como descubridor de proveedores de comida y bebida para eventos en Barranquilla, Colombia.
Usa únicamente WebSearch. Haz una exploración amplia por restaurantes para eventos, catering, banquetes, repostería, brunch, coffee break y alimentación empresarial. Busca nombres reales, sitios oficiales, fichas directas y datos de contacto que aparezcan públicamente. No abras páginas con WebFetch, no inventes teléfonos o correos y no uses resultados genéricos como candidatos.
Devuelve exactamente un objeto JSON con un campo "candidates" que contenga como máximo ${MAX_CURATION_CANDIDATES} objetos. Cada objeto debe tener: "name", "type", "direct_url", "phone", "email", "contact_source", "evidence", "rating", "reviews", "platform".
No te limites a Google: busca reputación activamente en Google, TripAdvisor, Booking, Rappi, DiDi (o DiDi Food) y Facebook; cualquier plataforma donde el negocio tenga reseñas públicas cuenta igual. Cuando los resultados de búsqueda muestren la reputación del negocio, cópiala tal cual: "rating" con un decimal (por ejemplo "4.7"), "reviews" con el número entero de reseñas (por ejemplo "128") y "platform" con la fuente exacta donde la encontraste. Es un dato prioritario: búscalo activamente. Si no aparece publicado en ninguna de estas plataformas, usa "Sin dato" en los tres; jamás estimes, redondees ni inventes una calificación o un número de reseñas. Booking.com publica su puntuación sobre 10 (ej. "8.3"): conviértela a escala 0-5 dividiendo entre 2 (8.3 → 4.2) antes de ponerla en "rating". Solo esas 6 plataformas cuentan: nunca uses un directorio agregador (Cybo, TodosNegocios, PaginasAmarillas o similares) como "platform"; si el dato solo aparece ahí, trátalo como no encontrado y usa "Sin dato".
Usa "Sin dato" cuando algo no esté publicado. Incluye candidatos aunque no tengan reseñas si existe una empresa real y una pista verificable de servicio o contacto. No repitas nombres ni incluyas negocios de otra ciudad. Respeta la lista histórica de no repetir incluida abajo.${blacklistInstruction}`;
      input.onPhase?.('researching', 'Construyendo una lista amplia de negocios por subtipos.', { current: 1, total: 4, label: 'Buscando candidatos' });
      const boundedDiscoveryPrompt = discoveryPrompt + '\nUsa como máximo 12 consultas WebSearch y termina cuando tengas un roster útil; no intentes agotar el presupuesto.';
      const discoveryRun = await runClaudeCode({
        prompt: boundedDiscoveryPrompt,
        onPhase: input.onPhase,
        maxTurns: 30,
        tools: ['WebSearch'],
        role: 'discovery',
        context: runContext,
      });
      const discovery = parseJsonEnvelope<{ candidates?: unknown[] }>(discoveryRun.output);
      const roster = discovery?.candidates
        ?.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate && typeof candidate === 'object'))
        .filter(candidate => !candidateIsBlacklisted(candidate, historicalBlacklist, city, category))
        .slice(0, MAX_CURATION_CANDIDATES) ?? [];
      if (!roster.length) throw new Error('CLAUDE_CODE_DESCUBRIMIENTO_VACIO: la búsqueda no devolvió ningún negocio nuevo para esta ciudad y categoría.');
      logCurationEvent('discovery_done', {
        ...runContext,
        webSearchCalls: discoveryRun.webSearchCalls,
        durationMs: discoveryRun.durationMs,
        partial: discoveryRun.partial,
        roster: roster.length,
      });
      discoveredCandidates = roster.map(candidate => ({
        name: typeof candidate.name === 'string' ? candidate.name.trim() : '',
        directUrl: typeof candidate.direct_url === 'string' ? candidate.direct_url.trim() : '',
        payload: candidate,
      })).filter(candidate => candidate.name);
      input.onPhase?.('researching', `Lista amplia construida: ${roster.length} candidatos para verificar.`, { current: 2, total: 4, label: 'Evaluando reputación y evidencia' });
      // Solo van a WebFetch las URLs que WebFetch puede leer. Un perfil de red social no se abre
      // (devuelve bloqueo), pero el negocio NO se descarta: pasa a la vía de respaldo, que arma su
      // fila con el contacto que ya encontró el descubrimiento.
      const verificationRoster = roster.filter(candidate => {
        const rawUrl = typeof candidate.direct_url === 'string' ? candidate.direct_url : '';
        return Boolean(rawUrl) && !isSocialProfileUrl(rawUrl) && !AGGREGATOR_OR_SHORTLINK_HOSTS.test(rawUrl);
      });
      logCurationEvent('verification_roster', {
        ...runContext,
        descubiertos: roster.length,
        aWebFetch: verificationRoster.length,
        aRespaldoPorRedSocial: roster.length - verificationRoster.length,
      });
      const compactVerificationRoster = verificationRoster.map(candidate => ({
        name: typeof candidate.name === 'string' ? candidate.name.slice(0, 160) : 'Sin dato',
        type: typeof candidate.type === 'string' ? candidate.type.slice(0, 80) : 'Sin dato',
        direct_url: typeof candidate.direct_url === 'string' ? candidate.direct_url.slice(0, 500) : 'Sin dato',
        phone: typeof candidate.phone === 'string' ? candidate.phone.slice(0, 80) : 'Sin dato',
        email: typeof candidate.email === 'string' ? candidate.email.slice(0, 160) : 'Sin dato',
        contact_source: typeof candidate.contact_source === 'string' ? candidate.contact_source.slice(0, 240) : 'Sin dato',
        evidence: typeof candidate.evidence === 'string' ? candidate.evidence.slice(0, 500) : 'Sin dato',
      }));
      // los subagentes solo tienen WebFetch y reciben un roster cerrado.
      const sharedVerificationPrompt = `Actúa como verificador de proveedores para eventos en Colombia.
Ciudad: ${city}. Categoría: ${category}.
Esta es una etapa de verificación sobre un roster creado por una búsqueda previa. Procesa el roster completo antes de responder; no hagas búsquedas generales ni inventes datos. Solo tienes WebFetch disponible: verifica una vez cada URL oficial o ficha directa del roster y, solo si falta contacto, una única ruta de contacto del mismo dominio. Si una URL falla, pasa al siguiente proveedor. Conserva como prospecto cualquier negocio con identidad, servicio, fuente viva y contacto público aunque sus reseñas no estén disponibles.
El contacto es obligatorio: una empresa sin correo corporativo verificable ni móvil colombiano público para WhatsApp no sirve. Busca explícitamente rutas como /contacto, /contactanos, /contact, /contact-us, /contactus, /nosotros, /about, /reservas, /cotizar, /agendar y /book, además de mailto:, tel:, pie de página y botones de WhatsApp. No infieras datos.
La reputación visible es obligatoria cuando existe: no te limites a Google, revisa también TripAdvisor, Booking, Rappi, DiDi (o DiDi Food) y Facebook. Si encuentras calificación y número de reseñas en la página, su ficha o cualquiera de esas plataformas, cópialos exactos junto con la plataforma donde los encontraste y repítelos LITERALMENTE en la justificación (no basta con decir que "cumple el umbral"; escribe la cifra real que encontraste). Si no están publicados en ninguna, usa "Sin dato" en los tres y di en la justificación qué falta por confirmar. Nunca estimes ni inventes esos valores. Booking.com publica su puntuación sobre 10 (ej. "8.3"): conviértela a escala 0-5 dividiendo entre 2 (8.3 → 4.2) antes de usarla. Solo esas 6 plataformas cuentan: nunca cites un directorio agregador (Cybo, TodosNegocios, PaginasAmarillas o similares); si el dato solo aparece ahí, es "Sin dato".
En la columna 19, "Reputación Multiplataforma", registra TODAS las plataformas con calificación y reseñas reales que encontraste, formato "Plataforma:Calificación:Reseñas" separadas por ";" (ejemplo "TripAdvisor:4.6:35;Facebook:4.5:30"); "Sin dato" si no encontraste ninguna. Sin 30 reseñas en una sola plataforma, el candidato igual pasa si 2 o más plataformas con calificación 4.5+ suman 60 o más reseñas combinadas; en ese caso la justificación debe decir "reputación combinada" y el total exacto.
En la última columna, "Categorías Adicionales" (columna 20), lista separadas por ";" las categorías oficiales adicionales que el negocio cumple de verdad según sus servicios evidenciados (ej. un hotel que también ofrece catering real es "Comida y Bebida" además de "Lugar"); "Sin dato" si solo aplica su categoría principal. No repitas ahí la categoría principal.
Usa exactamente estos valores controlados y no inventes etiquetas: Segmento = "Bajo Costo", "Premium" o "Sin clasificar"; Zona Estandarizada = "Zona Norte / Comercial Alta", "Zona Centro / Tradicional", "Zona Sur / Occidente Comercial", "Zona Campestre / Periferia", "Área Metropolitana", "Cobertura Nacional" o "Sin dato"; Escala = "Pequeño (Hasta 50 pers.)", "Mediano (50 a 200 pers.)", "Masivo (Más de 200 pers.)" o "Sin dato"; Formalidad = "Formalizado (NIT - Empresa)", "Independiente (RUT - Persona Natural)" o "No verificado"; Nivel Curaduría = "A" cuando haya 50 o más reseñas, "B" en cualquier otro caso. Para Instagram usa una URL de instagram.com, "@usuario" o exactamente "Sin Redes".
El ID debe tener el formato ABC-CC-###, donde ABC son tres letras y CC es el código de la categoría: Lugar 01, Comida y Bebida 02, Música 03, Servicios Especializados 04, Entretenimiento 05, Decoración temática 06, Fotografía y Video 07, Invitación digital 08, Menaje y mantelería 09, Carpas y mobiliario 10. La Fecha Verificación es la fecha de hoy en formato AAAA-MM-DD (ej. "2026-09-19"); nunca DD/MM/AAAA.
Devuelve exactamente un objeto JSON con "tsv" y "research_summary". En "tsv" usa el encabezado exacto ${JSON.stringify(CURATION_HEADERS.join('\t'))}, seguido de filas con ${CURATION_HEADERS.length} columnas separadas por tabulaciones. Usa "Sin dato" cuando no exista evidencia pública y explica el déficit en la justificación. No uses Markdown ni texto fuera del JSON.`;
      // Si nada del roster es legible por WebFetch, no se falla: el lote se arma solo con la vía
      // de respaldo a partir del contacto que ya encontró el descubrimiento.
      outputText = compactVerificationRoster.length
        ? await runVerificationSubagents(sharedVerificationPrompt, compactVerificationRoster, input.onPhase, maxTurns, model, runContext)
        : JSON.stringify({
          tsv: CURATION_HEADERS.join('\t'),
          research_summary: 'Ningún candidato tenía una página legible por WebFetch; el lote se arma con el contacto público hallado en la búsqueda y queda marcado para revisión.',
        });
    } else {
      const singleRun = await runResearchAgent(provider, {
        prompt: provider === 'codex' ? codexPrompt : prompt,
        onPhase: input.onPhase,
        maxTurns,
        tools: ['WebSearch', 'WebFetch'],
        role: 'single',
        context: runContext,
      });
      outputText = singleRun.output;
    }
  } else {
    if (!apiKey) throw new Error('GEMINI_NOT_CONFIGURED');
    const requestPayload = {
      model,
      input: prompt,
      tools: [{ type: 'google_search' }, { type: 'url_context' }],
      response_format: { type: 'text', mime_type: 'application/json', schema: responseSchema },
      stream: true,
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await fetch(GEMINI_INTERACTIONS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(requestPayload),
        });
        if (!response.ok) {
          const body = await response.json() as Record<string, unknown>;
          const errorPayload = typeof body.error === 'object' && body.error !== null ? body.error as Record<string, unknown> : {};
          const apiMessage = typeof errorPayload.message === 'string' ? errorPayload.message.replace(/\s+/g, ' ').slice(0, 240) : '';
          throw createGeminiRequestError(`GEMINI_REQUEST_FAILED_HTTP_${response.status}`, { status: response.status, apiMessage });
        }
        outputText = await readGeminiStream(response, input.onPhase);
        break;
      } catch (error) {
        const requestError = error as GeminiRequestError;
        const status = requestError.status;
        const networkFailure = status === undefined && requestError.streamFailure !== true;
        const retryable = status !== undefined ? RETRYABLE_GEMINI_STATUSES.has(status) : requestError.streamFailure === true || networkFailure;
        if (!retryable || attempt === 2) {
          if (requestError.streamFailure) {
            console.error('Gemini curation stream failed', requestError.apiMessage || requestError.message);
            throw new Error(requestError.apiMessage ? `GEMINI_STREAM_ERROR: ${requestError.apiMessage}` : 'GEMINI_STREAM_ERROR');
          }
          if (status === 429) throw new Error('GEMINI_RATE_LIMITED');
          if (status !== undefined && status >= 500) throw new Error('GEMINI_TEMPORARY_FAILURE');
          if (status !== undefined) {
            console.error('Gemini curation request failed', status, requestError.apiMessage || requestError.message);
            throw new Error(`${requestError.message}${requestError.apiMessage ? `: ${requestError.apiMessage}` : ''}`);
          }
          console.error('Gemini curation network request failed', requestError.message);
          throw new Error('GEMINI_NETWORK_ERROR');
        }
        await wait(1000 * (attempt + 1));
      }
    }
  }
  if (provider === 'gemini' && (!response?.ok || !outputText)) throw new Error('GEMINI_REQUEST_FAILED');
  if (!outputText) throw new Error(provider === 'codex' ? 'CODEX_EMPTY_RESPONSE' : 'CLAUDE_CODE_EMPTY_RESPONSE');

  input.onPhase?.('researching', 'Resultados listos; preparando vista previa.', { current: 4, total: 4, label: 'Validando candidatos' });
  const parsed = parseJsonEnvelope<{ tsv?: string; research_summary?: string }>(outputText);
  const fallbackTsv = typeof parsed?.tsv === 'string' && parsed.tsv.trim() ? undefined : extractTsvFallback(outputText);
  if (!parsed && !fallbackTsv) {
    console.error(`${provider} returned invalid JSON`, outputText.slice(-800));
    throw new Error(provider === 'gemini' ? 'GEMINI_INVALID_JSON' : provider === 'codex' ? 'CODEX_INVALID_JSON' : 'CLAUDE_CODE_INVALID_JSON');
  }
  const rawTsv = typeof parsed?.tsv === 'string' && parsed.tsv.trim() ? parsed.tsv : fallbackTsv;
  if (!rawTsv) throw new Error(provider === 'gemini' ? 'GEMINI_NO_ROWS' : provider === 'codex' ? 'CODEX_NO_ROWS' : 'CLAUDE_CODE_NO_ROWS');
  const baseTsv = limitCurationTsvRows(normalizeKnownSourceUrls(rawTsv));
  const withFallbackCandidates = appendFallbackCandidates(baseTsv, discoveredCandidates, city, category, runContext);
  const enriched = await enrichMissingReputationWithGooglePlaces(withFallbackCandidates, city, runContext);
  const filtered = filterByReputationThreshold(enriched, minRating, minReviews);
  // El agente manda: sus hallazgos van primero y el registro solo rellena lo que falte hasta el
  // objetivo. Sin esto el lote se quedaba en lo que el agente alcanzara, muy por debajo de los
  // negocios que cumplen el umbral y tienen ficha publica.
  const completed = await completeBatchFromHarvest({
    tsv: filtered.tsv, places: harvestedPlaces, city, category, minRating, minReviews, targetCount,
  });
  const tsv = completed.tsv;
  if (completed.added) {
    logCurationEvent('batch_completed', { ...runContext, anadidos: completed.added, conCorreo: completed.withEmail, delAgente: filtered.tsv.split('\n').length - 1 } as never);
  }
  if (filtered.removed) {
    logCurationEvent('threshold_filter', { ...runContext, minRating, minReviews, removidos: filtered.removed, bajoUmbral: filtered.belowThreshold, sinReputacion: filtered.withoutReputation } as never);
  }
  const parsedBatch = parseCurationTsv(tsv);
  const validation = validateCurationBatch(parsedBatch);
  // "Descubiertos" son las filas que realmente quedaron en el lote. Contar aquí el roster
  // completo inflaba la cifra que ve el operador frente a los proveedores que existen de verdad.
  const discovered = parsedBatch.rows.length;
  const contactable = parsedBatch.rows.filter(row => hasContactForDiscovery(row.rawCells)).length;
  const contactSummary = summarizeContactChannels(validation.accepted);
  const result = {
    tsv,
    researchSummary: parsed?.research_summary || 'Investigación completada; revisa las fuentes antes de importar.',
    provider,
    model,
    accepted: validation.accepted.length,
    rejected: validation.rejected.length,
    discovered,
    contactable,
    discoveredCandidates,
    acceptedRows: validation.accepted,
    rejectedRows: validation.rejected,
    contactSummary,
  };
  input.onPhase?.('researching', 'Resultados listos; preparando vista previa.', { current: 4, total: 4, label: 'Validando candidatos' }, buildLivePreview(tsv, model));
  return result;
}
