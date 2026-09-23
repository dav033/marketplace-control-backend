import { CURATION_HEADERS, parseCurationTsv, summarizeContactChannels, validateCurationBatch } from './curation';
import { curationCandidateKey, getCurationBlacklist, getExistingProviders, type CurationBlacklistEntry, type ExistingProvider } from './curation-history';
import { logCurationEvent } from './curation-log';
import { verifyContact } from './contact-verify';
import { buildLivePreviewRows, filterByReputationThreshold, hasContactForDiscovery, type CurationPhaseReporter, type GeminiCurationResult } from './gemini';
import { harvestToCurationTsv, sanitizeCell } from './harvest-import';
import { verifyHarvestedCandidates } from './harvest-verify';
import { categoryQueries, isContactable, type HarvestedPlace } from './places-harvest';
import { SERPER_MAPS_CREDITS, searchSerperMaps, serperPlaceToHarvested } from './serper-maps';

/**
 * Descubrimiento de proveedores con Google Maps vía Serper, sin búsqueda web de un agente.
 *
 * La búsqueda web del agente (el grounding de Gemini) era lo que agotaba la facturación: USD 14 por
 * cada 1.000 búsquedas, y un escaneo lanza docenas. Serper devuelve la ficha de Maps como datos
 * —calificación, reseñas, teléfono, web— por 3 créditos la consulta. Medido en Bogotá · Repostería:
 * 4 consultas, 54 negocios distintos, 25 aceptados por el validador, 12 créditos.
 *
 * Lo que Serper no sabe es si el negocio presta el servicio para eventos: la consulta arrastra
 * tiendas de insumos, escuelas y locales al detal. Eso lo decide la verificación con el agente,
 * que abre la web de cada negocio pero ya no busca proveedores.
 */

const SOURCE_LABEL = 'Google Maps';
const MAX_PER_SCAN = 20;

/**
 * Zonas con las que se amplían los escaneos siguientes. Maps devuelve como mucho 20 fichas por
 * consulta, ordenadas por relevancia: repetir la misma consulta trae lo mismo, y añadir la zona
 * trae negocios distintos del mismo rubro. Agotadas las zonas, el escaneo sale vacío y la corrida
 * se cierra sola por estancamiento.
 */
export const SERPER_SCAN_ZONES = ['norte', 'sur', 'centro', 'occidente', 'oriente'];

export function serperScanQueries(category: string, city: string, scanAttempt: number): string[] {
  const base = categoryQueries(category, city);
  if (scanAttempt <= 1) return base;
  const zone = SERPER_SCAN_ZONES[scanAttempt - 2];
  return zone ? base.map(query => `${query} ${zone}`) : [];
}

function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function phoneKey(value: string | undefined): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * Los negocios de este escaneo que vale la pena verificar: nuevos, contactables y que cumplen el
 * umbral. Lo que ya está en la base o salió en un escaneo anterior de la corrida no se vuelve a
 * pagar; lo que no llega al umbral caería después en el filtro, así que tampoco se verifica.
 */
export function selectSerperCandidates(places: HarvestedPlace[], input: {
  city: string;
  category: string;
  blacklist: CurationBlacklistEntry[];
  existing: ExistingProvider[];
  minRating: number;
  minReviews: number;
  limit: number;
}): { chosen: HarvestedPlace[]; known: number; belowThreshold: number; noContact: number } {
  const blocked = new Set(input.blacklist.map(entry => entry.candidateKey));
  const knownNames = new Set(input.existing.map(provider => normalizeName(provider.displayName)));
  const knownPhones = new Set(input.existing.map(provider => provider.phoneKey).filter(key => key.length >= 10));
  const chosen: HarvestedPlace[] = [];
  let known = 0;
  let belowThreshold = 0;
  let noContact = 0;
  for (const place of places) {
    const phone = phoneKey(place.phone);
    if (blocked.has(curationCandidateKey(place.name, input.city, input.category))
      || knownNames.has(normalizeName(place.name))
      || (phone && knownPhones.has(phone))) { known += 1; continue; }
    if (typeof place.rating !== 'number' || typeof place.reviews !== 'number'
      || place.rating < input.minRating || place.reviews < input.minReviews) { belowThreshold += 1; continue; }
    if (!isContactable(place)) { noContact += 1; continue; }
    if (chosen.length < input.limit) chosen.push(place);
    if (phone) knownPhones.add(phone);
    knownNames.add(normalizeName(place.name));
  }
  return { chosen, known, belowThreshold, noContact };
}

/**
 * Comprueba en el sitio del negocio los correos del lote y quita los que no se sostienen.
 *
 * `verifyBatchContacts` exige además que el móvil esté publicado en el sitio, y eso aquí no aplica:
 * el teléfono sale de la ficha de Maps, que es la fuente, no de lo que escribió el agente. Medido en
 * Bogotá · Repostería: 5 de 5 filas bajaban a revisión porque la pastelería no repite en su web el
 * número de su ficha. El correo sí puede venir del agente, así que ese se comprueba; si no aparece,
 * se quita el correo y la fila sigue por WhatsApp con el número de Maps, en vez de tumbarla entera.
 */
export async function confirmEmailsOnSite(
  tsv: string,
  /**
   * Sitio propio de cada negocio, por nombre. La Fuente URL no sirve: cuando el negocio tiene
   * Instagram, la fila cita la ficha de Maps, y ahí no hay correo que leer. Medido: 3 de 3 correos
   * reales se quitaban por buscarlos en Maps en vez de en la web del negocio.
   */
  websites: Map<string, string> = new Map(),
  check: typeof verifyContact = verifyContact,
): Promise<{ tsv: string; checked: number; removed: number; reasons: string[] }> {
  const lines = tsv.replace(/\r\n?/g, '\n').split('\n');
  const [header, ...rows] = lines;
  let checked = 0;
  let removed = 0;
  const reasons: string[] = [];
  const out = await Promise.all(rows.map(async line => {
    const cells = line.split('\t');
    const email = (cells[15] ?? '').trim();
    if (!email || email.toLowerCase() === 'sin dato') return line;
    checked += 1;
    const site = websites.get(normalizeName(cells[1] ?? '')) ?? cells[16] ?? '';
    const result = await check({ email, phone: '', sourceUrl: site, channel: 'email' });
    if (result.emailConfirmed) return line;
    removed += 1;
    // Solo el dominio: el buzón completo no hace falta para saber por qué se quitó.
    reasons.push(`${email.split('@')[1] ?? '?'}: ${result.reason ?? 'no confirmado'}`.slice(0, 160));
    cells[15] = 'Sin dato';
    return cells.join('\t');
  }));
  return { tsv: [header, ...out].join('\n'), checked, removed, reasons };
}

function emptyResult(model: string, researchSummary: string): GeminiCurationResult {
  return {
    tsv: CURATION_HEADERS.join('\t'),
    researchSummary,
    provider: 'codex',
    model,
    accepted: 0,
    rejected: 0,
    discovered: 0,
    contactable: 0,
    rejectedRows: [],
    contactSummary: summarizeContactChannels([]),
  };
}

export async function curateWithSerper(input: {
  city: string;
  category: string;
  /** Lo acepta por tener la misma firma que el agente; aquí no hay prompt de descubrimiento que lo lea. */
  instructions?: string;
  targetCount?: number;
  remainingCount?: number;
  scanAttempt?: number;
  jobId?: string;
  runId?: string;
  minRating?: number;
  minReviews?: number;
  onPhase?: CurationPhaseReporter;
}): Promise<GeminiCurationResult> {
  const city = input.city.trim();
  const category = input.category.trim();
  if (!city || !category) throw new Error('CITY_AND_CATEGORY_REQUIRED');
  const scanAttempt = input.scanAttempt ?? 1;
  const minRating = input.minRating ?? 4.5;
  const minReviews = input.minReviews ?? 30;
  const threshold = { minRating, minReviews };
  const model = 'Google Maps + verificación';
  const context = { jobId: input.jobId ?? 'sin-job', scanNumber: scanAttempt, role: 'single' as const };
  const report = (detail: string, current: number, label: string) => input.onPhase?.('researching', detail, { current, total: 4, label });

  const queries = serperScanQueries(category, city, scanAttempt);
  if (!queries.length) {
    // Sin más zonas no hay consultas nuevas: el escaneo vacío es lo que cierra la corrida.
    return emptyResult(model, 'Consultas de Google Maps agotadas para esta ciudad y categoría.');
  }

  report(`Buscando en Google Maps: ${queries.join(' · ')}`, 1, 'Buscando candidatos');
  const [blacklist, existing, responses] = await Promise.all([
    getCurationBlacklist(city, category, input.runId),
    getExistingProviders(city),
    Promise.all(queries.map(query => searchSerperMaps(query))),
  ]);
  if (responses.every(places => places === undefined)) throw new Error('SERPER_UNAVAILABLE');

  const byId = new Map<string, HarvestedPlace>();
  for (const places of responses) {
    for (const raw of places ?? []) {
      const place = serperPlaceToHarvested(raw);
      if (place && !byId.has(place.placeId)) byId.set(place.placeId, place);
    }
  }
  const remaining = Math.max(1, input.remainingCount ?? input.targetCount ?? MAX_PER_SCAN);
  const selection = selectSerperCandidates([...byId.values()], {
    city, category, blacklist, existing, minRating, minReviews,
    limit: Math.min(MAX_PER_SCAN, Math.max(8, remaining)),
  });
  logCurationEvent('serper_discovery', {
    ...context,
    queries: queries.length,
    credits: queries.length * SERPER_MAPS_CREDITS,
    fichas: byId.size,
    yaConocidos: selection.known,
    bajoUmbral: selection.belowThreshold,
    sinContacto: selection.noContact,
    elegidos: selection.chosen.length,
  } as never);
  if (!selection.chosen.length) {
    return emptyResult(model, `Google Maps devolvió ${byId.size} negocios, ninguno nuevo que cumpla ${minRating.toFixed(1)} y ${minReviews} reseñas con contacto.`);
  }

  report(`Verificando que ${selection.chosen.length} negocios presten el servicio y leyendo su contacto.`, 2, 'Evaluando reseñas y evidencia');
  const verification = await verifyHarvestedCandidates({
    city, category, candidates: selection.chosen, jobId: input.jobId, sourceLabel: SOURCE_LABEL,
    onPhase: (_phase, detail) => report(detail, 3, 'Extrayendo contacto'),
  });
  const dropped = selection.chosen.filter(place => verification.byPlaceId.get(place.placeId)?.relevant === false);
  // Con la verificación en pie, lo que no presta el servicio se descarta: la consulta por palabra
  // clave arrastra comercio parecido y el validador no sabría distinguirlo. Si la verificación
  // falló, no hay juicio que aplicar y las filas entran con contacto leído del sitio.
  const rows = harvestToCurationTsv(
    { city, category, candidates: selection.chosen, ready: [], apiCalls: queries.length, durationMs: 0, queriesUsed: queries },
    { verification: verification.byPlaceId, dropIrrelevant: true, sourceLabel: SOURCE_LABEL },
  );

  report('Comprobando que el correo esté publicado en el sitio de cada negocio.', 4, 'Validando candidatos');
  const filtered = filterByReputationThreshold(rows.tsv, minRating, minReviews);
  const websites = new Map(selection.chosen
    .filter(place => place.website)
    .map(place => [normalizeName(sanitizeCell(place.name)), place.website as string] as const));
  const emails = await confirmEmailsOnSite(filtered.tsv, websites);
  logCurationEvent('serper_email_check', { ...context, revisados: emails.checked, quitados: emails.removed, motivos: emails.reasons } as never);
  const tsv = emails.tsv;
  const parsed = parseCurationTsv(tsv, threshold);
  const validation = validateCurationBatch(parsed);
  const contactable = parsed.rows.filter(row => hasContactForDiscovery(row.rawCells)).length;

  const researchSummary = [
    `Google Maps: ${queries.length} consultas, ${byId.size} negocios, ${selection.chosen.length} nuevos que cumplen el umbral.`,
    verification.failureReason
      ? `La verificación no terminó (${verification.failureReason}); las filas entran con el contacto leído de su sitio.`
      : `Verificados ${verification.verified}; ${dropped.length} descartados por no prestar el servicio${dropped.length ? `: ${dropped.map(place => place.name).join(', ')}` : ''}.`,
  ].join(' ');
  const result: GeminiCurationResult = {
    tsv,
    researchSummary,
    provider: 'codex',
    model,
    accepted: validation.accepted.length,
    rejected: validation.rejected.length,
    discovered: parsed.rows.length,
    contactable,
    acceptedRows: validation.accepted,
    rejectedRows: validation.rejected,
    contactSummary: summarizeContactChannels(validation.accepted),
  };
  input.onPhase?.('researching', 'Resultados listos; preparando vista previa.', { current: 4, total: 4, label: 'Validando candidatos' }, {
    tsv,
    discovered: result.discovered,
    contactable,
    model,
    rejectedRows: validation.rejected.map(row => ({ line: row.line, issues: row.issues.map(item => ({ message: item.message })) })),
    rows: buildLivePreviewRows(parsed),
  });
  return result;
}
