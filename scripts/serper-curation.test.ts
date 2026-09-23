// Descubrimiento con Google Maps vía Serper. Sin red.
import assert from 'node:assert/strict';
import { SERPER_SCAN_ZONES, confirmEmailsOnSite, selectSerperCandidates, serperScanQueries } from '../src/lib/serper-curation.ts';
import { serperPlaceToHarvested } from '../src/lib/serper-maps.ts';
import { harvestedPlaceToRow } from '../src/lib/harvest-import.ts';
import { buildVerificationPrompt } from '../src/lib/harvest-verify.ts';
import { curationCandidateKey } from '../src/lib/curation-history.ts';

// Escaneo 1: las consultas de la categoría; los siguientes, una zona cada uno; luego, nada.
const base = serperScanQueries('Repostería y pastelería', 'Bogotá', 1);
assert.equal(base.length, 4);
assert.ok(base.every(query => query.endsWith('Bogotá')));
assert.deepEqual(serperScanQueries('Repostería y pastelería', 'Bogotá', 2), base.map(query => `${query} norte`));
assert.deepEqual(serperScanQueries('Repostería y pastelería', 'Bogotá', 2 + SERPER_SCAN_ZONES.length), [], 'agotadas las zonas, el escaneo sale vacío');
assert.deepEqual(serperScanQueries('Categoría inventada', 'Bogotá', 1), []);

// La ficha de Maps con la forma de la cosecha.
const ficha = serperPlaceToHarvested({ title: 'Mocka Pastelería', cid: '123', rating: 4.6, ratingCount: 50, phoneNumber: '+57 310 1234567', website: 'https://mocka.co', type: 'Pastelería' });
assert.deepEqual(ficha, {
  placeId: 'serper:123', name: 'Mocka Pastelería', rating: 4.6, reviews: 50, phone: '+57 310 1234567',
  website: 'https://mocka.co', mapsUrl: 'https://www.google.com/maps?cid=123', address: undefined, type: 'Pastelería',
});
assert.equal(serperPlaceToHarvested({ title: 'Sin cid' }), undefined);
assert.equal(serperPlaceToHarvested({ title: 'Sin reseñas', cid: '9', rating: 0 })?.rating, undefined);

// Selección: fuera lo conocido, lo que no llega al umbral y lo que no tiene contacto.
const lugar = (name: string, rating: number, reviews: number, phone?: string, website?: string) =>
  ({ placeId: `serper:${name}`, name, rating, reviews, phone, website, mapsUrl: 'https://www.google.com/maps?cid=1' });
const seleccion = selectSerperCandidates([
  lugar('Buena', 4.8, 90, '3101111111'),
  lugar('Ya en la base', 4.9, 200, '3102222222'),
  lugar('Mismo móvil con otro rótulo', 4.9, 200, '+57 310 222 2222'),
  lugar('Vista en el escaneo anterior', 4.7, 80, '3103333333'),
  lugar('Floja', 4.2, 500, '3104444444'),
  lugar('Pocas reseñas', 5, 10, '3105555555'),
  lugar('Sin contacto', 4.9, 100),
  lugar('Con web', 4.6, 40, undefined, 'https://conweb.co'),
], {
  city: 'Bogotá', category: 'Repostería y pastelería',
  blacklist: [{ candidateKey: curationCandidateKey('Vista en el escaneo anterior', 'Bogotá', 'Repostería y pastelería') } as never],
  existing: [{ candidateKey: 'x', displayName: 'Ya en la base', phoneKey: '3102222222', website: '' }],
  minRating: 4.5, minReviews: 30, limit: 20,
});
assert.deepEqual(seleccion.chosen.map(place => place.name), ['Buena', 'Con web']);
assert.equal(seleccion.known, 3);
assert.equal(seleccion.belowThreshold, 2);
assert.equal(seleccion.noContact, 1);
assert.equal(selectSerperCandidates([lugar('A', 5, 50, '3100000001'), lugar('B', 5, 50, '3100000002')], {
  city: 'Bogotá', category: 'Lugar', blacklist: [], existing: [], minRating: 4.5, minReviews: 30, limit: 1,
}).chosen.length, 1, 'respeta el tope del escaneo');

// La justificación dice de dónde salió la cifra.
const fila = harvestedPlaceToRow(ficha!, 'Bogotá', 'Repostería y pastelería', 1, { sourceLabel: 'Google Maps', verificationDate: '2026-09-23' });
assert.ok(fila![12].includes('obtenidas de Google Maps el 2026-09-23'), fila![12]);
assert.ok(harvestedPlaceToRow(ficha!, 'Bogotá', 'Repostería y pastelería', 1)![12].includes('API oficial de Places'), 'sin etiqueta, la de siempre');
assert.equal(fila![0].split('-')[1], '11', 'código de la categoría en el ID');

// El verificador recibe la fuente y la frontera de la categoría.
const prompt = buildVerificationPrompt('Bogotá', 'Repostería y pastelería', [ficha!], 'Google Maps');
assert.ok(prompt.includes('obtenidos de Google Maps'));
assert.ok(prompt.includes('Qué NO es: restaurantes'), 'lleva la frontera con Comida y Bebida');
assert.ok(!buildVerificationPrompt('Bogotá', 'Música', [ficha!]).includes('Qué NO es'), 'sin frontera escrita, nada');

// Correos: el confirmado se queda, el que el sitio no publica se quita sin tumbar la fila.
const cabecera = 'h'.repeat(3);
const filaCon = (email: string, url: string) => { const c = new Array(20).fill('x'); c[15] = email; c[16] = url; return c.join('\t'); };
const revisados: string[] = [];
const leidos: string[] = [];
const conMaps = filaCon('hola@mocka.co', 'https://www.google.com/maps?cid=1').split('\t'); conMaps[1] = 'Mocka Pastelería';
const correos = await confirmEmailsOnSite([cabecera, conMaps.join('\t'), filaCon('inventado@otro.com', 'https://mocka.co'), filaCon('Sin dato', 'https://x.co')].join('\n'),
  new Map([['mocka pasteleria', 'https://mocka.co']]),
  async ({ email, sourceUrl }) => { revisados.push(email); leidos.push(sourceUrl); return { ok: email === 'hola@mocka.co', emailConfirmed: email === 'hola@mocka.co', phoneConfirmed: false, pagesRead: 1, sourceStatus: 200 }; });
const salida = correos.tsv.split('\n');
assert.deepEqual(revisados, ['hola@mocka.co', 'inventado@otro.com'], '"Sin dato" no se revisa');
assert.equal(leidos[0], 'https://mocka.co', 'el correo se busca en la web del negocio, no en la ficha de Maps que cita la fila');
assert.equal(salida[1].split('\t')[15], 'hola@mocka.co');
assert.equal(salida[2].split('\t')[15], 'Sin dato');
assert.equal(salida[2].split('\t')[16], 'https://mocka.co', 'el resto de la fila intacto');
assert.deepEqual([correos.checked, correos.removed], [2, 1]);

console.log('serper curation tests passed');
