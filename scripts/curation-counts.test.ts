// Pruebas de conteo, deduplicación y filas con "Sin dato".
// Ejecutar con: node --experimental-strip-types scripts/curation-counts.test.ts
import assert from 'node:assert/strict';
import { CURATION_HEADERS, isDirectSourceUrl, parseCurationTsv, validateCurationBatch } from '../src/lib/curation.ts';
import { hasContactForDiscovery } from '../src/lib/gemini.ts';

const header = CURATION_HEADERS.join('\t');

type Overrides = Record<number, string>;

/** Candidato listo: reputación visible, contacto corporativo y fuente directa. */
function readyRow(index: number, overrides: Overrides = {}) {
  const cells = [
    `BAQ-02-${String(index).padStart(3, '0')}`,
    `Catering Listo ${index}`,
    'Comida y Bebida',
    'Sin clasificar',
    'Barranquilla',
    'Zona Norte / Comercial Alta',
    'Mediano (50 a 200 pers.)',
    'Formalizado (NIT - Empresa)',
    '4.8',
    '120',
    'Google',
    'A',
    `Calificación 4.8 con 120 reseñas en Google; catering para eventos publicado en 2026.`,
    `+57 315 721${String(8000 + index).slice(-4)}`,
    'Sin Redes',
    `contacto@cateringlisto${index}.com`,
    `https://cateringlisto${index}.com/contacto`,
    '2026-09-18',
    'Sin dato',
    'Sin dato',
  ];
  for (const [position, value] of Object.entries(overrides)) cells[Number(position)] = value;
  return cells.join('\t');
}

/** Prospecto real sin reputación pública: debe conservarse y marcarse para revisión. */
function prospectRow(index: number, overrides: Overrides = {}) {
  return readyRow(index, {
    1: `Prospecto Sin Reseñas ${index}`,
    8: 'Sin dato',
    9: 'Sin dato',
    10: 'Sin dato',
    11: 'B',
    12: 'Servicio de catering y contacto verificados en el sitio oficial; la reputación no está publicada y queda Sin dato para revisión.',
    15: `contacto@prospecto${index}.com`,
    16: `https://prospecto${index}.com/contacto`,
    ...overrides,
  });
}

function batch(rows: string[]) {
  const parsed = parseCurationTsv([header, ...rows].join('\n'));
  assert.equal(parsed.fatalErrors.length, 0, JSON.stringify(parsed.fatalErrors));
  return { parsed, validation: validateCurationBatch(parsed) };
}

// --- Fila con "Sin dato" en calificación y reseñas ----------------------------

const singleProspect = batch([prospectRow(1)]);
assert.equal(singleProspect.parsed.rows.length, 1, 'el parser no debe eliminar la fila');
const prospectIssues = singleProspect.parsed.rows[0].issues.map(item => item.code);
assert.deepEqual(prospectIssues, ['pending_reputation_review'],
  `un prospecto legítimo sin reseñas solo puede marcarse para revisión, no rechazarse por formato: ${JSON.stringify(prospectIssues)}`);
assert.ok(singleProspect.validation.rejected[0].issues[0].message.includes('Requiere revisión'),
  'el motivo debe ser legible para una persona, no un código interno');
assert.equal(hasContactForDiscovery(singleProspect.parsed.rows[0].rawCells), true,
  'un prospecto con correo corporativo cuenta como contactable');

// Si oculta el déficit en la justificación, sí debe señalarse.
const undisclosed = batch([prospectRow(2, { 12: 'Catering para eventos con excelente servicio en Barranquilla.' })]);
assert.ok(undisclosed.parsed.rows[0].issues.some(item => item.code === 'missing_review_disclosure'));

// Una calificación inventada mal formada se sigue rechazando.
const fabricated = batch([prospectRow(3, { 8: 'excelente' })]);
assert.ok(fabricated.parsed.rows[0].issues.some(item => item.code === 'invalid_rating'));

// --- Candidato listo ----------------------------------------------------------

const ready = batch([readyRow(1)]);
assert.equal(ready.validation.accepted.length, 1, JSON.stringify(ready.validation.rejected[0]?.issues));
assert.equal(ready.validation.accepted[0].contactChannel, 'email');

// --- 20 relevantes y 15 contactables ------------------------------------------

const mixed = [
  ...Array.from({ length: 8 }, (_, index) => readyRow(index + 1)),
  ...Array.from({ length: 7 }, (_, index) => prospectRow(index + 20)),
  // 5 filas reales pero sin ningún contacto accionable: cuentan como relevantes, no como contactables.
  ...Array.from({ length: 5 }, (_, index) => prospectRow(index + 40, {
    13: 'Sin dato',
    15: 'Sin dato',
    12: 'Servicio de catering confirmado en el sitio oficial; no hay contacto público ni reputación publicada, Sin dato en ambos.',
  })),
];
const mixedBatch = batch(mixed);
const relevantes = mixedBatch.parsed.rows.length;
const contactables = mixedBatch.parsed.rows.filter(row => hasContactForDiscovery(row.rawCells)).length;
const aceptados = mixedBatch.validation.accepted.length;
const rechazados = mixedBatch.validation.rejected.length;

assert.equal(relevantes, 20, `relevantes esperados 20, obtenidos ${relevantes}`);
assert.equal(contactables, 15, `contactables esperados 15, obtenidos ${contactables}`);
assert.equal(aceptados, 8, `aceptados esperados 8, obtenidos ${aceptados}`);
assert.equal(rechazados, 12, `rechazados esperados 12, obtenidos ${rechazados}`);
assert.equal(aceptados + rechazados, relevantes, 'cada fila cae exactamente en un grupo: aceptada o rechazada');

// --- Deduplicación ------------------------------------------------------------

const duplicateProvider = batch([readyRow(1), readyRow(1, { 0: 'BAQ-02-099', 16: 'https://otra-fuente.com/contacto' })]);
assert.equal(duplicateProvider.validation.accepted.length, 1);
assert.ok(duplicateProvider.validation.rejected[0].issues.some(item => item.code === 'duplicate_provider'));

const duplicateSource = batch([readyRow(1), readyRow(2, { 16: 'https://cateringlisto1.com/contacto' })]);
assert.equal(duplicateSource.validation.accepted.length, 1);
assert.ok(duplicateSource.validation.rejected[0].issues.some(item => item.code === 'duplicate_source'));

// --- Aceptados y rechazados conservan evidencia para la base de datos ---------

const forHistory = batch([readyRow(1), prospectRow(2)]);
const accepted = forHistory.validation.accepted[0];
assert.ok(accepted.rawEvidence.rawTsv.includes('Catering Listo 1'), 'el aceptado conserva su fila cruda');
assert.equal(accepted.rawEvidence.rawColumns['Fuente URL'], 'https://cateringlisto1.com/contacto');
assert.equal(accepted.fields.sourceUrl, 'https://cateringlisto1.com/contacto');

const rejected = forHistory.validation.rejected[0];
assert.ok(rejected.rawLine.includes('Prospecto Sin Reseñas 2'), 'el rechazado conserva su fila cruda');
assert.equal(rejected.rawRecord['Fuente URL'], 'https://prospecto2.com/contacto', 'el rechazado conserva su URL');
assert.ok(rejected.issues.every(item => item.code && item.message), 'cada rechazo guarda código y motivo legible');

console.log('curation counts tests passed');

// --- La lista negra enviada al prompt solo lleva nombres -----------------------

import { compactBlacklistForPrompt } from '../src/lib/gemini.ts';
import { isReleasedForRetry } from '../src/lib/curation-history.ts';

const promptBlacklist = compactBlacklistForPrompt([
  { candidateKey: 'a', displayName: 'Catering Uno', category: 'Comida y Bebida', city: 'Barranquilla', sourceUrl: 'https://uno.com/contacto', status: 'rejected', reasonCodes: ['invalid_phone'], reasons: [{ code: 'invalid_phone', message: 'teléfono inválido' }] },
  { candidateKey: 'b', displayName: 'Catering Dos', category: 'Comida y Bebida', city: 'Barranquilla', sourceUrl: 'https://dos.com', status: 'accepted', reasonCodes: [], reasons: [] },
  { candidateKey: 'c', displayName: 'catering uno', category: 'Comida y Bebida', city: 'Barranquilla', sourceUrl: 'https://otra.com', status: 'rejected', reasonCodes: [], reasons: [] },
]);
const promptNames = JSON.parse(promptBlacklist) as string[];
assert.deepEqual(promptNames, ['Catering Uno', 'Catering Dos'], 'solo nombres, y sin repetir el mismo negocio');
assert.ok(!promptBlacklist.includes('http'), 'el prompt no debe llevar URLs');
assert.ok(!promptBlacklist.includes('invalid_phone'), 'el prompt no debe llevar códigos ni motivos');

// --- Reintento de candidatos perdidos por un fallo del agente -----------------

const perdido = { status: 'rejected' as const, reasonCodes: ['not_returned_by_verification'], runId: 'run-1' };
assert.equal(isReleasedForRetry(perdido, 'run-1'), false, 'dentro de la misma ejecución sigue bloqueado');
assert.equal(isReleasedForRetry(perdido, 'run-2'), true, 'en una ejecución nueva se puede reintentar');
assert.equal(
  isReleasedForRetry({ status: 'rejected', reasonCodes: ['not_returned_by_verification', 'invalid_phone'], runId: 'run-1' }, 'run-2'),
  false,
  'si además falló por datos del negocio, sigue bloqueado');
assert.equal(
  isReleasedForRetry({ status: 'accepted', reasonCodes: [], runId: 'run-1' }, 'run-2'),
  false,
  'un aceptado nunca se reintenta');

console.log('curation blacklist tests passed');

// --- Perfiles de redes sociales como fuente de respaldo -----------------------

import { isSocialProfileUrl } from '../src/lib/gemini.ts';

// En Barranquilla el perfil de Instagram es, para buena parte del sector, la única presencia web.
assert.equal(isSocialProfileUrl('https://www.instagram.com/cateringbaq/'), true);
assert.equal(isSocialProfileUrl('https://www.facebook.com/banquetesbaq'), true);
assert.equal(isSocialProfileUrl('https://cateringbaq.com/contacto'), false);

// Un perfil concreto es una fuente válida para la aplicación; una búsqueda no lo es.
assert.equal(isDirectSourceUrl('https://www.instagram.com/cateringbaq/'), true);
assert.equal(isDirectSourceUrl('https://www.google.com/search?q=catering'), false);

// Una fila cuya única fuente es un perfil social, con WhatsApp real, sigue siendo contactable.
const social = batch([prospectRow(60, {
  16: 'https://www.instagram.com/cateringbaq/',
  15: 'Sin dato',
  13: '+57 315 7218407',
  12: 'Servicio de catering publicado en el perfil oficial; la reputación no está publicada, queda Sin dato para revisión.',
})]);
assert.equal(social.parsed.rows.length, 1);
assert.deepEqual(social.parsed.rows[0].issues.map(item => item.code), ['pending_reputation_review']);
assert.equal(hasContactForDiscovery(social.parsed.rows[0].rawCells), true);

console.log('curation social-source tests passed');

// --- Reputación traída del descubrimiento ------------------------------------

import { fallbackReputation } from '../src/lib/gemini.ts';

assert.deepEqual(fallbackReputation({ rating: '4.7', reviews: '128', platform: 'Google' }),
  { rating: '4.7', reviews: '128', platform: 'Google' });
assert.deepEqual(fallbackReputation({ rating: '4,7', reviews: '1.280', platform: 'tripadvisor' }),
  { rating: '4.7', reviews: '1280', platform: 'TripAdvisor' }, 'acepta coma decimal y separador de miles');

// Un dato a medias nunca puede convertirse en una calificación aparentemente verificada.
assert.equal(fallbackReputation({ rating: '4.7', reviews: '128' }), undefined, 'sin plataforma no se usa');
assert.equal(fallbackReputation({ rating: '4.7', platform: 'Google' }), undefined, 'sin reseñas no se usa');
assert.equal(fallbackReputation({ reviews: '128', platform: 'Google' }), undefined, 'sin calificación no se usa');
assert.equal(fallbackReputation({ rating: 'excelente', reviews: 'muchas', platform: 'Google' }), undefined);
assert.equal(fallbackReputation({ rating: '4.7', reviews: '0', platform: 'Google' }), undefined, 'cero reseñas no es reputación');
assert.equal(fallbackReputation({ rating: '4.7', reviews: '128', platform: 'Instagram' }), undefined, 'Instagram no es plataforma de reputación');
assert.equal(fallbackReputation({ rating: 'Sin dato', reviews: 'Sin dato', platform: 'Sin dato' }), undefined);

console.log('curation reputation tests passed');

// --- El mismo negocio nunca puede ocupar dos lugares del lote ------------------

// Caso real observado en Barranquilla: "Brunch & Munch" llegó tres veces con URLs distintas,
// una por la verificación y otra por la vía de respaldo.
const repetido = batch([
  prospectRow(70, { 1: 'Brunch & Munch', 16: 'https://brunchymunch.com/contacto' }),
  prospectRow(71, { 1: 'Brunch & Munch', 16: 'https://www.instagram.com/brunchymunch/' }),
  prospectRow(72, { 1: 'brunch & munch', 16: 'https://brunchymunch.com/nosotros' }),
]);
const duplicados = repetido.parsed.rows.filter(row => row.issues.some(item => item.code === 'duplicate_provider'));
assert.equal(duplicados.length, 2, 'las dos repeticiones deben quedar marcadas como duplicadas');
assert.equal(repetido.parsed.rows.length - duplicados.length, 1, 'solo un lugar del lote para ese negocio');

// Un duplicado entre filas que ya requieren revisión también se detecta.
assert.ok(repetido.validation.rejected.some(row => row.issues.some(item => item.code === 'duplicate_provider')));

// Negocios distintos con el mismo nombre base pero ciudad distinta no son duplicados.
const otraCiudad = batch([
  prospectRow(73, { 1: 'Brunch & Munch', 4: 'Barranquilla' }),
  prospectRow(74, { 1: 'Brunch & Munch', 4: 'Medellín', 16: 'https://brunchymunch.com/medellin' }),
]);
assert.equal(otraCiudad.parsed.rows.filter(row => row.issues.some(item => item.code === 'duplicate_provider')).length, 0);

console.log('curation dedupe tests passed');
