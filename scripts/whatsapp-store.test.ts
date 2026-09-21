// Persistencia de las conversaciones contra PostgreSQL de verdad.
//
// Se salta si no hay DATABASE_URL: la suite tiene que poder correr sin túnel. Cuando sí lo hay,
// comprueba lo que el modo memoria no puede demostrar — que el estado sobrevive al proceso.
import assert from 'node:assert/strict';
import { countOutreachToday, getConversation, isDuplicate, isPersistent, isSuppressed, saveInbound, saveOutreach, saveState, suppress } from '../src/lib/whatsapp-store.ts';
import { stateFromProvider } from '../src/lib/conversation-runner.ts';
import { isWindowOpen } from '../src/lib/whatsapp-session.ts';

if (!isPersistent()) {
  console.log('whatsapp store tests skipped (sin DATABASE_URL)');
  process.exit(0);
}

const wa = `99999${Date.now().toString().slice(-8)}`;
const candidato = {
  providerId: null as unknown as string,
  displayName: 'Prueba Store',
  city: 'Barranquilla',
  category: 'Comida y Bebida',
  phone: `+57 ${wa}`,
};

// Escribimos nosotros: la conversación queda guardada pero la ventana NO se abre.
await saveOutreach(wa, candidato, stateFromProvider(candidato));
const traida = await getConversation(wa);
assert.ok(traida, 'la conversación se recupera de la base');
assert.equal(traida.lastInboundAtMs, null, 'nuestro mensaje no abre la ventana');
assert.equal(isWindowOpen(traida.lastInboundAtMs), false);
assert.equal(traida.state.draft.company_name, 'Prueba Store', 'el borrador viaja entero en jsonb');
assert.equal(traida.state.draft.from_candidate, true);

// Contesta: se abre la ventana y el avance se conserva.
const ahora = Date.now();
await saveInbound(wa, 'Prueba', ahora, traida.state);
const respondida = await getConversation(wa);
assert.equal(isWindowOpen(respondida!.lastInboundAtMs), true, 'su respuesta abre la ventana');
assert.equal(respondida!.state.draft.company_name, 'Prueba Store');

// El avance se actualiza sin perder lo anterior.
await saveState(wa, { ...respondida!.state, draft: { ...respondida!.state.draft, full_name: 'Ana Gómez' } });
const avanzada = await getConversation(wa);
assert.equal(avanzada!.state.draft.full_name, 'Ana Gómez');
assert.equal(avanzada!.state.draft.company_name, 'Prueba Store', 'lo anterior sigue ahí');
assert.equal(isWindowOpen(avanzada!.lastInboundAtMs), true, 'guardar el avance no toca la ventana');

// Duplicados: Meta reintenta y el mismo mensaje no se procesa dos veces.
const idMensaje = `wamid.prueba.${Date.now()}`;
assert.equal(await isDuplicate(idMensaje, wa, 'hola'), false, 'la primera vez se procesa');
assert.equal(await isDuplicate(idMensaje, wa, 'hola'), true, 'la segunda se descarta');

// Supresión.
assert.equal(await isSuppressed(wa), false);
await suppress(wa, 'prueba automatizada', 'test');
assert.equal(await isSuppressed(wa), true, 'quien pide la baja queda registrado');

// El cupo diario cuenta conversaciones creadas hoy, y acabamos de crear una.
assert.ok(await countOutreachToday() >= 1, 'el contacto de hoy entra en el cupo');

console.log('whatsapp store tests passed');
