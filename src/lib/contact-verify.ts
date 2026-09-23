import { resolveMx } from 'node:dns/promises';
import { fetchPage } from './contact-scrape';
import { CURATION_HEADERS, parseCurationTsv, validateCurationBatch, type CurationThreshold, type ValidatedCurationRow } from './curation';
import { logCurationEvent, type ClaudeRunContext } from './curation-log';

/**
 * Verificación determinista del contacto ANTES de dar una fila por válida.
 *
 * Auditado a mano sobre 20 filas aceptadas en Cartagena (2026-09-22): el agente acertó el contacto
 * de forma comprobable en unos dos tercios; el resto eran buzones equivocados dentro del dominio
 * correcto (hojas de vida, una persona), móviles distintos al publicado o sitios que no se pudieron
 * leer. Este paso repite esa auditoría con código: lee el sitio del negocio y exige que el correo o
 * el móvil que dice el agente aparezcan publicados. Si no puede confirmarlo, la fila no se aprueba:
 * queda en revisión con el motivo escrito. No corrige datos ni inventa nada.
 */

export const CONTACT_UNVERIFIED_MARKER = '[Contacto no comprobado:';

/** Buzones que existen en el dominio correcto pero no sirven para vender: nunca cuentan como contacto comercial. */
export const NON_COMMERCIAL_MAILBOX = /^(hojas?devida|hojadevida|rrhh|recursoshumanos|talento(humano)?|empleos?|vacantes|cv|curriculum|nomina|contabilidad|facturacion(electronica)?|juridico|legal|pqrs?|habeasdata|tesoreria|cartera|proveedores|compras|notificaciones(judiciales)?)@/i;
/** "nombre.apellido@": un buzón personal solo vale si el sitio lo publica. */
const PERSONAL_MAILBOX = /^[a-z]+[._-][a-z]+@/i;
const SOCIAL_OR_AGGREGATOR = /(instagram\.com|facebook\.com|fb\.com|threads\.com|linktr\.ee|tiktok\.com|wa\.link|wa\.me|whatsapp\.com|ineventos\.com|planetacolombia\.com|informacolombia\.com|banquete\.com\.co|ueniweb\.com|wanderlog\.com|tripadvisor\.|rappi\.com|restaurantguru\.com|cybo\.com)/i;
const CONTACT_PATHS = ['/contacto', '/contact', '/contactenos', '/contactanos', '/nosotros', '/about'];
const CONCURRENCY = 4;

export type ContactCheck = {
  ok: boolean;
  /** Motivo en español cuando no se pudo confirmar; va a la justificación de la fila. */
  reason?: string;
  emailConfirmed: boolean;
  phoneConfirmed: boolean;
  pagesRead: number;
  sourceStatus: number;
};

function phoneKey(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const local = digits.startsWith('57') && digits.length === 12 ? digits.slice(2) : digits.slice(-10);
  return local.length === 10 ? local : '';
}

function candidatePages(sourceUrl: string): { base: URL; pages: string[] } | undefined {
  let base: URL;
  try {
    base = new URL(sourceUrl.includes('://') ? sourceUrl : `https://${sourceUrl}`);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(base.protocol)) return undefined;
  const root = new URL('/', base).toString();
  const pages = [base.toString(), root, ...CONTACT_PATHS.map(path => new URL(path, base).toString())];
  return { base, pages: [...new Set(pages)] };
}

async function hasMx(domain: string): Promise<boolean> {
  try { return (await resolveMx(domain)).length > 0; } catch { return false; }
}

/**
 * Comprueba el contacto de una fila contra su sitio. `sourceUrl` es la URL fuente de la fila; un
 * perfil de red social o un agregador no se puede leer, así que el contacto queda sin comprobar.
 */
export async function verifyContact(input: { email: string; phone: string; sourceUrl: string; channel: 'email' | 'whatsapp' }): Promise<ContactCheck> {
  const email = input.email.trim().toLowerCase();
  const hasEmail = Boolean(email) && email !== 'sin dato';
  const phone = phoneKey(input.phone);
  const result: ContactCheck = { ok: false, emailConfirmed: false, phoneConfirmed: false, pagesRead: 0, sourceStatus: 0 };

  if (hasEmail && NON_COMMERCIAL_MAILBOX.test(email)) {
    return { ...result, reason: `el correo ${email} es un buzón no comercial (hojas de vida, RR. HH., contabilidad)` };
  }
  if (SOCIAL_OR_AGGREGATOR.test(input.sourceUrl)) {
    return { ...result, reason: 'la fuente es un perfil en redes o un agregador y el contacto no se puede leer ahí; confírmalo a mano' };
  }
  const target = candidatePages(input.sourceUrl);
  if (!target) return { ...result, reason: 'la URL fuente no es una dirección legible' };

  const needEmail = input.channel === 'email' && hasEmail;
  const needPhone = input.channel === 'whatsapp' || !needEmail;
  const sitePhones = new Set<string>();
  for (const url of target.pages) {
    const { status, html } = await fetchPage(url);
    if (url === target.pages[0]) result.sourceStatus = status;
    if (!html) continue;
    result.pagesRead += 1;
    const lower = html.toLowerCase();
    if (hasEmail && (lower.includes(email) || lower.includes(`mailto:${email}`))) result.emailConfirmed = true;
    // Los números se comparan sin separadores: "+57 (317) 501-1415" y "3175011415" son el mismo.
    const compact = html.replace(/[\s().\- ]/g, '');
    if (phone && compact.includes(phone)) result.phoneConfirmed = true;
    for (const match of compact.match(/(?:\+?57)?3[0-5]\d{8}/g) ?? []) sitePhones.add(match.slice(-10));
    if ((!needEmail || result.emailConfirmed) && (!needPhone || result.phoneConfirmed)) break;
  }

  if (result.pagesRead === 0) {
    const blocked = result.sourceStatus === 403 || result.sourceStatus === 429;
    return { ...result, reason: blocked ? 'el sitio bloquea la lectura automática; confírmalo a mano' : `el sitio no respondió (HTTP ${result.sourceStatus || 'sin conexión'})` };
  }

  if (needEmail && !result.emailConfirmed) {
    const domain = email.split('@')[1] ?? '';
    const siteRoot = target.base.hostname.replace(/^www\./, '').split('.')[0];
    const sameRoot = domain.replace(/^www\./, '').split('.')[0] === siteRoot;
    const personal = PERSONAL_MAILBOX.test(email);
    // Un buzón genérico del propio dominio con correo configurado se acepta aunque no esté en la
    // portada: muchos sitios solo tienen un formulario. Uno personal o de otro dominio, no.
    if (sameRoot && !personal && await hasMx(domain)) {
      result.emailConfirmed = true;
    } else {
      return { ...result, reason: personal ? `el correo ${email} parece un buzón personal y el sitio no lo publica` : sameRoot ? `el dominio de ${email} no recibe correo (sin MX)` : `el correo ${email} es de otro dominio y el sitio no lo publica` };
    }
  }
  if (needPhone && !result.phoneConfirmed) {
    const published = [...sitePhones].filter(p => p !== phone).slice(0, 2);
    return { ...result, reason: published.length ? `el móvil ${input.phone} no aparece en el sitio, que publica ${published.join(' y ')}` : `el móvil ${input.phone} no aparece en el sitio` };
  }
  result.ok = true;
  return result;
}

export type BatchContactVerification = { tsv: string; checked: number; confirmed: number; demoted: number; unreadable: number };

/**
 * Verifica las filas que el validador daría por válidas y marca en la justificación las que no se
 * pudieron confirmar. El marcador lo reconoce `validateCurationBatch` como `contact_unverified`,
 * así que la fila sigue completa (nombre, cifras, contacto, URL) pero queda en revisión.
 */
export async function verifyBatchContacts(tsv: string, threshold?: CurationThreshold, context?: ClaudeRunContext): Promise<BatchContactVerification> {
  const lines = tsv.replace(/\r\n?/g, '\n').split('\n');
  const header = lines[0] ?? CURATION_HEADERS.join('\t');
  const parsed = parseCurationTsv(tsv, threshold);
  const validation = parsed.fatalErrors.length ? { accepted: [] as ValidatedCurationRow[] } : validateCurationBatch(parsed);
  const byLine = new Map(validation.accepted.map(row => [row.line, row]));
  const outcome: BatchContactVerification = { tsv, checked: 0, confirmed: 0, demoted: 0, unreadable: 0 };
  if (!byLine.size) return outcome;

  const rows = lines.slice(1);
  const updated = [...rows];
  const targets = [...byLine.values()];
  for (let start = 0; start < targets.length; start += CONCURRENCY) {
    const batch = targets.slice(start, start + CONCURRENCY);
    const checks = await Promise.all(batch.map(row => verifyContact({
      email: row.fields.email, phone: row.fields.phone, sourceUrl: row.fields.sourceUrl, channel: row.contactChannel,
    }).catch((): ContactCheck => ({ ok: false, reason: 'error al leer el sitio', emailConfirmed: false, phoneConfirmed: false, pagesRead: 0, sourceStatus: 0 }))));
    for (let index = 0; index < batch.length; index += 1) {
      const row = batch[index];
      const check = checks[index];
      outcome.checked += 1;
      if (check.ok) { outcome.confirmed += 1; continue; }
      outcome.demoted += 1;
      if (check.pagesRead === 0) outcome.unreadable += 1;
      const cells = (updated[row.line - 2] ?? row.rawLine).split('\t');
      if (!cells[12]?.includes(CONTACT_UNVERIFIED_MARKER)) {
        cells[12] = `${(cells[12] ?? '').trim()} ${CONTACT_UNVERIFIED_MARKER} ${check.reason}]`.slice(0, 900);
      }
      updated[row.line - 2] = cells.join('\t');
    }
  }
  outcome.tsv = [header, ...updated].join('\n');
  if (context) logCurationEvent('contact_verification', { ...context, checked: outcome.checked, confirmed: outcome.confirmed, demoted: outcome.demoted, unreadable: outcome.unreadable });
  return outcome;
}
