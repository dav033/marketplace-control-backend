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

// --- Calificación autodeclarada en JSON-LD -----------------------------------------------------
{
  const { extractSelfDeclaredRating } = await import('../src/lib/contact-scrape.ts');
  const { appendSelfDeclaredRatingHint } = await import('../src/lib/gemini.ts');
  const html = `<html><head><script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Restaurant","name":"Casa Tabor",
   "aggregateRating":{"@type":"AggregateRating","ratingValue":"4,7","reviewCount":"85"}}
  </script></head><body></body></html>`;
  const declared = extractSelfDeclaredRating(html);
  if (!declared || declared.rating !== 4.7 || declared.reviews !== 85) { console.log('  FALLA JSON-LD básico', declared); process.exit(1); }
  // Escala sobre 10 se lleva a 0-5; un bloque roto no invalida al siguiente; sin conteo no vale.
  const escalado = extractSelfDeclaredRating(`<script type="application/ld+json">{no es json}</script><script type="application/ld+json">{"@graph":[{"@type":"Hotel","aggregateRating":{"ratingValue":8.4,"bestRating":10,"ratingCount":200}}]}</script>`);
  if (!escalado || escalado.rating !== 4.2 || escalado.reviews !== 200) { console.log('  FALLA JSON-LD escalado', escalado); process.exit(1); }
  if (extractSelfDeclaredRating(`<script type="application/ld+json">{"aggregateRating":{"ratingValue":4.9}}</script>`) !== undefined) { console.log('  FALLA JSON-LD sin conteo'); process.exit(1); }
  if (extractSelfDeclaredRating('<html><body>sin datos</body></html>') !== undefined) { console.log('  FALLA JSON-LD ausente'); process.exit(1); }
  // La pista va a la justificación y no toca las celdas de calificación: la fila sigue en revisión.
  const hint = appendSelfDeclaredRatingHint('Confirma catering. No se pudo encontrar calificación pública tras una búsqueda dedicada.', { rating: 4.7, reviews: 85, foundAt: 'https://casatabor.com/' });
  if (!hint.includes('Pista sin verificar') || !hint.includes('4.7') || !hint.includes('85') || !hint.startsWith('Confirma catering.')) { console.log('  FALLA pista', hint); process.exit(1); }
  console.log('contact scrape self-declared rating tests passed');
}
