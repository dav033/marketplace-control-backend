export const CURATION_HEADERS = [
  'ID',
  'Nombre Comercial',
  'Categoría',
  'Segmento',
  'Ciudad',
  'Zona Estandarizada',
  'Escala',
  'Formalidad',
  'Calificación',
  'Nº Reseñas',
  'Plataforma Reputación',
  'Nivel Curaduría',
  'Por qué pasa la Curaduría',
  'Teléfono',
  'Instagram',
  'Correo Electronico',
  'Fuente URL',
  'Fecha Verificación',
] as const;

export type ProviderType = 1 | 2;

export type CurationFields = {
  id: string;
  displayName: string;
  category: string;
  segment: 'Bajo Costo' | 'Premium' | 'Sin clasificar';
  city: string;
  zone: string;
  scale: string;
  formality: string;
  rating: number;
  reviewCount: number;
  platform: string;
  curationLevel: 'A' | 'B';
  curationReason: string;
  phone: string;
  instagram: string;
  email: string;
  sourceUrl: string;
  verificationDate: string;
};

export type CurationIssue = {
  line: number;
  code: string;
  message: string;
};

export type ParsedCurationRow = {
  line: number;
  rawLine: string;
  rawCells: string[];
  rawRecord: Record<string, string>;
  fields?: CurationFields;
  providerType?: ProviderType;
  issues: CurationIssue[];
};

export type ParsedCurationBatch = {
  rows: ParsedCurationRow[];
  fatalErrors: CurationIssue[];
};

export type ValidatedCurationRow = ParsedCurationRow & {
  fields: CurationFields;
  providerType: ProviderType;
  dedupeKey: string;
  rawEvidence: {
    rawTsv: string;
    rawColumns: Record<string, string>;
    normalized: CurationFields;
    providerType: ProviderType;
  };
};

export type CurationBatchResult = {
  accepted: ValidatedCurationRow[];
  rejected: ParsedCurationRow[];
};

const CATEGORY_BY_KEY: Record<string, string> = {
  '1': 'Lugar',
  lugar: 'Lugar',
  '2': 'Comida y Bebida',
  'comida y bebida': 'Comida y Bebida',
  '3': 'Música',
  musica: 'Música',
  '4': 'Servicios Especializados',
  'servicios especializados': 'Servicios Especializados',
  '5': 'Entretenimiento',
  entretenimiento: 'Entretenimiento',
  '6': 'Decoración temática',
  'decoracion tematica': 'Decoración temática',
  '7': 'Fotografía y Video',
  'fotografia y video': 'Fotografía y Video',
  '8': 'Invitación digital',
  'invitacion digital': 'Invitación digital',
  '9': 'Menaje y mantelería',
  'menaje y manteleria': 'Menaje y mantelería',
  '10': 'Carpas y mobiliario',
  'carpas y mobiliario': 'Carpas y mobiliario',
};

const CATEGORY_CODE: Record<string, string> = {
  Lugar: '01',
  'Comida y Bebida': '02',
  Música: '03',
  'Servicios Especializados': '04',
  Entretenimiento: '05',
  'Decoración temática': '06',
  'Fotografía y Video': '07',
  'Invitación digital': '08',
  'Menaje y mantelería': '09',
  'Carpas y mobiliario': '10',
};

const ZONE_BY_KEY: Record<string, string> = {
  'zona norte / comercial alta': 'Zona Norte / Comercial Alta',
  'zona centro / tradicional': 'Zona Centro / Tradicional',
  'zona sur / occidente comercial': 'Zona Sur / Occidente Comercial',
  'zona campestre / periferia': 'Zona Campestre / Periferia',
  'area metropolitana': 'Área Metropolitana',
  'cobertura nacional': 'Cobertura Nacional',
  'sin dato': 'Sin dato',
};

const SCALE_BY_KEY: Record<string, string> = {
  'pequeno (hasta 50 pers.)': 'Pequeño (Hasta 50 pers.)',
  'mediano (50 a 200 pers.)': 'Mediano (50 a 200 pers.)',
  'masivo (mas de 200 pers.)': 'Masivo (Más de 200 pers.)',
  'sin dato': 'Sin dato',
};

const FORMALITY_BY_KEY: Record<string, string> = {
  'formalizado (nit - empresa)': 'Formalizado (NIT - Empresa)',
  'independiente (rut - persona natural)': 'Independiente (RUT - Persona Natural)',
  'no verificado': 'No verificado',
};

const PLATFORM_BY_KEY: Record<string, string> = {
  google: 'Google',
  'matrimonios.com.co': 'Matrimonios.com.co',
  'bodas.com.co': 'Bodas.com.co',
  tripadvisor: 'TripAdvisor',
  booking: 'Booking',
  'booking.com': 'Booking',
  facebook: 'Facebook',
  rappi: 'Rappi',
  didi: 'DiDi',
  'didi food': 'DiDi',
};

const EXPECTED_HEADER_KEYS = CURATION_HEADERS.map(header => normalizeKey(header));

function normalizeKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function cleanText(value: string): string {
  return value.trim().replace(/[ \t]+/g, ' ');
}

function issue(line: number, code: string, message: string): CurationIssue {
  return { line, code, message };
}

function valueAt(cells: string[], index: number): string {
  return cleanText(cells[index] ?? '');
}

function parseRating(value: string): number | undefined {
  if (!/^[0-5][.,]\d$/.test(value)) return undefined;
  const parsed = Number(value.replace(',', '.'));
  return parsed <= 5 ? parsed : undefined;
}

function parseReviewCount(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizePhone(value: string): string | undefined {
  if (normalizeKey(value) === 'sin dato') return 'Sin dato';
  if (/[;,/]|\band\b/i.test(value)) return undefined;
  const digits = value.replace(/\D/g, '');
  const local = digits.startsWith('57') ? digits.slice(2) : digits;
  if (!/^(?:3\d{9}|6\d{9})$/.test(local)) return undefined;
  return `+57 ${local.slice(0, 3)} ${local.slice(3)}`;
}

function normalizeInstagram(value: string): string | undefined {
  if (normalizeKey(value) === 'sin redes') return 'Sin Redes';
  const profile = value.match(/^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i)?.[1];
  const handle = profile ? `@${profile}` : value;
  return /^@[A-Za-z0-9._]{1,30}$/.test(handle) ? handle : undefined;
}

function normalizeEmail(value: string): string | undefined {
  if (normalizeKey(value) === 'sin dato') return 'Sin dato';
  const email = value.toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return undefined;
  return email;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isDirectSourceUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return false;
    const path = url.pathname.toLowerCase();
    if (path.includes('/search')) return false;
    for (const [key] of url.searchParams) {
      if (['q', 'query', 'search_query'].includes(key.toLowerCase())) return false;
    }
    if (url.searchParams.get('api') === '1' && url.searchParams.has('query')) return false;
    return true;
  } catch {
    return false;
  }
}

function containsForbiddenFormatting(value: string): boolean {
  return value.includes('|') || /[“”‘’]/u.test(value) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value);
}

function inferProviderType(fields: Pick<CurationFields, 'category' | 'displayName' | 'curationReason'>): ProviderType {
  if (fields.category === 'Lugar') return 1;
  if (fields.category !== 'Comida y Bebida') return 2;

  const name = normalizeKey(fields.displayName);
  const evidence = normalizeKey(`${fields.displayName} ${fields.curationReason}`);
  const conventionalRestaurant = /\b(restaurante|hotel|cafeteria|bar)\b/u.test(name);
  const madeToOrder = /\b(catering|caterin|banquete|banqueter|barras? de cocteleria|bartender|servicio de alimentacion|buffet|chef para eventos)\b/u.test(evidence);
  return madeToOrder && !conventionalRestaurant ? 2 : 1;
}

function normalizeRow(cells: string[], line: number, rawLine: string, rawRecord: Record<string, string>): ParsedCurationRow {
  const issues: CurationIssue[] = [];
  if (cells.some(cell => cleanText(cell) === '')) issues.push(issue(line, 'empty_cell', 'Cada columna debe tener un valor; usa "Sin dato" o "Sin Redes" cuando corresponda.'));
  if (cells.some(containsForbiddenFormatting)) issues.push(issue(line, 'forbidden_formatting', 'La fila contiene una barra vertical, comillas decorativas o caracteres de control.'));

  const id = valueAt(cells, 0).toUpperCase();
  const displayName = valueAt(cells, 1);
  const category = CATEGORY_BY_KEY[normalizeKey(valueAt(cells, 2))];
  const segmentKey = normalizeKey(valueAt(cells, 3));
  const segment = ({ 'bajo costo': 'Bajo Costo', premium: 'Premium', 'sin clasificar': 'Sin clasificar' } as const)[segmentKey];
  const city = valueAt(cells, 4);
  const zone = ZONE_BY_KEY[normalizeKey(valueAt(cells, 5))];
  const scale = SCALE_BY_KEY[normalizeKey(valueAt(cells, 6))];
  const formality = FORMALITY_BY_KEY[normalizeKey(valueAt(cells, 7))];
  const ratingValue = valueAt(cells, 8);
  const rating = parseRating(ratingValue);
  const reviewValue = valueAt(cells, 9);
  const reviewCount = parseReviewCount(reviewValue);
  const platform = PLATFORM_BY_KEY[normalizeKey(valueAt(cells, 10))] ?? valueAt(cells, 10);
  const curationLevel = valueAt(cells, 11).toUpperCase();
  const curationReason = valueAt(cells, 12);
  const phone = normalizePhone(valueAt(cells, 13));
  const instagram = normalizeInstagram(valueAt(cells, 14));
  const email = normalizeEmail(valueAt(cells, 15));
  const sourceUrl = valueAt(cells, 16);
  const verificationDate = valueAt(cells, 17);

  if (!/^[A-Z]{3}-\d{2}-\d{3}$/.test(id)) issues.push(issue(line, 'invalid_id', 'El ID debe tener el formato COD-CC-###.'));
  if (category === undefined) issues.push(issue(line, 'invalid_category', 'La categoría no pertenece a las 10 categorías oficiales.'));
  else if (/^[A-Z]{3}-\d{2}-\d{3}$/.test(id) && id.slice(4, 6) !== CATEGORY_CODE[category]) issues.push(issue(line, 'category_id_mismatch', 'El código de categoría del ID no coincide con la categoría.'));
  if (!displayName || normalizeKey(displayName) === 'sin dato') issues.push(issue(line, 'invalid_name', 'El nombre comercial es obligatorio.'));
  if (!segment) issues.push(issue(line, 'invalid_segment', 'Segmento debe ser Bajo Costo, Premium o Sin clasificar.'));
  if (!city || normalizeKey(city) === 'sin dato') issues.push(issue(line, 'invalid_city', 'La ciudad es obligatoria.'));
  if (!zone) issues.push(issue(line, 'invalid_zone', 'Zona Estandarizada no tiene un valor permitido.'));
  if (!scale) issues.push(issue(line, 'invalid_scale', 'Escala no tiene un valor permitido.'));
  if (!formality) issues.push(issue(line, 'invalid_formality', 'Formalidad no tiene un valor permitido.'));
  if (rating === undefined) issues.push(issue(line, 'invalid_rating', 'La calificación debe ser una cifra exacta entre 4.5 y 5.0 con un decimal.'));
  if (reviewCount === undefined) issues.push(issue(line, 'invalid_review_count', 'Nº Reseñas debe ser un entero exacto sin separadores.'));
  if (!platform || normalizeKey(platform) === 'sin dato' || normalizeKey(platform) === 'instagram') issues.push(issue(line, 'invalid_platform', 'La plataforma de reputación es obligatoria y no puede ser Instagram.'));
  if (!['A', 'B'].includes(curationLevel)) issues.push(issue(line, 'invalid_curation_level', 'Nivel Curaduría debe ser A o B.'));
  if (!curationReason || normalizeKey(curationReason) === 'sin dato') issues.push(issue(line, 'missing_curation_reason', 'Por qué pasa la Curaduría debe explicar reputación y capacidad para eventos.'));
  if (phone === undefined) issues.push(issue(line, 'invalid_phone', 'Teléfono debe ser un único número colombiano normalizado o Sin dato.'));
  if (instagram === undefined) issues.push(issue(line, 'invalid_instagram', 'Instagram debe ser @usuario, una URL de Instagram o Sin Redes.'));
  if (email === undefined) issues.push(issue(line, 'invalid_email', 'Correo Electronico debe ser un correo válido o Sin dato.'));
  if (!isDirectSourceUrl(sourceUrl)) issues.push(issue(line, 'invalid_source_url', 'Fuente URL debe ser una URL HTTP(S) directa de la ficha, no una búsqueda.'));
  if (!isValidDate(verificationDate)) issues.push(issue(line, 'invalid_verification_date', 'Fecha Verificación debe tener formato AAAA-MM-DD y ser una fecha válida.'));

  if (rating !== undefined && reviewCount !== undefined && category !== undefined && segment && zone && scale && formality && phone && instagram && email) {
    const normalizedFields: CurationFields = {
      id,
      displayName,
      category,
      segment,
      city,
      zone,
      scale,
      formality,
      rating,
      reviewCount,
      platform,
      curationLevel: curationLevel as 'A' | 'B',
      curationReason,
      phone,
      instagram,
      email,
      sourceUrl,
      verificationDate,
    };
    const providerType = inferProviderType(normalizedFields);
    const minimumReviews = providerType === 1 ? 50 : 15;
    const expectedLevel = reviewCount >= 50 ? 'A' : 'B';
    if (reviewCount < minimumReviews) issues.push(issue(line, 'insufficient_reviews', `Tipo ${providerType} requiere al menos ${minimumReviews} reseñas exactas.`));
    if (curationLevel !== expectedLevel || (curationLevel === 'B' && providerType !== 2)) issues.push(issue(line, 'invalid_curation_level_for_threshold', `Nivel ${expectedLevel} no coincide con el volumen o el Tipo ${providerType}.`));
    if (rating < 4.5) issues.push(issue(line, 'low_rating', 'La calificación mínima de curaduría es 4.5.'));
    const reasonKey = normalizeKey(curationReason);
    const reasonHasRating = curationReason.replace(',', '.').includes(rating.toFixed(1));
    const reasonHasReviews = new RegExp(`(?:^|\\D)${reviewCount}(?:\\D|$)`).test(curationReason.replace(/[.,]/g, ' '));
    const reasonHasPlatform = reasonKey.includes(normalizeKey(platform));
    if (!reasonHasRating || !reasonHasReviews || !reasonHasPlatform) issues.push(issue(line, 'invalid_curation_reason', 'La justificación debe conservar calificación, reseñas y plataforma de la evidencia.'));

    return { line, rawLine, rawCells: cells, rawRecord, fields: normalizedFields, providerType, issues };
  }

  return { line, rawLine, rawCells: cells, rawRecord, issues };
}

export function parseCurationTsv(input: string): ParsedCurationBatch {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text) return { rows: [], fatalErrors: [issue(1, 'empty_input', 'El TSV está vacío.')] };

  let lines = text.split('\n');
  while (lines.at(-1) === '') lines.pop();
  if (lines[0].trim() === '```' && lines.at(-1)?.trim() === '```') lines = lines.slice(1, -1);
  if (!lines.length || !lines[0].trim()) return { rows: [], fatalErrors: [issue(1, 'missing_header', 'El TSV necesita la línea de encabezados de 18 columnas.')] };

  const headerCells = lines[0].split('\t').map(cleanText);
  const headerKeys = headerCells.map(normalizeKey);
  const headerValid = headerCells.length === CURATION_HEADERS.length && headerKeys.every((header, index) => header === EXPECTED_HEADER_KEYS[index]);
  if (!headerValid) return { rows: [], fatalErrors: [issue(1, 'invalid_header', `El encabezado debe contener exactamente las 18 columnas de curaduría, en el orden definido.`)] };

  const rows: ParsedCurationRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = index + 1;
    if (!rawLine.trim()) {
      rows.push({ line, rawLine, rawCells: [], rawRecord: {}, issues: [issue(line, 'blank_row', 'La fila está vacía; no se puede importar.') ] });
      continue;
    }
    const rawCells = rawLine.split('\t');
    const rawRecord = Object.fromEntries(CURATION_HEADERS.map((header, position) => [header, rawCells[position] ?? '']));
    if (rawCells.length !== CURATION_HEADERS.length) {
      rows.push({ line, rawLine, rawCells, rawRecord, issues: [issue(line, 'column_count', `La fila tiene ${rawCells.length} columnas; debe tener exactamente 18.`)] });
      continue;
    }
    rows.push(normalizeRow(rawCells, line, rawLine, rawRecord));
  }

  if (!rows.length) return { rows: [], fatalErrors: [issue(2, 'missing_rows', 'El TSV necesita al menos una fila de datos.')] };
  return { rows, fatalErrors: [] };
}

export function validateCurationBatch(parsed: ParsedCurationBatch): CurationBatchResult {
  const accepted: ValidatedCurationRow[] = [];
  const rejected: ParsedCurationRow[] = parsed.rows.filter(row => row.issues.length > 0);
  const providerKeys = new Set<string>();
  const sourceUrls = new Set<string>();

  for (const row of parsed.rows) {
    if (row.issues.length > 0 || !row.fields || !row.providerType) continue;
    const fields = row.fields;
    const providerType = row.providerType;
    const dedupeKey = `${normalizeKey(fields.displayName)}|${normalizeKey(fields.city)}|${normalizeKey(fields.category)}`;
    const sourceKey = fields.sourceUrl.toLowerCase();
    if (providerKeys.has(dedupeKey)) {
      row.issues.push(issue(row.line, 'duplicate_provider', 'El proveedor ya aparece en este lote.'));
      rejected.push(row);
      continue;
    }
    if (sourceUrls.has(sourceKey)) {
      row.issues.push(issue(row.line, 'duplicate_source', 'La Fuente URL ya aparece en este lote.'));
      rejected.push(row);
      continue;
    }
    providerKeys.add(dedupeKey);
    sourceUrls.add(sourceKey);
    accepted.push({
      ...row,
      fields,
      providerType,
      dedupeKey,
      rawEvidence: {
        rawTsv: row.rawLine,
        rawColumns: row.rawRecord,
        normalized: fields,
        providerType,
      },
    });
  }
  return { accepted, rejected };
}
