import { parseMultiPlatformReputation } from './curation';
import { logCurationEvent, type ClaudeRunContext } from './curation-log';

/**
 * Subagentes de reputación: una llamada corta a Gemini por cada fila que el lote dejó en "Sin dato".
 *
 * El agente de descubrimiento investiga 8–20 negocios en un solo contexto y reparte sus búsquedas:
 * en producción devolvía "Sin dato" en negocios que sí tienen ficha en Google (Manizales, Menaje:
 * 12 de 12). Medido el 2026-09-23: la misma búsqueda de Gemini, dedicada a UN negocio con nombre,
 * dirección y teléfono, sí ve la ficha (Alma alquiler de mobiliario: 5.0 con 16 reseñas, igual que
 * Maps). No usa Google Places: es la herramienta `google_search` que ya se paga con Gemini.
 */

const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const CONCURRENCY = 4;
const TIMEOUT_MS = 120_000;
const ALLOWED_PLATFORMS = ['Google', 'Tripadvisor', 'Booking', 'Rappi', 'DiDi', 'Facebook'] as const;

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

export type ReputationTarget = {
  name: string;
  city: string;
  phone?: string;
  website?: string;
  /** Texto libre de la fila (justificación): suele traer la dirección, que ayuda a desambiguar. */
  hint?: string;
};

export type ReputationFinding = {
  rating: string;
  reviews: string;
  platform: string;
  matchedBy: string;
  seenIn: string;
};

const responseSchema = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    rating: { type: 'string', description: 'Calificación exacta, ej. "4.8", o "Sin dato".' },
    reviews: { type: 'string', description: 'Número exacto de reseñas, ej. "45", o "Sin dato".' },
    platform: { type: 'string', description: 'Google, Tripadvisor, Booking, Rappi, DiDi o Facebook.' },
    matched_by: { type: 'string', description: 'phone, address, website o name: qué dato de la ficha coincide con el negocio pedido.' },
    seen_in: { type: 'string', description: 'Dónde viste la cifra exactamente.' },
  },
  required: ['found', 'rating', 'reviews', 'platform', 'matched_by', 'seen_in'],
};

function buildPrompt(target: ReputationTarget): string {
  const lines = [
    `Busca en Google la ficha pública del negocio "${target.name}" en ${target.city}, Colombia.`,
    target.phone ? `Teléfono conocido: ${target.phone}.` : '',
    target.website ? `Sitio conocido: ${target.website}.` : '',
    target.hint ? `Contexto (puede traer la dirección): ${target.hint.slice(0, 400)}` : '',
    '',
    'Necesito SOLO su calificación y su número de reseñas. Prioriza la ficha de Google (Google Maps / perfil de empresa); si no tiene, sirven Tripadvisor, Booking, Rappi, DiDi o Facebook. Nunca un directorio agregador (Cybo, PaginasAmarillas, Guía Local, top10place, nicelocal o similares).',
    'La ficha debe ser de ESTE negocio: confirma que coincide el teléfono, la dirección o el sitio. Un negocio con nombre parecido pero otro teléfono y otra dirección NO sirve.',
    'Si no ves la cifra literalmente en tus resultados, responde found=false y "Sin dato". No estimes, no redondees, no inventes.',
  ];
  return lines.filter(Boolean).join('\n');
}

function extractText(body: Record<string, unknown>): string | undefined {
  if (!Array.isArray(body.steps)) return undefined;
  for (const step of [...body.steps].reverse()) {
    const content = (step as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    const part = content.find(item => typeof (item as Record<string, unknown>)?.text === 'string') as Record<string, string> | undefined;
    if (part) return part.text;
  }
  return undefined;
}

/** Valida la respuesta del subagente: solo pasa una cifra con forma de cifra real y plataforma admitida. */
export function parseReputationAnswer(text: string): ReputationFinding | undefined {
  const json = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  let answer: Record<string, unknown>;
  try {
    answer = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (answer.found !== true) return undefined;
  const rating = Number(String(answer.rating ?? '').replace(',', '.'));
  const reviews = Number(String(answer.reviews ?? '').replace(/[.,\s]/g, ''));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) return undefined;
  if (!Number.isInteger(reviews) || reviews < 1) return undefined;
  const rawPlatform = String(answer.platform ?? '').toLowerCase();
  const platform = ALLOWED_PLATFORMS.find(name => rawPlatform.includes(name.toLowerCase()));
  if (!platform) return undefined;
  const matchedBy = String(answer.matched_by ?? '').toLowerCase();
  // Coincidir solo por nombre es justo el caso "otro negocio con rótulo parecido".
  if (!/phone|address|website|tel|direc|sitio/.test(matchedBy)) return undefined;
  return { rating: rating.toFixed(1), reviews: String(reviews), platform, matchedBy, seenIn: String(answer.seen_in ?? '').slice(0, 200) };
}

export async function lookupReputation(target: ReputationTarget): Promise<ReputationFinding | undefined> {
  return (await lookupReputationRaw(target)).finding;
}

/**
 * Igual que `lookupReputation`, pero devuelve también la respuesta cruda (para el benchmark).
 *
 * La búsqueda no es determinista: Happy City Megamall (4.3/69) salió en 2 de 3 intentos idénticos.
 * Por eso lo no encontrado se reintenta (`CURATION_REPUTATION_ATTEMPTS`, 2 por defecto); lo
 * encontrado no, así que el reintento solo cuesta en las filas que siguen en "Sin dato".
 */
export async function lookupReputationRaw(target: ReputationTarget): Promise<{ finding?: ReputationFinding; raw?: string; error?: string; attempts: number }> {
  const configured = Number(env('CURATION_REPUTATION_ATTEMPTS') || 2);
  const maxAttempts = Number.isInteger(configured) && configured >= 1 && configured <= 3 ? configured : 2;
  let last: { finding?: ReputationFinding; raw?: string; error?: string } = {};
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await singleLookup(target);
    if (last.finding || last.error === 'GEMINI_NOT_CONFIGURED') return { ...last, attempts: attempt };
  }
  return { ...last, attempts: maxAttempts };
}

async function singleLookup(target: ReputationTarget): Promise<{ finding?: ReputationFinding; raw?: string; error?: string }> {
  const apiKey = env('GEMINI_API_KEY');
  if (!apiKey) return { error: 'GEMINI_NOT_CONFIGURED' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(GEMINI_INTERACTIONS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: env('GEMINI_AGENT_MODEL') || 'gemini-3.8-flash',
        input: buildPrompt(target),
        tools: [{ type: 'google_search' }],
        response_format: { type: 'text', mime_type: 'application/json', schema: responseSchema },
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { error: `HTTP_${response.status}` };
    const text = extractText(await response.json() as Record<string, unknown>);
    return text ? { finding: parseReputationAnswer(text), raw: text } : { error: 'EMPTY' };
  } catch (error) {
    return { error: (error as Error).name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

const isMissing = (value: string | undefined) => /^sin dato$/i.test((value ?? '').trim());

/**
 * Rellena calificación, reseñas, plataforma, nivel y justificación de las filas en "Sin dato", con la
 * misma forma que dejaba Places, para que `validateCurationBatch` (que exige ver las cifras en la
 * justificación) las lea igual. Lo que el subagente no confirma queda como estaba: "Requiere revisión".
 */
export async function enrichMissingReputationWithSubagents(
  tsv: string,
  city: string,
  context?: ClaudeRunContext,
  lookup: (target: ReputationTarget) => Promise<ReputationFinding | undefined> = lookupReputation,
): Promise<string> {
  if (!env('GEMINI_API_KEY') && lookup === lookupReputation) return tsv;
  const lines = tsv.replace(/\r\n?/g, '\n').split('\n');
  const header = lines[0] ?? '';
  const rows = lines.slice(1).filter(line => line.trim());
  const updated = [...rows];
  const pending = rows
    .map((line, index) => ({ index, cells: line.split('\t') }))
    .filter(({ cells }) => (isMissing(cells[8]) || isMissing(cells[9])) && (cells[1] ?? '').trim());
  let enriched = 0;
  for (let start = 0; start < pending.length; start += CONCURRENCY) {
    await Promise.all(pending.slice(start, start + CONCURRENCY).map(async ({ index, cells }) => {
      const found = await lookup({
        name: cells[1].trim(),
        city: (cells[4] ?? '').trim() || city,
        phone: isMissing(cells[13]) ? undefined : cells[13]?.trim(),
        website: isMissing(cells[16]) || /grounding-api-redirect/.test(cells[16] ?? '') ? undefined : cells[16]?.trim(),
        hint: cells[12]?.trim(),
      });
      if (!found) return;
      enriched += 1;
      cells[8] = found.rating;
      cells[9] = found.reviews;
      cells[10] = found.platform;
      cells[11] = Number(found.reviews) >= 50 ? 'A' : 'B';
      const baseReason = (cells[12] ?? '').trim();
      cells[12] = `${baseReason ? `${baseReason} ` : ''}Reputación hallada por búsqueda dedicada: ${found.rating} con ${found.reviews} reseñas en ${found.platform}.`.slice(0, 900);
      const others = (parseMultiPlatformReputation(cells[18] ?? 'Sin dato') ?? []).filter(entry => entry.platform.toLowerCase() !== found.platform.toLowerCase());
      cells[18] = [...others, { platform: found.platform, rating: Number(found.rating), reviews: Number(found.reviews) }]
        .map(entry => `${entry.platform}:${entry.rating.toFixed(1)}:${entry.reviews}`)
        .join(';');
      updated[index] = cells.join('\t');
    }));
  }
  if (context) logCurationEvent('reputation_subagents', { ...context, attempted: pending.length, enriched });
  return [header, ...updated].join('\n');
}
