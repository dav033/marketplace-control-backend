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
    '32',
    'Google',
    'B',
    '4.8 con 32 reseñas en Google; servicio de música para eventos publicado.',
    '+57 315 721-8407',
    '@banda.prueba',
    'CONTACTO@GMAIL.COM',
    'https://www.google.com/maps/place/Banda+Prueba',
    '2026-09-17',
    'Sin dato',
    'Sin dato',
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
assert.equal(valid.accepted[0].fields.email, 'contacto@gmail.com');
assert.equal(valid.accepted[0].providerType, 2);
assert.equal(valid.accepted[0].contactChannel, 'whatsapp');
assert.deepEqual(valid.accepted[0].rawEvidence.rawColumns['Nombre Comercial'], 'Banda Prueba');

const corporateEmail = parseOne(`${header}\n${row({ 6: 'Mediano (50 a 200 pers.)', 13: 'Sin dato', 15: 'ventas@bandaprueba.com', 16: 'https://bandaprueba.com/proveedores/banda' })}`);
assert.equal(corporateEmail.accepted.length, 1);
assert.equal(corporateEmail.accepted[0].contactChannel, 'email');

const noActionableContact = parseOne(`${header}\n${row({ 13: 'Sin dato', 15: 'Sin dato' })}`);
assert.equal(noActionableContact.accepted.length, 0);
assert.ok(noActionableContact.rejected[0].issues.some(item => item.code === 'missing_whatsapp_contact'));

// El estándar es único (4.5 estrellas, 30 reseñas mínimas) sin importar el Tipo de proveedor.
const belowUnifiedMinimum = parseOne(`${header}\n${row({ 0: 'MDE-01-001', 2: 'Lugar', 9: '29', 10: 'Google', 11: 'B', 12: '4.8 con 29 reseñas en Google; salón de eventos publicado.', 16: 'https://example.com/venue' })}`);
assert.equal(belowUnifiedMinimum.accepted.length, 0);
assert.ok(belowUnifiedMinimum.rejected[0].issues.some(item => item.code === 'insufficient_reviews'));

// 30-49 reseñas ya no se rechaza para Tipo 1 (Lugar): el mínimo unificado reemplazó el umbral de 50.
const typeOneWithUnifiedMinimum = parseOne(`${header}\n${row({ 0: 'MDE-01-001', 2: 'Lugar', 9: '35', 10: 'Rappi', 11: 'B', 12: '4.8 con 35 reseñas en Rappi; salón de eventos publicado.', 16: 'https://example.com/venue' })}`);
assert.equal(typeOneWithUnifiedMinimum.accepted.length, 1);
assert.equal(typeOneWithUnifiedMinimum.accepted[0].fields.platform, 'Rappi');

// Reputación combinada: sin suficientes reseñas en una sola plataforma, pero el total repartido en
// 2+ plataformas con 4.5+ llega a 60 o más.
const combinedReputationRow = row({
  0: 'MDE-01-001', 2: 'Lugar', 8: 'Sin dato', 9: 'Sin dato', 10: 'Sin dato', 11: 'B',
  12: 'Servicio de salón de eventos y contacto verificados en el sitio oficial. Reputación combinada de varias plataformas: 65 reseñas en total. No se pudo encontrar calificación pública tras una búsqueda dedicada en Google.',
  16: 'https://example.com/venue',
  18: 'TripAdvisor:4.6:35;Facebook:4.5:30',
});
const combinedReputation = parseOne(`${header}\n${combinedReputationRow}`);
assert.equal(combinedReputation.accepted.length, 1, JSON.stringify(combinedReputation.rejected[0]?.issues));
assert.deepEqual(combinedReputation.accepted[0].fields.multiPlatformReputation, [
  { platform: 'TripAdvisor', rating: 4.6, reviews: 35 },
  { platform: 'Facebook', rating: 4.5, reviews: 30 },
]);

// Bug real ("Casa Tabor"): la principal YA alcanza el mínimo sola; que además haya 2+ plataformas
// que también calificarían para el modo combinado no debe exigir la frase "reputación combinada".
const alreadyQualifiesWithExtraPlatforms = row({
  0: 'MDE-01-001', 2: 'Lugar', 9: '83', 11: 'A', 16: 'https://example.com/venue',
  12: 'Google reporta 4.8 con 83 opiniones. Booking reporta 4.6 con 100 opiniones.',
  18: 'Google:4.8:83;Booking:4.6:100',
});
const alreadyQualifies = parseOne(`${header}\n${alreadyQualifiesWithExtraPlatforms}`);
assert.equal(alreadyQualifies.accepted.length, 1, JSON.stringify(alreadyQualifies.rejected[0]?.issues));

// La misma repartición pero por debajo de 60 combinadas: sigue sin alcanzar, queda para revisión.
const combinedTooFewRow = row({
  0: 'MDE-01-001', 2: 'Lugar', 8: 'Sin dato', 9: 'Sin dato', 10: 'Sin dato', 11: 'B',
  12: 'Servicio de salón de eventos y contacto verificados en el sitio oficial. No se pudo encontrar calificación pública tras una búsqueda dedicada en Google.',
  16: 'https://example.com/venue',
  18: 'TripAdvisor:4.6:15;Facebook:4.5:10',
});
const combinedTooFew = parseOne(`${header}\n${combinedTooFewRow}`);
assert.equal(combinedTooFew.accepted.length, 0);
assert.ok(combinedTooFew.rejected[0].issues.some(item => item.code === 'pending_reputation_review'));

// Columna multiplataforma mal formada: falta el tercer campo en una entrada.
const malformedMultiPlatform = parseOne(`${header}\n${row({ 18: 'TripAdvisor:4.6' })}`);
assert.equal(malformedMultiPlatform.accepted.length, 0);
assert.ok(malformedMultiPlatform.rejected[0].issues.some(item => item.code === 'invalid_multiplatform_reputation'));

// Booking.com publica sobre 10, no sobre 5: 8.3/10 debe convertirse a 4.2/5, no invalidar la fila
// (bug real encontrado en producción con "Hotel American Golf").
const bookingScaleRow = row({
  0: 'MDE-01-001', 2: 'Lugar', 16: 'https://example.com/hotel',
  12: '4.8 con 32 reseñas en Google; servicio de música para eventos publicado. Booking reporta 8.3/10 con 40 reseñas.',
  18: 'Booking:8.3:40',
});
const bookingScale = parseOne(`${header}\n${bookingScaleRow}`);
assert.equal(bookingScale.accepted.length, 1, JSON.stringify(bookingScale.rejected[0]?.issues));
assert.deepEqual(bookingScale.accepted[0].fields.multiPlatformReputation, [{ platform: 'Booking', rating: 4.2, reviews: 40 }]);

// La misma conversión aplica si Booking es la plataforma PRINCIPAL (columna 8-10), no solo dentro
// de la lista multiplataforma. 9.2/10 convierte a 4.6/5, que sí alcanza el mínimo de curaduría (4.5).
const bookingAsPrimary = parseOne(`${header}\n${row({ 8: '9.2', 9: '40', 10: 'Booking', 12: '4.6 con 40 reseñas en Booking; servicio de música para eventos publicado.' })}`);
assert.equal(bookingAsPrimary.accepted.length, 1, JSON.stringify(bookingAsPrimary.rejected[0]?.issues));
assert.equal(bookingAsPrimary.accepted[0].fields.rating, 4.6);

// Categorías adicionales: un hotel (Lugar) que también ofrece catering real.
const withAdditionalCategories = parseOne(`${header}\n${row({ 0: 'MDE-01-001', 2: 'Lugar', 16: 'https://example.com/hotel', 19: 'Comida y Bebida;Entretenimiento' })}`);
assert.equal(withAdditionalCategories.accepted.length, 1, JSON.stringify(withAdditionalCategories.rejected[0]?.issues));
assert.deepEqual(withAdditionalCategories.accepted[0].fields.additionalCategories, ['Comida y Bebida', 'Entretenimiento']);

// No puede repetir la categoría principal como adicional.
const additionalRepeatsPrimary = parseOne(`${header}\n${row({ 0: 'MDE-01-001', 2: 'Lugar', 16: 'https://example.com/hotel', 19: 'Lugar' })}`);
assert.equal(additionalRepeatsPrimary.accepted.length, 0);
assert.ok(additionalRepeatsPrimary.rejected[0].issues.some(item => item.code === 'invalid_additional_categories'));

// Categoría adicional que no es una de las 10 oficiales.
const additionalUnknownCategory = parseOne(`${header}\n${row({ 19: 'Categoria Inventada' })}`);
assert.equal(additionalUnknownCategory.accepted.length, 0);
assert.ok(additionalUnknownCategory.rejected[0].issues.some(item => item.code === 'invalid_additional_categories'));

// Bug real: un directorio agregador (Cybo) se aceptaba como plataforma de reputación válida porque
// el validador solo bloqueaba "Instagram" por nombre en vez de exigir una lista blanca real.
const aggregatorPlatform = parseOne(`${header}\n${row({ 10: 'Cybo', 12: '4.8 con 32 reseñas en Cybo; servicio de música para eventos publicado.' })}`);
assert.equal(aggregatorPlatform.accepted.length, 0);
assert.ok(aggregatorPlatform.rejected[0].issues.some(item => item.code === 'invalid_platform'));

// La misma lista blanca aplica dentro de "Reputación Multiplataforma".
const aggregatorInMultiPlatform = parseOne(`${header}\n${row({ 18: 'Cybo:4.6:40;Google:4.7:35' })}`);
assert.equal(aggregatorInMultiPlatform.accepted.length, 0);
assert.ok(aggregatorInMultiPlatform.rejected[0].issues.some(item => item.code === 'invalid_multiplatform_reputation'));

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
