const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

/**
 * Cosecha de candidatos directamente desde Google Places.
 *
 * Invierte el orden del descubrimiento. El pipeline original pedía al agente que encontrara nombres
 * en la web abierta y después intentaba encontrarles reputación; medido en producción, eso dejaba el
 * 80 % de las filas en "Sin dato" porque muchos proveedores reales no tienen ficha de Google y los
 * portales de bodas colombianos cerraron (ver nota en `curation.ts`). Preguntarle a Places por la
 * categoría en la ciudad devuelve negocios que por construcción YA traen calificación, número de
 * reseñas, teléfono y sitio web en la misma respuesta.
 *
 * Incluye por igual personas jurídicas y naturales: Places lista al fotógrafo independiente con su
 * propio nombre igual que al estudio constituido, y para la curaduría ambos son válidos.
 */

export type HarvestedPlace = {
  placeId: string;
  name: string;
  rating?: number;
  reviews?: number;
  phone?: string;
  website?: string;
  /** Ficha en Google Maps. Sirve de Fuente URL directa cuando el negocio no tiene web propia. */
  mapsUrl?: string;
  address?: string;
  /** Rótulo de tipo que asigna Google ("Fotógrafo", "Servicio de banquetes"). Útil para filtrar. */
  type?: string;
};

export type HarvestResult = {
  city: string;
  category: string;
  /** Todos los negocios operativos y distintos que devolvieron las consultas. */
  candidates: HarvestedPlace[];
  /** Subconjunto que ya cumple el umbral de candidato listo. */
  ready: HarvestedPlace[];
  apiCalls: number;
  durationMs: number;
  queriesUsed: string[];
};

/**
 * Consultas por categoría. `{city}` se sustituye por la ciudad. Son consultas de SERVICIO, no de
 * nombre: es lo que hace que Places devuelva un listado del rubro en vez de intentar adivinar un
 * negocio concreto.
 */
const CATEGORY_QUERIES: Record<string, string[]> = {
  'Lugar': [
    'salón de eventos en {city}',
    'centro de convenciones {city}',
    'finca para eventos {city}',
    'hotel para eventos y bodas {city}',
  ],
  'Comida y Bebida': [
    'servicio de catering en {city}',
    'banquetes para eventos {city}',
    'restaurante para eventos {city}',
    'repostería y tortas para eventos {city}',
  ],
  'Música': [
    'grupo musical para eventos {city}',
    'DJ para bodas y eventos {city}',
    'orquesta para matrimonios {city}',
    'alquiler de sonido para eventos {city}',
  ],
  'Servicios Especializados': [
    'organizador de eventos {city}',
    'wedding planner {city}',
    'producción y logística de eventos {city}',
    'alquiler de luces y sonido para eventos {city}',
  ],
  'Entretenimiento': [
    'animación de fiestas {city}',
    'hora loca y show para eventos {city}',
    'entretenimiento para eventos {city}',
    'recreación y animadores infantiles {city}',
  ],
  'Decoración temática': [
    'decoración de eventos {city}',
    'decoración de fiestas infantiles {city}',
    'globos y decoración {city}',
    'ambientación de bodas {city}',
  ],
  'Fotografía y Video': [
    'fotógrafo de bodas en {city}',
    'fotografía de eventos {city}',
    'estudio fotográfico {city}',
    'video para eventos {city}',
  ],
  'Invitación digital': [
    'invitaciones de boda {city}',
    'tarjetas de invitación {city}',
    'diseño gráfico de invitaciones {city}',
    'papelería para eventos {city}',
  ],
  'Menaje y mantelería': [
    'alquiler de mantelería {city}',
    'alquiler de menaje para eventos {city}',
    'alquiler de vajilla y cristalería {city}',
    'lencería para eventos {city}',
  ],
  'Carpas y mobiliario': [
    'alquiler de carpas {city}',
    'alquiler de sillas y mesas {city}',
    'mobiliario para eventos {city}',
    'alquiler de toldos y tarimas {city}',
  ],
};

export function isGooglePlacesConfiguredForHarvest(): boolean {
  return Boolean(env('GOOGLE_PLACES_API_KEY'));
}

export function hasHarvestQueries(category: string): boolean {
  return Boolean(CATEGORY_QUERIES[category]);
}

/**
 * Tipos de Google que nunca son un proveedor de eventos, por mucho que salgan en la consulta. Las
 * consultas por servicio arrastran comercio adyacente: buscar "invitaciones" devuelve centros
 * comerciales y papelerías de barrio; "mantelería" devuelve tiendas de ropa. El tipo genérico
 * `service` no sirve para filtrar porque cubre también a los proveedores buenos, así que esto es
 * una lista de exclusión, no de admisión.
 */
const EXCLUDED_PRIMARY_TYPES = new Set([
  'shopping_mall', 'supermarket', 'department_store', 'clothing_store', 'womens_clothing_store',
  'mens_clothing_store', 'shoe_store', 'electronics_store', 'amusement_park', 'amusement_center',
  'indoor_playground', 'spa', 'beauty_salon', 'hair_salon', 'gym', 'bank', 'atm', 'hospital',
  'pharmacy', 'school', 'university', 'church', 'gas_station', 'car_repair', 'real_estate_agency',
  'corporate_office', 'government_office', 'tourist_attraction', 'museum', 'park',
]);

const FIELD_MASK = [
  'places.id',
  'places.primaryType',
  'places.displayName',
  'places.rating',
  'places.userRatingCount',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.formattedAddress',
  'places.primaryTypeDisplayName',
  'places.businessStatus',
  'nextPageToken',
].join(',');

type RawPlace = {
  id?: string;
  primaryType?: string;
  displayName?: { text?: string };
  rating?: number;
  userRatingCount?: number;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  formattedAddress?: string;
  primaryTypeDisplayName?: { text?: string };
  businessStatus?: string;
};

async function searchPage(textQuery: string, pageToken?: string): Promise<{ places: RawPlace[]; nextPageToken?: string } | undefined> {
  const apiKey = env('GOOGLE_PLACES_API_KEY');
  if (!apiKey) return undefined;
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(pageToken ? { textQuery, languageCode: 'es', pageToken } : { textQuery, languageCode: 'es' }),
  });
  if (!response.ok) {
    console.error('Places harvest failed', response.status, (await response.text().catch(() => '')).slice(0, 300));
    return undefined;
  }
  const body = await response.json() as { places?: RawPlace[]; nextPageToken?: string };
  return { places: body.places ?? [], nextPageToken: body.nextPageToken };
}

function toHarvested(place: RawPlace): HarvestedPlace | undefined {
  const name = place.displayName?.text?.trim();
  if (!place.id || !name) return undefined;
  return {
    placeId: place.id,
    name,
    rating: typeof place.rating === 'number' ? place.rating : undefined,
    reviews: typeof place.userRatingCount === 'number' ? place.userRatingCount : undefined,
    phone: place.nationalPhoneNumber?.trim() || undefined,
    website: place.websiteUri?.trim() || undefined,
    mapsUrl: place.googleMapsUri?.trim() || undefined,
    address: place.formattedAddress?.trim() || undefined,
    type: place.primaryTypeDisplayName?.text?.trim() || undefined,
  };
}

/** Umbral de "candidato listo" de la curaduría: calificación 4.5+ y 30 reseñas o más. */
export function meetsReadyThreshold(place: HarvestedPlace): boolean {
  return typeof place.rating === 'number' && place.rating >= 4.5
    && typeof place.reviews === 'number' && place.reviews >= 30;
}

export function isContactable(place: HarvestedPlace): boolean {
  return Boolean(place.phone || place.website);
}

export async function harvestCategoryCandidates(
  city: string,
  category: string,
  options: { pagesPerQuery?: number } = {},
): Promise<HarvestResult> {
  const startedAt = Date.now();
  const templates = CATEGORY_QUERIES[category] ?? [];
  // Una sola página por consulta, a propósito. Places ordena por relevancia y agota lo pertinente
  // en la primera: la segunda se rellena con coincidencias cada vez más flojas y es de donde salían
  // los centros comerciales en "Invitación digital", los escape rooms en "Entretenimiento" y un sex
  // shop en "Menaje". Medido sobre las 8 categorías problemáticas: con una página, las 12 primeras
  // de cada una son del rubro correcto. Más volumen por esta vía cuesta precisión, no la mejora.
  const pagesPerQuery = Math.max(1, options.pagesPerQuery ?? 1);
  const byPlaceId = new Map<string, HarvestedPlace>();
  const queriesUsed: string[] = [];
  let apiCalls = 0;

  for (const template of templates) {
    const query = template.replaceAll('{city}', city);
    queriesUsed.push(query);
    let pageToken: string | undefined;
    for (let page = 0; page < pagesPerQuery; page += 1) {
      const result = await searchPage(query, pageToken);
      apiCalls += 1;
      if (!result) break;
      for (const raw of result.places) {
        // Un negocio cerrado permanentemente no sirve como proveedor, aunque conserve sus reseñas.
        if (raw.businessStatus && raw.businessStatus !== 'OPERATIONAL') continue;
        if (raw.primaryType && EXCLUDED_PRIMARY_TYPES.has(raw.primaryType)) continue;
        const harvested = toHarvested(raw);
        // Se deduplica por placeId, no por nombre: dos sucursales comparten rótulo pero son fichas
        // distintas, y el mismo negocio aparece en varias consultas del mismo rubro.
        if (harvested && !byPlaceId.has(harvested.placeId)) byPlaceId.set(harvested.placeId, harvested);
      }
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
  }

  // Se conserva el orden en que Places devolvió los resultados, que es su ranking de RELEVANCIA.
  // Ordenar por número de reseñas parece razonable y es un error: asciende a los negocios más
  // grandes que apenas rozan la consulta — centros comerciales, parques de ocio — por encima del
  // proveedor pequeño y pertinente. Medido: al ordenar por reseñas, los 5 primeros "listos" de
  // "Invitación digital" eran cuatro centros comerciales y una panadería.
  const candidates = [...byPlaceId.values()];
  return {
    city,
    category,
    candidates,
    ready: candidates.filter(meetsReadyThreshold),
    apiCalls,
    durationMs: Date.now() - startedAt,
    queriesUsed,
  };
}

/**
 * Formatea la cosecha para inyectarla en el prompt del agente. El agente deja de descubrir y pasa a
 * verificar: confirma que el negocio sirve eventos y completa correo e Instagram, partiendo de datos
 * de reputación que ya vienen de la API y que por tanto no debe inventar ni volver a buscar.
 */
export function formatHarvestForPrompt(result: HarvestResult, limit = 25): string {
  const rows = result.candidates.filter(isContactable).slice(0, limit);
  if (!rows.length) return '';
  const lines = rows.map(place => {
    const reputation = typeof place.rating === 'number' && typeof place.reviews === 'number'
      ? `${place.rating.toFixed(1)} con ${place.reviews} reseñas en Google`
      : 'sin reputación pública en Google';
    const contact = [place.phone ? `tel ${place.phone}` : '', place.website ? `web ${place.website}` : '']
      .filter(Boolean).join(' · ');
    return `- ${place.name}${place.type ? ` (${place.type})` : ''} — ${reputation} — ${contact}`;
  });
  return lines.join('\n');
}
