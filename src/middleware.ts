import { defineMiddleware } from 'astro:middleware';

const publicPrefixes = ['/registro', '/t/', '/api/public', '/api/health'];

export const onRequest = defineMiddleware(({ request }, next) => {
  const pathname = new URL(request.url).pathname;
  const accessKey = import.meta.env.ADMIN_ACCESS_KEY ?? process.env.ADMIN_ACCESS_KEY;

  if (!accessKey || publicPrefixes.some((prefix) => pathname.startsWith(prefix))) return next();

  const authorization = request.headers.get('authorization');
  const expected = `Basic ${btoa(`operator:${accessKey}`)}`;
  if (authorization === expected) return next();

  return new Response('Autenticación requerida', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Marketplace Control"' },
  });
});
