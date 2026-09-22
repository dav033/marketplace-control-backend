import { CATEGORY_CODE, CURATION_HEADERS } from './curation';
import type { HarvestedPlace, HarvestResult } from './places-harvest';
import type { CandidateVerification } from './harvest-verify';
import { inferAdditionalCategories } from './category-inference';

/**
 * Convierte una cosecha de Google Places en filas TSV de curaduría, sin pasar por el agente.
 *
 * Medido: de los proveedores que el agente devolvía con la cosecha inyectada en su prompt, solo el
 * 17 % procedía de esa lista — descartaba el resto y volvía a descubrir por su cuenta, devolviendo
 * por ejemplo un asador brasileño como proveedor de mantelería. Generar el TSV aquí elimina ese
 * traspaso: la reputación y el contacto llegan tal cual los dio la API.
 *
 * Quince de las veinte columnas salen de Places o se calculan. Las que no se pueden saber se dejan
 * en su valor declarado de ausencia ("Sin dato", "Sin Redes", "No verificado"), nunca inventadas:
 * el correo sigue necesitando una visita al sitio, y segmento, escala y zona son juicios que no se
 * deducen de una ficha. Instagram se rellena cuando el negocio registro su perfil como sitio web en
 * Google, que es lo habitual entre los proveedores pequenos.
 */

/** Códigos de ciudad para el ID. Cualquier otra ciudad cae al alternativo de tres letras. */
const CITY_CODES: Record<string, string> = {
  barranquilla: 'BAQ',
  bogota: 'BOG',
  medellin: 'MDE',
  cali: 'CLO',
  cartagena: 'CTG',
  'santa marta': 'SMR',
  bucaramanga: 'BGA',
};

function normalizeKey(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function cityCode(city: string): string {
  const known = CITY_CODES[normalizeKey(city)];
  if (known) return known;
  const letters = normalizeKey(city).replace(/[^a-z]/g, '').toUpperCase();
  return (letters.slice(0, 3) || 'XXX').padEnd(3, 'X');
}

/**
 * El validador rechaza la fila entera si una celda trae una barra vertical, comillas tipográficas o
 * caracteres de control. Los rótulos de Google los traen a menudo ("Morada Photography | Fotógrafo
 * de bodas"), así que se limpian en vez de perder el candidato.
 */
export function sanitizeCell(value: string): string {
  return value
    .replace(/\|/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Teléfono colombiano tal y como lo exige la curaduría: "+57 3XX XXXXXXX". */
export function toCurationPhone(raw: string | undefined): string {
  if (!raw) return 'Sin dato';
  const digits = raw.replace(/\D/g, '');
  const local = digits.startsWith('57') ? digits.slice(2) : digits;
  if (!/^(?:3\d{9}|6\d{9})$/.test(local)) return 'Sin dato';
  return `+57 ${local.slice(0, 3)} ${local.slice(3)}`;
}

/**
 * Extrae "@usuario" de una URL de perfil de Instagram, en el formato exacto que exige la curaduría.
 * Devuelve undefined para cualquier otra URL, incluidas las de publicaciones o exploración.
 */
export function toInstagramHandle(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  const profile = rawUrl.match(/^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i)?.[1];
  if (!profile) return undefined;
  if (['p', 'reel', 'reels', 'explore', 'stories', 'tv'].includes(profile.toLowerCase())) return undefined;
  return `@${profile}`;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export type HarvestRowOptions = {
  /** Punto de partida de la numeración del ID, para no repetir IDs entre lotes. */
  startIndex?: number;
  verificationDate?: string;
  /** Correo, Instagram y pertinencia que el agente confirmó para cada ficha, por placeId. */
  verification?: Map<string, CandidateVerification>;
  /** Omite los negocios que el agente marcó como no pertinentes para la categoría. */
  dropIrrelevant?: boolean;
};

/**
 * Una fila de curaduría a partir de un negocio cosechado. Devuelve `undefined` cuando falta lo
 * imprescindible: sin reputación o sin una URL directa la fila no podría validarse, y arrastrarla
 * solo ensuciaría el lote.
 */
export function harvestedPlaceToRow(
  place: HarvestedPlace,
  city: string,
  category: string,
  index: number,
  options: HarvestRowOptions = {},
): string[] | undefined {
  const code = CATEGORY_CODE[category];
  if (!code) return undefined;
  if (typeof place.rating !== 'number' || typeof place.reviews !== 'number' || place.reviews <= 0) return undefined;

  // Muchos proveedores pequeños registran su perfil de Instagram como "sitio web" en Google. Ese
  // dato vale más en la columna Instagram que como Fuente URL, y deja la ficha de Maps como fuente.
  const verified = options.verification?.get(place.placeId);
  // Un "no sirve" del agente NO descarta la fila por defecto. Medido: marco como no pertinentes a
  // dos fotografos reales de Barranquilla con 5.0/35 y 4.9/64. Perder en silencio un proveedor
  // bueno es peor que arrastrar uno dudoso, porque el dudoso se ve y el perdido no. La fila entra
  // con la duda escrita en la justificacion para que la resuelva una persona.
  if (options.dropIrrelevant && verified && !verified.relevant) return undefined;
  // El agente solo puede aportar correo, Instagram y pertinencia. La reputación y el teléfono
  // siguen viniendo de Places: son los datos que no debe poder tocar.
  const instagramHandle = verified?.instagram ?? toInstagramHandle(place.website);
  const sourceUrl = (instagramHandle ? place.mapsUrl : place.website) || place.mapsUrl || place.website;
  if (!sourceUrl) return undefined;

  const rating = place.rating.toFixed(1);
  const reviews = String(place.reviews);
  const level = place.reviews >= 50 ? 'A' : 'B';
  const name = sanitizeCell(place.name);
  if (!name) return undefined;

  // La justificación debe repetir calificación, reseñas y plataforma: el validador las vuelve a
  // buscar dentro del texto para que ninguna cifra quede sin respaldo visible.
  const reason = sanitizeCell(
    `Calificación ${rating} con ${reviews} reseñas públicas en Google, obtenidas de la API oficial de Places el ${options.verificationDate ?? todayIso()}. `
    + `${place.type ? `Google lo clasifica como ${place.type}. ` : ''}`
    + (verified && !verified.relevant
      ? `REQUIERE REVISIÓN: el agente no pudo confirmar que preste el servicio de ${category}${verified.note ? ` (${verified.note})` : ''}. Verifícalo antes de contactar.`
      : verified?.note
        ? `Verificado por el agente: ${verified.note}`
        : 'Falta confirmar correo electrónico e Instagram, que la API no entrega.'),
  );

  const row = new Array<string>(CURATION_HEADERS.length).fill('Sin dato');
  row[0] = `${cityCode(city)}-${code}-${String(index).padStart(3, '0')}`;
  row[1] = name;
  row[2] = category;
  row[3] = 'Sin clasificar';
  row[4] = sanitizeCell(city);
  row[5] = 'Sin dato';
  row[6] = 'Sin dato';
  row[7] = 'No verificado';
  row[8] = rating;
  row[9] = reviews;
  row[10] = 'Google';
  row[11] = level;
  row[12] = reason;
  row[13] = toCurationPhone(place.phone);
  row[14] = instagramHandle ?? 'Sin Redes';
  row[15] = verified?.email ?? 'Sin dato';
  row[16] = sanitizeCell(sourceUrl);
  row[17] = options.verificationDate ?? todayIso();
  row[18] = `Google:${rating}:${reviews}`;
  // Categorías adicionales: la cosecha solo sabe la categoría que buscó, pero el nombre y el tipo de
  // Google suelen delatar las demás ("Alquiler de mobiliario y menaje", "Salón de eventos y catering").
  // Antes esta columna iba siempre en "Sin dato" y ningún proveedor cosechado tenía más de una.
  const adicionales = inferAdditionalCategories({ name: place.name, type: place.type }, category);
  row[19] = adicionales.length ? adicionales.join('; ') : 'Sin dato';
  return row;
}

export type HarvestTsvResult = {
  tsv: string;
  rows: number;
  skipped: number;
};

/** TSV completo, con encabezado, listo para el mismo validador e importador que usa el agente. */
export function harvestToCurationTsv(result: HarvestResult, options: HarvestRowOptions = {}): HarvestTsvResult {
  const lines: string[] = [CURATION_HEADERS.join('\t')];
  let index = options.startIndex ?? 1;
  let skipped = 0;
  for (const place of result.candidates) {
    const row = harvestedPlaceToRow(place, result.city, result.category, index, options);
    if (!row) { skipped += 1; continue; }
    lines.push(row.join('\t'));
    index += 1;
  }
  return { tsv: lines.join('\n'), rows: lines.length - 1, skipped };
}
