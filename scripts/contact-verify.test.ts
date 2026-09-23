// Verificación determinista del contacto: lo que no está publicado en el sitio no se aprueba.
import assert from 'node:assert/strict';
import { verifyContact, verifyBatchContacts, CONTACT_UNVERIFIED_MARKER } from '../src/lib/contact-verify.ts';
import { CURATION_HEADERS, parseCurationTsv, validateCurationBatch } from '../src/lib/curation.ts';

const realFetch = globalThis.fetch;
const pages = new Map<string, { status: number; html: string }>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const page = pages.get(url) ?? { status: 404, html: '' };
  return new Response(page.html, { status: page.status, headers: { 'content-type': 'text/html' } });
}) as typeof fetch;
const realInfo = console.info; console.info = () => {};

try {
  pages.set('https://cande.co/', { status: 200, html: '<a href="mailto:info@cande.co">info@cande.co</a> Tel +57 (311) 697-8835' });
  pages.set('https://cande.co/eventos', { status: 200, html: '<p>Banquetes</p>' });

  // Correo y móvil publicados: confirmado.
  const ok = await verifyContact({ email: 'info@cande.co', phone: '+57 311 6978835', sourceUrl: 'https://cande.co/eventos', channel: 'email' });
  assert.equal(ok.ok, true); assert.equal(ok.emailConfirmed, true); assert.equal(ok.phoneConfirmed, true);

  // Móvil distinto al publicado: no se aprueba y el motivo dice cuál publica el sitio.
  const otroMovil = await verifyContact({ email: 'Sin dato', phone: '+57 300 0000000', sourceUrl: 'https://cande.co/', channel: 'whatsapp' });
  assert.equal(otroMovil.ok, false); assert.match(otroMovil.reason ?? '', /no aparece en el sitio, que publica 3116978835/);

  // Buzón no comercial en el dominio correcto: no vale aunque exista.
  const rrhh = await verifyContact({ email: 'hojadevida@cande.co', phone: 'Sin dato', sourceUrl: 'https://cande.co/', channel: 'email' });
  assert.equal(rrhh.ok, false); assert.match(rrhh.reason ?? '', /no comercial/);

  // Buzón personal que el sitio no publica: no vale. Uno genérico del mismo dominio con MX sí (aquí no hay MX real: cae).
  const personal = await verifyContact({ email: 'diana.perez@cande.co', phone: 'Sin dato', sourceUrl: 'https://cande.co/', channel: 'email' });
  assert.equal(personal.ok, false); assert.match(personal.reason ?? '', /personal/);

  // Fuente en red social: no se puede leer, queda para confirmar a mano.
  const social = await verifyContact({ email: 'Sin dato', phone: '+57 311 6978835', sourceUrl: 'https://www.instagram.com/cande/', channel: 'whatsapp' });
  assert.equal(social.ok, false); assert.match(social.reason ?? '', /redes/);

  // Sitio que bloquea robots.
  pages.set('https://bloqueado.co/', { status: 403, html: '' });
  const bloqueado = await verifyContact({ email: 'Sin dato', phone: '+57 311 6978835', sourceUrl: 'https://bloqueado.co/', channel: 'whatsapp' });
  assert.equal(bloqueado.ok, false); assert.match(bloqueado.reason ?? '', /bloquea/); assert.equal(bloqueado.pagesRead, 0);

  // Lote: la fila no confirmada conserva sus datos, pero el validador la baja a revisión.
  function row(name: string, phone: string, url: string): string {
    const cells = new Array(20).fill('Sin dato');
    cells[0] = 'CTG-02-001'; cells[1] = name; cells[2] = 'Comida y Bebida'; cells[3] = 'Sin clasificar'; cells[4] = 'Cartagena';
    cells[7] = 'No verificado'; cells[8] = '4.6'; cells[9] = '90'; cells[10] = 'Google'; cells[11] = 'A';
    cells[12] = 'Calificación 4.6 con 90 reseñas en Google; banquetes publicados.'; cells[13] = phone; cells[14] = 'Sin Redes';
    cells[16] = url; cells[17] = '2026-09-22'; cells[18] = 'Google:4.6:90';
    return cells.join('\t');
  }
  const tsv = [CURATION_HEADERS.join('\t'), row('Candé', '+57 311 6978835', 'https://cande.co/'), row('Fantasma', '+57 300 0000000', 'https://cande.co/fantasma')].join('\n');
  const batch = await verifyBatchContacts(tsv, { minRating: 4.5, minReviews: 30 });
  assert.equal(batch.checked, 2); assert.equal(batch.confirmed, 1); assert.equal(batch.demoted, 1);
  const validated = validateCurationBatch(parseCurationTsv(batch.tsv));
  assert.deepEqual(validated.accepted.map(r => r.fields.displayName), ['Candé']);
  const fantasma = validated.rejected.find(r => r.rawCells[1] === 'Fantasma');
  assert.ok(fantasma?.issues.some(i => i.code === 'contact_unverified'));
  assert.ok(fantasma?.rawCells[12].includes(CONTACT_UNVERIFIED_MARKER));
  assert.equal(fantasma?.rawCells[13], '+57 300 0000000', 'el dato no se borra: se marca');
  // Idempotente: verificar dos veces no duplica el marcador.
  const again = await verifyBatchContacts(batch.tsv, { minRating: 4.5, minReviews: 30 });
  assert.equal((again.tsv.match(/Contacto no comprobado/g) ?? []).length, 1);
} finally {
  globalThis.fetch = realFetch; console.info = realInfo;
}
console.log('contact verify tests passed');
