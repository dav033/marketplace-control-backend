import { isPlausibleEmail } from '../src/lib/contact-scrape.ts';

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) { failed += 1; console.log(`  FALLA ${label}: ${actual}, esperado ${expected}`); }
}

// Correos reales que deben pasar.
check('corporativo', isPlausibleEmail('eventos@lastrinitarias.com'), true);
check('gmail', isPlausibleEmail('c.ancestral.col@gmail.com'), true);
check('con signo más', isPlausibleEmail('contacto+eventos@negocio.co'), true);

// Nombres de fichero que cumplen el patrón de correo. El caso que motivó el filtro.
check('recurso @2x', isPlausibleEmail('logo@2x.png'), false);
check('recurso @3x', isPlausibleEmail('icono@3x'), false);
check('hoja de estilo', isPlausibleEmail('sprite@media.css'), false);
check('tipografía', isPlausibleEmail('fuente@bold.woff2'), false);

// Marcadores de plantilla que dejan los sitios a medio configurar.
check('tu@dominio', isPlausibleEmail('tu@dominio.com'), false);
check('your@email', isPlausibleEmail('your@email.com'), false);
check('noreply', isPlausibleEmail('noreply@negocio.com'), false);
check('ejemplo', isPlausibleEmail('ejemplo@negocio.com'), false);

// Infraestructura de terceros que aparece incrustada en la página.
check('sentry', isPlausibleEmail('abc@sentry.io.ingest'), false);
check('wixpress', isPlausibleEmail('soporte@wixpress.com'), false);

// Formas inválidas.
check('sin arroba', isPlausibleEmail('negocio.com'), false);
check('sin dominio', isPlausibleEmail('hola@'), false);
check('dominio sin punto', isPlausibleEmail('hola@localhost'), false);
check('demasiado corto', isPlausibleEmail('a@b.c'), false);

if (failed) { console.log(`contact scrape tests: ${failed} fallos`); process.exit(1); }
console.log('contact scrape tests passed');
