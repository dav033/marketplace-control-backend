// Prueba del portero de `/api/v1/*`. Importa el módulo real, no una copia: si la comparación del
// token cambia, esta prueba tiene que enterarse.
import assert from 'node:assert/strict';
import { SERVICE_TOKEN_HEADER } from '../src/lib/contract.ts';
import { assertServiceAuth } from '../src/lib/api-auth.ts';

const request = (headers: Record<string, string> = {}) => new Request('https://back/api/v1/dashboard', { headers });

// Sin token configurado y fuera de desarrollo (en Node no hay `import.meta.env.DEV`), el backend se
// cierra en vez de abrirse: un backend público sin token expondría la base entera.
delete process.env.BACKEND_SERVICE_TOKEN;
const unconfigured = assertServiceAuth(request());
assert.equal(unconfigured?.status, 503, 'sin token configurado debe responder 503');

process.env.BACKEND_SERVICE_TOKEN = 'token-de-servicio-correcto';

assert.equal(assertServiceAuth(request())?.status, 401, 'sin cabecera debe rechazar');
assert.equal(assertServiceAuth(request({ [SERVICE_TOKEN_HEADER]: 'otro' }))?.status, 401, 'token distinto debe rechazar');
assert.equal(
  assertServiceAuth(request({ [SERVICE_TOKEN_HEADER]: 'token-de-servicio-correct' }))?.status,
  401,
  'un prefijo del token no debe pasar',
);
assert.equal(assertServiceAuth(request({ [SERVICE_TOKEN_HEADER]: 'token-de-servicio-correcto' })), null, 'el token correcto debe pasar');

console.log('api auth tests passed');
