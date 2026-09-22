// El agente que conversa por WhatsApp. Sin red ni base: el modelo es un guion falso con la misma
// firma que la llamada a Gemini, y el guardado de la ficha se sustituye por funciones que anotan.
import assert from 'node:assert/strict';
import { applyNotes, buildSystemInstruction, converse } from '../src/lib/conversation-agent.ts';
import { CONSENT_TEXT, readConsentReply, runTurn, stateFromProvider, type ConversationState, type TurnDeps } from '../src/lib/conversation-runner.ts';
import type { GeminiContent, GenerateRequest } from '../src/lib/gemini-chat.ts';
import type { ProviderProfile } from '../src/lib/provider-profile.ts';

// --- Un modelo falso: devuelve respuestas en orden y guarda lo que se le pidió ---
type Step = GeminiContent | ((request: GenerateRequest) => GeminiContent);
function scripted(steps: Step[]) {
  const requests: GenerateRequest[] = [];
  const generate = async (request: GenerateRequest) => {
    // Copia profunda: `converse` sigue añadiendo al mismo array después de la llamada.
    requests.push(structuredClone(request));
    const step = steps.shift();
    if (!step) throw new Error('el guion se quedó sin respuestas');
    return typeof step === 'function' ? step(request) : step;
  };
  return { generate, requests };
}
const say = (text: string): GeminiContent => ({ role: 'model', parts: [{ text }] });
const call = (name: string, args: Record<string, unknown> = {}, id = `call-${name}`): GeminiContent => ({
  role: 'model',
  parts: [{ functionCall: { name, args, id }, thoughtSignature: 'firma-opaca' }],
});

const profile: ProviderProfile = {
  providerId: 'e417a75f-ae40-41a1-8474-8a32cf72d193',
  displayName: 'Atalú',
  category: 'Comida y Bebida',
  additionalCategories: ['Decoración temática'],
  city: 'Barranquilla',
  address: 'Cra 53 #80-12',
  websiteUrl: null,
  zone: 'Alto Prado',
  segment: 'Premium',
  scale: null,
  instagram: '@atalu.eventos',
  curationReason: 'Catering de bodas con reseñas consistentes',
  sources: [{ name: 'Google', rating: 4.8, reviews: 124 }, { name: 'Instagram', rating: null, reviews: null }],
};

// --- applyNotes: el modelo propone, las reglas del formulario deciden ---
{
  const { draft, saved, rejected } = applyNotes({ company_name: 'Atalú' }, {
    full_name: '  Andrés   Pérez ',
    email: 'Andres@Atalu.CO',
    products: ['menú de boda', 'drogas', 'estación de postres', 'x'.repeat(61)],
    services: ['Comida y Bebida', 'Categoría inventada'],
    volume_max: 300,
    notas: 'Atienden toda la costa',
  });
  assert.equal(draft.full_name, 'Andrés Pérez', 'los espacios se normalizan');
  assert.equal(draft.email, 'andres@atalu.co', 'el correo se guarda en minúsculas, como exige la tabla');
  assert.deepEqual(draft.products, ['menú de boda', 'estación de postres'], 'lo vetado y lo largo no entran; lo demás sí');
  assert.deepEqual(draft.services, ['Comida y Bebida'], 'solo categorías oficiales');
  assert.deepEqual([draft.volume_min, draft.volume_max], [1, 300], 'solo un máximo: el mínimo es 1');
  assert.equal(draft.description, 'Atienden toda la costa');
  assert.ok(saved.includes('products') && saved.includes('email'));
  assert.ok(rejected.some((item) => item.value === 'drogas'), 'lo vetado queda con motivo para que el agente lo explique');
  assert.ok(rejected.some((item) => item.field === 'products' && item.value.length > 60));
}
{
  const { draft, rejected } = applyNotes({}, { email: 'no-es-un-correo', volume_min: 500, volume_max: 20, phone: '12' });
  assert.equal(draft.email, undefined);
  assert.equal(draft.volume_min, undefined, 'un rango al revés no entra');
  assert.equal(draft.phone, undefined);
  assert.deepEqual(rejected.map((item) => item.field).sort(), ['email', 'phone', 'volume']);
}
{
  const muchos = Array.from({ length: 12 }, (_, index) => `producto ${index + 1}`);
  const { draft, rejected } = applyNotes({ products: ['torta'] }, { products: muchos });
  assert.equal(draft.products?.length, 10, 'el catálogo admite hasta 10 productos');
  assert.equal(draft.products?.[0], 'torta', 'lo anotado antes se conserva');
  assert.ok(rejected.some((item) => item.field === 'products'), 'se le dice que sobran para que pregunte cuáles son los principales');

  const nota = applyNotes({ description: 'Hacen bodas' }, { notas: 'También eventos de empresa' });
  assert.equal(nota.draft.description, 'Hacen bodas · También eventos de empresa', 'las notas se suman, no se pisan');
  assert.equal(applyNotes({}, { company_name: 'Venta de armas' }).draft.company_name, undefined);
}

// --- readConsentReply: solo un sí o un no claros cuentan ---
for (const si of ['sí', 'Si', 'Sí, claro', 'dale', 'bueno sí', 'de una', 'Hágale', 'autorizo', 'ok', 'si señor', 'Sí, y también hacemos tortas']) {
  assert.equal(readConsentReply(si), 'yes', `debe contar como sí: ${si}`);
}
for (const no of ['no', 'No.', 'no autorizo', 'prefiero que no', 'mejor no']) {
  assert.equal(readConsentReply(no), 'no', `debe contar como no: ${no}`);
}
for (const duda of ['¿para qué es?', 'sí? para qué lo usan', 'no sé', 'hola', 'nosotros hacemos tortas', 'si tengo una duda, me llamas', '']) {
  assert.equal(readConsentReply(duda), undefined, `debe quedar pendiente: ${duda}`);
}

// --- El prompt lleva la ficha del proveedor y la guía de su sector ---
{
  const system = buildSystemInstruction({ userMessage: 'hola', draft: { company_name: 'Atalú' }, history: [], profile, registration: null });
  assert.match(system, /Google 4\.8★ \(124 reseñas\)/, 'la reputación pública viaja al agente');
  assert.match(system, /Alto Prado/);
  assert.match(system, /@atalu\.eventos/);
  assert.match(system, /Catering de bodas con reseñas consistentes/, 'también por qué nos interesó');
  assert.match(system, /menús para eventos/, 'guía de Comida y Bebida');
  assert.match(system, /estilos y temáticas/, 'y la de su categoría adicional');
  assert.doesNotMatch(system, /Instagram null/, 'lo que no se sabe no se inventa');

  const sinFicha = buildSystemInstruction({ userMessage: 'hola', draft: {}, history: [], profile: null, registration: null, profileName: 'Caro' });
  assert.match(sinFicha, /nos escribió sin que lo hubiéramos contactado/);
  assert.match(sinFicha, /Caro/);
}

// --- converse: herramientas, firma de Gemini y rechazos ---
{
  const { generate, requests } = scripted([
    call('anotar_datos', { full_name: 'Andrés', products: ['catering para bodas', 'armas'] }),
    say('¡Qué bien, Andrés! Lo de las armas no lo podemos listar. ¿Para cuántos invitados suelen trabajar?'),
  ]);
  const result = await converse({
    userMessage: 'soy Andrés, hacemos catering para bodas y armas',
    draft: { company_name: 'Atalú' },
    history: [{ role: 'model', text: 'Hola, escribimos de Marketplace Control.' }],
    profile,
    registration: null,
  }, generate);

  assert.equal(result.draft.full_name, 'Andrés');
  assert.deepEqual(result.draft.products, ['catering para bodas']);
  assert.ok(result.rejected.some((item) => item.value === 'armas'));
  assert.match(result.reply, /cuántos invitados/);

  const primera = requests[0];
  assert.equal(primera.contents[0].role, 'user', 'Gemini exige empezar por el usuario aunque hayamos escrito primero');
  assert.equal(primera.contents.at(-1)?.parts[0].text, 'soy Andrés, hacemos catering para bodas y armas');

  const segunda = requests[1];
  const eco = segunda.contents.at(-2);
  assert.equal(eco?.parts[0].thoughtSignature, 'firma-opaca', 'la respuesta del modelo vuelve intacta, con su firma');
  const respuesta = segunda.contents.at(-1)?.parts[0].functionResponse;
  assert.equal(respuesta?.id, 'call-anotar_datos', 'la respuesta de la herramienta lleva el id de la llamada');
  assert.deepEqual((respuesta?.response.rechazado as Array<{ valor: string }>).map((item) => item.valor), ['armas'], 'el agente se entera de lo rechazado');
}
{
  // Sin nombre del negocio no se puede pedir la autorización: no habría ficha que guardar.
  const { generate, requests } = scripted([call('pedir_autorizacion'), say('Antes cuéntame, ¿cómo se llama tu negocio?')]);
  const result = await converse({ userMessage: 'listo, guárdalo', draft: {}, history: [], profile: null, registration: null }, generate);
  assert.equal(result.askedConsent, false);
  assert.equal(requests[1].contents.at(-1)?.parts[0].functionResponse?.response.ok, false);
}

// --- runTurn: la conversación completa, con el guardado sustituido ---
const seed = { providerId: profile.providerId, displayName: 'Atalú', city: 'Barranquilla', category: 'Comida y Bebida' };

function deps(steps: Step[], extra: Partial<TurnDeps> = {}) {
  const model = scripted(steps);
  const saves: unknown[][] = [];
  const updates: unknown[][] = [];
  const turnDeps: Partial<TurnDeps> = {
    generate: model.generate,
    agentAvailable: () => true,
    loadProfile: async () => profile,
    loadRegistration: async () => null,
    save: async (...args) => { saves.push(args); return { ok: true, submissionId: 'sub-1', providerPromoted: true }; },
    update: async (...args) => { updates.push(args); return true; },
    ...extra,
  };
  return { turnDeps, requests: model.requests, saves, updates };
}
const source = { channel: 'chat-prueba' as const, handle: 'sesion-1' };

{
  // Escribimos primero (plantilla), él contesta, el agente anota y pide la autorización.
  let state: ConversationState = stateFromProvider(seed, 'Hola, escribimos de Marketplace Control. ¿Te interesa?');
  const primero = deps([
    call('anotar_datos', { full_name: 'Andrés', products: ['menú de boda'] }),
    call('pedir_autorizacion'),
    say('Perfecto, Andrés, ya tengo lo principal de Atalú.'),
  ]);
  let turn = await runTurn(state, 'sí me interesa, soy Andrés y hacemos menús de boda', source, primero.turnDeps);
  assert.equal(turn.outcome, 'reply');
  assert.ok(turn.reply.endsWith(CONSENT_TEXT), 'el texto legal lo añade el código, siempre igual');
  assert.equal(turn.state.consent, 'pending');
  assert.equal(turn.state.draft.full_name, 'Andrés');
  assert.deepEqual(turn.state.history?.map((item) => item.role), ['model', 'user', 'model'], 'la memoria guarda los dos lados');
  assert.equal(primero.saves.length, 0, 'nada se guarda sin autorización');
  state = turn.state;

  // Responde que sí: la ficha se guarda ANTES de que conteste el agente, y el agente lo sabe.
  const segundo = deps([say('¡Gracias, Andrés! Una persona del equipo revisa tu ficha y te contacta.')]);
  turn = await runTurn(state, 'Sí, claro', source, segundo.turnDeps);
  assert.equal(turn.outcome, 'submitted');
  assert.equal(turn.state.submissionId, 'sub-1');
  assert.equal(segundo.saves.length, 1);
  assert.equal((segundo.saves[0][0] as { privacy_consent?: boolean }).privacy_consent, true);
  assert.equal((segundo.saves[0][1] as { providerId?: string }).providerId, profile.providerId, 'la ficha queda atada al candidato');
  assert.match(String(segundo.requests[0].contents.at(-1)?.parts[0].text), /quedó guardada/, 'el agente se entera por una nota del sistema');
  assert.equal(turn.state.finished, false, 'guardar no cierra la conversación: sigue el seguimiento');
  state = turn.state;

  // Seguimiento: cambia el correo y la ficha guardada se actualiza con el antes y el después.
  const tercero = deps([call('anotar_datos', { email: 'hola@atalu.co' }), say('Listo, actualicé tu correo.')]);
  turn = await runTurn(state, 'oye, mejor ponme hola@atalu.co', source, tercero.turnDeps);
  assert.equal(tercero.saves.length, 0, 'no se guarda otra ficha');
  assert.equal(tercero.updates.length, 1);
  assert.equal(tercero.updates[0][0], 'sub-1');
  assert.equal((tercero.updates[0][2] as { email?: string }).email, 'hola@atalu.co');
  assert.doesNotMatch(turn.reply, /Para guardar tu ficha/, 'con la ficha guardada no se vuelve a pedir autorización');
}
{
  // Dice que no a la autorización: no se guarda nada y el agente lo sabe.
  const state: ConversationState = { ...stateFromProvider(seed), consent: 'pending' };
  const d = deps([say('Entendido, no guardo nada. Si cambias de opinión, me dices.')]);
  const turn = await runTurn(state, 'no', source, d.turnDeps);
  assert.equal(turn.state.consent, 'denied');
  assert.equal(d.saves.length, 0);
  assert.match(String(d.requests[0].contents.at(-1)?.parts[0].text), /NO autorizó/);
}
{
  // Una duda no es un sí: la autorización sigue pendiente.
  const state: ConversationState = { ...stateFromProvider(seed), consent: 'pending' };
  const d = deps([say('Es para que el equipo pueda revisar tu perfil. ¿Me autorizas?')]);
  const turn = await runTurn(state, '¿y eso para qué es?', source, d.turnDeps);
  assert.equal(turn.state.consent, 'pending');
  assert.equal(d.saves.length, 0);
}
{
  // No le interesa: se cierra. Si vuelve a escribir, se le atiende.
  const d = deps([call('no_interesado', { motivo: 'no le interesa' }), say('Entiendo, gracias por tu tiempo.')]);
  const cerrado = await runTurn(stateFromProvider(seed), 'no me interesa, gracias', source, d.turnDeps);
  assert.equal(cerrado.outcome, 'declined');
  assert.equal(cerrado.state.finished, true);

  const d2 = deps([say('¡Hola de nuevo! Claro, seguimos.')]);
  const reabierto = await runTurn(cerrado.state, 'oye, al final sí me interesa', source, d2.turnDeps);
  assert.equal(reabierto.state.finished, false);
  assert.equal(reabierto.outcome, 'reply');
}
{
  // Si el modelo falla, el proveedor recibe un mensaje de respaldo y su mensaje no se pierde.
  const d = deps([() => { throw new Error('GEMINI_CHAT_HTTP_503'); }]);
  const turn = await runTurn(stateFromProvider(seed), 'hola', source, d.turnDeps);
  assert.equal(turn.outcome, 'error');
  assert.match(turn.reply, /problema/);
  assert.equal(turn.state.history?.at(-1)?.text, 'hola');

  const sinKey = await runTurn(stateFromProvider(seed), 'hola', source, { ...d.turnDeps, agentAvailable: () => false });
  assert.equal(sinKey.outcome, 'unavailable');
}
{
  // Estados que guardó el bot anterior: allí `finished` también quería decir "ficha guardada".
  const legado = { draft: { company_name: 'Atalú', privacy_consent: true }, finished: true, submissionId: 'sub-viejo' } as ConversationState;
  const d = deps([say('Tu ficha sigue en revisión.')], {
    loadRegistration: async () => ({ submissionStatus: 'reviewing', providerStatus: 'unconfirmed', receivedOn: '20/09/2026' }),
  });
  const turn = await runTurn(legado, '¿cómo va lo mío?', source, d.turnDeps);
  assert.equal(d.saves.length, 0, 'no se guarda de nuevo');
  assert.equal(turn.state.finished, false);
  assert.match(d.requests[0].systemInstruction, /lo está revisando/, 'el agente conoce el estado de la revisión');
}

console.log('conversation agent tests passed');
