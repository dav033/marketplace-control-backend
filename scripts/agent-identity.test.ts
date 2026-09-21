// La interfaz no debe nombrar al proveedor de IA. Esta prueba cubre los mensajes de fallo del
// agente, servidos por /api/ai/curation. La otra vía por la que se colaba —las plantillas del
// panel— vive en el repo del frontend desde la separación (frontend/scripts/ui-identity.test.ts):
// el backend ya no tiene acceso a esos archivos ni debería necesitarlo.
import assert from 'node:assert/strict';
import { neutralizeAgentText } from '../src/lib/agent-identity.ts';

// Códigos reales que produce el runner y que antes llegaban crudos a la pantalla.
assert.match(neutralizeAgentText('CODEX_NOT_FOUND: no se encontró el ejecutable de Codex CLI.'), /^El agente de búsqueda no está disponible/);
assert.match(neutralizeAgentText('GEMINI_NOT_CONFIGURED'), /^El agente de búsqueda no está disponible/);
assert.match(neutralizeAgentText('CLAUDE_CODE_MAX_TURNS'), /sin margen antes de terminar/);
assert.match(neutralizeAgentText('CODEX_TIMEOUT: el agente superó 240s'), /tardó demasiado/);

// Un mensaje desconocido no se descarta: se muestra, pero sin la marca del proveedor.
const desconocido = neutralizeAgentText('Gemini devolvió un lote vacío para Barranquilla');
assert.ok(!/gemini/i.test(desconocido), `no debe nombrar al proveedor: ${desconocido}`);
assert.match(desconocido, /Barranquilla/, 'debe conservar el detalle útil');
assert.ok(!/codex/i.test(neutralizeAgentText('Codex CLI cerró la conexión')), 'tampoco Codex');
assert.ok(!/claude/i.test(neutralizeAgentText('Claude Code no respondió')), 'tampoco Claude Code');

console.log('agent identity tests passed');
