// Simulación de contacto saliente desde el panel. Sin red ni base: el proveedor se busca con una
// función falsa y el guardado de la ficha se sustituye.
import assert from 'node:assert/strict';
import { buildSimulationTrigger, parseSimulationTrigger } from '../src/lib/contract.ts';
import { simulationAllowed, startSimulation } from '../src/lib/whatsapp-simulation.ts';
import { runTurn } from '../src/lib/conversation-runner.ts';

const id = 'e417a75f-ae40-41a1-8474-8a32cf72d193';

// --- El disparador: `id: <uuid>` al principio del mensaje, y nada más lo es ---
assert.equal(buildSimulationTrigger(id), `id: ${id}`);
assert.equal(parseSimulationTrigger(buildSimulationTrigger(id)), id, 'lo que arma el panel lo lee el backend');
assert.equal(parseSimulationTrigger(`  ID:${id.toUpperCase()}  `), id, 'mayúsculas y espacios dan igual');
assert.equal(parseSimulationTrigger(`hola, id: ${id}`), null, 'solo cuenta al principio: un proveedor real no lo dispara de casualidad');
assert.equal(parseSimulationTrigger('id: 123'), null);
assert.equal(parseSimulationTrigger(`id: ${id}0`), null, 'un uuid más largo no es este uuid');
assert.equal(parseSimulationTrigger('hola'), null);

// --- Quién puede simular ---
delete process.env.WHATSAPP_SIMULATION_NUMBERS;
assert.equal(simulationAllowed('573001112233'), false, 'sin configurar, nadie');
process.env.WHATSAPP_SIMULATION_NUMBERS = '+57 300 111 2233, 573004445566';
assert.equal(simulationAllowed('573001112233'), true, 'el número se compara solo por dígitos');
assert.equal(simulationAllowed('573004445566'), true);
assert.equal(simulationAllowed('573009999999'), false);
process.env.WHATSAPP_SIMULATION_NUMBERS = '*';
assert.equal(simulationAllowed('573009999999'), true, '"*" habilita a cualquiera');
process.env.WHATSAPP_SIMULATION_NUMBERS = '573001112233';

// --- Arranque: el sistema escribe primero, con la ficha del proveedor precargada ---
const proveedor = {
  provider_id: id, display_name: 'Atalú Catering', category: 'Comida y Bebida', additional_categories: [],
  city: 'Barranquilla', phone: '+57 310 0000000', contact_email: null,
} as never;
const lookup = async (providerId: string) => (providerId === id ? proveedor : null);

assert.deepEqual(await startSimulation('573009999999', id, lookup), { ok: false, reason: 'NOT_ALLOWED' });
assert.deepEqual(await startSimulation('573001112233', '00000000-0000-4000-8000-000000000000', lookup), { ok: false, reason: 'PROVIDER_NOT_FOUND' });

const inicio = await startSimulation('573001112233', id, lookup);
assert.ok(inicio.ok);
if (inicio.ok) {
  assert.match(inicio.opening, /Encontramos a Atalú Catering en Barranquilla/, 'la misma invitación que recibe el proveedor real');
  assert.deepEqual(inicio.state.history, [{ role: 'model', text: inicio.opening }], 'el agente sabe qué le escribimos');
  assert.equal(inicio.state.seed?.providerId, id);
  assert.equal(inicio.state.draft.company_name, 'Atalú Catering');
  assert.ok(inicio.state.simulation?.startedAt, 'queda marcada como simulación');

  // Al guardar la ficha, la simulación viaja hasta el guardado para que no toque al proveedor real.
  const guardados: Array<{ simulationId?: string; providerId?: string }> = [];
  const turn = await runTurn({ ...inicio.state, consent: 'pending' }, 'sí', { channel: 'whatsapp', handle: '573001112233' }, {
    agentAvailable: () => true,
    generate: async () => ({ role: 'model', parts: [{ text: '¡Gracias! Quedó guardada.' }] }),
    loadProfile: async () => null,
    loadRegistration: async () => null,
    save: async (_draft, source) => { guardados.push(source); return { ok: true, submissionId: 'sub-sim', providerPromoted: false }; },
    update: async () => true,
  });
  assert.equal(turn.outcome, 'submitted');
  assert.equal(guardados[0].providerId, id);
  assert.equal(guardados[0].simulationId, String(inicio.state.simulation?.startedAt));
  assert.ok(turn.state.simulation, 'la marca sigue en la conversación');
}

console.log('whatsapp simulation tests passed');
