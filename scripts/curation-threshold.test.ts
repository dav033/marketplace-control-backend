import { filterByReputationThreshold } from '../src/lib/gemini.ts';

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
check('estándar deja 2', names(estandar.tsv), 'Alta|Justo en el umbral');
check('estándar quita 3', estandar.removed, 3);
check('bajo umbral', estandar.belowThreshold, 2);
check('sin reputación', estandar.withoutReputation, 1);

// El límite es inclusivo: 4.5 con 30 reseñas cumple un umbral de 4.5 y 30.
check('límite inclusivo', names(estandar.tsv).includes('Justo en el umbral'), true);

check('exigente deja 1', names(filterByReputationThreshold(tsv, 4.8, 100).tsv), 'Alta');
check('laxo deja 4', names(filterByReputationThreshold(tsv, 4.0, 10).tsv),
  'Alta|Justo en el umbral|Poca calificación|Pocas reseñas');

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

if (failed) { console.log(`curation threshold tests: ${failed} fallos`); process.exit(1); }
console.log('curation threshold tests passed');
