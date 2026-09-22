import { pool, query } from './db';

/**
 * Lo que el agente de conversación sabe de un proveedor antes de hablar con él.
 *
 * Es lo que permite que la conversación no sea un formulario: la curaduría ya encontró su
 * reputación, su zona, su Instagram y por qué encaja en el catálogo, y hasta ahora el chat solo
 * usaba el nombre y la ciudad. Aquí se reúne todo eso en una ficha corta para el prompt.
 *
 * Solo entran datos públicos que la curaduría observó. `providers.notes` se deja fuera a propósito:
 * son notas internas del operador y no son algo que el agente deba poder repetirle al proveedor.
 */

export type ProviderProfile = {
  providerId: string;
  displayName: string;
  category: string;
  additionalCategories: string[];
  city: string;
  address: string | null;
  websiteUrl: string | null;
  zone: string | null;
  segment: string | null;
  scale: string | null;
  instagram: string | null;
  /** Por qué la curaduría lo consideró apto, tal como lo escribió. */
  curationReason: string | null;
  /** Su ciudad ya está abierta: puede registrarse él mismo hoy, sin esperar a que abramos. */
  cityOpen: boolean;
  sources: Array<{ name: string; rating: number | null; reviews: number | null }>;
};

export type RegistrationStatus = {
  submissionStatus: string;
  providerStatus: string | null;
  receivedOn: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type NormalizedEvidence = {
  zone?: string; segment?: string; scale?: string; instagram?: string; curationReason?: string;
};

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  // La curaduría escribe "Sin dato" cuando no encontró algo: para el agente eso es no saberlo.
  if (!text || /^sin (dato|clasificar)$/i.test(text)) return null;
  return text.slice(0, 400);
}

export async function loadProviderProfile(providerId: string): Promise<ProviderProfile | null> {
  if (!pool || !UUID_PATTERN.test(providerId)) return null;

  const [providers, sources] = await Promise.all([
    query<{
      provider_id: string; display_name: string; category: string; additional_categories: string[] | null;
      city: string; address: string | null; website_url: string | null; city_open: boolean;
    }>(
      // Si su ciudad ya está abierta puede registrarse solo; si no, el enlace lo llevaría a una
      // ciudad donde todavía no operamos, así que el agente necesita saberlo antes de hablar.
      `SELECT p.provider_id, p.display_name, p.category, p.additional_categories, p.city, p.address, p.website_url,
              COALESCE((SELECT c.status = 'abierta' FROM marketplace.cities c
                        WHERE lower(trim(p.city)) = lower(c.name)
                        ORDER BY c.status DESC LIMIT 1), false) AS city_open
       FROM marketplace.providers p WHERE p.provider_id = $1`,
      [providerId],
    ),
    query<{ source_name: string; observed_rating: string | null; observed_reviews: number | null; normalized: NormalizedEvidence | null }>(
      `SELECT source_name, observed_rating, observed_reviews, raw_payload->'normalized' AS normalized
       FROM marketplace.provider_sources
       WHERE provider_id = $1
       ORDER BY observed_reviews DESC NULLS LAST
       LIMIT 8`,
      [providerId],
    ),
  ]);

  const row = providers.rows[0];
  if (!row) return null;

  // La fila principal de la curaduría es la que trae `normalized`; las de reputación multiplataforma
  // solo guardan su calificación.
  const evidence = sources.rows.find((source) => source.normalized)?.normalized ?? {};

  return {
    providerId: row.provider_id,
    displayName: row.display_name,
    category: row.category,
    additionalCategories: row.additional_categories ?? [],
    city: row.city,
    address: clean(row.address),
    websiteUrl: clean(row.website_url),
    zone: clean(evidence.zone),
    segment: clean(evidence.segment),
    scale: clean(evidence.scale),
    instagram: clean(evidence.instagram),
    curationReason: clean(evidence.curationReason),
    cityOpen: row.city_open === true,
    sources: sources.rows
      .filter((source) => source.observed_rating !== null || source.observed_reviews !== null)
      .map((source) => ({
        name: source.source_name,
        rating: source.observed_rating === null ? null : Number(source.observed_rating),
        reviews: source.observed_reviews,
      })),
  };
}

export async function loadRegistrationStatus(submissionId: string): Promise<RegistrationStatus | null> {
  if (!pool || !UUID_PATTERN.test(submissionId)) return null;
  const result = await query<{ submission_status: string; provider_status: string | null; received_on: string }>(
    `SELECT s.submission_status, p.status AS provider_status, to_char(s.created_at, 'DD/MM/YYYY') AS received_on
     FROM marketplace.registration_submissions s
     LEFT JOIN marketplace.providers p ON p.provider_id = s.provider_id
     WHERE s.submission_id = $1`,
    [submissionId],
  );
  const row = result.rows[0];
  return row ? { submissionStatus: row.submission_status, providerStatus: row.provider_status, receivedOn: row.received_on } : null;
}

/** La ficha en el formato que lee el agente: una línea por dato, solo lo que se sabe. */
export function describeProfile(profile: ProviderProfile): string {
  const lines: string[] = [];
  const categorias = [profile.category, ...profile.additionalCategories].join(', ');
  lines.push(`- Negocio: ${profile.displayName} · ${categorias} · ${profile.city}${profile.zone ? ` (${profile.zone})` : ''}`);
  if (profile.address) lines.push(`- Dirección: ${profile.address}`);
  if (profile.websiteUrl) lines.push(`- Web: ${profile.websiteUrl}`);
  if (profile.instagram) lines.push(`- Instagram: ${profile.instagram}`);
  if (profile.segment || profile.scale) {
    lines.push(`- Perfil: ${[profile.segment, profile.scale].filter(Boolean).join(' · ')}`);
  }
  const reputacion = profile.sources
    .filter((source) => source.rating !== null && source.reviews !== null)
    .map((source) => `${source.name} ${source.rating}★ (${source.reviews} reseñas)`);
  if (reputacion.length) lines.push(`- Reputación pública: ${reputacion.join('; ')}`);
  if (profile.curationReason) lines.push(`- Por qué nos interesó: ${profile.curationReason}`);
  // Lo primero que decide el agente: si puede mandarlo al registro hoy o si todavía no hay dónde.
  lines.push(profile.cityOpen
    ? `- Happia YA está abierto en ${profile.city}: puede registrarse hoy mismo.`
    : `- Happia todavía NO está abierto en ${profile.city}.`);
  return lines.join('\n');
}

const SUBMISSION_LABELS: Record<string, string> = {
  new: 'recibido, esperando que una persona del equipo lo revise',
  reviewing: 'una persona del equipo lo está revisando',
  approved: 'aprobado',
  converted: 'aprobado y ya forma parte del catálogo',
  rejected: 'cerrado por el equipo',
  spam: 'cerrado por el equipo',
};

export function describeRegistrationStatus(status: RegistrationStatus): string {
  return `Registro recibido el ${status.receivedOn}; estado: ${SUBMISSION_LABELS[status.submissionStatus] ?? status.submissionStatus}.`;
}
