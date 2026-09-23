// Benchmark de los subagentes de reputación contra cifras comprobadas a mano en Google Maps.
//
// Uso (lee GEMINI_API_KEY y GEMINI_AGENT_MODEL del entorno):
//   node --env-file=.env --experimental-strip-types --import ./scripts/ts-resolver.mjs \
//     scripts/bench-reputation.ts casos.json "Manizales" [salida.json]
//
// casos.json: [{ id, name, phone?, website?, hint?, expected: { rating, reviews } | null }]
// `expected: null` significa que la ficha no tiene reseñas: cualquier cifra ahí es inventada.
import { readFileSync, writeFileSync } from 'node:fs';
import { lookupReputationRaw } from '../src/lib/reputation-lookup.ts';

type Case = { id: string; name: string; phone?: string; website?: string; hint?: string; expected: { rating: string; reviews: string } | null };

const [casesPath, city = 'Manizales', outPath] = process.argv.slice(2);
if (!casesPath) throw new Error('Falta la ruta de casos.json');
const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as Case[];

const started = Date.now();
const results = await Promise.all(cases.map(async item => {
  const t0 = Date.now();
  const answer = await lookupReputationRaw({ name: item.name, city, phone: item.phone, website: item.website, hint: item.hint });
  const got = answer.finding;
  let verdict: 'correcto' | 'sin_dato_ok' | 'omitido' | 'inventado' | 'cifra_distinta';
  if (!item.expected) verdict = got ? 'inventado' : 'sin_dato_ok';
  else if (!got) verdict = 'omitido';
  else verdict = got.rating === item.expected.rating && got.reviews === item.expected.reviews ? 'correcto' : 'cifra_distinta';
  return { id: item.id, name: item.name, expected: item.expected, got, verdict, error: answer.error, raw: answer.raw, seconds: Math.round((Date.now() - t0) / 1000) };
}));

for (const r of results) {
  const exp = r.expected ? `${r.expected.rating}/${r.expected.reviews}` : 'sin reseñas';
  const got = r.got ? `${r.got.rating}/${r.got.reviews} ${r.got.platform} (${r.got.matchedBy})` : `Sin dato${r.error ? ` [${r.error}]` : ''}`;
  console.log(`${r.verdict.padEnd(14)} ${r.id}  ${r.name.padEnd(34)} esperado ${exp.padEnd(12)} obtenido ${got}  ${r.seconds}s`);
}
const count = (v: string) => results.filter(r => r.verdict === v).length;
console.log(`\ncorrecto ${count('correcto')} · sin_dato_ok ${count('sin_dato_ok')} · omitido ${count('omitido')} · cifra_distinta ${count('cifra_distinta')} · inventado ${count('inventado')} · total ${Math.round((Date.now() - started) / 1000)}s`);
if (outPath) writeFileSync(outPath, JSON.stringify(results, null, 2));
