// La conversación entera, sin red: el motor no llama al modelo ni a la base, así que se puede
// recorrer paso a paso y comprobar que recoge lo mismo que el formulario web.
import assert from 'node:assert/strict';
import { advance, matchCategories, matchVolume, isPlainYesNo, looksLikeQuestion, nextStep, openingMessage, seedDraft, splitItems, stripLeadingYesNo, summarize, type RegistrationDraft } from '../src/lib/registration-chat.ts';

// --- Interpretación de lenguaje suelto ---
assert.deepEqual(matchCategories('hacemos comida y bebida, y también entretenimiento'), ['Comida y Bebida', 'Entretenimiento']);
assert.deepEqual(matchCategories('musica en vivo'), ['Música'], 'debe reconocer sin tilde');
assert.deepEqual(matchCategories('vendemos zapatos'), [], 'nada fuera de la lista oficial');

assert.deepEqual(matchVolume('de 50 a 300'), { min: 50, max: 300 });
assert.deepEqual(matchVolume('entre 80 y 120 personas'), { min: 80, max: 120 });
assert.deepEqual(matchVolume('unas 200'), { min: 200, max: 200 }, 'un solo número vale como rango cerrado');
assert.equal(matchVolume('de 300 a 50'), undefined, 'un rango invertido no es válido');
assert.equal(matchVolume('muchas personas'), undefined);

assert.deepEqual(splitItems('menú de boda, estación de postres y coctelería'), ['menú de boda', 'estación de postres', 'coctelería']);

// --- Conversación completa, como la haría un proveedor ---
let draft: RegistrationDraft = {};
const dicho: string[] = [];
function responder(texto: string) {
  const resultado = advance(draft, texto);
  draft = resultado.draft;
  dicho.push(resultado.message);
  return resultado;
}

assert.equal(nextStep({})?.key, 'company_name', 'empieza preguntando la empresa');

responder('Banquetes del Norte');
assert.equal(draft.company_name, 'Banquetes del Norte');
responder('David Therán');
responder('contacto@banquetesdelnorte.com');
assert.equal(draft.email, 'contacto@banquetesdelnorte.com');
responder('no');
assert.equal(draft.phone, null, '"no" omite el teléfono, no lo deja pendiente');
responder('Comida y Bebida');
assert.deepEqual(draft.services, ['Comida y Bebida']);
responder('menú de boda, estación de postres, coctelería');
assert.deepEqual(draft.products, ['menú de boda', 'estación de postres', 'coctelería']);
responder('de 50 a 300');
assert.equal(draft.volume_min, 50);
assert.equal(draft.volume_max, 300);
responder('no');
responder('sí');
assert.equal(draft.privacy_consent, true);
responder('no');
assert.equal(draft.marketing_consent, false, 'el consentimiento comercial es independiente');

const confirmacion = advance(draft, 'sí');
assert.equal(confirmacion.type, 'submit', 'tras confirmar, la ficha se envía');

// El resumen tiene que enseñar lo que se va a guardar antes de confirmar.
const resumen = summarize(draft);
for (const esperado of ['Banquetes del Norte', 'contacto@banquetesdelnorte.com', 'Comida y Bebida', 'de 50 a 300']) {
  assert.ok(resumen.includes(esperado), `el resumen debe incluir ${esperado}`);
}

// --- Rechazos ---
assert.equal(advance({ company_name: 'X' }, '').type, 'retry', 'una respuesta vacía repregunta');
assert.equal(advance({ company_name: 'Banquetes', full_name: 'David' }, 'no tengo').type, 'retry', 'un correo inválido no pasa');

const rechazo = advance({
  company_name: 'Banquetes', full_name: 'David', email: 'a@b.co', phone: null,
  services: ['Música'], products: ['DJ'], volume_min: 10, volume_max: 20, description: null,
}, 'no');
assert.equal(rechazo.type, 'declined', 'sin consentimiento de privacidad se corta');
assert.equal(rechazo.draft.privacy_consent, false);

// Un paso opcional respondido con null cuenta como respondido y no se vuelve a preguntar.
assert.equal(nextStep({ company_name: 'X', full_name: 'Y', email: 'a@b.co', phone: null })?.key, 'services');

console.log('registration chat tests passed');

// --- Apertura: el saludo no es el nombre de la empresa ---
// Sin esto, "Hola, quiero registrar mi negocio" quedaba guardado como company_name y toda la ficha
// se desplazaba un campo.
for (const saludo of ['Hola', 'hola!', 'Buenas tardes', 'Hola, quiero registrar mi negocio', 'quiero registrarme', 'Buenos días, me gustaría ser proveedor', '¿información?']) {
  const resultado = advance({}, saludo);
  assert.equal(resultado.draft.company_name, undefined, `"${saludo}" no debe guardarse como empresa`);
  assert.equal(resultado.type, 'question', `"${saludo}" debe devolver la pregunta de apertura`);
}

// Pero un nombre de empresa real sí se guarda, aunque suene corto.
for (const nombre of ['Carpas del Caribe', 'Banquetes del Norte', 'DJ Sonido Patio']) {
  assert.equal(advance({}, nombre).draft.company_name, nombre, `"${nombre}" sí es un nombre de empresa`);
}

console.log('registration chat opening tests passed');

// --- Saludo y paso de identidad ---
// El saludo del flujo normal salía como "¿Hablo con alguien de undefined?" cuando el paso de
// confirmar identidad pasó a ser el primero de la lista.
const saludoNormal = openingMessage();
assert.ok(!saludoNormal.includes('undefined'), `el saludo no debe llevar undefined: ${saludoNormal}`);
assert.match(saludoNormal, /c[oó]mo se llama tu empresa/i, 'el flujo normal empieza preguntando la empresa');

// En el flujo normal NO se pregunta identidad: el proveedor acaba de decir su empresa.
const trasEmpresa = advance({}, 'Panadería La 40');
assert.match(trasEmpresa.message, /nombre completo/i, 'tras la empresa toca el nombre, no confirmar identidad');
assert.equal(trasEmpresa.draft.from_candidate, undefined);

// Desde un candidato sí, porque escribimos nosotros primero.
const candidato = { providerId: 'abc', displayName: 'Amaría Repostería', city: 'Barranquilla', category: 'Comida y Bebida', phone: '+57 310 3727440' };
const sembrado = seedDraft(candidato);
assert.equal(sembrado.from_candidate, true);
assert.equal(sembrado.company_name, 'Amaría Repostería');
assert.deepEqual(sembrado.services, ['Comida y Bebida'], 'la categoría del candidato se precarga');
assert.equal(sembrado.phone, '+57 310 3727440');
assert.equal(sembrado.full_name, undefined, 'el nombre de la persona NO se precarga: es lo que viene a confirmar');
assert.equal(nextStep(sembrado)?.key, 'identity_confirmed');
// El saludo cuando escribimos primero ya no lo redacta el bot: es la plantilla aprobada por Meta,
// y se comprueba en whatsapp-outreach.test.ts.

// Número equivocado: no se insiste.
const equivocado = advance(sembrado, 'no');
assert.equal(equivocado.type, 'declined');

// Tras confirmar, salta directo a lo que falta.
const confirmado = advance(sembrado, 'sí');
assert.match(confirmado.message, /nombre completo/i);

// "No tengo correo" recibe una explicación, no la misma frase otra vez.
const sinCorreo = advance({ from_candidate: true, identity_confirmed: true, company_name: 'X', full_name: 'Y' }, 'no tengo correo');
assert.equal(sinCorreo.type, 'retry');
assert.match(sinCorreo.message, /lo necesito/i, 'debe explicar por qué hace falta el correo');
assert.ok(!/no me cuadra/i.test(sinCorreo.message), 'no debe soltar el mensaje genérico');

console.log('registration chat candidate tests passed');

// --- Un "no" no es un dato ---
// El paso de productos es obligatorio, pero aceptaba "no" y lo guardaba como products: ["no"].
const sinProductos = advance({ company_name: 'X', full_name: 'Y', email: 'a@b.co', phone: null, services: ['Música'] }, 'no');
assert.equal(sinProductos.type, 'retry', '"no" no es un producto válido');
assert.match(sinProductos.message, /sin saber qué ofreces/i, 'debe explicar por qué es obligatorio');
assert.equal(sinProductos.draft.products, undefined);

for (const suelto of ['no', 'sí', 'si']) {
  assert.equal(advance({}, suelto).draft.company_name, undefined, `"${suelto}" no es una razón social`);
  assert.equal(
    advance({ company_name: 'Panadería' }, suelto).draft.full_name, undefined,
    `"${suelto}" no es el nombre de una persona`,
  );
}

console.log('registration chat guard tests passed');

// --- Una pregunta no es una respuesta ---
// "¿y esto cuánto me cuesta?" se guardaba como el nombre de la persona de contacto, porque los
// pasos de texto libre aceptaban cualquier cadena. Detectarlo es lo que deja que el agente conteste.
for (const pregunta of ['¿y esto cuánto me cuesta?', 'cuanto vale', 'quienes son ustedes', '¿es gratis?', 'como funciona esto', 'para qué necesitan mi correo']) {
  assert.equal(looksLikeQuestion(pregunta), true, `"${pregunta}" debe detectarse como pregunta`);
}
for (const respuesta of ['Ana Gómez', 'Carpas del Caribe', 'tortas de boda, postres', 'Trabajamos toda la costa']) {
  assert.equal(looksLikeQuestion(respuesta), false, `"${respuesta}" NO es una pregunta`);
}

const conPregunta = advance({ from_candidate: true, identity_confirmed: true, company_name: 'Amaría' }, '¿y esto cuánto me cuesta?');
assert.equal(conPregunta.type, 'retry', 'una pregunta va a la vía de "no entendí", donde contesta el agente');
assert.equal(conPregunta.draft.full_name, undefined, 'la pregunta no se guarda como nombre');

console.log('registration chat question tests passed');

// --- Preguntas en medio de la frase, y frases corridas ---
// Caso real: "antes de euq trata todo esto" se guardó como el único producto del proveedor. El
// interrogativo no iba al principio, así que la detección por inicio no lo veía.
for (const frase of ['antes de que trata todo esto', 'de que se trata', 'no entiendo', 'y esto como funciona', 'cuanto cuesta estar ahi']) {
  assert.equal(looksLikeQuestion(frase), true, `"${frase}" es una pregunta aunque no empiece por interrogativo`);
}
// Y lo que NO debe confundirse con pregunta, porque "que" aparece dentro de respuestas legítimas.
for (const frase of ['menu de boda que hacemos por encargo', 'tortas que decoramos a mano']) {
  assert.equal(looksLikeQuestion(frase), false, `"${frase}" es una respuesta, no una pregunta`);
}

const baseProductos = {
  from_candidate: true, identity_confirmed: true, company_name: 'X', full_name: 'Y',
  email: 'a@b.co', phone: null, services: ['Comida y Bebida'],
};
// La frase con typo del caso real: sin comas y larga, se repregunta en vez de guardarse.
assert.equal(advance(baseProductos, 'antes de euq trata todo esto').type, 'retry');
assert.equal(advance(baseProductos, 'antes de euq trata todo esto').draft.products, undefined);
// Listas reales siguen entrando.
assert.deepEqual(advance(baseProductos, 'tortas de boda, postres').draft.products, ['tortas de boda', 'postres']);
assert.deepEqual(advance(baseProductos, 'carpas para 200 personas').draft.products, ['carpas para 200 personas']);

// Un nombre de persona no son siete palabras.
assert.equal(advance({ company_name: 'X' }, 'pues mira la verdad no se muy bien').draft.full_name, undefined);
assert.equal(advance({ company_name: 'X' }, 'Ana Gómez Restrepo').draft.full_name, 'Ana Gómez Restrepo');

console.log('registration chat prose tests passed');

// --- Un mensaje puede traer dos datos ---
// "si, me llamo julian" confirma la identidad Y da el nombre. Leyendo solo el "si", el bot pedía
// justo el nombre que le acababan de decir.
assert.equal(stripLeadingYesNo('si, me llamo julian'), 'me llamo julian');
assert.equal(stripLeadingYesNo('sí me llamo Ana Gómez'), 'me llamo Ana Gómez');
assert.equal(stripLeadingYesNo('claro, soy Pedro'), 'soy Pedro');
assert.equal(stripLeadingYesNo('listo: Carpas del Caribe'), 'Carpas del Caribe');
assert.equal(stripLeadingYesNo('si'), '', 'un "sí" pelado no deja resto');
assert.equal(stripLeadingYesNo('Ana Gómez'), '', 'lo que no empieza por sí/no no se toca');
assert.equal(stripLeadingYesNo('sindicato de meseros'), '', 'no debe partir una palabra que empiece por "si"');

console.log('registration chat compound tests passed');

// --- Un "no" pelado no es lo mismo que una negativa con motivo ---
// `isNegative` casa con todo lo que EMPIECE por "no", así que "no quiero decirtelo" tomaba el
// atajo determinista y el bot repetía el mismo mensaje fijo una y otra vez.
for (const pelado of ['no', 'si', 'sí', 'no gracias', 'si claro', 'ninguno']) {
  assert.equal(isPlainYesNo(pelado), true, `"${pelado}" sí es un sí/no pelado`);
}
for (const conMotivo of ['no quiero decirtelo', 'no puedo decirte mi nombre', 'no tengo correo corporativo']) {
  assert.equal(isPlainYesNo(conMotivo), false, `"${conMotivo}" merece una respuesta, no el mensaje fijo`);
}

console.log('registration chat refusal tests passed');
