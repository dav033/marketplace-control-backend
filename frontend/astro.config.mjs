import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// El panel, desplegado aparte del backend. No lleva adaptador de Node ni acceso a PostgreSQL: todo
// lo que necesita lo pide por HTTP a la API que corre en AWS.
export default defineConfig({
  output: 'server',
  adapter: vercel(),
  server: { host: true, port: 4322 },
});
