import { filterByReputationThreshold } from '../src/lib/gemini.ts';

const H = ['ID','Nombre','Cat','Seg','Ciudad','Zona','Escala','Form','Calificación','Reseñas',
  'Plat','Nivel','Razón','Tel','IG','Correo','URL','Fecha','Multi','Adic'].join('\t');

function row(name: string, rating: string, reviews: string) {
  const cells = new Array(20).fill('Sin dato');
  cells[1] = name; cells[8] = rating; cells[9] = reviews;
  return cells.join('\t');
}
const tsv = [H,
  row('Alta', '4.9', '120'),
  row('Justo en el umbral', '4.5', '30'),
  row('Poca calificación', '4.2', '500'),
  row('Pocas reseñas', '5.0', '12'),
  row('Sin reputación', 'Sin dato', 'Sin dato'),
].join('\n');

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) { failed += 1; console.log(`  FALLA ${label}: ${actual}, esperado ${expected}`); }
}
const names = (out: string) => out.split('\n').slice(1).filter(Boolean).map(l => l.split('\t')[1]).join('|');

const estandar = filterByReputationThreshold(tsv, 4.5, 30);
check('estándar deja 2', names(estandar.tsv), 'Alta|Justo en el umbral');
check('estándar quita 3', estandar.removed, 3);
check('bajo umbral', estandar.belowThreshold, 2);
check('sin reputación', estandar.withoutReputation, 1);

// El límite es inclusivo: 4.5 con 30 reseñas cumple un umbral de 4.5 y 30.
check('límite inclusivo', names(filterByReputationThreshold(tsv, 4.5, 30).tsv).includes('Justo en el umbral'), true);

const exigente = filterByReputationThreshold(tsv, 4.8, 100);
check('exigente deja 1', names(exigente.tsv), 'Alta');

const laxo = filterByReputationThreshold(tsv, 4.0, 10);
check('laxo deja 4', names(laxo.tsv), 'Alta|Justo en el umbral|Poca calificación|Pocas reseñas');

// Sin umbral efectivo el lote no se toca: quitar filas sin que nadie lo pida seria peor.
const sinUmbral = filterByReputationThreshold(tsv, 0, 0);
check('sin umbral no filtra', sinUmbral.removed, 0);
check('sin umbral conserva las 5', sinUmbral.tsv.split('\n').length - 1, 5);

// Un lote vacío no debe romper.
check('solo encabezado', filterByReputationThreshold(H, 4.5, 30).removed, 0);

if (failed) { console.log(`curation threshold tests: ${failed} fallos`); process.exit(1); }
console.log('curation threshold tests passed');
