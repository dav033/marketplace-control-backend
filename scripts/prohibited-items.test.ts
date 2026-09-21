// Lo que no entra al catálogo. Nace de una prueba real: "comida, bebidas, servicios de catering,
// drogas alucinogenas, armas, globos" se guardó entero sin que nadie lo mirara.
import assert from 'node:assert/strict';
import { findProhibited, isProhibited } from '../src/lib/prohibited-items.ts';

for (const veto of ['drogas alucinogenas', 'drogas', 'armas', 'municiones', 'explosivos', 'cocaina', 'pistolas', 'servicios sexuales', 'documentos falsos']) {
  assert.equal(isProhibited(veto), true, `debe rechazarse: ${veto}`);
}
// Con tildes y mayúsculas da igual.
assert.equal(isProhibited('Drogas Alucinógenas'), true);
assert.equal(isProhibited('MUNICIÓN'), true);

// Lo que SÍ es un servicio legítimo de eventos y no puede bloquearse por parecido de palabras.
for (const valido of [
  'armado de carpas', 'armador de escenarios', 'globos', 'bebidas', 'comida',
  'servicio de catering', 'coctelería', 'menú de boda', 'alquiler de mobiliario',
  'decoración con globos', 'bebidas alcohólicas', 'show de fuego',
]) {
  assert.equal(isProhibited(valido), false, `NO debe bloquearse: ${valido}`);
}

// El caso literal de la prueba: se nombran solo los que fallan, no se descarta todo en silencio.
const lote = ['comida', 'bebidas', 'servios de catering', 'drogas alucionegenas', 'armas', 'globos'];
const vetados = findProhibited(lote);
assert.deepEqual(vetados, ['drogas alucionegenas', 'armas'], 'incluso con el typo, "drogas" y "armas" se detectan');
assert.equal(findProhibited(['comida', 'globos']).length, 0);

console.log('prohibited items tests passed');

// Ampliación tras una prueba real: "asesinar perros" y "sexo" se colaron enteros.
for (const veto of ['sexo', 'asesinar perros', 'matar animales', 'pornografia', 'secuestro']) {
  assert.equal(isProhibited(veto), true, `debe rechazarse: ${veto}`);
}
// Y lo que no puede confundirse por parecido.
for (const valido of ['sexteto de jazz', 'asesoria de eventos', 'matarife de cerdos para asado']) {
  assert.equal(isProhibited(valido), false, `NO debe bloquearse: ${valido}`);
}
console.log('prohibited items extended tests passed');
