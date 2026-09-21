// Mide cuántas filas generadas directamente desde la cosecha pasan el validador de curaduría,
// sin intervención del agente.
//
// Uso:
//   node --env-file=.env --experimental-strip-types --import ./scripts/ts-resolver.mjs \
//     scripts/bench-harvest-tsv.ts "Barranquilla" salida.json
import { writeFileSync } from 'node:fs';
import { harvestCategoryCandidates } from '../src/lib/places-harvest.ts';
import { harvestToCurationTsv } from '../src/lib/harvest-import.ts';
import { parseCurationTsv, validateCurationBatch } from '../src/lib/curation.ts';

const CATEGORIES = ['Lugar','Comida y Bebida','Música','Servicios Especializados','Entretenimiento',
  'Decoración temática','Fotografía y Video','Invitación digital','Menaje y mantelería','Carpas y mobiliario'];

const city = process.argv[2] ?? 'Barranquilla';
const outPath = process.argv[3] ?? 'bench-harvest-tsv.json';
const started = Date.now();

type Row = { category: string; candidates: number; generated: number; skipped: number;
  parsed: number; accepted: number; rejected: number; reasons: Record<string, number>;
  fatal: string[]; samples: string[] };
const runs: Row[] = [];

console.log('categoria|candidatos|filas|aceptadas|rechazadas|%acept');
for (const category of CATEGORIES) {
  const harvest = await harvestCategoryCandidates(city, category);
  const { tsv, rows, skipped } = harvestToCurationTsv(harvest);
  const parsed = parseCurationTsv(tsv);
  const validation = validateCurationBatch(parsed);
  const reasons: Record<string, number> = {};
  for (const r of validation.rejected) for (const i of r.issues) reasons[i.code] = (reasons[i.code] ?? 0) + 1;
  runs.push({
    category, candidates: harvest.candidates.length, generated: rows, skipped,
    parsed: parsed.rows.length, accepted: validation.accepted.length, rejected: validation.rejected.length,
    reasons, fatal: parsed.fatalErrors.map(e => e.code),
    samples: validation.accepted.slice(0, 3).map(r => `${r.fields.displayName} · ${r.fields.rating}/${r.fields.reviewCount}`),
  });
  const last = runs[runs.length - 1];
  console.log([category, last.candidates, last.generated, last.accepted, last.rejected,
    last.parsed ? Math.round(last.accepted / last.parsed * 100) + '%' : '0%'].join('|'));
}

const sum = (f: (r: Row) => number) => runs.reduce((a, r) => a + f(r), 0);
const allReasons: Record<string, number> = {};
for (const r of runs) for (const [k, v] of Object.entries(r.reasons)) allReasons[k] = (allReasons[k] ?? 0) + v;
console.log(`\nTOTAL ${Math.round((Date.now() - started) / 1000)}s · candidatos ${sum(r => r.candidates)} · filas ${sum(r => r.generated)} · ACEPTADAS ${sum(r => r.accepted)} · rechazadas ${sum(r => r.rejected)} · descartadas al generar ${sum(r => r.skipped)}`);
console.log('\nMOTIVOS DE RECHAZO:');
for (const [k, v] of Object.entries(allReasons).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log('\nEJEMPLOS ACEPTADOS:');
for (const r of runs) if (r.samples.length) console.log(`  ${r.category}: ${r.samples.join(' | ')}`);
writeFileSync(outPath, JSON.stringify({ city, elapsedMs: Date.now() - started, runs }, null, 2));
