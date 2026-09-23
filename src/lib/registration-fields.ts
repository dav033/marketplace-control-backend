/**
 * Validación de los campos de registro de un proveedor.
 *
 * La usan los dos caminos que producen una ficha —el formulario web (`/api/public/form-submit`) y
 * el chat de registro (`registration-chat.ts`)— con las mismas reglas: dos validaciones paralelas
 * acabarían separándose, y entonces uno aceptaría fichas que el otro rechaza.
 */

/** Donde el proveedor completa su ficha por su cuenta. Solo sirve si su ciudad ya está abierta. */
export const REGISTER_URL = 'https://www.happia.co/register';

/** Las 11 categorías oficiales de curaduría; nada fuera de esta lista entra como servicio. */
export const OFFICIAL_CATEGORIES = new Set([
  'Lugar', 'Comida y Bebida', 'Música', 'Servicios Especializados', 'Entretenimiento',
  'Decoración temática', 'Fotografía y Video', 'Invitación digital', 'Menaje y mantelería', 'Carpas y mobiliario',
  'Repostería y pastelería',
]);

/**
 * El formulario manda productos y servicios como JSON dentro de un campo oculto. Se sanea aquí y no
 * se confía en los límites del navegador: el envío puede venir de cualquier cliente.
 */
export function parseList(raw: string, max: number, allowed?: Set<string>): string[] | undefined {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(parsed)) return undefined;
  const clean: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') return undefined;
    const value = entry.replace(/\s+/g, ' ').trim();
    if (!value || value.length > 60) return undefined;
    if (allowed && !allowed.has(value)) return undefined;
    if (!clean.includes(value)) clean.push(value);
  }
  return clean.length > max ? undefined : clean;
}

export function parseVolume(rawMin: string, rawMax: string): { min: number; max: number } | undefined {
  const min = Number(rawMin);
  const max = Number(rawMax);
  if (!Number.isInteger(min) || !Number.isInteger(max)) return undefined;
  if (min < 1 || max < min || max > 100000) return undefined;
  return { min, max };
}
