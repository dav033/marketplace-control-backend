// El agente que redacta fuera de guion. Sin red: no se lanza el CLI, solo se comprueban el filtro
// de cordura y los argumentos con los que se invocaría.
import assert from 'node:assert/strict';
import { looksContaminated, parseInterpretation } from '../src/lib/chat-agent.ts';
import { buildCodexArgs } from '../src/lib/gemini.ts';

// --- Filtro de cordura ---
// Codex arrastra instrucciones de agente de la máquina donde corre. En pruebas reales llegó a
// responder "Uso caveman full para responder breve": una frase sobre sí mismo, nunca para un
// proveedor. Cuando aparece, se descarta y se usa el mensaje fijo.
for (const sucio of [
  'Uso caveman full para responder breve.',
  'Usaré el modo caveman solicitado para responder breve.',
  'Como modelo de lenguaje, no puedo ayudarte con eso.',
  'Según mi prompt del system, debo preguntarte esto.',
]) {
  assert.equal(looksContaminated(sucio), true, `debe descartarse: ${sucio}`);
}

for (const limpio of [
  'Somos Marketplace Control, un marketplace colombiano de proveedores para eventos. ¿Cómo se llama tu empresa?',
  'Lo necesitamos para contactarte y dejarlo en tu ficha. ¿A qué correo te escribimos?',
  'Claro, trabajamos con bodas y eventos corporativos. ¿Para cuántos asistentes sueles trabajar?',
  'No tengo esa información en este momento. ¿Y cuál es tu nombre completo?',
]) {
  assert.equal(looksContaminated(limpio), false, `NO debe descartarse: ${limpio}`);
}

// --- Argumentos del CLI ---
const base = buildCodexArgs('gpt-5.6-terra', 'low');
assert.ok(base.includes('--sandbox') && base.includes('read-only'), 'siempre en sandbox de solo lectura');
assert.deepEqual(base.slice(base.indexOf('-m'), base.indexOf('-m') + 2), ['-m', 'gpt-5.6-terra']);
assert.ok(base.some((arg) => arg.includes('model_reasoning_effort="low"')), 'el esfuerzo viaja como override de config');
assert.equal(base.includes('--ignore-user-config'), false, 'por defecto NO se aísla: la curaduría usa la config de la máquina');

// El chat sí se aísla: sin esto, las instrucciones personales de quien tenga la máquina se cuelan
// en lo que se le dice a un proveedor.
const aislado = buildCodexArgs('gpt-5.6-terra', 'low', true);
assert.ok(aislado.includes('--ignore-user-config'), 'el chat ignora la configuración personal');

// Modelo y esfuerzo entran en una lista blanca: van al argv y no pueden llevar nada raro.
assert.throws(() => buildCodexArgs('modelo; rm -rf /', 'low'), /CODEX_CONFIG_INVALID/);
assert.throws(() => buildCodexArgs('gpt-5.6-terra', 'low"; echo'), /CODEX_CONFIG_INVALID/);

console.log('chat agent tests passed');

// --- Lectura de la respuesta del intérprete ---
// El CLI no siempre devuelve el JSON pelado: a veces lo envuelve o lo rodea de texto.
const respuesta = parseInterpretation('{"answers": true, "value": "Carpas del Caribe"}');
assert.deepEqual(respuesta, { kind: 'answer', value: 'Carpas del Caribe' });

assert.deepEqual(
  parseInterpretation('```json\n{"answers": true, "value": "Amaría Repostería"}\n```'),
  { kind: 'answer', value: 'Amaría Repostería' },
  'debe aguantar que venga envuelto en markdown',
);

const noEsRespuesta = parseInterpretation('{"answers": false, "ends": false, "reply": "Somos un catálogo de proveedores. ¿Cómo se llama tu empresa?"}');
assert.equal(noEsRespuesta?.kind, 'other');
assert.equal(noEsRespuesta?.kind === 'other' && noEsRespuesta.ends, false);

const despedida = parseInterpretation('{"answers": false, "ends": true, "reply": "Gracias por tu tiempo."}');
assert.equal(despedida?.kind === 'other' && despedida.ends, true, 'una despedida cierra la conversación');

// Lo que no se puede leer se descarta, y quien llama vuelve al parser determinista.
assert.equal(parseInterpretation('no es json'), undefined);
assert.equal(parseInterpretation('{"answers": true}'), undefined, 'sin valor no hay respuesta');
assert.equal(parseInterpretation('{"answers": false}'), undefined, 'sin texto no hay nada que decir');

// Una respuesta contaminada por el entorno se descarta aunque el JSON sea válido.
assert.equal(
  parseInterpretation('{"answers": false, "ends": false, "reply": "Uso caveman full para responder breve."}'),
  undefined,
);

console.log('chat agent interpret tests passed');

// --- El agente también veta productos ---
// Una lista de términos no cubre la semántica: "asesinar perros" y "sexo" pasaron el filtro de
// palabras, y "venta de riñones humanos" no está en ninguna lista imaginable.
const conVetados = parseInterpretation('{"answers": true, "value": "pasteles", "rejected": ["venta de riñones humanos"]}');
assert.deepEqual(conVetados, { kind: 'answer', value: 'pasteles', rejected: ['venta de riñones humanos'] });

// Una lista vacía o ausente no debe convertirse en un rechazo.
assert.deepEqual(
  parseInterpretation('{"answers": true, "value": "pasteles, comida", "rejected": []}'),
  { kind: 'answer', value: 'pasteles, comida' },
);
assert.deepEqual(
  parseInterpretation('{"answers": true, "value": "pasteles, comida"}'),
  { kind: 'answer', value: 'pasteles, comida' },
);
// Y la basura dentro del array se descarta en vez de acabar en el mensaje al proveedor.
assert.deepEqual(
  parseInterpretation('{"answers": true, "value": "x", "rejected": ["", "  ", 42, "armas"]}'),
  { kind: 'answer', value: 'x', rejected: ['armas'] },
);

console.log('chat agent rejection tests passed');
