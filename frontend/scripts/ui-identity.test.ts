// La interfaz no debe nombrar al proveedor de IA que hace la investigación (Gemini, Codex, Claude
// Code): es una decisión de operación del backend, y un cambio de proveedor no debe dejar textos
// mintiendo en pantalla. La otra mitad de esta prueba —los mensajes de fallo del agente— vive en el
// repo del backend (scripts/agent-identity.test.ts) desde la separación.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const uiDirs = ['src/pages', 'src/components', 'src/layouts'];
const marcas = /gemini|codex|claude|openai|anthropic/i;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.astro') ? [full] : [];
  });
}

for (const dir of uiDirs) {
  for (const file of walk(dir)) {
    const contenido = readFileSync(file, 'utf8');
    assert.ok(!marcas.test(contenido), `${file} nombra al proveedor de IA en la interfaz`);
  }
}

console.log('ui identity tests passed');
