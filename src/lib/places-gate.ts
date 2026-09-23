import { logCurationEvent } from './curation-log';

/**
 * Puerta única para toda llamada a `places.googleapis.com`.
 *
 * Existe por un incidente de facturación: los campos que pide este backend (`rating`,
 * `userRatingCount`, `nationalPhoneNumber`, `websiteUri`) convierten cada Text Search en el SKU
 * "Places API Text Search Enterprise", que solo regala 1.000 eventos al mes y luego cobra ~USD 35 por
 * cada 1.000. Una sola búsqueda del panel podía lanzar decenas de peticiones (10 escaneos × 4
 * consultas de cosecha + hasta 4 búsquedas por fila sin reputación), y la API se activaba con solo
 * tener la clave configurada.
 *
 * Reglas, en orden:
 *  1. Sin `GOOGLE_PLACES_API_KEY` no hay nada que hacer.
 *  2. La clave por sí sola NO activa nada: hace falta `GOOGLE_PLACES_OPT_IN=1`.
 *  3. `GOOGLE_PLACES_KILL_SWITCH=1` gana sobre el opt-in: apaga todo sin tocar la clave.
 *  4. `GOOGLE_PLACES_MAX_REQUESTS` es un tope duro de peticiones por proceso y por día UTC. Con
 *     opt-in y sin valor, se aplica `DEFAULT_MAX_REQUESTS`. El contador vive en memoria: un
 *     reinicio lo pone a cero, así que el tope acota cada arranque, no el mes.
 *
 * Cada intento se cuenta, permitido o bloqueado, y el motivo del bloqueo queda en el log y en
 * `getPlacesUsage()` (lo expone `/api/health`).
 */

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

export const DEFAULT_MAX_REQUESTS = 50;
const DEFAULT_TIMEOUT_MS = 8_000;
const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

export type PlacesBlockReason = 'not_configured' | 'not_opted_in' | 'kill_switch' | 'limit_reached';

export type PlacesUsage = {
  /** true solo cuando una petición se haría de verdad ahora mismo. */
  enabled: boolean;
  configured: boolean;
  optedIn: boolean;
  killSwitch: boolean;
  limit: number;
  /** Día UTC al que pertenecen los contadores. */
  window: string;
  attempted: number;
  performed: number;
  blocked: number;
  blockedByReason: Record<PlacesBlockReason, number>;
};

type Counters = {
  window: string;
  attempted: number;
  performed: number;
  blocked: number;
  blockedByReason: Record<PlacesBlockReason, number>;
};

function emptyCounters(window: string): Counters {
  return {
    window,
    attempted: 0,
    performed: 0,
    blocked: 0,
    blockedByReason: { not_configured: 0, not_opted_in: 0, kill_switch: 0, limit_reached: 0 },
  };
}

// En globalThis y no en el módulo: `astro dev` recarga el módulo con cada cambio de archivo y un
// contador de módulo volvería a cero a mitad de una búsqueda.
const registry = globalThis as typeof globalThis & { __placesGate?: Counters };

function todayWindow(): string {
  return new Date().toISOString().slice(0, 10);
}

function counters(): Counters {
  const window = todayWindow();
  if (!registry.__placesGate || registry.__placesGate.window !== window) registry.__placesGate = emptyCounters(window);
  return registry.__placesGate;
}

function isOn(value: string | undefined): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function placesRequestLimit(): number {
  const raw = String(env('GOOGLE_PLACES_MAX_REQUESTS') ?? '').trim();
  if (!raw) return DEFAULT_MAX_REQUESTS;
  const parsed = Number(raw);
  // Un valor ilegible no puede abrir la puerta de par en par: se cierra.
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

export function placesBlockReason(): PlacesBlockReason | undefined {
  if (!env('GOOGLE_PLACES_API_KEY')) return 'not_configured';
  if (isOn(env('GOOGLE_PLACES_KILL_SWITCH'))) return 'kill_switch';
  if (!isOn(env('GOOGLE_PLACES_OPT_IN'))) return 'not_opted_in';
  if (counters().performed >= placesRequestLimit()) return 'limit_reached';
  return undefined;
}

/** Sin contar: para decidir si vale la pena preparar una consulta. */
export function isGooglePlacesEnabled(): boolean {
  return placesBlockReason() === undefined;
}

export function getPlacesUsage(): PlacesUsage {
  const current = counters();
  return {
    enabled: isGooglePlacesEnabled(),
    configured: Boolean(env('GOOGLE_PLACES_API_KEY')),
    optedIn: isOn(env('GOOGLE_PLACES_OPT_IN')),
    killSwitch: isOn(env('GOOGLE_PLACES_KILL_SWITCH')),
    limit: placesRequestLimit(),
    window: current.window,
    attempted: current.attempted,
    performed: current.performed,
    blocked: current.blocked,
    blockedByReason: { ...current.blockedByReason },
  };
}

/** Solo para pruebas y benchmarks: los contadores de producción no se tocan a mano. */
export function resetPlacesUsageForTests(): void {
  registry.__placesGate = emptyCounters(todayWindow());
}

export type PlacesTextSearchOutcome =
  | { status: 'ok'; body: Record<string, unknown> }
  | { status: 'blocked'; reason: PlacesBlockReason }
  | { status: 'failed'; httpStatus?: number; error: string };

/**
 * Único punto por el que sale una petición a Places. Cuenta el intento antes de decidir, para que
 * "cuántas se intentaron" y "cuántas se bloquearon" sean auditables por separado.
 */
export async function placesTextSearch(
  body: Record<string, unknown>,
  fieldMask: string,
  options: { purpose: string; timeoutMs?: number } = { purpose: 'unspecified' },
): Promise<PlacesTextSearchOutcome> {
  const current = counters();
  current.attempted += 1;
  const reason = placesBlockReason();
  if (reason) {
    current.blocked += 1;
    current.blockedByReason[reason] += 1;
    logCurationEvent('places_request_blocked', {
      purpose: options.purpose, reason, attempted: current.attempted, performed: current.performed,
      blocked: current.blocked, limit: placesRequestLimit(),
    });
    return { status: 'blocked', reason };
  }
  // Se cuenta como realizada ANTES de enviarla: un timeout no demuestra que Google no la cobró.
  current.performed += 1;
  logCurationEvent('places_request', {
    purpose: options.purpose, attempted: current.attempted, performed: current.performed,
    blocked: current.blocked, limit: placesRequestLimit(),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(PLACES_TEXT_SEARCH_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': String(env('GOOGLE_PLACES_API_KEY')),
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      console.error('Places request failed', options.purpose, response.status, detail);
      return { status: 'failed', httpStatus: response.status, error: detail || `HTTP ${response.status}` };
    }
    return { status: 'ok', body: await response.json() as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Places request errored', options.purpose, message);
    return { status: 'failed', error: message };
  } finally {
    clearTimeout(timer);
  }
}
