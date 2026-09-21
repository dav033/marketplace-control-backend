// Benchmark end-to-end de la curaduría para todas las categorías oficiales.
//
// Uso:
//   node --env-file=.env --experimental-strip-types --import ./scripts/ts-resolver.mjs \
//     scripts/bench-all-categories.ts "Barranquilla" 5 salida.json
//
// Ejecuta una curaduría real por categoría (secuencial, para que los tiempos sean comparables),
// guarda métricas por categoría e incrementalmente vuelca el JSON a disco.
import { writeFileSync } from 'node:fs';
import { runCurationGoal } from '../src/lib/curation-run.ts';
import { hasContactForDiscovery, killAllClaudeChildren } from '../src/lib/gemini.ts';
import { parseCurationTsv, validateCurationBatch } from '../src/lib/curation.ts';

const CATEGORIES = [
  'Lugar',
  'Comida y Bebida',
  'Música',
  'Servicios Especializados',
  'Entretenimiento',
  'Decoración temática',
  'Fotografía y Video',
  'Invitación digital',
  'Menaje y mantelería',
  'Carpas y mobiliario',
];

const city = process.argv[2] ?? 'Barranquilla';
const targetCount = Number(process.argv[3] ?? 5);
const outPath = process.argv[4] ?? 'bench-categories.json';

process.on('SIGINT', () => { killAllClaudeChildren(); process.exit(130); });

const runs: unknown[] = [];
const suiteStart = Date.now();

function flush() {
  writeFileSync(outPath, JSON.stringify({
    city,
    targetCount,
    startedAt: new Date(suiteStart).toISOString(),
    elapsedMs: Date.now() - suiteStart,
    completed: runs.length,
    total: CATEGORIES.length,
    runs,
  }, null, 2));
}

for (const [index, category] of CATEGORIES.entries()) {
  const t0 = Date.now();
  console.log(`\n===== [${index + 1}/${CATEGORIES.length}] ${category} =====`);
  try {
    const result = await runCurationGoal({
      city,
      category,
      targetCount,
      jobId: `bench-${Date.now()}-${index}`,
      onPhase: (phase, detail) => console.log(`  ${phase}: ${detail}`),
    });
    const durationMs = Date.now() - t0;
    const parsed = parseCurationTsv(result.tsv);
    const validation = validateCurationBatch(parsed);
    const contactables = parsed.rows.filter((row) => hasContactForDiscovery(row.rawCells));
    const withReputation = parsed.rows.filter((row) =>
      /^[0-5][.,]\d$/.test((row.rawCells[8] ?? '').trim()) && /^\d+$/.test((row.rawCells[9] ?? '').trim()));

    const reasons: Record<string, number> = {};
    for (const row of validation.rejected) {
      for (const issue of row.issues) reasons[issue.code] = (reasons[issue.code] ?? 0) + 1;
    }

    runs.push({
      category,
      ok: true,
      durationMs,
      msPerProvider: parsed.rows.length ? Math.round(durationMs / parsed.rows.length) : null,
      attempts: result.attempts,
      stoppedReason: result.stoppedReason,
      targetReached: result.targetReached,
      relevant: parsed.rows.length,
      contactable: contactables.length,
      contactTarget: result.contactTarget,
      accepted: validation.accepted.length,
      rejected: validation.rejected.length,
      acceptRate: parsed.rows.length ? +(validation.accepted.length / parsed.rows.length).toFixed(3) : null,
      withReputation: withReputation.length,
      alert: result.alert ?? null,
      historySaved: result.historySaved,
      rejectionReasons: reasons,
      providers: parsed.rows.map((row) => ({
        name: (row.rawCells[1] ?? '').trim(),
        rating: (row.rawCells[8] ?? '').trim(),
        reviews: (row.rawCells[9] ?? '').trim(),
        contactable: hasContactForDiscovery(row.rawCells),
      })),
    });
    console.log(`  -> ${durationMs}ms | relevantes ${parsed.rows.length} | aceptados ${validation.accepted.length} | escaneos ${result.attempts}`);
  } catch (error) {
    runs.push({
      category,
      ok: false,
      durationMs: Date.now() - t0,
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(`  -> FALLO: ${error instanceof Error ? error.message : String(error)}`);
  }
  flush();
}

flush();
console.log(`\nBenchmark completo en ${Math.round((Date.now() - suiteStart) / 1000)}s -> ${outPath}`);
killAllClaudeChildren();
process.exit(0);
