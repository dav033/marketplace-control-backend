// El cupo de WhatsApp: ritmo diario, pool semanal y lo que un día puede tomar prestado.
//
// Sin base de datos ni red: la aritmética se prueba sola, que es justo lo que hay que poder repasar
// antes de mandar mensajes que no se pueden deshacer.
import assert from 'node:assert/strict';
import { computeAllowance, dailyBurstLimit, dailyLimit, quotaEpoch, weeklyLimit } from '../src/lib/whatsapp-outreach.ts';

const cupo = (sentToday: number, sentThisWeek: number, topes = { daily: 30, weekly: 210, burst: 60 }) =>
  computeAllowance({ sentToday, sentThisWeek, ...topes });

// --- Los topes por defecto: 30 al día, 210 a la semana, 60 como techo de un día ---
for (const clave of ['WHATSAPP_DAILY_OUTREACH_LIMIT', 'WHATSAPP_WEEKLY_OUTREACH_LIMIT', 'WHATSAPP_DAILY_OUTREACH_BURST']) {
  delete process.env[clave];
}
assert.equal(dailyLimit(), 30);
assert.equal(weeklyLimit(), 210, 'siete días al ritmo diario');
assert.equal(dailyBurstLimit(), 60, 'el doble del ritmo diario');

// El semanal sigue al diario cuando no se configura aparte.
process.env.WHATSAPP_DAILY_OUTREACH_LIMIT = '40';
assert.equal(weeklyLimit(), 280);
assert.equal(dailyBurstLimit(), 80);

// Un valor ilegible no ensancha el cupo: se cae al de respaldo.
process.env.WHATSAPP_DAILY_OUTREACH_LIMIT = 'muchos';
assert.equal(dailyLimit(), 30, 'texto');
process.env.WHATSAPP_DAILY_OUTREACH_LIMIT = '0';
assert.equal(dailyLimit(), 30, 'cero');
process.env.WHATSAPP_DAILY_OUTREACH_LIMIT = '-5';
assert.equal(dailyLimit(), 30, 'negativo');
process.env.WHATSAPP_DAILY_OUTREACH_LIMIT = '30.5';
assert.equal(dailyLimit(), 30, 'decimal');
delete process.env.WHATSAPP_DAILY_OUTREACH_LIMIT;

// El techo del día nunca queda por debajo del ritmo ni por encima del presupuesto de la semana.
process.env.WHATSAPP_DAILY_OUTREACH_BURST = '10';
assert.equal(dailyBurstLimit(), 30, 'un techo menor que el ritmo diario no tendría sentido');
process.env.WHATSAPP_DAILY_OUTREACH_BURST = '9999';
assert.equal(dailyBurstLimit(), 210, 'el presupuesto semanal manda sobre el techo del día');
delete process.env.WHATSAPP_DAILY_OUTREACH_BURST;

// --- Día en blanco: el ritmo son 30, y hasta 30 más se pueden pedir prestados a la semana ---
{
  const hoy = cupo(0, 0);
  assert.equal(hoy.available, 60);
  assert.equal(hoy.base, 30, 'lo que sale sin tocar el pool');
  assert.equal(hoy.borrowed, 30, 'lo que saldría prestado');
  assert.equal(hoy.weeklyRemaining, 210);
  assert.equal(hoy.blocked, undefined);
}

// Con envíos hechos, el ritmo se consume antes que el pool.
{
  const hoy = cupo(10, 10);
  assert.equal(hoy.base, 20, 'quedan 20 del ritmo de hoy');
  assert.equal(hoy.available, 50);
  assert.equal(hoy.borrowed, 30);
}

// Pasado el ritmo, todo lo que queda es prestado.
{
  const hoy = cupo(30, 30);
  assert.equal(hoy.base, 0);
  assert.equal(hoy.borrowed, 30, 'del ritmo no queda nada; el resto sale del pool');
  assert.equal(hoy.available, 30);
}

// --- El techo del día corta aunque la semana esté casi intacta ---
{
  const hoy = cupo(60, 60);
  assert.equal(hoy.available, 0);
  assert.equal(hoy.blocked, 'DAILY_LIMIT_REACHED');
  assert.ok(hoy.weeklyRemaining > 0, 'el pool sigue ahí: mañana se puede seguir');
}

// --- El pool corta aunque el día esté en blanco ---
{
  const hoy = cupo(0, 210);
  assert.equal(hoy.available, 0);
  assert.equal(hoy.blocked, 'WEEKLY_LIMIT_REACHED');
}

// Y cuando al pool le queda menos que al día, es el pool el que fija lo que se puede enviar.
{
  const hoy = cupo(0, 200);
  assert.equal(hoy.available, 10, 'la semana solo da para 10 más');
  assert.equal(hoy.base, 10, 'no se puede prometer un ritmo que el pool no cubre');
  assert.equal(hoy.borrowed, 0, 'lo prestado nunca es negativo');
  assert.equal(hoy.exhaustedReason, 'WEEKLY_LIMIT_REACHED');
}

// --- Nunca se pasa del presupuesto, se mire como se mire ---
// El recorrido llega más allá de los dos topes a propósito: bajar `WHATSAPP_WEEKLY_OUTREACH_LIMIT`
// con envíos ya hechos deja la ventana pasada de presupuesto, y de ahí no puede salir nada.
for (let enviadosHoy = 0; enviadosHoy <= 70; enviadosHoy += 5) {
  for (let enviadosSemana = enviadosHoy; enviadosSemana <= 230; enviadosSemana += 5) {
    const hoy = cupo(enviadosHoy, enviadosSemana);
    assert.ok(hoy.available >= 0, 'lo disponible nunca es negativo');
    assert.ok(hoy.borrowed >= 0, 'lo prestado nunca es negativo');
    assert.equal(hoy.base + hoy.borrowed, hoy.available, 'el desglose suma lo disponible');
    assert.ok(hoy.available <= Math.max(0, 60 - enviadosHoy), 'el día no pasa de su techo');
    assert.ok(hoy.available <= hoy.weeklyRemaining, 'la semana no pasa de su presupuesto');
    assert.equal(hoy.available === 0, hoy.blocked !== undefined, 'se bloquea exactamente al llegar a cero');
  }
}

// --- Un presupuesto semanal más estrecho que el ritmo diario: manda la semana ---
{
  const hoy = cupo(0, 0, { daily: 30, weekly: 10, burst: 60 });
  assert.equal(hoy.available, 10);
  assert.equal(hoy.exhaustedReason, 'WEEKLY_LIMIT_REACHED');
}

// --- Desde cuándo cuenta: el único ajuste que ENSANCHA el cupo, así que falla hacia contar de más ---
delete process.env.WHATSAPP_QUOTA_EPOCH;
assert.equal(quotaEpoch(), undefined, 'sin valor, cuentan las dos ventanas enteras');

process.env.WHATSAPP_QUOTA_EPOCH = '2026-09-01T10:00:00Z';
assert.equal(quotaEpoch()?.toISOString(), '2026-09-01T10:00:00.000Z', 'un instante pasado se respeta');

process.env.WHATSAPP_QUOTA_EPOCH = 'el lunes pasado';
assert.equal(quotaEpoch(), undefined, 'ilegible: se ignora y se cuenta todo');
process.env.WHATSAPP_QUOTA_EPOCH = '   ';
assert.equal(quotaEpoch(), undefined, 'en blanco: se ignora');
process.env.WHATSAPP_QUOTA_EPOCH = new Date(Date.now() + 60 * 60 * 1000).toISOString();
assert.equal(quotaEpoch(), undefined, 'en el futuro dejaría el cupo abierto para siempre: se ignora');
delete process.env.WHATSAPP_QUOTA_EPOCH;

console.log('whatsapp quota tests passed');
