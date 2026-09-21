import { inferContactChannel } from '../src/lib/curation.ts';

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) { failed += 1; console.log(`  FALLA ${label}: ${actual}, esperado ${expected}`); }
}
const MOVIL = '+57 300 1112233';
const FIJO = '+57 605 3597067';
const canal = (email: string, phone: string, scale = 'Sin dato') =>
  inferContactChannel({ email, phone, scale } as never);

// El corporativo manda, tenga o no móvil.
check('corporativo con móvil', canal('contacto@negocio.com', MOVIL), 'email');
check('corporativo sin móvil', canal('contacto@negocio.com', FIJO), 'email');
check('corporativo sin teléfono', canal('contacto@negocio.com', 'Sin dato'), 'email');

// Sin corporativo, el móvil es el canal natural del proveedor pequeño.
check('gmail con móvil manda a WhatsApp', canal('negocio@gmail.com', MOVIL), 'whatsapp');
check('hotmail con móvil manda a WhatsApp', canal('negocio@hotmail.com', MOVIL), 'whatsapp');
check('sin correo con móvil', canal('Sin dato', MOVIL), 'whatsapp');

// Ni corporativo ni móvil: el correo gratuito es el único contacto que queda.
check('gmail sin móvil usa el correo', canal('negocio@gmail.com', FIJO), 'email');
check('gmail sin teléfono usa el correo', canal('negocio@gmail.com', 'Sin dato'), 'email');

// Sin nada que usar, queda WhatsApp y la validación lo rechazará por falta de móvil.
check('sin contacto', canal('Sin dato', 'Sin dato'), 'whatsapp');
check('sin contacto con fijo', canal('Sin dato', FIJO), 'whatsapp');

// Una empresa mediana o masiva va por correo aunque el suyo sea gratuito.
check('empresa mediana con gmail', canal('negocio@gmail.com', MOVIL, 'Mediano (50 a 200 pers.)'), 'email');
check('empresa masiva con gmail', canal('negocio@gmail.com', MOVIL, 'Masivo (Más de 200 pers.)'), 'email');

if (failed) { console.log(`contact channel tests: ${failed} fallos`); process.exit(1); }
console.log('contact channel tests passed');
