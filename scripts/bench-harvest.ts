// Benchmark de la cosecha desde Google Places para todas las categorías oficiales.
//
// Uso:
//   node --env-file=.env --experimental-strip-types --import ./scripts/ts-resolver.mjs \
//     scripts/bench-harvest.ts "Barranquilla" salida.json
import { writeFileSync } from 'node:fs';
import { harvestCategoryCandidates, isContactable } from '../src/lib/places-harvest.ts';

const CATEGORIES = ['Lugar','Comida y Bebida','Música','Servicios Especializados','Entretenimiento',
  'Decoración temática','Fotografía y Video','Invitación digital','Menaje y mantelería','Carpas y mobiliario'];

const city = process.argv[2] ?? 'Barranquilla';
const outPath = process.argv[3] ?? 'bench-harvest.json';
const started = Date.now();
type HarvestRun = {
  category: string; durationMs: number; apiCalls: number; candidates: number;
  withReputation: number; contactables: number; ready: number;
  pctReputation: number; pctContactable: number;
  topReady: Array<{ name: string; rating?: number; reviews?: number; hasPhone: boolean; hasWebsite: boolean }>;
};
const runs: HarvestRun[] = [];

console.log('categoria|ms|llamadas|distintos|conRepu|%repu|contactables|%cont|listos');
for (const category of CATEGORIES) {
  const r = await harvestCategoryCandidates(city, category);
  const withRep = r.candidates.filter(c => typeof c.rating === 'number' && (c.reviews ?? 0) > 0);
  const contactables = r.candidates.filter(isContactable);
  const pct = (n: number) => r.candidates.length ? Math.round(n / r.candidates.length * 100) : 0;
  runs.push({
    category, durationMs: r.durationMs, apiCalls: r.apiCalls,
    candidates: r.candidates.length, withReputation: withRep.length,
    contactables: contactables.length, ready: r.ready.length,
    pctReputation: pct(withRep.length), pctContactable: pct(contactables.length),
    topReady: r.ready.slice(0, 5).map(p => ({ name: p.name, rating: p.rating, reviews: p.reviews, hasPhone: Boolean(p.phone), hasWebsite: Boolean(p.website) })),
  });
  console.log([category, r.durationMs, r.apiCalls, r.candidates.length, withRep.length,
    pct(withRep.length) + '%', contactables.length, pct(contactables.length) + '%', r.ready.length].join('|'));
}

const sum = (f: (r: HarvestRun) => number) => runs.reduce((a, r) => a + f(r), 0);
const totals = {
  durationMs: Date.now() - started,
  apiCalls: sum(r => r.apiCalls),
  candidates: sum(r => r.candidates),
  withReputation: sum(r => r.withReputation),
  contactables: sum(r => r.contactables),
  ready: sum(r => r.ready),
};
console.log(`\nTOTAL ${Math.round(totals.durationMs/1000)}s · ${totals.apiCalls} llamadas · ${totals.candidates} candidatos · ${totals.withReputation} con reputación · ${totals.ready} listos`);
writeFileSync(outPath, JSON.stringify({ city, startedAt: new Date(started).toISOString(), totals, runs }, null, 2));
