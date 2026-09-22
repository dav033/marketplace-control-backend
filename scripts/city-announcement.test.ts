// A quién le toca el anuncio de apertura de una ciudad. Sin base de datos: la regla se prueba sola,
// que es justo lo que hay que poder repasar antes de mandar mensajes que no se pueden deshacer.
import assert from 'node:assert/strict';
import { announcementDecision } from '../src/lib/cities.ts';

const fila = (extra: Partial<{ status: string; whatsapp_status: string | null; announced: boolean }> = {}) => ({
  status: 'candidate', whatsapp_status: null as string | null, announced: false, ...extra,
});

// --- Audiencia normal: solo quienes ya aceptaron la conversación ---
{
  assert.equal(announcementDecision(fila({ whatsapp_status: 'conversacion_aceptada' }), 'aceptados'), null);
  // Quien ya dio su ficha por el chat también aceptó, y sigue necesitando registrarse en la web.
  assert.equal(announcementDecision(fila({ status: 'unconfirmed', whatsapp_status: 'inscrito' }), 'aceptados'), null);

  // Estos son los que sobraban: se les mandó la invitación y nunca contestaron.
  assert.equal(announcementDecision(fila({ whatsapp_status: 'mensaje_enviado' }), 'aceptados'), 'NO_ACEPTO');
  assert.equal(announcementDecision(fila({ whatsapp_status: 'conversacion_iniciada' }), 'aceptados'), 'NO_ACEPTO');
  assert.equal(announcementDecision(fila(), 'aceptados'), 'NO_ACEPTO', 'sin conversación no hay anuncio');
}

// --- Lo que nunca recibe el anuncio, diga lo que diga la audiencia ---
for (const audiencia of ['aceptados', 'todos'] as const) {
  assert.equal(announcementDecision(fila({ announced: true, whatsapp_status: 'inscrito' }), audiencia), 'ALREADY_ANNOUNCED');
  assert.equal(announcementDecision(fila({ whatsapp_status: 'rechazado' }), audiencia), 'REJECTED');
  assert.equal(announcementDecision(fila({ whatsapp_status: 'conversacion_rechazada' }), audiencia), 'REJECTED');
  assert.equal(announcementDecision(fila({ status: 'rejected' }), audiencia), 'REJECTED');
  assert.equal(announcementDecision(fila({ status: 'archived' }), audiencia), 'REJECTED');
  // Ya está publicado en el catálogo: el anuncio lo invitaría a algo que ya hizo.
  assert.equal(announcementDecision(fila({ status: 'approved' }), audiencia), 'ALREADY_REGISTERED');
}

// --- Ciudad entera: el mensaje en frío, para una ciudad donde no se ha hablado con nadie ---
{
  assert.equal(announcementDecision(fila(), 'todos'), null);
  assert.equal(announcementDecision(fila({ whatsapp_status: 'mensaje_enviado' }), 'todos'), null);
  assert.equal(announcementDecision(fila({ whatsapp_status: 'inscrito' }), 'todos'), 'ALREADY_REGISTERED');
}

console.log('city announcement tests passed');
