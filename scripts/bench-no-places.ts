// Benchmark de la curaduría SIN Google Places, con ciudad y categorías fijas.
//
// Uso:
//   CURATION_PROVIDER=claude-code node --experimental-strip-types --import ./scripts/ts-resolver.mjs \
//     scripts/bench-no-places.ts "Barranquilla" 5 salida.json ["Cat A,Cat B"]
//
// El cuarto argumento (opcional) limita las categorías, para reanudar una corrida cortada.
//
// Places queda cerrado por construcción (no hay opt-in) y el script lo comprueba al final con los
// contadores de la puerta: si `performed` no es cero, el benchmark se declara inválido.
//
// Cada categoría corre una vez y del MISMO lote se derivan las dos condiciones, para que la
// comparación no dependa del azar del agente:
//   - "antes"   (commit a374d53 sin Places): las filas sin reputación verificable se descartaban.
//   - "después" (este cambio): se conservan como "Requiere revisión", con contacto y evidencia.
// Lo que sí cambia entre condiciones es el post-procesado, que es determinista.
import { writeFileSync } from 'node:fs';
import { runCurationGoal } from '../src/lib/curation-run.ts';
import { hasContactForDiscovery, killAllClaudeChildren } from '../src/lib/gemini.ts';
import { parseCurationTsv, validateCurationBatch } from '../src/lib/curation.ts';
import { getPlacesUsage } from '../src/lib/places-gate.ts';

const DEFAULT_CATEGORIES = ['Comida y Bebida', 'Fotografía y Video', 'Invitación digital', 'Menaje y mantelería'];

const city = process.argv[2] ?? 'Barranquilla';
const targetCount = Number(process.argv[3] ?? 5);
const outPath = process.argv[4] ?? 'bench-no-places.json';
const CATEGORIES = process.argv[5] ? process.argv[5].split(',').map(value => value.trim()).filter(Boolean) : DEFAULT_CATEGORIES;

type Run = {
  category: string; ok: boolean; durationMs: number; attempts?: number; stoppedReason?: string;
  rows?: number; accepted?: number; review?: number; otherRejected?: number;
  withReputation?: number; withContact?: number; pctReputation?: number; pctContact?: number;
  before?: { rows: number; accepted: number; withContact: number };
  rejectionReasons?: Record<string, number>;
  providers?: Array<{ name: string; rating: string; reviews: string; platform: string; contact: boolean; status: 'aceptado' | 'revision' | 'rechazado'; sourceUrl: string }>;
  error?: string;
};

const runs: Run[] = [];
const startedAt = Date.now();
process.on('SIGINT', () => { killAllClaudeChildren(); process.exit(130); });

function flush() {
  writeFileSync(outPath, JSON.stringify({
    city, targetCount, provider: process.env.CURATION_PROVIDER ?? 'gemini', startedAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt, places: getPlacesUsage(), runs,
  }, null, 2));
}

const hasReputation = (cells: string[]) => /^[0-5][.,]\d$/.test((cells[8] ?? '').trim()) && /^\d+$/.test((cells[9] ?? '').trim());

for (const category of CATEGORIES) {
  const t0 = Date.now();
  console.log(`\n===== ${category} =====`);
  try {
    const result = await runCurationGoal({ city, category, targetCount, jobId: `bench-np-${Date.now()}` });
    const parsed = parseCurationTsv(result.tsv);
    const validation = validateCurationBatch(parsed);
    const reasons: Record<string, number> = {};
    for (const row of validation.rejected) for (const issue of row.issues) reasons[issue.code] = (reasons[issue.code] ?? 0) + 1;
    const reviewRows = validation.rejected.filter(row => row.issues.every(issue => ['pending_reputation_review', 'missing_review_disclosure'].includes(issue.code)));
    const acceptedLines = new Set(validation.accepted.map(row => row.line));
    const reviewLines = new Set(reviewRows.map(row => row.line));
    const rows = parsed.rows;
    const withRep = rows.filter(row => hasReputation(row.rawCells));
    const withContact = rows.filter(row => hasContactForDiscovery(row.rawCells));
    // "Antes": solo sobrevivían las filas con reputación numérica; el resto desaparecía.
    const before = {
      rows: withRep.length,
      accepted: validation.accepted.length,
      withContact: withRep.filter(row => hasContactForDiscovery(row.rawCells)).length,
    };
    const pct = (n: number) => rows.length ? Math.round(n / rows.length * 100) : 0;
    runs.push({
      category, ok: true, durationMs: Date.now() - t0, attempts: result.attempts, stoppedReason: result.stoppedReason,
      rows: rows.length, accepted: validation.accepted.length, review: reviewRows.length,
      otherRejected: validation.rejected.length - reviewRows.length,
      withReputation: withRep.length, withContact: withContact.length,
      pctReputation: pct(withRep.length), pctContact: pct(withContact.length),
      before, rejectionReasons: reasons,
      providers: rows.map(row => ({
        name: (row.rawCells[1] ?? '').trim(), rating: (row.rawCells[8] ?? '').trim(), reviews: (row.rawCells[9] ?? '').trim(),
        platform: (row.rawCells[10] ?? '').trim(), contact: hasContactForDiscovery(row.rawCells),
        status: acceptedLines.has(row.line) ? 'aceptado' : reviewLines.has(row.line) ? 'revision' : 'rechazado',
        sourceUrl: (row.rawCells[16] ?? '').trim(),
      })),
    });
    const last = runs[runs.length - 1];
    console.log(`  ${Math.round(last.durationMs / 1000)}s · filas ${last.rows} · aceptadas ${last.accepted} · revisión ${last.review} · con reputación ${last.withReputation} · con contacto ${last.withContact} · antes habría quedado ${before.rows}`);
  } catch (error) {
    runs.push({ category, ok: false, durationMs: Date.now() - t0, error: error instanceof Error ? error.message : String(error) });
    console.log(`  FALLO: ${error instanceof Error ? error.message : String(error)}`);
  }
  flush();
}

const places = getPlacesUsage();
console.log('\n================ RESUMEN ================');
const sum = (f: (r: Run) => number) => runs.filter(r => r.ok).reduce((a, r) => a + f(r), 0);
console.log(`después: filas=${sum(r => r.rows ?? 0)} aceptadas=${sum(r => r.accepted ?? 0)} revisión=${sum(r => r.review ?? 0)} conReputación=${sum(r => r.withReputation ?? 0)} conContacto=${sum(r => r.withContact ?? 0)} tiempo=${Math.round(sum(r => r.durationMs) / 1000)}s`);
console.log(`antes:   filas=${sum(r => r.before?.rows ?? 0)} aceptadas=${sum(r => r.before?.accepted ?? 0)} conContacto=${sum(r => r.before?.withContact ?? 0)}`);
console.log(`Places: intentadas=${places.attempted} realizadas=${places.performed} bloqueadas=${places.blocked} habilitado=${places.enabled}`);
if (places.performed > 0) console.log('BENCHMARK INVÁLIDO: hubo peticiones reales a Google Places.');
flush();
killAllClaudeChildren();
process.exit(places.performed > 0 ? 2 : 0);
