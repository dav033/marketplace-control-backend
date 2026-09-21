// Benchmark reducido: mismas categorías con y sin cosecha, objetivo pequeño.
// Pensado para iterar en minutos en vez de en media hora.
//
// Uso:
//   node --env-file=.env --experimental-strip-types --import ./scripts/ts-resolver.mjs \
//     scripts/bench-reduced.ts "Barranquilla" 3 salida.json
import { writeFileSync } from 'node:fs';
import { runCurationGoal } from '../src/lib/curation-run.ts';
import { hasContactForDiscovery, killAllClaudeChildren } from '../src/lib/gemini.ts';
import { parseCurationTsv, validateCurationBatch } from '../src/lib/curation.ts';

// Cuatro categorías representativas: una que ya funcionaba y tres que daban cero.
const CATEGORIES = ['Comida y Bebida', 'Fotografía y Video', 'Invitación digital', 'Menaje y mantelería'];

const city = process.argv[2] ?? 'Barranquilla';
const targetCount = Number(process.argv[3] ?? 3);
const outPath = process.argv[4] ?? 'bench-reduced.json';

type Arm = { arm: string; category: string; ok: boolean; durationMs: number; attempts?: number;
  relevant?: number; contactable?: number; accepted?: number; rejected?: number;
  withReputation?: number; rejectionReasons?: Record<string, number>;
  providers?: Array<{ name: string; rating: string; reviews: string }>; error?: string };

const results: Arm[] = [];
const startedAt = Date.now();
process.on('SIGINT', () => { killAllClaudeChildren(); process.exit(130); });

function flush() {
  writeFileSync(outPath, JSON.stringify({ city, targetCount, elapsedMs: Date.now() - startedAt, results }, null, 2));
}

// "solo-agente" apaga todo Google Places: sin enriquecimiento de reputación, sin punto de partida
// y sin completado del lote. Es lo que mide cuánto aporta el modelo por sí mismo.
for (const arm of ['solo-agente', 'con-places']) {
  const soloAgente = arm === 'solo-agente';
  process.env.CURATION_DISABLE_PLACES = soloAgente ? '1' : '0';
  process.env.CURATION_DISABLE_HARVEST = soloAgente ? '1' : '0';
  for (const category of CATEGORIES) {
    const t0 = Date.now();
    try {
      const r = await runCurationGoal({ city, category, targetCount, jobId: `red-${arm}-${Date.now()}` });
      const parsed = parseCurationTsv(r.tsv);
      const v = validateCurationBatch(parsed);
      const reasons: Record<string, number> = {};
      for (const row of v.rejected) for (const i of row.issues) reasons[i.code] = (reasons[i.code] ?? 0) + 1;
      results.push({
        arm, category, ok: true, durationMs: Date.now() - t0, attempts: r.attempts,
        relevant: parsed.rows.length,
        contactable: parsed.rows.filter(x => hasContactForDiscovery(x.rawCells)).length,
        accepted: v.accepted.length, rejected: v.rejected.length,
        withReputation: parsed.rows.filter(x => /^[0-5][.,]\d$/.test((x.rawCells[8] ?? '').trim()) && /^\d+$/.test((x.rawCells[9] ?? '').trim())).length,
        rejectionReasons: reasons,
        providers: parsed.rows.map(x => ({ name: (x.rawCells[1] ?? '').trim(), rating: (x.rawCells[8] ?? '').trim(), reviews: (x.rawCells[9] ?? '').trim() })),
      });
      const last = results[results.length - 1];
      console.log(`[${arm}] ${category}: ${Math.round(last.durationMs / 1000)}s · relev ${last.relevant} · acept ${last.accepted} · repu ${last.withReputation} · escaneos ${last.attempts}`);
    } catch (error) {
      results.push({ arm, category, ok: false, durationMs: Date.now() - t0, error: error instanceof Error ? error.message : String(error) });
      console.log(`[${arm}] ${category}: FALLO`);
    }
    flush();
  }
}

const agg = (arm: string, f: (r: Arm) => number) => results.filter(r => r.arm === arm && r.ok).reduce((a, r) => a + f(r), 0);
console.log('\n================ RESUMEN ================');
for (const arm of ['solo-agente', 'con-places']) {
  console.log(`${arm.padEnd(12)} acept=${agg(arm, r => r.accepted ?? 0)} repu=${agg(arm, r => r.withReputation ?? 0)} relev=${agg(arm, r => r.relevant ?? 0)} escaneos=${agg(arm, r => r.attempts ?? 0)} tiempo=${Math.round(agg(arm, r => r.durationMs) / 1000)}s`);
}
flush();
killAllClaudeChildren();
process.exit(0);
