import type { ReputationFinding, ReputationTarget } from './reputation-lookup';
import type { HarvestedPlace } from './places-harvest';

/**
 * Reputación desde la ficha de Google Maps vía Serper (`/maps`), sin modelo de por medio.
 *
 * La búsqueda de Gemini ve la ficha de forma intermitente y con cifras viejas (Casa de Fercho: 2 de
 * 6 intentos, y con 4.8/336 cuando Maps muestra 4.7/338). Serper devuelve la ficha como datos:
 * `rating`, `ratingCount`, `phoneNumber`, `website`. La identidad la decide el código: mismo móvil o
 * mismo dominio propio. Coincidir solo por nombre no vale, igual que en los subagentes.
 * Coste: `/maps` gasta 3 créditos por consulta (`/places` gasta 1 pero no trae teléfono).
 */

const SERPER_MAPS_URL = 'https://google.serper.dev/maps';
const TIMEOUT_MS = 15_000;

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

export function isSerperConfigured(): boolean {
  return Boolean(String(env('SERPER_API_KEY') || '').trim());
}

export type SerperPlace = {
  title?: string;
  address?: string;
  phoneNumber?: string;
  website?: string;
  rating?: number;
  ratingCount?: number;
  cid?: string;
  /** Rótulo de Google en español ("Pastelería", "Servicio de catering"). */
  type?: string;
  types?: string[];
};

/** Créditos que gasta una consulta a `/maps`, medido contra el saldo de la cuenta. */
export const SERPER_MAPS_CREDITS = 3;

/**
 * Una consulta de servicio a Maps ("pastelería tortas de boda Bogotá"): el listado del rubro, no la
 * ficha de un negocio. `undefined` si no hay clave o Serper no respondió tras reintentar.
 */
export function searchSerperMaps(query: string): Promise<SerperPlace[] | undefined> {
  return searchMaps(query);
}

/** La ficha de Maps con la forma que ya entienden la verificación y el constructor de filas. */
export function serperPlaceToHarvested(place: SerperPlace): HarvestedPlace | undefined {
  const name = String(place.title ?? '').trim();
  if (!place.cid || !name) return undefined;
  const rating = Number(place.rating);
  const reviews = Number(place.ratingCount);
  return {
    placeId: `serper:${place.cid}`,
    name,
    rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    reviews: Number.isInteger(reviews) && reviews > 0 ? reviews : undefined,
    phone: place.phoneNumber?.trim() || undefined,
    website: place.website?.trim() || undefined,
    mapsUrl: `https://www.google.com/maps?cid=${place.cid}`,
    address: place.address?.trim() || undefined,
    type: place.type?.trim() || place.types?.[0]?.trim() || undefined,
  };
}

/** Últimos 10 dígitos: "+57 310 8094969", "3108094969" y "(310) 809-4969" son el mismo número. */
export function phoneKey(value: string | undefined): string | undefined {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : undefined;
}

const SHARED_HOSTS = /(^|\.)(facebook|instagram|wa|whatsapp|linktr|wixsite|webnode|blogspot|google|tiktok|youtube)\./i;

export function ownDomain(value: string | undefined): string | undefined {
  try {
    const host = new URL(String(value ?? '').trim()).hostname.toLowerCase().replace(/^www\./, '');
    // Un subdominio de un servicio compartido (wixsite, webnode, facebook...) no identifica a nadie.
    return host && !SHARED_HOSTS.test(`.${host}`) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Elige la ficha que es de ESTE negocio; sin coincidencia de teléfono o dominio, ninguna. */
export function matchSerperPlace(places: SerperPlace[], target: ReputationTarget): ReputationFinding | undefined {
  const wantedPhone = phoneKey(target.phone);
  const wantedDomain = ownDomain(target.website);
  for (const place of places) {
    const byPhone = wantedPhone && phoneKey(place.phoneNumber) === wantedPhone;
    const byDomain = !byPhone && wantedDomain && ownDomain(place.website) === wantedDomain;
    if (!byPhone && !byDomain) continue;
    const rating = Number(place.rating);
    const reviews = Number(place.ratingCount);
    // La ficha es suya pero sin reseñas: no hay cifra que dar, y no se busca otra ficha.
    if (!Number.isFinite(rating) || rating < 1 || rating > 5 || !Number.isInteger(reviews) || reviews < 1) return undefined;
    return {
      rating: rating.toFixed(1),
      reviews: String(reviews),
      platform: 'Google',
      matchedBy: byPhone ? 'phone' : 'website',
      seenIn: `Google Maps: ${place.title ?? ''}${place.address ? `, ${place.address}` : ''}`.slice(0, 200),
    };
  }
  return undefined;
}

async function searchMaps(query: string): Promise<SerperPlace[] | undefined> {
  const first = await searchMapsOnce(query);
  if (first !== 'retry') return first;
  await new Promise(resolve => setTimeout(resolve, 1500));
  const second = await searchMapsOnce(query);
  return second === 'retry' ? undefined : second;
}

async function searchMapsOnce(query: string): Promise<SerperPlace[] | undefined | 'retry'> {
  const apiKey = String(env('SERPER_API_KEY') || '').trim();
  if (!apiKey) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(SERPER_MAPS_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'co', hl: 'es' }),
      signal: controller.signal,
    });
    // 429 y 5xx son pasajeros: con 39 consultas a la vez se perdió una ficha que sí existía.
    if (response.status === 429 || response.status >= 500) return 'retry';
    if (!response.ok) return undefined;
    const body = await response.json() as { places?: SerperPlace[] };
    return Array.isArray(body.places) ? body.places : [];
  } catch (error) {
    return (error as Error).name === 'AbortError' ? undefined : 'retry';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Primero por nombre y ciudad; si ninguna ficha coincide y hay móvil, una segunda consulta por el
 * número (el rótulo en Maps puede ser otro: "Casa de Eventos G&M" está como "Patty Bridal").
 * El número va como "+57 314 8576552" y sin ciudad: con la ciudad, o sin prefijo, Maps devuelve la
 * ciudad misma y no la ficha.
 */
export async function lookupSerperReputation(target: ReputationTarget): Promise<ReputationFinding | undefined> {
  const byName = await searchMaps(`${target.name} ${target.city}`);
  const found = byName && matchSerperPlace(byName, target);
  if (found) return found;
  const phone = phoneKey(target.phone);
  if (!phone) return undefined;
  const byPhone = await searchMaps(`+57 ${phone.slice(0, 3)} ${phone.slice(3)}`);
  return byPhone ? matchSerperPlace(byPhone, target) : undefined;
}
