// Pruebas del bot de WhatsApp. Todo offline: ni Meta ni el modelo se llaman aquí.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { extractInboundMessages, resolveWebhookChallenge, verifySignature } from '../src/lib/whatsapp.ts';
import { SERVICE_WINDOW_MS, isWindowOpen, msLeftInWindow } from '../src/lib/whatsapp-session.ts';

// --- Verificación del webhook (GET) ---
process.env.WHATSAPP_VERIFY_TOKEN = 'token-de-verificacion';
const ok = resolveWebhookChallenge(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-de-verificacion', 'hub.challenge': '12345' }));
assert.deepEqual(ok, { ok: true, challenge: '12345' }, 'el challenge debe devolverse tal cual');

const malToken = resolveWebhookChallenge(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'otro', 'hub.challenge': '12345' }));
assert.equal(malToken.ok, false, 'un verify_token distinto no debe pasar');

const malModo = resolveWebhookChallenge(new URLSearchParams({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'token-de-verificacion', 'hub.challenge': '1' }));
assert.equal(malModo.ok, false, 'solo se acepta hub.mode=subscribe');

// --- Firma del cuerpo (POST) ---
process.env.WHATSAPP_APP_SECRET = 'app-secret-de-prueba';
const cuerpo = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
const firma = `sha256=${createHmac('sha256', 'app-secret-de-prueba').update(cuerpo, 'utf8').digest('hex')}`;

assert.equal(verifySignature(cuerpo, firma), true, 'la firma correcta debe pasar');
assert.equal(verifySignature(cuerpo, null), false, 'sin cabecera no pasa');
assert.equal(verifySignature(cuerpo, 'sha256=00'), false, 'una firma de otra longitud no pasa');
assert.equal(verifySignature(`${cuerpo} `, firma), false, 'un cuerpo alterado invalida la firma');
assert.equal(
  verifySignature(cuerpo, `sha256=${createHmac('sha256', 'otro-secreto').update(cuerpo, 'utf8').digest('hex')}`),
  false,
  'firmado con otro secreto no pasa',
);

// --- Lectura del payload ---
const payload = {
  entry: [{
    changes: [{
      value: {
        contacts: [{ wa_id: '573001234567', profile: { name: 'Banquetes del Norte' } }],
        messages: [
          { id: 'wamid.uno', from: '573001234567', type: 'text', timestamp: '1758000000', text: { body: '  Hola, quiero registrarme  ' } },
          { id: 'wamid.dos', from: '573001234567', type: 'audio', timestamp: '1758000001', audio: { id: 'x' } },
          { id: 'wamid.tres', from: '573001234567', type: 'text', timestamp: '1758000002', text: { body: '   ' } },
        ],
      },
    }],
  }],
};
const entrantes = extractInboundMessages(payload);
assert.equal(entrantes.length, 1, 'solo los mensajes de texto con contenido');
assert.equal(entrantes[0].text, 'Hola, quiero registrarme', 'el texto llega sin espacios sobrantes');
assert.equal(entrantes[0].profileName, 'Banquetes del Norte', 'el nombre sale de contacts por wa_id');
assert.equal(entrantes[0].timestampMs, 1758000000 * 1000, 'el timestamp de Meta viene en segundos');

// Un acuse de entrega no es un mensaje: no debe disparar respuesta.
assert.equal(extractInboundMessages({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.x', status: 'delivered' }] } }] }] }).length, 0);
assert.equal(extractInboundMessages({}).length, 0, 'un payload vacío no debe reventar');

// --- Ventana de servicio de 24h ---
const ahora = Date.now();
assert.equal(isWindowOpen(null, ahora), false, 'sin mensaje entrante la ventana esta cerrada: solo plantilla');
assert.equal(isWindowOpen(ahora, ahora), true, 'recien escrito, la ventana esta abierta');
assert.equal(isWindowOpen(ahora, ahora + SERVICE_WINDOW_MS - 1000), true, 'un segundo antes sigue abierta');
assert.equal(isWindowOpen(ahora, ahora + SERVICE_WINDOW_MS), false, 'a las 24h exactas ya esta cerrada');
assert.equal(msLeftInWindow(null), 0, 'sin entrante no queda ventana');
assert.equal(msLeftInWindow(ahora, ahora + SERVICE_WINDOW_MS + 5000), 0, 'nunca devuelve negativo');

console.log('whatsapp tests passed');
