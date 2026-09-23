// Serper: qué ficha de Maps se acepta como la del negocio, y cómo queda la justificación.
import assert from 'node:assert/strict';
import { matchSerperPlace, ownDomain, phoneKey } from '../src/lib/serper-maps.ts';
import { dropMissingReputationClaims } from '../src/lib/reputation-lookup.ts';

assert.equal(phoneKey('+57 310 8094969'), '3108094969');
assert.equal(phoneKey('(310) 809-4969'), '3108094969');
assert.equal(phoneKey('76457273'), undefined);
assert.equal(ownDomain('https://www.coordieventos.com/contactenos/'), 'coordieventos.com');
// Un servicio compartido no identifica a nadie.
assert.equal(ownDomain('https://horalocarhythmic.wixsite.com/bucaramanga'), undefined);
assert.equal(ownDomain('https://www.facebook.com/divertyparkjuegos/'), undefined);

const fercho = { title: 'Eventos La Casa de Fercho', address: 'Cl. 33 #31 50', phoneNumber: '+57 310 8094969', rating: 4.7, ratingCount: 338 };
const otro = { title: 'Eventos V&M', phoneNumber: '+57 305 4399023', rating: 5, ratingCount: 4 };

// Respuesta real (2026-09-23): la ficha correcta es la segunda; el teléfono la elige.
assert.deepEqual(
  matchSerperPlace([otro, fercho], { name: 'Alquileres y Eventos La Casa de Fercho', city: 'Bucaramanga', phone: '+57 310 809 4969' }),
  { rating: '4.7', reviews: '338', platform: 'Google', matchedBy: 'phone', seenIn: 'Google Maps: Eventos La Casa de Fercho, Cl. 33 #31 50' },
);
// Nombre parecido, otro teléfono y sin web: no es el negocio.
assert.equal(matchSerperPlace([otro], { name: 'Casa de Eventos G&M', city: 'Manizales', phone: '+57 314 8576552' }), undefined);
// Por dominio propio cuando el teléfono no coincide.
assert.equal(matchSerperPlace([{ title: 'Happy kids Animaciones', phoneNumber: '+57 322 3666357', website: 'https://recreacionhappykids.com/', rating: 3, ratingCount: 2 }],
  { name: 'Recreación Happy Kids', city: 'Bucaramanga', phone: '+573239117996', website: 'https://www.recreacionhappykids.com/' })?.matchedBy, 'website');
// Ficha propia sin reseñas: no hay cifra.
assert.equal(matchSerperPlace([{ title: 'Coordieventos', phoneNumber: '+57 320 4263948' }], { name: 'Coordieventos', city: 'Bucaramanga', phone: '+57 320 4263948' }), undefined);

assert.equal(
  dropMissingReputationClaims('Proveedor de menaje con sede en La Aurora. Requiere revisión debido a que no registra ficha pública con reseñas ni calificación comprobable. WhatsApp +57 310 809 4969.'),
  'Proveedor de menaje con sede en La Aurora. WhatsApp +57 310 809 4969.',
);

console.log('serper-maps: ok');
