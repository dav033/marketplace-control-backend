// Estado del contacto por WhatsApp y modo prueba. Sin red ni base.
import assert from 'node:assert/strict';
import { applyStatusEvents, nextStatus, type StatusChange } from '../src/lib/conversation-status.ts';
import { redirectTarget, testNumbers } from '../src/lib/whatsapp.ts';

const vacio: StatusChange = { status: null, reason: null };

// --- El recorrido feliz ---
assert.deepEqual(
  applyStatusEvents(vacio, [{ type: 'sent' }, { type: 'inbound' }, { type: 'interest' }, { type: 'registered' }]).status,
  'inscrito',
);
assert.equal(nextStatus(vacio, { type: 'sent' }).status, 'mensaje_enviado');
assert.equal(nextStatus({ status: 'mensaje_enviado', reason: null }, { type: 'inbound' }).status, 'conversacion_iniciada', 'contestar inicia la conversación');
assert.equal(nextStatus({ status: 'conversacion_aceptada', reason: null }, { type: 'inbound' }).status, 'conversacion_aceptada', 'seguir escribiendo no la devuelve a iniciada');

// --- Rechazar la conversación no es lo mismo que rechazar la inscripción ---
const sinInteres = applyStatusEvents(vacio, [{ type: 'sent' }, { type: 'inbound' }, { type: 'decline', reason: 'No le interesa' }]);
assert.deepEqual(sinInteres, { status: 'conversacion_rechazada', reason: 'No le interesa' }, 'dijo que no antes de aceptar conversar');

const seEchoAtras = applyStatusEvents(vacio, [{ type: 'inbound' }, { type: 'interest' }, { type: 'decline', reason: 'Ya no quiere' }]);
assert.deepEqual(seEchoAtras, { status: 'rechazado', reason: 'Ya no quiere' }, 'aceptó conversar y luego rechazó la inscripción');

const sinAutorizacion = applyStatusEvents(vacio, [{ type: 'inbound' }, { type: 'interest' }, { type: 'consent_denied' }]);
assert.equal(sinAutorizacion.status, 'rechazado', 'negar la autorización es rechazar la inscripción');

const inadecuado = applyStatusEvents(vacio, [{ type: 'inbound' }, { type: 'inappropriate', reason: 'insultos' }]);
assert.deepEqual(inadecuado, { status: 'rechazado', reason: 'Comportamiento inadecuado: insultos' });

// --- Lo que no se puede deshacer por accidente ---
const inscrito: StatusChange = { status: 'inscrito', reason: null };
assert.equal(nextStatus(inscrito, { type: 'inbound' }).status, 'inscrito');
assert.equal(nextStatus(inscrito, { type: 'decline', reason: 'x' }).status, 'inscrito', 'la baja de un inscrito la gestiona el equipo');
assert.equal(nextStatus(inscrito, { type: 'interest' }).status, 'inscrito');
assert.equal(nextStatus(inscrito, { type: 'inappropriate', reason: 'amenazas' }).status, 'rechazado', 'el comportamiento inadecuado sí lo mueve');
assert.equal(nextStatus({ status: 'conversacion_iniciada', reason: null }, { type: 'sent' }).status, 'conversacion_iniciada', 'reenviar no retrocede');

// --- Reabrir ---
assert.equal(nextStatus(sinInteres, { type: 'interest' }).status, 'conversacion_aceptada', '"al final sí me interesa" reabre');
assert.equal(nextStatus(inadecuado, { type: 'interest' }).status, 'rechazado', 'tras un comportamiento inadecuado no se reabre solo');

// --- Modo prueba: a dónde van todos los mensajes ---
delete process.env.WHATSAPP_REDIRECT_ALL_TO;
assert.equal(redirectTarget(), null, 'sin configurar, cada mensaje va a su destinatario');
process.env.WHATSAPP_REDIRECT_ALL_TO = '3185391610';
assert.equal(redirectTarget(), '573185391610', 'un móvil colombiano sin indicativo se completa con 57');
process.env.WHATSAPP_REDIRECT_ALL_TO = '+57 318 539 1610';
assert.equal(redirectTarget(), '573185391610');
process.env.WHATSAPP_REDIRECT_ALL_TO = '3185391610, 316 867 8691';
assert.deepEqual(testNumbers(), ['573185391610', '573168678691'], 'varios teléfonos de prueba, separados por comas');
assert.equal(redirectTarget(), '573185391610', 'el primero es el de por defecto');
delete process.env.WHATSAPP_REDIRECT_ALL_TO;
assert.deepEqual(testNumbers(), []);

console.log('whatsapp status tests passed');
