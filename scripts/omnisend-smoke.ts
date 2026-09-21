// Comprueba que OMNISEND_API_KEY es válida contra la API real, sin escribir nada.
//
// Uso:
//   node --env-file=.env --experimental-strip-types --import ./scripts/ts-resolver.mjs \
//     scripts/omnisend-smoke.ts
//
// Solo hace GET. No crea contactos, ni plantillas, ni campañas, ni envía correo: una llave rota
// tiene que detectarse sin tocar la cuenta.
//
// La distinción que hace útil este test: Omnisend responde 401 cuando no reconoce la llave, y 403
// con `detail: "This action requires the 'X' permission"` cuando sí la reconoce pero al token le
// falta ese scope. Verificado a mano: una llave inventada y una petición sin llave dan 401; la
// llave real del proyecto da 403 en todos los recursos de lectura. Por eso 403 NO se reporta como
// llave rota: se reporta como llave buena con scopes recortados.
//
// No importa `src/lib/omnisend.ts`: ese módulo lee `import.meta.env`, que solo existe dentro de
// Astro/Vite y revienta al cargarlo desde Node suelto. La comprobación replica sus cabeceras.
const env = (name: string) => process.env[name];
const API_BASE = 'https://api.omnisend.com/api';
const version = env('OMNISEND_VERSION') || '2026-03-15';

if (!env('OMNISEND_API_KEY')) {
  console.error('FALLO: OMNISEND_API_KEY no está configurada en el entorno.');
  process.exit(1);
}

type Probe = { status: number; ok: boolean; ms: number; detail: string };

async function probe(path: string): Promise<Probe> {
  const started = Date.now();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      authorization: `Omnisend-API-Key ${env('OMNISEND_API_KEY')}`,
      'content-type': 'application/json',
      'Omnisend-Version': version,
    },
  });
  const text = await response.text();
  let detail = '';
  try {
    const body = JSON.parse(text) as { detail?: string; title?: string };
    detail = body.detail || body.title || '';
  } catch {
    detail = text.slice(0, 120);
  }
  return { status: response.status, ok: response.ok, ms: Date.now() - started, detail };
}

console.log(`Omnisend-Version: ${version}`);
console.log(`Remitente configurado: ${env('OMNISEND_SENDER_EMAIL') ?? '(sin OMNISEND_SENDER_EMAIL)'}`);
console.log('');

// `/contacts` y `/campaigns` son los dos recursos que toca el envío real (upsertConsentedContact y
// createEmailCampaignDraft + sendEmailCampaignTest). `/segments` lo usa createTagSegment.
const resources = ['/contacts?limit=1', '/campaigns?limit=1', '/segments?limit=1'];
const results: Array<{ path: string } & Probe> = [];
for (const path of resources) {
  const result = await probe(path);
  results.push({ path, ...result });
  console.log(`GET ${path.padEnd(20)} -> ${String(result.status).padEnd(4)} (${result.ms}ms) ${result.detail}`);
}
console.log('');

if (results.some((result) => result.status === 401)) {
  console.error('FALLO: Omnisend no reconoce la llave (401). OMNISEND_API_KEY es inválida o fue revocada.');
  process.exit(1);
}

const forbidden = results.filter((result) => result.status === 403);
if (forbidden.length === results.length) {
  console.log('La llave es válida: Omnisend la reconoce (403, no 401) en los tres recursos.');
  console.log('Le faltan los scopes de LECTURA. Permisos que pide la API:');
  for (const result of forbidden) {
    const scope = /'([a-z.]+)'/.exec(result.detail)?.[1] ?? '(sin detalle)';
    console.log(`  - ${scope}`);
  }
  console.log('');
  console.log('Esto no bloquea el envío de campañas, que usa permisos de escritura, pero sí impide');
  console.log('leer estadísticas: getCampaignStatistics hace GET /campaigns/{id} y necesita');
  console.log('campaigns.read. Si /api/campaigns/{id}/stats devuelve error, la causa es esta.');
  process.exit(0);
}

if (results.every((result) => result.ok)) {
  console.log('OK: la llave de Omnisend es válida y tiene permisos de lectura en contactos, campañas y segmentos.');
  process.exit(0);
}

console.error('FALLO: respuesta inesperada de Omnisend. Revisa los códigos de arriba.');
process.exit(1);

// Este archivo no importa nada, y sin un `export` TypeScript no lo trata como módulo: el `await`
// de nivel superior daría ts(1375) en `astro check`.
export {};
