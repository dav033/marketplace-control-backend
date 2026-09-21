import { completeBatchFromHarvest } from '../src/lib/gemini.ts';
import { CURATION_HEADERS } from '../src/lib/curation.ts';
import type { HarvestedPlace } from '../src/lib/places-harvest.ts';

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) { failed += 1; console.log(`  FALLA ${label}: ${actual}, esperado ${expected}`); }
}

const H = CURATION_HEADERS.join('\t');

function agentRow(name: string, phone = 'Sin dato') {
  const cells = new Array(20).fill('Sin dato');
  cells[0] = 'BAQ-02-001'; cells[1] = name; cells[2] = 'Comida y Bebida'; cells[4] = 'Barranquilla';
  cells[8] = '4.7'; cells[9] = '90'; cells[10] = 'Google'; cells[13] = phone;
  return cells.join('\t');
}

function place(name: string, rating: number, reviews: number, phone?: string): HarvestedPlace {
  return { placeId: `id-${name}`, name, rating, reviews, phone, website: 'https://ejemplo.co', mapsUrl: 'https://maps.google.com/?cid=1' };
}

const base = { city: 'Barranquilla', category: 'Comida y Bebida', minRating: 4.5, minReviews: 50 };
const names = (tsv: string) => tsv.split('\n').slice(1).filter(Boolean).map(l => l.split('\t')[1]);

// Completa hasta el objetivo con lo que el agente no alcanzó.
const corto = completeBatchFromHarvest({
  tsv: [H, agentRow('Del agente')].join('\n'),
  places: [place('Uno', 4.9, 120), place('Dos', 4.6, 80), place('Tres', 4.8, 60)],
  targetCount: 3, ...base,
});
check('añade hasta el objetivo', corto.added, 2);
check('el del agente va primero', names(corto.tsv)[0], 'Del agente');
check('total igual al objetivo', names(corto.tsv).length, 3);

// Lo que no alcanza el umbral no entra, aunque falten huecos.
const bajoUmbral = completeBatchFromHarvest({
  tsv: [H, agentRow('Del agente')].join('\n'),
  places: [place('Poca calificación', 4.2, 500), place('Pocas reseñas', 5, 20)],
  targetCount: 10, ...base,
});
check('no rellena con lo que no cumple', bajoUmbral.added, 0);

// Deduplica por nombre: el agente y el registro pueden traer el mismo negocio.
const porNombre = completeBatchFromHarvest({
  tsv: [H, agentRow('Delicatessen Salome')].join('\n'),
  places: [place('delicatessen salome', 4.9, 74), place('Otro', 4.8, 90)],
  targetCount: 5, ...base,
});
check('no duplica por nombre', porNombre.added, 1);
check('el añadido es el otro', names(porNombre.tsv)[1], 'Otro');

// Deduplica por teléfono: el mismo negocio con otro rótulo.
const porTelefono = completeBatchFromHarvest({
  tsv: [H, agentRow('Catering Ana', '+57 300 4445566')].join('\n'),
  places: [place('Ana Catering y Eventos', 4.9, 74, '300 4445566'), place('Distinto', 4.7, 60, '301 1112233')],
  targetCount: 5, ...base,
});
check('no duplica por teléfono', porTelefono.added, 1);
check('el añadido es el distinto', names(porTelefono.tsv)[1], 'Distinto');

// Con el lote ya completo no se toca nada.
const lleno = completeBatchFromHarvest({
  tsv: [H, agentRow('A'), agentRow('B')].join('\n'),
  places: [place('Uno', 4.9, 120)],
  targetCount: 2, ...base,
});
check('lote completo no crece', lleno.added, 0);

// Sin candidatos del registro, el lote del agente queda intacto.
const sinRegistro = completeBatchFromHarvest({
  tsv: [H, agentRow('Del agente')].join('\n'), places: [], targetCount: 10, ...base,
});
check('sin registro no cambia', sinRegistro.added, 0);
check('conserva lo del agente', names(sinRegistro.tsv).length, 1);

if (failed) { console.log(`curation complete tests: ${failed} fallos`); process.exit(1); }
console.log('curation complete tests passed');
