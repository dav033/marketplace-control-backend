import { nameMatches, toE164Colombia, toDomain } from '../src/lib/google-places.ts';

// [nombre buscado, rótulo de Google, debe emparejar]
const CASES: Array<[string, string, boolean]> = [
  // Falsos positivos que la regla estricta existe para impedir. NO deben emparejar.
  ['Casa Monaco', 'Mónaco Lounge Bar', false],
  ['Alto Nivel Producción de Eventos', 'Salon de Eventos Altos del Pueblito', false],
  ['QuieroMusicos.com', 'Trio Musical Caribe en Barranquilla', false],
  ['SJC Event Planner', 'La Historia De Tu Boda - Wedding and Event Planners', false],
  ['EVENTUM', 'Escenarium Events Solutions', false],
  ['Pijama Party & Co. Barranquilla', 'Picardias Barranquilla y Soledad', false],
  ['Fiestas Mix', 'Mega Party', false],
  ['Fotógrafo Orellano', 'FOTOKOLOR', false],
  ['El Gran Día', 'Centro Comercial Gran Centro', false],
  ['Invitara', 'Ecobot, Reciclar Invita', false],
  ['Mantelería para Eventos Empresa', 'ZU EVENTOS - ALQUILER DE SILLAS Y MESAS', false],
  ['Valentina Event Planner', 'GABY NIETO DESTINATION WEDDING & EVENT PLANNER', false],
  ['Producciones de León', 'Sound Audio & Producciones', false],

  // Verdaderos que la regla estricta rechazaba de más. DEBEN emparejar.
  ['HR Producciones & Eventos', 'HR Produccion y eventos S.A.S.', true],
  ['Casa de Banquetes Marlloly', '@banquetesmarlloly', true],

  // Verdaderos que ya funcionaban. No deben romperse.
  ['Rodizio Carne e Vinho', 'Restaurante Rodizio carne e vinho - carrera 43', true],
  ['La Punta Gorda y Más Carnes', 'La Punta Gorda y Mas Carnes', true],
  ['ZU Eventos', 'ZU EVENTOS - ALQUILER DE SILLAS Y MESAS', true],
  ['Hotel Barranquilla Plaza', 'Hotel Barranquilla Plaza', true],
  ['Eventos Caribe SAS', 'Eventos Caribe', true],
];

let failed = 0;
for (const [search, candidate, expected] of CASES) {
  const actual = nameMatches(search, candidate);
  if (actual !== expected) {
    failed += 1;
    console.log(`  FALLA  "${search}" vs "${candidate}" -> ${actual}, esperado ${expected}`);
  }
}
console.log(`nameMatches: ${CASES.length - failed}/${CASES.length} casos correctos`);

const PHONES: Array<[string, string | undefined]> = [
  ['3014023323', '+573014023323'],
  ['+57 301 402 3323', '+573014023323'],
  ['(605) 385 1234', '+576053851234'],
  ['Sin dato', undefined],
  ['123', undefined],
  ['', undefined],
];
let pf = 0;
for (const [raw, expected] of PHONES) {
  const actual = toE164Colombia(raw);
  if (actual !== expected) { pf += 1; console.log(`  FALLA teléfono "${raw}" -> ${actual}, esperado ${expected}`); }
}
console.log(`toE164Colombia: ${PHONES.length - pf}/${PHONES.length} casos correctos`);

const DOMAINS: Array<[string, string | undefined]> = [
  ['http://www.rodiziobq.com/', 'rodiziobq.com'],
  ['rodiziobq.com', 'rodiziobq.com'],
  ['https://instagram.com/algo', undefined],
  ['https://wa.me/573014023323', undefined],
  ['Sin dato', undefined],
];
let df = 0;
for (const [raw, expected] of DOMAINS) {
  const actual = toDomain(raw);
  if (actual !== expected) { df += 1; console.log(`  FALLA dominio "${raw}" -> ${actual}, esperado ${expected}`); }
}
console.log(`toDomain: ${DOMAINS.length - df}/${DOMAINS.length} casos correctos`);

if (failed || pf || df) process.exit(1);
console.log('TODO CORRECTO');
