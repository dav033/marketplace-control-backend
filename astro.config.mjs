import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  server: { host: true, port: 4321 },
  // La protección CSRF de Astro compara el header Origin contra el propio host, pensada para un
  // sitio que sirve su UI y su API desde el mismo dominio con sesión por cookie. Aquí ninguna ruta
  // usa cookies: /api/v1/* exige `x-service-token`, el panel usa Basic Auth, y el webhook de
  // WhatsApp valida la firma HMAC del cuerpo. Con el frontend en otro dominio (Vercel) reenviando
  // por su propio proxy, el Origin que llega aquí es el del frontend, nunca el del backend, así que
  // la comprobación por defecto bloqueaba todo DELETE/POST que cruzara el proxy — se vio primero con
  // el borrado de proveedores, pero afectaba igual al envío del formulario público.
  security: { checkOrigin: false },
});
