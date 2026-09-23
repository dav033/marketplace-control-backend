// Contención de Google Places: apagado por defecto, opt-in explícito, interruptor de emergencia,
// tope duro y contadores. Se sustituye `fetch` global para contar lo que saldría a la red.
import assert from 'node:assert/strict';
import { getPlacesUsage, placesBlockReason, placesTextSearch, placesRequestLimit, resetPlacesUsageForTests, DEFAULT_MAX_REQUESTS } from '../src/lib/places-gate.ts';
import { isGooglePlacesConfigured, lookupGooglePlaceReputation } from '../src/lib/google-places.ts';
import { harvestCategoryCandidates, isGooglePlacesConfiguredForHarvest } from '../src/lib/places-harvest.ts';

const realFetch = globalThis.fetch;
let networkCalls: string[] = [];
function stubNetwork(body: unknown = { places: [] }) {
  networkCalls = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    networkCalls.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
function setEnv(values: Record<string, string | undefined>) {
  for (const name of ['GOOGLE_PLACES_API_KEY', 'GOOGLE_PLACES_OPT_IN', 'GOOGLE_PLACES_KILL_SWITCH', 'GOOGLE_PLACES_MAX_REQUESTS']) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  resetPlacesUsageForTests();
}
// Silencia el log estructurado de la puerta durante la prueba; se restaura al final.
const realInfo = console.info;
console.info = () => {};

try {
  // --- Sin clave: nada que hacer ---------------------------------------------------------------
  setEnv({});
  stubNetwork();
  assert.equal(placesBlockReason(), 'not_configured');
  assert.equal(isGooglePlacesConfigured(), false);
  assert.equal(await lookupGooglePlaceReputation('Casa Tabor', 'Barranquilla', { phone: '3014023323' }), undefined);
  assert.equal(networkCalls.length, 0);

  // --- Criterio de aceptación: clave configurada SIN opt-in = cero llamadas -------------------
  setEnv({ GOOGLE_PLACES_API_KEY: 'clave-de-prueba' });
  stubNetwork({ places: [{ displayName: { text: 'Casa Tabor' }, rating: 4.8, userRatingCount: 120, formattedAddress: 'Barranquilla' }] });
  assert.equal(placesBlockReason(), 'not_opted_in');
  assert.equal(isGooglePlacesConfigured(), false, 'la clave sola no activa Places');
  assert.equal(isGooglePlacesConfiguredForHarvest(), false);
  assert.equal(await lookupGooglePlaceReputation('Casa Tabor', 'Barranquilla', { phone: '3014023323', websiteUrl: 'casatabor.com' }), undefined);
  const harvest = await harvestCategoryCandidates('Barranquilla', 'Lugar');
  assert.equal(harvest.candidates.length, 0);
  assert.equal(harvest.apiCalls, 0);
  assert.equal(networkCalls.length, 0, 'con clave y sin opt-in no sale ninguna petición');
  // Y el intento directo por la puerta queda contado como bloqueado, no como realizado.
  const blocked = await placesTextSearch({ textQuery: 'x' }, 'places.id', { purpose: 'test' });
  assert.deepEqual(blocked, { status: 'blocked', reason: 'not_opted_in' });
  let usage = getPlacesUsage();
  assert.equal(usage.enabled, false);
  assert.equal(usage.attempted, 1);
  assert.equal(usage.blocked, 1);
  assert.equal(usage.performed, 0);
  assert.equal(usage.blockedByReason.not_opted_in, 1);
  assert.equal(networkCalls.length, 0);

  // --- Interruptor de emergencia gana sobre el opt-in ------------------------------------------
  setEnv({ GOOGLE_PLACES_API_KEY: 'clave-de-prueba', GOOGLE_PLACES_OPT_IN: '1', GOOGLE_PLACES_KILL_SWITCH: '1' });
  stubNetwork();
  assert.equal(placesBlockReason(), 'kill_switch');
  assert.equal(isGooglePlacesConfigured(), false);
  assert.equal((await placesTextSearch({ textQuery: 'x' }, 'places.id', { purpose: 'test' })).status, 'blocked');
  assert.equal(networkCalls.length, 0);

  // --- Opt-in explícito: sí sale, y se cuenta --------------------------------------------------
  setEnv({ GOOGLE_PLACES_API_KEY: 'clave-de-prueba', GOOGLE_PLACES_OPT_IN: '1' });
  stubNetwork({ places: [{ id: 'p1', displayName: { text: 'Salón Real' }, rating: 4.9, userRatingCount: 80, nationalPhoneNumber: '301 4023323' }] });
  assert.equal(placesRequestLimit(), DEFAULT_MAX_REQUESTS, 'sin tope explícito aplica el tope por defecto');
  assert.equal(isGooglePlacesConfigured(), true);
  const ok = await placesTextSearch({ textQuery: 'salón de eventos' }, 'places.id', { purpose: 'test' });
  assert.equal(ok.status, 'ok');
  assert.equal(networkCalls.length, 1);
  assert.ok(networkCalls[0].startsWith('https://places.googleapis.com/v1/places:searchText'));
  usage = getPlacesUsage();
  assert.equal(usage.performed, 1);
  assert.equal(usage.attempted, 1);
  assert.equal(usage.blocked, 0);

  // --- Tope duro: la petición N+1 se bloquea aunque haya opt-in ----------------------------------
  setEnv({ GOOGLE_PLACES_API_KEY: 'clave-de-prueba', GOOGLE_PLACES_OPT_IN: '1', GOOGLE_PLACES_MAX_REQUESTS: '3' });
  stubNetwork({ places: [] });
  // La cosecha de "Lugar" tiene 4 consultas: solo 3 pueden salir, la cuarta ni se intenta.
  const limited = await harvestCategoryCandidates('Barranquilla', 'Lugar');
  assert.equal(networkCalls.length, 3, 'nunca más peticiones que el tope');
  assert.equal(limited.apiCalls, 3);
  assert.equal(placesBlockReason(), 'limit_reached');
  const overflow = await placesTextSearch({ textQuery: 'x' }, 'places.id', { purpose: 'test' });
  assert.deepEqual(overflow, { status: 'blocked', reason: 'limit_reached' });
  usage = getPlacesUsage();
  assert.equal(usage.performed, 3);
  assert.equal(usage.blocked, 1);
  assert.equal(usage.blockedByReason.limit_reached, 1);
  assert.equal(usage.limit, 3);
  assert.equal(networkCalls.length, 3);

  // --- Un tope ilegible cierra la puerta, no la abre ---------------------------------------------
  setEnv({ GOOGLE_PLACES_API_KEY: 'clave-de-prueba', GOOGLE_PLACES_OPT_IN: '1', GOOGLE_PLACES_MAX_REQUESTS: 'muchas' });
  stubNetwork();
  assert.equal(placesRequestLimit(), 0);
  assert.equal(placesBlockReason(), 'limit_reached');
  assert.equal(networkCalls.length, 0);

  // --- Tope 0 explícito: opt-in sin presupuesto no llama ------------------------------------------
  setEnv({ GOOGLE_PLACES_API_KEY: 'clave-de-prueba', GOOGLE_PLACES_OPT_IN: '1', GOOGLE_PLACES_MAX_REQUESTS: '0' });
  stubNetwork();
  assert.equal(await lookupGooglePlaceReputation('Casa Tabor', 'Barranquilla', { phone: '3014023323' }), undefined);
  assert.equal(networkCalls.length, 0);

  // --- Un fallo HTTP cuenta como realizada (Google puede haberla cobrado) ------------------------
  setEnv({ GOOGLE_PLACES_API_KEY: 'clave-de-prueba', GOOGLE_PLACES_OPT_IN: '1', GOOGLE_PLACES_MAX_REQUESTS: '5' });
  networkCalls = [];
  globalThis.fetch = (async () => new Response('quota', { status: 429 })) as typeof fetch;
  const realError = console.error;
  console.error = () => {};
  const failed = await placesTextSearch({ textQuery: 'x' }, 'places.id', { purpose: 'test' });
  console.error = realError;
  assert.equal(failed.status, 'failed');
  assert.equal(getPlacesUsage().performed, 1);
} finally {
  globalThis.fetch = realFetch;
  console.info = realInfo;
  setEnv({});
}

console.log('places gate tests passed');
