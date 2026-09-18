// Ejecución controlada de una curaduría completa, fuera del servidor web.
//
// Uso:
//   node --env-file=.env --experimental-strip-types --import ./scripts/ts-resolver.mjs \
//     scripts/curation-smoke.ts "Barranquilla" "Comida y Bebida" 20
//
// Imprime el progreso por fase y los conteos reales al terminar. No importa nada a la base de
// datos de proveedores: solo guarda el historial de curaduría, igual que la interfaz.
import { runCurationGoal } from '../src/lib/curation-run.ts';
import { hasContactForDiscovery } from '../src/lib/gemini.ts';
import { parseCurationTsv, validateCurationBatch } from '../src/lib/curation.ts';
import { killAllClaudeChildren } from '../src/lib/gemini.ts';

const city = process.argv[2] ?? 'Barranquilla';
const category = process.argv[3] ?? 'Comida y Bebida';
const targetCount = Number(process.argv[4] ?? 20);
const jobId = `smoke-${Date.now()}`;
const startedAt = Date.now();

function elapsed() {
  return `${Math.round((Date.now() - startedAt) / 1000)}s`;
}

process.on('SIGINT', () => { killAllClaudeChildren(); process.exit(130); });

let lastDetail = '';
const result = await runCurationGoal({
  city,
  category,
  targetCount,
  jobId,
  onPhase: (phase, detail, progress) => {
    if (detail === lastDetail) return;
    lastDetail = detail;
    console.log(`[${elapsed()}] ${phase} ${progress ? `${progress.current}/${progress.total}` : ''} ${detail}`);
  },
});

const parsed = parseCurationTsv(result.tsv);
const validation = validateCurationBatch(parsed);
const contactables = parsed.rows.filter(row => hasContactForDiscovery(row.rawCells));

console.log('\n================ RESULTADO ================');
console.log(`Ciudad · categoría : ${city} · ${category}`);
console.log(`Duración total     : ${elapsed()}`);
console.log(`Escaneos usados    : ${result.attempts}`);
console.log(`Motivo de parada   : ${result.stoppedReason}`);
console.log(`Objetivo alcanzado : ${result.targetReached}`);
console.log(`Relevantes         : ${parsed.rows.length} / ${targetCount}`);
console.log(`Contactables       : ${contactables.length} / ${result.contactTarget}`);
console.log(`Aceptados (listos) : ${validation.accepted.length}`);
console.log(`Requieren revisión : ${validation.rejected.length}`);
console.log(`Historial guardado : ${result.historySaved}`);
if (result.alert) console.log(`Aviso              : ${result.alert}`);

const conReputacion = parsed.rows.filter(row => /^[0-5][.,]\d$/.test((row.rawCells[8] ?? '').trim()) && /^\d+$/.test((row.rawCells[9] ?? '').trim()));
console.log(`Con calificación y reseñas visibles: ${conReputacion.length}`);

console.log('\nMotivos de "requiere revisión":');
const motivos = new Map<string, number>();
for (const row of validation.rejected) for (const issue of row.issues) motivos.set(issue.code, (motivos.get(issue.code) ?? 0) + 1);
for (const [code, count] of [...motivos].sort((a, b) => b[1] - a[1])) console.log(`  ${code}: ${count}`);

console.log('\nProveedores:');
for (const row of parsed.rows) {
  const nombre = (row.rawCells[1] ?? '').trim();
  const calificacion = (row.rawCells[8] ?? '').trim();
  const resenas = (row.rawCells[9] ?? '').trim();
  const contacto = hasContactForDiscovery(row.rawCells) ? 'contactable' : 'sin contacto';
  console.log(`  - ${nombre} · ${calificacion}/${resenas} · ${contacto}`);
}

killAllClaudeChildren();
process.exit(0);
