import { demoDashboard, demoProvider } from './demo';
import {
  REGISTRATION_CATEGORIES,
  SERVICE_TOKEN_HEADER,
  type CampaignOverview,
  type DashboardData,
  type Provider,
  type ProviderSource,
  type Registration,
  type Preregistered,
  type RegistrationLink,
} from './contract';

const env = (name: string) => import.meta.env[name as keyof ImportMetaEnv] ?? process.env[name];

/**
 * Cliente del backend, y única vía por la que el frontend obtiene datos.
 *
 * Ninguna página vuelve a importar `lib/db`: eso es lo que permite desplegar el front en Vercel,
 * donde no hay (ni debe haber) credenciales de PostgreSQL. Las páginas piden aquí y esto habla HTTP
 * con la API que corre en AWS.
 *
 * `BACKEND_URL` vacío significa "el mismo origen": mientras front y back comparten proceso, la
 * llamada se resuelve contra la propia aplicación y no hace falta configurar nada. Al separarlos,
 * basta apuntar esa variable al dominio del backend.
 */
function backendBase(origin: string) {
  const configured = env('BACKEND_URL');
  return (configured || origin).replace(/\/$/, '');
}

export class BackendUnavailableError extends Error {
  constructor(readonly path: string, readonly status: number | null, readonly cause?: unknown) {
    super(`BACKEND_UNAVAILABLE ${path}${status ? ` (${status})` : ''}`);
    this.name = 'BackendUnavailableError';
  }
}

async function get<T>(path: string, origin: string): Promise<T> {
  const token = env('BACKEND_SERVICE_TOKEN');
  const url = `${backendBase(origin)}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: token ? { [SERVICE_TOKEN_HEADER]: token } : {},
    });
  } catch (cause) {
    throw new BackendUnavailableError(path, null, cause);
  }
  if (response.status === 404) throw new BackendUnavailableError(path, 404);
  if (!response.ok) throw new BackendUnavailableError(path, response.status);
  return await response.json() as T;
}

/**
 * Las lecturas del panel degradan a datos de demostración cuando el backend no responde, que es
 * exactamente lo que hacía `getDashboard()` sin `DATABASE_URL`. La pantalla sigue siendo revisable
 * y el aviso de «Modo demostración» sale del mismo campo `connected` de siempre.
 */
export async function fetchDashboard(origin: string): Promise<DashboardData> {
  try {
    return await get<DashboardData>('/api/v1/dashboard', origin);
  } catch {
    return demoDashboard();
  }
}

export async function fetchProvider(id: string, origin: string): Promise<(Provider & { sources: ProviderSource[] }) | null> {
  try {
    return await get<Provider & { sources: ProviderSource[] }>(`/api/v1/providers/${encodeURIComponent(id)}`, origin);
  } catch (error) {
    // Un 404 es una respuesta legítima del backend: el proveedor no existe. Solo se cae a
    // demostración cuando el backend no contesta, para no inventar una ficha que no está.
    if (error instanceof BackendUnavailableError && error.status === 404) return null;
    return demoProvider(id);
  }
}

export async function fetchRegistration(id: string, origin: string): Promise<Registration | null> {
  try {
    return await get<Registration>(`/api/v1/registrations/${encodeURIComponent(id)}`, origin);
  } catch (error) {
    if (error instanceof BackendUnavailableError && error.status === 404) return null;
    const data = demoDashboard();
    return data.registrations.find((entry) => entry.submission_id === id) ?? null;
  }
}

export async function fetchPreregistered(origin: string): Promise<Preregistered[]> {
  try {
    const body = await get<{ providers: Preregistered[] }>('/api/v1/preregistrations', origin);
    return body.providers ?? [];
  } catch {
    // Sin backend no hay lista que enseñar: la pantalla lo dice en vez de inventarse proveedores.
    return [];
  }
}

export async function fetchCampaignOverview(origin: string): Promise<CampaignOverview> {
  try {
    return await get<CampaignOverview>('/api/v1/campaigns/overview', origin);
  } catch {
    return {
      connected: false,
      campaigns: [],
      recipients: [],
      cities: [],
      statuses: [],
      categories: [],
      defaultSender: '',
      omnisendReady: false,
      qaRecipientsLabel: '',
      emailEligibleCount: 0,
      qaRecipientsCount: 0,
    };
  }
}

export async function fetchRegistrationLink(token: string, origin: string): Promise<RegistrationLink> {
  try {
    return await get<RegistrationLink>(`/api/v1/registration-links/${encodeURIComponent(token)}`, origin);
  } catch {
    // Mismo criterio que tenía la página: si la consulta falla, el formulario se muestra igual y la
    // validación real la repite el endpoint al recibir el envío.
    return { providerName: 'tu negocio de eventos', linkState: 'valid', submittedAt: null, categories: REGISTRATION_CATEGORIES };
  }
}
