import { defineMiddleware } from 'astro:middleware';

const publicPrefixes = ['/registro', '/t/', '/api/public', '/api/health'];
const retiredMcpPrefixes = ['/mcp', '/oauth', '/.well-known/oauth-'];

export const onRequest = defineMiddleware(({ request }, next) => {
  const pathname = new URL(request.url).pathname;
  if (retiredMcpPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    return new Response('Not Found', { status: 404 });
  }
  const accessKey = import.meta.env.ADMIN_ACCESS_KEY ?? process.env.ADMIN_ACCESS_KEY;
  const localAutoLogin = import.meta.env.DEV
    && (import.meta.env.LOCAL_AUTO_LOGIN ?? process.env.LOCAL_AUTO_LOGIN) === 'true';

  if (publicPrefixes.some((prefix) => pathname.startsWith(prefix))) return next();
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
