import assert from 'node:assert/strict';
import {
  CURATION_HEADERS,
  parseCurationTsv,
  validateCurationBatch,
} from '../src/lib/curation.ts';

const header = CURATION_HEADERS.join('\t');

function row(overrides: Record<number, string> = {}) {
  const cells = [
    'MDE-03-001',
    'Banda Prueba',
    'Música',
    'Sin clasificar',
    'Medellín',
    'Área Metropolitana',
    'Sin dato',
    'No verificado',
    '4,8',
    '15',
    'Google',
    'B',
    '4.8 con 15 reseñas en Google; servicio de música para eventos publicado.',
    '+57 315 721-8407',
    '@banda.prueba',
    'CONTACTO@EJEMPLO.COM',
    'https://www.google.com/maps/place/Banda+Prueba',
    '2026-09-17',
  ];
  for (const [index, value] of Object.entries(overrides)) cells[Number(index)] = value;
  return cells.join('\t');
}

function parseOne(input: string) {
  const parsed = parseCurationTsv(input);
  assert.equal(parsed.fatalErrors.length, 0);
  return validateCurationBatch(parsed);
}

const valid = parseOne(`${header}\n${row()}`);
assert.equal(valid.accepted.length, 1);
assert.equal(valid.rejected.length, 0);
assert.equal(valid.accepted[0].fields.phone, '+57 315 7218407');
assert.equal(valid.accepted[0].fields.email, 'contacto@ejemplo.com');
assert.equal(valid.accepted[0].providerType, 2);
assert.deepEqual(valid.accepted[0].rawEvidence.rawColumns['Nombre Comercial'], 'Banda Prueba');

const typeOneTooFew = parseOne(`${header}\n${row({ 0: 'MDE-01-001', 2: 'Lugar', 9: '49', 10: 'Google', 11: 'B', 12: '4.8 con 49 reseñas en Google; salón de eventos publicado.', 16: 'https://example.com/venue' })}`);
assert.equal(typeOneTooFew.accepted.length, 0);
assert.ok(typeOneTooFew.rejected[0].issues.some(item => item.code === 'insufficient_reviews'));
assert.ok(typeOneTooFew.rejected[0].issues.some(item => item.code === 'invalid_curation_level_for_threshold'));

const malformed = parseOne(`${header}\n${row({ 9: '15,000' })}\n${row({ 0: 'MDE-03-002', 16: 'https://www.google.com/search?q=banda' })}`);
assert.equal(malformed.accepted.length, 0);
assert.ok(malformed.rejected[0].issues.some(item => item.code === 'invalid_review_count'));
assert.ok(malformed.rejected[1].issues.some(item => item.code === 'invalid_source_url'));

const weakEvidence = parseOne(`${header}\n${row({ 12: 'Excelente proveedor para eventos.' })}`);
assert.equal(weakEvidence.accepted.length, 0);
assert.ok(weakEvidence.rejected[0].issues.some(item => item.code === 'invalid_curation_reason'));

const wrongColumnCount = parseCurationTsv(`${header}\n${row().split('\t').slice(0, 17).join('\t')}`);
assert.equal(wrongColumnCount.rows[0].issues[0].code, 'column_count');

const badHeader = parseCurationTsv(`Nombre\tCiudad\n${row()}`);
assert.equal(badHeader.fatalErrors[0].code, 'invalid_header');

console.log('curation tests passed');
