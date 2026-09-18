// Pruebas del runner de Claude Code y del registro de jobs.
// Ejecutar con: node --experimental-strip-types scripts/curation-runner.test.ts
// Las pruebas marcadas [CLI] lanzan el binario real de Claude Code con prompts mínimos.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import {
  activeClaudeChildCount,
  buildClaudeArgs,
  isInformationalStderr,
  killAllClaudeChildren,
  runClaudeCode,
  splitRosterForSubagents,
} from '../src/lib/gemini.ts';
import { createCurationJob, failCurationJob, getRunningCurationJob } from '../src/lib/curation-job.ts';

const runCliTests = process.env.SKIP_CLI_TESTS !== '1';
const claudePath = process.env.CLAUDE_CODE_PATH || 'claude';

function processAlive(pid: number): boolean {
  if (process.platform !== 'win32') {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  const output = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
  return output.includes(String(pid));
}

// --- Argumentos del CLI -------------------------------------------------------

const discoveryArgs = buildClaudeArgs('hola', 30, ['WebSearch'], 'sonnet');

// El modelo siempre debe ser explícito.
assert.equal(discoveryArgs[discoveryArgs.indexOf('--model') + 1], 'sonnet');

// Sin servidores MCP: evita cargar 197 herramientas y 1.7s extra de arranque por proceso.
assert.ok(discoveryArgs.includes('--strict-mcp-config'));

// Nada que requiera permiso puede colgar una ejecución no interactiva.
assert.equal(discoveryArgs[discoveryArgs.indexOf('--permission-prompts') + 1], 'none');

// --allowedTools no restringe nada por sí solo: la restricción real es --disallowedTools.
const deniedStart = discoveryArgs.indexOf('--disallowedTools');
assert.ok(deniedStart > 0);
const deniedTools = discoveryArgs.slice(deniedStart + 1);
assert.ok(deniedTools.includes('Task'), 'Task debe estar denegado: evita que el agente cree sus propios subagentes');
assert.ok(deniedTools.includes('Bash'));
assert.ok(deniedTools.includes('Write'));
// Un agente de descubrimiento no puede abrir páginas; uno de verificación no puede buscar.
assert.ok(deniedTools.includes('WebFetch'));
const verificationArgs = buildClaudeArgs('hola', 20, ['WebFetch'], 'sonnet');
assert.ok(verificationArgs.slice(verificationArgs.indexOf('--disallowedTools') + 1).includes('WebSearch'));
assert.ok(!verificationArgs.slice(verificationArgs.indexOf('--disallowedTools') + 1).includes('WebFetch'));

// El prompt nunca debe registrarse ni exponerse como argumento suelto en los logs.
assert.equal(discoveryArgs[0], '-p');

// --- stderr informativo -------------------------------------------------------

// Este es el warning exacto que antes convertía una respuesta válida en CLAUDE_CODE_FAILED.
assert.equal(isInformationalStderr('Warning: no stdin data received in 3s, proceeding without it.'), true);
assert.equal(isInformationalStderr('(node:123) ExperimentalWarning: something'), true);
assert.equal(isInformationalStderr('   \n  \n'), true);
assert.equal(isInformationalStderr('Error: ENOTFOUND api.anthropic.com'), false);
assert.equal(isInformationalStderr('Warning: no stdin data received in 3s\nError: token inválido'), false);

// --- Reparto de rosters entre subagentes --------------------------------------

const roster = Array.from({ length: 9 }, (_, index) => ({ name: `Proveedor ${index}` }));
const chunks = splitRosterForSubagents(roster);
assert.equal(chunks.length, 2, 'siempre dos subagentes cuando hay roster suficiente');
assert.equal(chunks[0].length + chunks[1].length, roster.length, 'ningún proveedor se pierde');
const names0 = new Set(chunks[0].map(item => item.name));
assert.ok(chunks[1].every(item => !names0.has(item.name)), 'los rosters deben ser disjuntos, no duplicados');
assert.equal(splitRosterForSubagents([{ name: 'único' }]).length, 1, 'un solo proveedor no genera un subagente vacío');
assert.equal(splitRosterForSubagents([]).length, 0);

// --- Un solo job activo por ciudad y categoría --------------------------------

const jobA = createCurationJob({ city: 'Barranquilla', category: 'Comida y Bebida', targetCount: 20 });
const duplicate = getRunningCurationJob('  barranquilla ', 'COMIDA Y BEBIDA');
assert.equal(duplicate?.jobId, jobA.jobId, 'un segundo intento debe reutilizar el job en curso, sin importar espacios ni mayúsculas');
assert.equal(getRunningCurationJob('Medellín', 'Comida y Bebida'), undefined, 'otra ciudad sí puede correr en paralelo');
failCurationJob(jobA.jobId, 'prueba');
assert.equal(getRunningCurationJob('Barranquilla', 'Comida y Bebida'), undefined, 'al terminar, la ciudad queda libre');

// El registro vive en globalThis para sobrevivir a la invalidación de módulos de `astro dev`.
assert.ok((globalThis as { __curationJobs?: Map<string, unknown> }).__curationJobs instanceof Map);

if (!runCliTests) {
  console.log('curation runner tests passed (pruebas [CLI] omitidas)');
  process.exit(0);
}

// --- [CLI] stdin cerrado y sin warning ----------------------------------------

const stdinProbe = await new Promise<{ code: number | null; stderr: string }>(resolve => {
  const child = spawn(claudePath, ['-p', 'Di solamente: OK', '--output-format', 'stream-json', '--verbose',
    '--max-turns', '1', '--strict-mcp-config', '--model', 'sonnet'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.resume();
  // Bloquea el event loop: con stdin en 'pipe' + .end() esto provoca el warning de stdin.
  const until = Date.now() + 5000;
  while (Date.now() < until) { /* espera activa deliberada */ }
  child.on('close', code => resolve({ code, stderr }));
});
assert.equal(stdinProbe.code, 0, 'el CLI debe terminar con código 0');
assert.ok(!stdinProbe.stderr.includes('no stdin data received'),
  'con stdio[0]="ignore" el warning de stdin no puede aparecer ni con el event loop bloqueado');

// --- [CLI] una ejecución sana devuelve salida y no deja procesos vivos ---------

const healthy = await runClaudeCode({
  prompt: 'Responde exactamente con este texto y nada más: {"tsv":"ok","research_summary":"ok"}',
  maxTurns: 2,
  tools: [],
  role: 'single',
  context: { jobId: 'test', scanNumber: 1, role: 'single' },
});
assert.ok(healthy.output.trim().length > 0, 'una ejecución exitosa debe devolver texto');
assert.equal(healthy.partial, false);
assert.equal(activeClaudeChildCount(), 0, 'no deben quedar procesos registrados tras una ejecución exitosa');

// --- [CLI] timeout total: aborta y no deja huérfanos --------------------------

let timedOut = '';
const before = Date.now();
await runClaudeCode({
  prompt: 'Cuenta lentamente del 1 al 500, un número por línea, con una frase para cada uno.',
  maxTurns: 6,
  tools: [],
  role: 'single',
  context: { jobId: 'test', scanNumber: 1, role: 'single' },
  maxRuntimeMs: 4000,
  maxIdleMs: 60_000,
}).then(() => { timedOut = 'la ejecución terminó antes del timeout'; }, error => { timedOut = (error as Error).message; });
assert.ok(timedOut.startsWith('CLAUDE_CODE_TIMEOUT') || timedOut === 'la ejecución terminó antes del timeout', timedOut);
if (timedOut.startsWith('CLAUDE_CODE_TIMEOUT')) {
  assert.ok(Date.now() - before < 30_000, 'el timeout debe cortar rápido, no esperar al final');
  assert.ok(timedOut.includes('último evento'), 'el mensaje debe decir en qué fase se quedó, no solo un código');
  assert.equal(activeClaudeChildCount(), 0, 'el timeout debe desregistrar el proceso');
}

// --- [CLI] timeout por inactividad -------------------------------------------

let idleReason = '';
await runClaudeCode({
  prompt: 'Cuenta lentamente del 1 al 500, un número por línea, con una frase para cada uno.',
  maxTurns: 6,
  tools: [],
  role: 'single',
  context: { jobId: 'test', scanNumber: 1, role: 'single' },
  maxRuntimeMs: 120_000,
  maxIdleMs: 3000,
}).then(() => { idleReason = 'terminó antes de quedar inactivo'; }, error => { idleReason = (error as Error).message; });
assert.ok(idleReason.startsWith('CLAUDE_CODE_IDLE_TIMEOUT') || idleReason === 'terminó antes de quedar inactivo', idleReason);

// --- [CLI] cierre del árbol de procesos en Windows ----------------------------

const treeProbe = spawn(claudePath, ['-p', 'Cuenta del 1 al 300 con una frase por número.',
  '--output-format', 'stream-json', '--verbose', '--max-turns', '4', '--strict-mcp-config', '--model', 'sonnet'],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
treeProbe.stdout.resume();
treeProbe.stderr.resume();
const treePid = treeProbe.pid!;
await new Promise(resolve => setTimeout(resolve, 4000));
assert.equal(processAlive(treePid), true, 'el proceso de prueba debe estar vivo antes de matarlo');
if (process.platform === 'win32') {
  execFileSync('taskkill', ['/PID', String(treePid), '/T', '/F'], { stdio: 'ignore' });
} else {
  treeProbe.kill('SIGKILL');
}
await new Promise(resolve => treeProbe.once('close', resolve));
assert.equal(processAlive(treePid), false, 'taskkill /T /F debe cerrar el árbol completo');

// --- Limpieza global ----------------------------------------------------------

assert.equal(killAllClaudeChildren(), 0, 'no debe quedar ningún hijo registrado al final');

console.log('curation runner tests passed');
