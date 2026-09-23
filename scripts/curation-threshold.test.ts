import { filterByReputationThreshold } from '../src/lib/gemini.ts';
import { CURATION_HEADERS, parseCurationTsv, validateCurationBatch } from '../src/lib/curation.ts';

const H = ['ID', 'Nombre', 'Cat', 'Seg', 'Ciudad', 'Zona', 'Escala', 'Form', 'Calificación', 'Reseñas',
  'Plat', 'Nivel', 'Razón', 'Tel', 'IG', 'Correo', 'URL', 'Fecha', 'Multi', 'Adic'].join('\t');

function row(name: string, rating: string, reviews: string, multi = 'Sin dato') {
  const cells = new Array(20).fill('Sin dato');
  cells[1] = name; cells[8] = rating; cells[9] = reviews; cells[18] = multi;
  return cells.join('\t');
}

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) { failed += 1; console.log(`  FALLA ${label}: ${actual}, esperado ${expected}`); }
}
const names = (out: string) => out.split('\n').slice(1).filter(Boolean).map(line => line.split('\t')[1]).join('|');

const tsv = [H,
  row('Alta', '4.9', '120'),
  row('Justo en el umbral', '4.5', '30'),
  row('Poca calificación', '4.2', '500'),
  row('Pocas reseñas', '5.0', '12'),
  row('Sin reputación', 'Sin dato', 'Sin dato'),
].join('\n');

const estandar = filterByReputationThreshold(tsv, 4.5, 30);
// "Sin dato" no se tira: se conserva para que el validador lo marque "Requiere revisión". Solo
// cae lo que SÍ tiene cifra y no alcanza el umbral.
check('estándar deja 3', names(estandar.tsv), 'Alta|Justo en el umbral|Sin reputación');
check('estándar quita 2', estandar.removed, 2);
check('bajo umbral', estandar.belowThreshold, 2);
check('sin reputación se conserva para revisión', estandar.keptForReview, 1);

// El límite es inclusivo: 4.5 con 30 reseñas cumple un umbral de 4.5 y 30.
check('límite inclusivo', names(estandar.tsv).includes('Justo en el umbral'), true);

check('exigente deja 1 verificada más la de revisión', names(filterByReputationThreshold(tsv, 4.8, 100).tsv), 'Alta|Sin reputación');
check('laxo deja las 5', names(filterByReputationThreshold(tsv, 4.0, 10).tsv),
  'Alta|Justo en el umbral|Poca calificación|Pocas reseñas|Sin reputación');

// Sin umbral efectivo el lote no se toca: quitar filas sin que nadie lo pida sería peor.
const sinUmbral = filterByReputationThreshold(tsv, 0, 0);
check('sin umbral no filtra', sinUmbral.removed, 0);
check('sin umbral conserva las 5', sinUmbral.tsv.split('\n').length - 1, 5);

// Un lote vacío no debe romper.
check('solo encabezado', filterByReputationThreshold(H, 4.5, 30).removed, 0);

// --- Reputación repartida entre plataformas ---
// La curaduría acepta a quien no llega al mínimo en ninguna plataforma por separado pero suma el
// doble entre dos o más que sí alcanzan la calificación. El filtro debe respetar esa regla: mirar
// solo las columnas principales tiraba proveedores legítimos.
const combinado = [H,
  row('Combinada', '4.6', '25', 'Facebook:4.6:25;TripAdvisor:4.7:40'),
  row('Combinada corta', '4.6', '20', 'Facebook:4.6:20;TripAdvisor:4.7:25'),
  row('Combinada mal calificada', '4.2', '80', 'Facebook:4.2:80;TripAdvisor:4.1:90'),
  row('Una sola plataforma', '4.9', '70', 'Google:4.9:70'),
].join('\n');

const conCombinada = filterByReputationThreshold(combinado, 4.5, 30);
check('combinada sobrevive', names(conCombinada.tsv).includes('Combinada|'), true);
check('combinada corta cae', names(conCombinada.tsv).includes('Combinada corta'), false);
check('combinada mal calificada cae', names(conCombinada.tsv).includes('Combinada mal calificada'), false);
check('una sola plataforma sobrevive', names(conCombinada.tsv).includes('Una sola plataforma'), true);

// El mínimo combinado escala con el umbral: con 50 exigidas hacen falta 100 sumadas.
check('combinada cae con umbral alto',
  names(filterByReputationThreshold(combinado, 4.5, 50).tsv).includes('Combinada|'), false);

// Una sola plataforma, por muchas reseñas que traiga, no activa la regla combinada.
const unaSola = [H, row('Solo una', '4.0', '10', 'Facebook:4.9:500')].join('\n');
check('una plataforma no combina', names(filterByReputationThreshold(unaSola, 4.5, 30).tsv), '');

// --- El umbral del operador llega al validador -------------------------------------------------
// Con 3.5 y 30 pedidos, un negocio de 4.0 con 40 reseñas es válido; con el estándar, no. Y con 3.5
// un 3.2 sigue cayendo: bajar el mínimo no es quitarlo.
function fullRow(name: string, rating: string, reviews: string): string {
  const cells = new Array(20).fill('Sin dato');
  cells[0] = 'CTG-02-001'; cells[1] = name; cells[2] = 'Comida y Bebida'; cells[3] = 'Sin clasificar'; cells[4] = 'Cartagena';
  cells[7] = 'No verificado'; cells[8] = rating; cells[9] = reviews; cells[10] = 'Google'; cells[11] = Number(reviews) >= 50 ? 'A' : 'B';
  cells[12] = `Calificación ${rating} con ${reviews} reseñas en Google; catering para eventos publicado.`;
  cells[13] = '+57 300 1112233'; cells[14] = 'Sin Redes'; cells[16] = 'https://ejemplo.co/'; cells[17] = '2026-09-22';
  cells[18] = `Google:${rating}:${reviews}`;
  return cells.join('\t');
}
const lote = [CURATION_HEADERS.join('\t'), fullRow('Cuatro', '4.0', '40'), fullRow('Tres dos', '3.2', '90'), fullRow('Pocas', '4.9', '12')].join('\n');
const relajado = validateCurationBatch(parseCurationTsv(lote, { minRating: 3.5, minReviews: 30 }));
check('con 3.5 acepta el 4.0', relajado.accepted.map(r => r.fields.displayName).join('|'), 'Cuatro');
check('con 3.5 el 3.2 cae por calificación', relajado.rejected.find(r => r.rawCells[1] === 'Tres dos')?.issues.some(i => i.code === 'low_rating'), true);
check('con 3.5 las 12 reseñas caen', relajado.rejected.find(r => r.rawCells[1] === 'Pocas')?.issues.some(i => i.code === 'insufficient_reviews'), true);
const estandarValidado = validateCurationBatch(parseCurationTsv(lote));
check('el estándar sigue rechazando el 4.0', estandarValidado.accepted.length, 0);
check('mensaje con el mínimo pedido', relajado.rejected.find(r => r.rawCells[1] === 'Tres dos')?.issues.find(i => i.code === 'low_rating')?.message, 'La calificación mínima de curaduría es 3.5.');

if (failed) { console.log(`curation threshold tests: ${failed} fallos`); process.exit(1); }
console.log('curation threshold tests passed');
