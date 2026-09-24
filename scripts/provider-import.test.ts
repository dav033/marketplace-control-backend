// El importador no debe volver a tumbar filas que la curación ya dio por buenas.
import assert from 'node:assert/strict';
import { importCurationTsv } from '../src/lib/provider-import.ts';
import { CURATION_HEADERS } from '../src/lib/curation.ts';

const realFetch = globalThis.fetch;
let fetched = 0;
globalThis.fetch = (async () => { fetched += 1; return new Response('', { status: 404 }); }) as typeof fetch;

function row(name: string, reason: string): string {
  const cells = new Array(20).fill('Sin dato');
  cells[0] = 'BOG-11-001'; cells[1] = name; cells[2] = 'Repostería y pastelería'; cells[3] = 'Sin clasificar'; cells[4] = 'Bogotá';
  cells[7] = 'No verificado'; cells[8] = '4.6'; cells[9] = '90'; cells[10] = 'Google'; cells[11] = 'A';
  cells[12] = reason; cells[13] = '+57 311 6978835'; cells[14] = 'Sin Redes';
  cells[16] = 'https://www.instagram.com/dulce/'; cells[17] = '2026-09-23'; cells[18] = 'Google:4.6:90';
  return cells.join('\t');
}

try {
  const tsv = [
    CURATION_HEADERS.join('\t'),
    row('Dulce', 'Calificación 4.6 con 90 reseñas en Google; pastelería para eventos.'),
    row('Dudosa', 'Calificación 4.6 con 90 reseñas en Google. [Contacto no comprobado: el sitio no respondió (HTTP 404)]'),
  ].join('\n');
  const result = await importCurationTsv(tsv, { minRating: 4.5, minReviews: 30 });
  // Sin base de datos el lote llega hasta el final de la validación y se detiene ahí.
  assert.equal(fetched, 0, 'importar no vuelve a leer sitios');
  assert.equal(result.body.error, 'DATABASE_NOT_CONFIGURED', 'hubo filas aceptadas: solo falta la base de datos');
  assert.equal(result.body.contactSummary.whatsapp, 1, 'la fila de Maps con móvil sigue aceptada');
  assert.equal(result.body.rejected, 1, 'la marcada por la curación sigue rechazada');
  assert.ok(result.body.rejectedRows[0].issues.some(i => i.code === 'contact_unverified'));
} finally {
  globalThis.fetch = realFetch;
}
console.log('provider import tests passed');
