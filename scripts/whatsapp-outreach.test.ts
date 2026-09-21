// Contacto saliente: nosotros escribimos primero. Sin red — no se llama a Meta.
import assert from 'node:assert/strict';
import { outreachTranscript, startOutreach, toWhatsappNumber } from '../src/lib/whatsapp-outreach.ts';
import { isWindowOpen } from '../src/lib/whatsapp-session.ts';
import { getConversation, isSuppressed, saveInbound, saveOutreach, suppress } from '../src/lib/whatsapp-store.ts';
import { stateFromProvider } from '../src/lib/conversation-runner.ts';

// --- Normalización del número: Meta lo quiere solo con dígitos ---
assert.equal(toWhatsappNumber('+57 310 3727440'), '573103727440');
assert.equal(toWhatsappNumber('310 372 7440'), '573103727440', 'un móvil sin indicativo se completa con 57');
assert.equal(toWhatsappNumber('(605) 385-1234'), '6053851234');
assert.equal(toWhatsappNumber(null), undefined);
assert.equal(toWhatsappNumber('123'), undefined, 'demasiado corto');
assert.equal(toWhatsappNumber('3'.repeat(20)), undefined, 'demasiado largo');

const candidato = {
  providerId: 'e417a75f-ae40-41a1-8474-8a32cf72d193',
  displayName: 'Amaría Repostería',
  city: 'Barranquilla',
  category: 'Comida y Bebida',
  phone: '+57 310 3727440',
};

assert.match(outreachTranscript(candidato), /Amaría Repostería/);
assert.match(outreachTranscript(candidato), /Barranquilla/);

// --- Sin credenciales no se intenta enviar nada ---
delete process.env.WHATSAPP_ACCESS_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;
const sinCredenciales = await startOutreach(candidato);
assert.deepEqual(sinCredenciales, { ok: false, reason: 'WHATSAPP_NOT_CONFIGURED' });

// Con credenciales pero sin plantilla aprobada tampoco: escribir primero sin plantilla lo rechaza Meta.
process.env.WHATSAPP_ACCESS_TOKEN = 'token-de-prueba';
process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
delete process.env.WHATSAPP_OUTREACH_TEMPLATE;
const sinPlantilla = await startOutreach(candidato);
assert.deepEqual(sinPlantilla, { ok: false, reason: 'TEMPLATE_NOT_CONFIGURED' });

// Un candidato sin teléfono utilizable no se contacta.
process.env.WHATSAPP_OUTREACH_TEMPLATE = 'contacto_proveedor';
assert.deepEqual(await startOutreach({ ...candidato, phone: null }), { ok: false, reason: 'PHONE_MISSING' });

// --- La ventana NO se abre porque escribamos nosotros ---
// Sin base, el store cae a memoria; la regla que se comprueba es la misma.
await saveOutreach('573103727440', candidato, stateFromProvider(candidato));
const guardada = await getConversation('573103727440');
assert.equal(guardada?.lastInboundAtMs, null, 'nuestro mensaje no abre la ventana de servicio');
assert.equal(isWindowOpen(guardada?.lastInboundAtMs ?? null), false, 'hasta que contesten, solo plantilla');
assert.equal(guardada?.state.draft.company_name, 'Amaría Repostería', 'la ficha queda precargada');
assert.equal(guardada?.state.draft.from_candidate, true);

// Cuando contestan, la ventana se abre y el avance sigue donde estaba.
await saveInbound('573103727440', 'Amaría', Date.now(), guardada!.state);
const respondida = await getConversation('573103727440');
assert.equal(isWindowOpen(respondida?.lastInboundAtMs ?? null), true, 'su respuesta abre la ventana');
assert.equal(respondida?.state.draft.company_name, 'Amaría Repostería', 'no se pierde lo precargado');

// --- No se insiste a quien ya contactamos ---
const repetido = await startOutreach(candidato);
assert.deepEqual(repetido, { ok: false, reason: 'ALREADY_CONTACTED' }, 'insistir degrada la calidad de la cuenta');

// --- Ni a quien pidio que no le escribieran ---
await suppress('573109999999', 'no me escriban', 'prueba');
assert.equal(await isSuppressed('573109999999'), true);
const suprimido = await startOutreach({ ...candidato, providerId: 'otro', phone: '+57 310 9999999' });
assert.deepEqual(suprimido, { ok: false, reason: 'SUPPRESSED' }, 'la supresion manda sobre todo lo demas');

console.log('whatsapp outreach tests passed');
