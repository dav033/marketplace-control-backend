import { isGooglePlacesEnabled, placesTextSearch } from './places-gate';

/**
 * "Configurada" significa "se puede usar ahora": clave presente, opt-in explícito, sin interruptor
 * de emergencia y con presupuesto. La clave sola no basta (ver `places-gate.ts`).
 */
export function isGooglePlacesConfigured(): boolean {
  return isGooglePlacesEnabled();
}

export type GooglePlaceReputation = { rating: string; reviews: string; platform: 'Google'; matchedBy: 'phone' | 'website' | 'name' };

const GENERIC_NAME_WORDS = new Set(['sas', 'sa', 'ltda', 'eu', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'the']);
/** Sufijos societarios: ruido para emparejar, porque Google rara vez los incluye en el rótulo. */
const LEGAL_SUFFIX = /\b(s\s?a\s?s|s\s?a|ltda|e\s?u|sociedad\s+por\s+acciones\s+simplificada)\b\.?/gi;

/** "QuieroMusicos" -> "Quiero Musicos": el agente escribe nombres pegados que Google separa. */
function splitCamelCase(value: string): string {
  return value.replace(/([a-záéíóúñ])([A-ZÁÉÍÓÚÑ])/g, '$1 $2');
}

function normalizeForMatch(value: string): string {
  return splitCamelCase(value)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantTokens(name: string): string[] {
  return normalizeForMatch(name).split(' ').filter(token => token.length > 2 && !GENERIC_NAME_WORDS.has(token));
}

/** Tolerancia singular/plural: "Producciones" y "Produccion" son el mismo negocio. */
function stem(token: string): string {
  const stemmed = token.replace(/(es|s)$/, '');
  return stemmed.length >= 4 ? stemmed : token;
}

function containsToken(candidateNormalized: string, token: string): boolean {
  if (candidateNormalized.includes(token)) return true;
  const stemmed = stem(token);
  return stemmed !== token && candidateNormalized.includes(stemmed);
}

/**
 * Google a veces rotula el negocio con el nombre pegado, típicamente cuando la ficha nació de un
 * usuario de Instagram: "Casa de Banquetes Marlloly" aparece como "@banquetesmarlloly". Acepta
 * cuando dos palabras distintivas CONSECUTIVAS del nombre buscado aparecen concatenadas en el
 * rótulo. Exigir dos consecutivas es lo que impide que esto degenere en coincidencia por una
 * palabra suelta.
 */
function matchesAsConcatenation(searchTokens: string[], candidateNormalized: string): boolean {
  // Se compara contra cada palabra del rótulo por separado, nunca contra el rótulo entero sin
  // espacios: eso último daría por concatenado cualquier par de palabras contiguas y bastaría
  // "Event Planner" para emparejar dos negocios sin relación.
  const candidateTokens = candidateNormalized.split(' ').filter(Boolean);
  for (let index = 0; index < searchTokens.length - 1; index += 1) {
    const first = searchTokens[index];
    const second = searchTokens[index + 1];
    if (first.length < 5 || second.length < 5) continue;
    const glued = `${first}${second}`;
    if (candidateTokens.some(token => token.includes(glued))) return true;
  }
  return false;
}

/**
 * Text Search es una búsqueda difusa: el primer resultado puede ser un negocio totalmente distinto
 * que solo comparte una palabra con la consulta (confirmado en producción — "Casa Monaco" en
 * Barranquilla devolvía "Mónaco Lounge Bar" como primer resultado). Exige que TODAS las palabras
 * significativas del nombre buscado aparezcan en el nombre del resultado, con dos relajaciones
 * acotadas: tolerancia singular/plural y rótulos concatenados.
 */
export function nameMatches(searchName: string, candidateName: string): boolean {
  const searchTokens = significantTokens(searchName);
  if (!searchTokens.length) return false;
  const candidateNormalized = normalizeForMatch(candidateName);
  if (searchTokens.every(token => containsToken(candidateNormalized, token))) return true;
  return matchesAsConcatenation(searchTokens, candidateNormalized);
}

/** La misma búsqueda difusa mezcla ciudades: exige que la ciudad buscada aparezca en la dirección. */
export function cityMatches(city: string, address: string): boolean {
  return normalizeForMatch(address).includes(normalizeForMatch(city));
}

/**
 * Colombia: 10 dígitos (celular 3XXXXXXXXX o fijo con indicativo) se envían como +57XXXXXXXXXX.
 * Devuelve undefined si no queda un número plausible, para no gastar una búsqueda en basura.
 */
export function toE164Colombia(rawPhone: string): string | undefined {
  const trimmed = rawPhone.trim();
  if (!trimmed || /^sin\s+dato$/i.test(trimmed)) return undefined;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+57${digits}`;
  if (digits.length === 12 && digits.startsWith('57')) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith('057')) return `+${digits.slice(1)}`;
  return undefined;
}

const SOCIAL_HOSTS = new Set([
  'instagram.com', 'facebook.com', 'm.facebook.com', 'fb.com', 'fb.me',
  'wa.me', 'api.whatsapp.com', 'whatsapp.com', 'linktr.ee', 'linktree.com',
  'tiktok.com', 'twitter.com', 'x.com', 'youtube.com', 'youtu.be',
  'maps.google.com', 'goo.gl', 'maps.app.goo.gl', 'g.page', 'bit.ly',
]);

export function toDomain(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed || /^sin\s+dato$/i.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    const host = url.host.replace(/^www\./, '').toLowerCase();
    // Un perfil de red social no identifica al negocio en Places: el dominio sería instagram.com.
    if (SOCIAL_HOSTS.has(host)) return undefined;
    return host.includes('.') ? host : undefined;
  } catch {
    return undefined;
  }
}

type PlaceResult = {
  rating?: number;
  userRatingCount?: number;
  formattedAddress?: string;
  websiteUri?: string;
  displayName?: { text?: string };
};

const FIELD_MASK = 'places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.websiteUri';

async function searchText(textQuery: string): Promise<PlaceResult[] | undefined> {
  const outcome = await placesTextSearch({ textQuery, languageCode: 'es' }, FIELD_MASK, { purpose: 'reputation_lookup' });
  if (outcome.status !== 'ok') return undefined;
  const body = outcome.body as { places?: PlaceResult[] };
  return body.places ?? [];
}

function hasReputation(place: PlaceResult): boolean {
  return typeof place.rating === 'number'
    && typeof place.userRatingCount === 'number'
    && place.userRatingCount > 0;
}

function toReputation(place: PlaceResult, matchedBy: GooglePlaceReputation['matchedBy']): GooglePlaceReputation {
  return { rating: place.rating!.toFixed(1), reviews: String(place.userRatingCount), platform: 'Google', matchedBy };
}

/**
 * Google Places API (New), Text Search. A diferencia de la búsqueda web genérica, esta API oficial
 * devuelve `rating`/`userRatingCount` como datos estructurados directamente desde Google. Resuelve un
 * límite real y verificado: Google Maps renderiza su calificación con JavaScript y no la expone como
 * texto rastreable por búsqueda web — ni una búsqueda genérica ni un fetch directo a la página de
 * Maps la muestran, aunque exista y sea visible para una persona en el navegador.
 *
 * Busca en cascada por identidad decreciente: teléfono (identifica el negocio sin ambigüedad),
 * dominio propio, y por último nombre + ciudad, que es la vía difusa y por eso la más exigente.
 */
export async function lookupGooglePlaceReputation(
  name: string,
  city: string,
  options: { phone?: string; websiteUrl?: string } = {},
): Promise<GooglePlaceReputation | undefined> {
  if (!isGooglePlacesEnabled()) return undefined;
  try {
    const phone = options.phone ? toE164Colombia(options.phone) : undefined;
    if (phone) {
      const places = await searchText(phone);
      // El teléfono es identidad: Places devuelve un único negocio. Aun así se exige que el
      // resultado sea reconocible (ciudad o nombre), por si la fila trae el teléfono de un
      // directorio en vez del negocio.
      const match = (places ?? []).find(place => hasReputation(place)
        && ((place.formattedAddress ? cityMatches(city, place.formattedAddress) : false)
          || (place.displayName?.text ? nameMatches(name, place.displayName.text) : false)));
      if (match) return toReputation(match, 'phone');
    }

    const domain = options.websiteUrl ? toDomain(options.websiteUrl) : undefined;
    if (domain) {
      const places = await searchText(domain);
      const match = (places ?? []).find(place => hasReputation(place)
        && (place.websiteUri ?? '').toLowerCase().includes(domain)
        && (place.formattedAddress ? cityMatches(city, place.formattedAddress) : false));
      if (match) return toReputation(match, 'website');
    }

    const queries = [`${name} ${city} Colombia`];
    // Reintento con el nombre simplificado: sin sufijo societario y sin lo que sigue a un guion,
    // que suele ser una coletilla de servicio ("Custom Proyectos - Cabina 360°").
    const simplified = name.replace(LEGAL_SUFFIX, ' ').split(/\s[-–—]\s/)[0].trim();
    if (simplified && simplified.toLowerCase() !== name.toLowerCase()) queries.push(`${simplified} ${city} Colombia`);

    for (const query of queries) {
      const places = await searchText(query);
      if (places === undefined) return undefined;
      const match = places.find(place => hasReputation(place)
        && typeof place.displayName?.text === 'string'
        && typeof place.formattedAddress === 'string'
        && nameMatches(name, place.displayName.text)
        && cityMatches(city, place.formattedAddress));
      if (match) return toReputation(match, 'name');
    }
    return undefined;
  } catch (error) {
    console.error('Google Places lookup errored', error instanceof Error ? error.message : error);
    return undefined;
  }
}
