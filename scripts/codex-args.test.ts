// Argumentos con los que la curaduría lanza el CLI de Codex. Sin red: no se lanza nada.
// (Vivían en la prueba del chat, que ya no usa Codex; la curaduría sí.)
import assert from 'node:assert/strict';
import { buildCodexArgs } from '../src/lib/gemini.ts';

const base = buildCodexArgs('gpt-5.6-terra', 'low');
assert.ok(base.includes('--sandbox') && base.includes('read-only'), 'siempre en sandbox de solo lectura');
assert.deepEqual(base.slice(base.indexOf('-m'), base.indexOf('-m') + 2), ['-m', 'gpt-5.6-terra']);
assert.ok(base.some((arg) => arg.includes('model_reasoning_effort="low"')), 'el esfuerzo viaja como override de config');
assert.equal(base.includes('--ignore-user-config'), false, 'por defecto NO se aísla: la curaduría usa la config de la máquina');

const aislado = buildCodexArgs('gpt-5.6-terra', 'low', true);
assert.ok(aislado.includes('--ignore-user-config'), 'se puede aislar de la configuración personal');

// Modelo y esfuerzo entran en una lista blanca: van al argv y no pueden llevar nada raro.
assert.throws(() => buildCodexArgs('modelo; rm -rf /', 'low'), /CODEX_CONFIG_INVALID/);
assert.throws(() => buildCodexArgs('gpt-5.6-terra', 'low"; echo'), /CODEX_CONFIG_INVALID/);

console.log('codex args tests passed');
