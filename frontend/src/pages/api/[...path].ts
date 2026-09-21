import type { APIRoute } from 'astro';
import { SERVICE_TOKEN_HEADER } from '../../lib/contract';

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

/**
 * Puente entre el navegador y el backend.
 *
 * EL PROBLEMA QUE RESUELVE: los scripts de las páginas llaman a `/api/ai/curation`,
 * `/api/campaigns`, `/api/chat/test`… como rutas del mismo origen. Con el panel en Vercel esas
 * rutas ya no existen ahí. Las dos salidas obvias son malas:
 *
 * - Llamar al backend directamente desde el navegador obliga a CORS y, peor, a que el token de
 *   servicio viaje en el JavaScript de la página, donde lo ve cualquiera.
 * - Reescribir cada fetch para apuntar a otro dominio reparte la configuración por media docena de
 *   archivos y deja el token igual de expuesto.
 *
 * Así que el navegador sigue hablando con su propio origen y es el servidor del frontend quien
 * reenvía, añadiendo el token del lado donde no se ve. Ningún `fetch` de las páginas cambia.
 */

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization',
  'proxy-authenticate', 'te', 'trailer', 'host', 'content-length',
]);

function backendBase(): string | undefined {
  const configured = env('BACKEND_URL');
  return configured ? configured.replace(/\/$/, '') : undefined;
}

const proxy: APIRoute = async ({ request, params, url }) => {
  const base = backendBase();
  if (!base) {
    // Sin backend configurado no hay nada que reenviar, y decirlo claro ahorra media hora de
    // depuración frente a un 404 silencioso.
    return new Response(JSON.stringify({ ok: false, error: 'BACKEND_URL_NOT_CONFIGURED' }), {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const ruta = params.path ?? '';
  const destino = `${base}/api/${ruta}${url.search}`;

  const cabeceras = new Headers();
  request.headers.forEach((valor, nombre) => {
    if (!HOP_BY_HOP.has(nombre.toLowerCase())) cabeceras.set(nombre, valor);
  });

  // El token se añade AQUÍ, en el servidor del frontend. Nunca sale al navegador.
  const token = env('BACKEND_SERVICE_TOKEN');
  if (token) cabeceras.set(SERVICE_TOKEN_HEADER, token);

  const tieneCuerpo = request.method !== 'GET' && request.method !== 'HEAD';

  let respuesta: Response;
  try {
    respuesta = await fetch(destino, {
      method: request.method,
      headers: cabeceras,
      body: tieneCuerpo ? await request.arrayBuffer() : undefined,
      // `manual` conserva el 303 del formulario público en vez de seguirlo aquí: quien tiene que
      // ir a la página de "gracias" es el navegador, no este servidor.
      redirect: 'manual',
    });
  } catch (error) {
    console.error('proxy al backend falló', destino, error instanceof Error ? error.message : error);
    return new Response(JSON.stringify({ ok: false, error: 'BACKEND_UNREACHABLE' }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const salida = new Headers();
  respuesta.headers.forEach((valor, nombre) => {
    if (!HOP_BY_HOP.has(nombre.toLowerCase())) salida.set(nombre, valor);
  });

  return new Response(respuesta.body, { status: respuesta.status, headers: salida });
};

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
