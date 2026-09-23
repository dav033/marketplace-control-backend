// Subagentes de reputación: qué respuestas se aceptan y cómo queda la fila para el validador.
import assert from 'node:assert/strict';
import { enrichMissingReputationWithSubagents, parseReputationAnswer, type ReputationTarget } from '../src/lib/reputation-lookup.ts';
import { CURATION_HEADERS, parseCurationTsv, validateCurationBatch } from '../src/lib/curation.ts';

// Respuesta real (Alma, 2026-09-23), con cerco de Markdown.
assert.deepEqual(
  parseReputationAnswer('```json\n{"found":true,"rating":"5","reviews":"16","platform":"Google Maps","matched_by":"phone","seen_in":"Ficha de Google"}\n```'),
  { rating: '5.0', reviews: '16', platform: 'Google', matchedBy: 'phone', seenIn: 'Ficha de Google' },
);
// found=false, cifras vacías o fuera de rango, plataforma no admitida, coincidencia solo por nombre: nada.
assert.equal(parseReputationAnswer('{"found":false,"rating":"Sin dato","reviews":"Sin dato","platform":"Google","matched_by":"phone","seen_in":""}'), undefined);
assert.equal(parseReputationAnswer('{"found":true,"rating":"Sin dato","reviews":"12","platform":"Google","matched_by":"phone","seen_in":""}'), undefined);
assert.equal(parseReputationAnswer('{"found":true,"rating":"7.9","reviews":"12","platform":"Google","matched_by":"phone","seen_in":""}'), undefined);
assert.equal(parseReputationAnswer('{"found":true,"rating":"4.9","reviews":"12","platform":"Cybo","matched_by":"phone","seen_in":""}'), undefined);
assert.equal(parseReputationAnswer('{"found":true,"rating":"4.9","reviews":"12","platform":"Google","matched_by":"name","seen_in":""}'), undefined);
assert.equal(parseReputationAnswer('no es json'), undefined);
// Miles con separador: "1.479" reseñas son 1479, no 1.
assert.equal(parseReputationAnswer('{"found":true,"rating":"4,0","reviews":"1.479","platform":"Google","matched_by":"address","seen_in":""}')?.reviews, '1479');

const row = (id: string, name: string, phone: string) => [
  id, name, 'Menaje y mantelería', 'Premium', 'Manizales', 'Zona Norte / Comercial Alta', 'Mediano (50 a 200 pers.)',
  'Independiente (RUT - Persona Natural)', 'Sin dato', 'Sin dato', 'Sin dato', 'B',
  'Empresa manizaleña con alquiler de menaje y mantelería para eventos, con actividad verificada en los últimos meses. Requiere revisión.',
  phone, 'Sin Redes', 'Sin dato', 'https://donceleventos.com/menaje/', '2026-09-23', 'Sin dato', 'Sin dato',
].join('\t');
const tsv = [CURATION_HEADERS.join('\t'), row('MNZ-09-001', 'Doncel Event Planner', '+57 304 2374329'), row('MNZ-09-002', 'Sin Ficha', '+57 305 0000000')].join('\n');

const asked: ReputationTarget[] = [];
const out = await enrichMissingReputationWithSubagents(tsv, 'Manizales', undefined, async target => {
  asked.push(target);
  return target.name === 'Doncel Event Planner' ? { rating: '5.0', reviews: '30', platform: 'Google', matchedBy: 'phone', seenIn: 'ficha' } : undefined;
});
assert.equal(asked.length, 2);
assert.equal(asked[0].phone, '+57 304 2374329');
const [, doncel, sinFicha] = out.split('\n').map(line => line.split('\t'));
assert.equal(doncel[8], '5.0'); assert.equal(doncel[9], '30'); assert.equal(doncel[10], 'Google'); assert.equal(doncel[18], 'Google:5.0:30');
assert.match(doncel[12], /5\.0 con 30 reseñas en Google/);
// Lo que el subagente no confirma queda intacto.
assert.equal(sinFicha[8], 'Sin dato'); assert.equal(sinFicha[9], 'Sin dato');

// El validador lee la cifra: con 4.5/30 la fila ya no cae por reputación.
const validation = validateCurationBatch(parseCurationTsv(out, { minRating: 4.5, minReviews: 30 }));
const doncelAccepted = validation.accepted.find(r => r.rawCells[1] === 'Doncel Event Planner');
assert.ok(doncelAccepted, 'Doncel debe quedar aceptado');
assert.deepEqual(doncelAccepted.issues, []);
assert.ok(!validation.accepted.some(r => r.rawCells[1] === 'Sin Ficha'), 'sin cifra no se acepta');

console.log('reputation-lookup: ok');
