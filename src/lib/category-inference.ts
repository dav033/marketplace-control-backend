import { OFFICIAL_CATEGORIES } from './registration-fields';

/**
 * Deduce las categorías oficiales de un negocio a partir de su nombre y de cómo lo clasifica Google.
 *
 * Nace de un agujero real: los proveedores cosechados de Google Places entraban todos con una sola
 * categoría —la de la búsqueda— y con "Sin dato" en las adicionales, así que "Casa de Eventos
 * Barcelona Plaza (Alquiler de mobiliario y menaje para eventos)" quedaba solo en "Comida y Bebida".
 * El TSV de curaduría sí trae esa columna; esto la rellena cuando viene de la cosecha.
 *
 * Es una ayuda, no un veredicto: propone categorías evidentes por el texto y una persona las corrige
 * en la ficha. Por eso los términos son concretos ("menaje", "carpas") y no generales ("eventos"),
 * que valdrían para todos.
 */

// Fuera por falsos positivos vistos en nombres reales: "quinta" y "terraza" (Banquetes La Quinta,
// Restaurante Bar La Terraza), "flores" y "coro" (apellidos), "show" suelto (Takuma Cocina Show, un
// teppanyaki) y "sonido" suelto (alquilar sonido es producción, no un grupo musical).
const KEYWORDS: Record<string, string[]> = {
  'Lugar': [
    'salon de eventos', 'salon de recepciones', 'centro de convenciones', 'casa de eventos',
    'finca', 'hacienda', 'quinta de eventos', 'hotel', 'club campestre', 'terraza de eventos',
    'salon social', 'venue',
  ],
  'Comida y Bebida': [
    'catering', 'banquete', 'banquetes', 'restaurante', 'buffet', 'bufet', 'cocteleria', 'coctel',
    'gastronomia', 'chef', 'heladeria', 'pizzeria', 'asadero', 'parrilla', 'sushi', 'cafeteria',
    'comida', 'bebidas', 'bar',
  ],
  'Música': [
    'dj', 'orquesta', 'banda', 'grupo musical', 'mariachi', 'mariachis', 'musica', 'musical',
    'vallenato', 'papayera', 'saxofonista', 'violinista', 'serenata',
  ],
  'Servicios Especializados': [
    'wedding planner', 'organizador de eventos', 'organizacion de eventos', 'planeacion de eventos',
    'produccion de eventos', 'logistica', 'protocolo', 'coordinacion de eventos', 'meseros',
    'luces y sonido', 'sonido e iluminacion',
  ],
  'Entretenimiento': [
    'show infantil', 'shows infantiles', 'show de magia', 'show en vivo', 'shows en vivo',
    'animacion', 'recreacion', 'recreacionista', 'payaso', 'payasos', 'hora loca', 'zanqueros',
    'mago', 'magos', 'karaoke', 'inflables', 'circo', 'comediante', 'fiesta infantil',
  ],
  'Decoración temática': [
    'decoracion', 'decoraciones', 'globos', 'floristeria', 'floral', 'arreglos florales',
    'flores para eventos', 'ambientacion', 'escenografia',
  ],
  'Fotografía y Video': [
    'fotografia', 'fotografo', 'foto', 'fotos', 'video', 'videos', 'audiovisual', 'filmacion',
    'cabina de fotos', 'photobooth', 'dron',
  ],
  'Invitación digital': ['invitacion', 'invitaciones', 'tarjeteria', 'papeleria'],
  'Menaje y mantelería': [
    'menaje', 'manteleria', 'mantel', 'manteles', 'vajilla', 'cristaleria', 'cuberteria', 'lenceria',
  ],
  'Carpas y mobiliario': [
    'carpa', 'carpas', 'toldo', 'toldos', 'mobiliario', 'alquiler de sillas', 'alquiler de mesas',
    'sillas', 'mesas', 'tarima', 'tarimas', 'pista de baile',
  ],
  'Repostería y pastelería': [
    'reposteria', 'pasteleria', 'panaderia', 'torta', 'tortas', 'ponque', 'ponques', 'pastel',
    'pasteles', 'cupcake', 'cupcakes', 'postre', 'postres', 'brownie', 'brownies', 'cheesecake',
    'galletas', 'macarons', 'mesa de dulces', 'mesa de postres', 'dulces', 'cake', 'cakes', 'bakery',
  ],
};

function fold(value: string) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Compara por palabra completa: "bar" no puede saltar dentro de "Barranquilla", ni "foto" dentro de
 * un apellido. Las expresiones de varias palabras se buscan igual, pero como frase.
 */
function mentions(text: string, keyword: string) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(text);
}

/** Todas las categorías oficiales que el texto sugiere, en el orden oficial. */
export function inferCategories(text: string): string[] {
  const folded = fold(text);
  return Object.entries(KEYWORDS)
    .filter(([, keywords]) => keywords.some((keyword) => mentions(folded, keyword)))
    .map(([category]) => category)
    .filter((category) => OFFICIAL_CATEGORIES.has(category));
}

/**
 * Las adicionales para una ficha: lo que sugieren el nombre y el tipo de Google, sin la principal.
 *
 * `max` deja sitio para la principal dentro del tope de 5 categorías del formulario.
 */
export function inferAdditionalCategories(
  input: { name: string; type?: string | null; notes?: string | null },
  primaryCategory: string,
  max = 4,
): string[] {
  const texto = [input.name, input.type ?? '', input.notes ?? ''].join(' · ');
  return inferCategories(texto).filter((category) => category !== primaryCategory).slice(0, max);
}
