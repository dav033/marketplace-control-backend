import { defineMiddleware } from 'astro:middleware';
import { hasValidServiceToken } from './lib/api-auth';

// El webhook de WhatsApp lo llama Meta, no un operador: con Basic Auth delante, la verificación
// recibiría 401 y Meta nunca guardaría la URL. Lo que lo protege es la firma HMAC del cuerpo,
// comprobada en el propio endpoint. Se abre SOLO esa ruta: antes el prefijo era `/api/whatsapp` y
// dejaba pública también `/api/whatsapp/outreach`, que manda mensajes reales.
const publicPrefixes = ['/registro', '/t/', '/api/public', '/api/health'];
const publicExactPaths = ['/api/whatsapp/webhook'];

// `/api/v1` es la API que consume el frontend desde su propio servidor. No lleva Basic Auth porque
// no la pide un navegador con credenciales de operador: se autentica con el token de servicio que
// comprueba cada endpoint (`assertServiceAuth`). Dejarla dentro del Basic la rompería en cuanto el
// front viva en otro dominio.
const servicePrefixes = ['/api/v1'];
const retiredMcpPrefixes = ['/mcp', '/oauth', '/.well-known/oauth-'];

export const onRequest = defineMiddleware(({ request }, next) => {
  const pathname = new URL(request.url).pathname;
  if (retiredMcpPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    return new Response('Not Found', { status: 404 });
  }
  const accessKey = import.meta.env.ADMIN_ACCESS_KEY ?? process.env.ADMIN_ACCESS_KEY;
  const localAutoLogin = import.meta.env.DEV
    && (import.meta.env.LOCAL_AUTO_LOGIN ?? process.env.LOCAL_AUTO_LOGIN) === 'true';

  if (servicePrefixes.some((prefix) => pathname.startsWith(prefix))) return next();

  // El panel llama a estas rutas a través de su propio servidor, que ya comprobó la sesión del
  // operador y añade el token de servicio. Antes solo valía el Basic Auth, y eso obligaba al
  // navegador a pedir usuario y contraseña aparte del login del panel.
  if (hasValidServiceToken(request)) return next();
  if (publicPrefixes.some((prefix) => pathname.startsWith(prefix))) return next();
  if (publicExactPaths.includes(pathname.replace(/\/+$/, ''))) return next();
  if (localAutoLogin) return next();
  if (!accessKey) return new Response('Administración no configurada', { status: 503 });

  const authorization = request.headers.get('authorization');
  const expected = `Basic ${btoa(`operator:${accessKey}`)}`;
  if (authorization === expected) return next();

  return new Response('Autenticación requerida', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Marketplace Control"' },
  });
});
