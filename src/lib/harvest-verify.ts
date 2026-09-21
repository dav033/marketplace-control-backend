import { runResearchAgent, type ClaudeRunResult } from './gemini';
import { logCurationEvent } from './curation-log';
import type { HarvestedPlace } from './places-harvest';
import { scrapeProviderContact, type ScrapedContact } from './contact-scrape';

const env = (name: string) => import.meta.env?.[name as keyof ImportMetaEnv] ?? process.env[name];

/**
 * Verificación de candidatos ya cosechados, en lugar de descubrimiento.
 *
 * Es la corrección de un fallo medido: cuando la lista de Google Places se le entregaba al agente
 * como texto dentro de su prompt de descubrimiento, solo el 17 % de lo que devolvía procedía de esa
 * lista — descartaba el resto y se inventaba su propia búsqueda, devolviendo por ejemplo un asador
 * brasileño como proveedor de mantelería.
 *
 * Aquí la tarea es otra: se le dan negocios concretos y se le pregunta por cada uno si presta el
 * servicio de la categoría y cuál es su correo. No puede añadir proveedores porque no se le pide
 * que busque ninguno, y la respuesta se empareja por índice: cualquier entrada que no corresponda a
 * un candidato enviado se descarta al fusionar.
 *
 * Calificación, reseñas, teléfono y nombre NUNCA salen de aquí: esos vienen de la API de Places y
 * el agente no los toca.
 */

export type CandidateVerification = {
  /** El negocio presta el servicio de la categoría para eventos. */
  relevant: boolean;
  email?: string;
  instagram?: string;
  note?: string;
};

export type VerificationOutcome = {
  byPlaceId: Map<string, CandidateVerification>;
  verified: number;
  relevant: number;
  withEmail: number;
  withInstagram: number;
  durationMs: number;
  partial: boolean;
  failureReason?: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HANDLE_PATTERN = /^@[A-Za-z0-9._]{1,30}$/;

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 320) return undefined;
  // Un correo de plantilla o de un directorio no sirve como contacto del proveedor.
  if (/^(info|contacto|hola)@(example|dominio|empresa|tudominio)\./.test(email)) return undefined;
  return email;
}

function normalizeInstagram(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw || /^sin\s/i.test(raw)) return undefined;
  const fromUrl = raw.match(/^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i)?.[1];
  const handle = fromUrl ? `@${fromUrl}` : (raw.startsWith('@') ? raw : `@${raw}`);
  if (!HANDLE_PATTERN.test(handle)) return undefined;
  if (['p', 'reel', 'reels', 'explore', 'stories', 'tv'].includes(handle.slice(1).toLowerCase())) return undefined;
  return handle;
}

/** El CLI suele envolver el JSON en prosa o en una valla de código; se rescata el array. */
export function extractJsonArray(output: string): unknown[] | undefined {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, output].filter((value): value is string => typeof value === 'string');
  for (const candidate of candidates) {
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch { /* sigue con el siguiente candidato */ }
  }
  return undefined;
}

export function buildVerificationPrompt(city: string, category: string, candidates: HarvestedPlace[]): string {
  const listado = candidates.map((place, index) => {
    const url = place.website || place.mapsUrl || 'sin sitio web';
    return `${index + 1}. ${place.name}${place.type ? ` (${place.type})` : ''} — ${url}${place.phone ? ` — tel ${place.phone}` : ''}`;
  }).join('\n');

  return `Actúa como verificador de proveedores para eventos en Colombia. NO busques proveedores nuevos.

Abajo hay ${candidates.length} negocios reales de ${city}, obtenidos de la API oficial de Google Places. Su nombre, calificación, reseñas y teléfono ya están verificados y no debes tocarlos ni volver a buscarlos.

Tu tarea es exactamente dos cosas por cada negocio de la lista:
1. Decidir si presta el servicio de la categoría "${category}" para eventos. Un negocio puede tener excelente calificación y aun así no servir: el rótulo de Google es genérico y arrastra comercio parecido. Si no puedes confirmar que presta ese servicio, responde false.
2. Buscar su correo electrónico de contacto y su perfil de Instagram en su sitio web o su ficha pública.

LISTA:
${listado}

Responde ÚNICAMENTE con un array JSON, sin texto alrededor, con un objeto por cada número de la lista:
[{"i":1,"sirve":true,"correo":"contacto@negocio.com","instagram":"@negocio","nota":"confirma catering para eventos en su sitio"}]

Reglas estrictas:
- Un objeto por cada número del 1 al ${candidates.length}, con ese mismo "i". No añadas números que no estén en la lista ni negocios nuevos.
- "correo" e "instagram" en null si no los encuentras publicados. JAMÁS los inventes ni los deduzcas del dominio.
- "sirve" en false cuando el negocio no preste el servicio de "${category}" para eventos, y explica por qué en "nota".
- "nota" en español, máximo 160 caracteres, diciendo en qué fuente lo confirmaste.`;
}

export async function verifyHarvestedCandidates(input: {
  city: string;
  category: string;
  candidates: HarvestedPlace[];
  jobId?: string;
  onPhase?: (phase: string, detail: string) => void;
}): Promise<VerificationOutcome> {
  const startedAt = Date.now();
  const empty: VerificationOutcome = {
    byPlaceId: new Map(), verified: 0, relevant: 0, withEmail: 0, withInstagram: 0,
    durationMs: 0, partial: false,
  };
  if (!input.candidates.length) return empty;

  // Paso determinista primero: leer el sitio del proveedor. El agente no abre paginas — en una
  // corrida real hizo 5 busquedas web y CERO aperturas, y encontro 0 correos de 3 candidatos.
  // Descargar la portada y una pagina de contacto tarda un segundo y no puede inventarse nada.
  input.onPhase?.('scraping', `Leyendo el sitio de ${input.candidates.length} candidatos.`);
  const scraped = new Map<string, { email?: string; instagram?: string }>();
  const withSite = input.candidates.filter(place => place.website);
  const CONCURRENCY = 4;
  for (let start = 0; start < withSite.length; start += CONCURRENCY) {
    const batch = withSite.slice(start, start + CONCURRENCY);
    const results = await Promise.all(batch.map(async place => ({
      placeId: place.placeId,
      contact: await scrapeProviderContact(place.website!).catch((): ScrapedContact => ({})),
    })));
    for (const { placeId, contact } of results) {
      if (contact.email || contact.instagram) scraped.set(placeId, contact);
    }
  }

  const configured = String(env('CURATION_PROVIDER') || 'gemini').trim().toLowerCase();
  // La verificación necesita un CLI con búsqueda web; la vía Gemini de descubrimiento no aplica aquí.
  const provider: 'claude-code' | 'codex' = configured === 'claude-code' ? 'claude-code' : 'codex';

  input.onPhase?.('verifying', `Verificando ${input.candidates.length} candidatos con el agente.`);

  let run: ClaudeRunResult;
  try {
    run = await runResearchAgent(provider, {
      prompt: buildVerificationPrompt(input.city, input.category, input.candidates),
      role: 'verification',
      context: { jobId: input.jobId ?? 'verify', scanNumber: 1, role: 'verification' },
      maxTurns: Math.min(60, 8 + input.candidates.length * 2),
      tools: ['WebSearch', 'WebFetch'],
      onPhase: input.onPhase ? (phase, detail) => input.onPhase?.(phase, detail) : undefined,
    });
  } catch (error) {
    return { ...empty, durationMs: Date.now() - startedAt, failureReason: error instanceof Error ? error.message : 'VERIFY_FAILED' };
  }

  const parsed = extractJsonArray(run.output);
  if (!parsed) {
    // El agente fallo, pero lo leido de los sitios sigue siendo valido y no se tira. La pertinencia
    // queda sin juzgar, que es justo lo que el agente no pudo responder.
    const fallback = new Map<string, CandidateVerification>();
    for (const place of input.candidates) {
      const fromSite = scraped.get(place.placeId);
      if (fromSite) fallback.set(place.placeId, { relevant: true, email: fromSite.email, instagram: fromSite.instagram });
    }
    const values = [...fallback.values()];
    return {
      byPlaceId: fallback, verified: fallback.size, relevant: fallback.size,
      withEmail: values.filter(v => v.email).length, withInstagram: values.filter(v => v.instagram).length,
      durationMs: Date.now() - startedAt, partial: run.partial, failureReason: 'VERIFY_OUTPUT_UNPARSEABLE',
    };
  }

  const byPlaceId = new Map<string, CandidateVerification>();
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const position = Number(record.i);
    // El índice es el único vínculo con la lista enviada: cualquier otro se descarta, que es lo que
    // impide que el agente cuele un negocio que nadie le pidió.
    if (!Number.isInteger(position) || position < 1 || position > input.candidates.length) continue;
    const place = input.candidates[position - 1];
    if (byPlaceId.has(place.placeId)) continue;
    const fromSite = scraped.get(place.placeId);
    byPlaceId.set(place.placeId, {
      relevant: record.sirve === true,
      // Lo leido del sitio manda sobre lo que diga el agente: es la fuente, no una interpretacion.
      email: fromSite?.email ?? normalizeEmail(record.correo),
      instagram: fromSite?.instagram ?? normalizeInstagram(record.instagram),
      note: typeof record.nota === 'string' ? record.nota.trim().slice(0, 160) : undefined,
    });
  }

  const values = [...byPlaceId.values()];
  const outcome: VerificationOutcome = {
    byPlaceId,
    verified: byPlaceId.size,
    relevant: values.filter(v => v.relevant).length,
    withEmail: values.filter(v => v.email).length,
    withInstagram: values.filter(v => v.instagram).length,
    durationMs: Date.now() - startedAt,
    partial: run.partial,
    failureReason: run.failureReason,
  };

  logCurationEvent('harvest_verification', {
    jobId: input.jobId ?? 'verify', scanNumber: 1, role: 'verification',
    enviados: input.candidates.length, verificados: outcome.verified, pertinentes: outcome.relevant,
    conCorreo: outcome.withEmail, conInstagram: outcome.withInstagram, durationMs: outcome.durationMs,
  } as never);

  return outcome;
}
