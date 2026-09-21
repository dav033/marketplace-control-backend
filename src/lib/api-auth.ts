import { SERVICE_TOKEN_HEADER } from './contract';

// `import.meta.env?` con encadenamiento opcional, igual que en `db.ts`: fuera de Astro ese objeto no
// existe, y sin el `?` este módulo no se podría ni cargar desde una prueba de Node.
const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

/**
 * Autenticación de servicio para `/api/v1/*`.
 *
 * Estos endpoints no los llama un humano con navegador, sino el frontend desde su propio servidor,
 * así que no usan el Basic Auth del panel: usan un token compartido en una cabecera. La diferencia
 * importa cuando el front vive en Vercel y el back en EC2, porque el Basic del operador no viaja en
 * esa llamada máquina-a-máquina.
 *
 * Sin `BACKEND_SERVICE_TOKEN` configurado solo se permite en desarrollo. En producción se responde
 * 503 en vez de abrir: un backend público sin token sería una filtración de la base entera.
 */
export function assertServiceAuth(request: Request): Response | null {
  const expected = env('BACKEND_SERVICE_TOKEN');

  if (!expected) {
    if (import.meta.env?.DEV) return null;
    return json({ ok: false, error: 'BACKEND_SERVICE_TOKEN_NOT_CONFIGURED' }, 503);
  }

  const provided = request.headers.get(SERVICE_TOKEN_HEADER);
  if (!provided || !timingSafeEqual(provided, expected)) {
    return json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  }
  return null;
}

/** Comparación de longitud constante: evita filtrar el token por diferencia de tiempos. */
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // La respuesta lleva datos de operación: ningún intermediario debe guardarla.
      'cache-control': 'no-store',
    },
  });
}
