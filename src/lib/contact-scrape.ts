/**
 * Extrae correo e Instagram del sitio web del proveedor, leyendo la página.
 *
 * Sustituye a pedírselo al agente. Medido en una corrida real de verificación: 5 búsquedas web y
 * CERO aperturas de página, así que encontró 0 correos de 3 candidatos. El correo casi nunca está
 * en los resultados de búsqueda — está dentro del sitio, y a menudo en /contacto, no en la portada.
 * Descargar dos páginas y leerlas tarda un segundo y no puede inventarse una dirección.
 */

export type ScrapedContact = {
  email?: string;
  instagram?: string;
  /** Página donde se encontró, para dejar rastro de la evidencia. */
  foundAt?: string;
  /**
   * Calificación que el propio sitio declara en su JSON-LD (`aggregateRating` de schema.org). Es
   * un dato AUTODECLARADO por el negocio: sirve de pista para quien revisa, nunca de verificación.
   */
  selfDeclaredRating?: SelfDeclaredRating;
};

export type SelfDeclaredRating = { rating: number; reviews: number; foundAt: string };

/** Rutas habituales de contacto en sitios colombianos, en orden de probabilidad. */
const CONTACT_PATHS = ['/contacto', '/contact', '/nosotros', '/about', '/contactanos', '/contáctanos'];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;
const INSTAGRAM_RE = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})/gi;

/** Perfiles reservados de Instagram que no identifican a un negocio. */
const INSTAGRAM_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts', 'about', 'developer', 'legal']);
/** Un recurso estatico incrustado en la pagina: "instagram.com/rsrc.php" no es una cuenta. */
const INSTAGRAM_FILE_LIKE = /\.(?:php|js|css|html?|json|png|jpe?g|gif|svg|ico)$/i;

/**
 * Correo de un tercero. Las agencias que montan el sitio dejan el suyo en el pie, y acaba
 * repetido en proveedores sin relacion: "cliente@gurusoluciones.com" aparecio en dos negocios
 * distintos de esta prueba. Solo se acepta el correo del propio dominio o uno de correo gratuito,
 * que es el que usan de verdad los proveedores pequenos.
 */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'hotmail.com', 'hotmail.es', 'outlook.com', 'outlook.es', 'yahoo.com', 'yahoo.es',
  'live.com', 'icloud.com', 'protonmail.com', 'proton.me', 'aol.com',
]);

/**
 * Descarta lo que parece un correo pero no lo es. El caso frecuente no es el correo falso sino el
 * nombre de fichero: "logo@2x.png" cumple el patrón de correo y acabaría en la base de datos.
 */
const REJECTED_DOMAINS = /(?:example|dominio|tudominio|domain|email|sentry\.io|wixpress|godaddy|squarespace|shopify|cloudflare)\./i;
const FILE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|svg|css|js|woff2?|ttf|ico|mp4|pdf)$/i;
const PLACEHOLDER_LOCAL = /^(?:tu|your|nombre|name|correo|email|usuario|user|test|ejemplo|sample|no-?reply|noreply|donotreply)$/i;

export function isPlausibleEmail(value: string): boolean {
  const email = value.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return false;
  if (FILE_EXTENSIONS.test(email)) return false;
  if (REJECTED_DOMAINS.test(email)) return false;
  const [local, domain] = email.split('@');
  if (!local || !domain || PLACEHOLDER_LOCAL.test(local)) return false;
  // Un "@2x" de un recurso gráfico: la parte local es solo dígitos y una letra de escala.
  if (/^\d+x$/i.test(local)) return false;
  if (!domain.includes('.') || domain.endsWith('.')) return false;
  return true;
}

/** Raiz del dominio: "lastrinitarias" de "lastrinitarias.com.co" o de "www.lastrinitarias.com". */
function domainRoot(domain: string): string {
  return (domain.replace(/^www\./, '').split('.')[0] ?? '').toLowerCase();
}

function sharesRoot(emailDomain: string, siteHost: string): boolean {
  const a = domainRoot(emailDomain);
  const b = domainRoot(siteHost);
  // Cinco caracteres evitan que raices cortas y genericas ("casa", "bar") emparejen por azar.
  if (a.length < 5 || b.length < 5) return a === b && a.length > 0;
  return a === b || a.includes(b) || b.includes(a);
}

/** Entre varios correos, el del propio dominio del negocio vale más que un gmail suelto. */
function pickBestEmail(emails: string[], host: string): string | undefined {
  const unique = [...new Set(emails.map(e => e.toLowerCase()))].filter(isPlausibleEmail);
  if (!unique.length) return undefined;
  const bareHost = host.replace(/^www\./, '');
  const sameDomain = unique.filter(e => e.endsWith(`@${bareHost}`));
  // La raiz del dominio, no la cadena entera: un negocio en "lastrinitarias.com.co" publica su
  // correo en "@lastrinitarias.com" y son el mismo. Comparar literalmente lo descartaba.
  const relatedDomain = unique.filter(e => sharesRoot(e.split('@')[1] ?? '', bareHost));
  const freeMail = unique.filter(e => FREE_MAIL_DOMAINS.has(e.split('@')[1] ?? ''));
  const pool = sameDomain.length ? sameDomain : relatedDomain.length ? relatedDomain : freeMail;
  if (!pool.length) return undefined;
  const preferred = ['contacto', 'info', 'ventas', 'comercial', 'hola', 'contact', 'sales'];
  for (const prefix of preferred) {
    const match = pool.find(e => e.startsWith(`${prefix}@`));
    if (match) return match;
  }
  return pool[0];
}

function pickInstagram(html: string): string | undefined {
  INSTAGRAM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INSTAGRAM_RE.exec(html)) !== null) {
    const handle = match[1];
    if (INSTAGRAM_RESERVED.has(handle.toLowerCase())) continue;
    if (INSTAGRAM_FILE_LIKE.test(handle)) continue;
    return `@${handle}`;
  }
  return undefined;
}

/** Estado HTTP y HTML de una página; `html` vacío cuando no es legible (error, bloqueo o no es HTML). */
export async function fetchPage(url: string, timeoutMs = 8000): Promise<{ status: number; html: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'es-CO,es;q=0.9',
      },
    });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || (!type.includes('html') && !type.includes('text'))) return { status: response.status, html: '' };
    return { status: response.status, html: (await response.text()).slice(0, 600_000) };
  } catch {
    return { status: 0, html: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Sin un user agent de navegador muchos sitios responden 403 y perdemos un candidato bueno.
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'es-CO,es;q=0.9',
      },
    });
    if (!response.ok) return undefined;
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('html') && !type.includes('text')) return undefined;
    const text = await response.text();
    // 600 kB alcanzan de sobra para una portada; más allá suele ser una aplicación empaquetada.
    return text.slice(0, 600_000);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const JSON_LD_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function findAggregateRating(node: unknown, depth = 0): { rating: number; reviews: number } | undefined {
  if (!node || typeof node !== 'object' || depth > 6) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findAggregateRating(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  const aggregate = record.aggregateRating;
  if (aggregate && typeof aggregate === 'object' && !Array.isArray(aggregate)) {
    const data = aggregate as Record<string, unknown>;
    const ratingValue = Number(String(data.ratingValue ?? '').replace(',', '.'));
    const best = Number(data.bestRating ?? 5) || 5;
    const count = Number(data.ratingCount ?? data.reviewCount ?? 0);
    if (Number.isFinite(ratingValue) && ratingValue > 0 && Number.isInteger(count) && count > 0) {
      // Escalas distintas de 5 (Booking usa 10) se llevan a 0-5, igual que hace la curaduría.
      const rating = Math.round((best === 5 ? ratingValue : (ratingValue / best) * 5) * 10) / 10;
      if (rating >= 0 && rating <= 5) return { rating, reviews: count };
    }
  }
  for (const value of Object.values(record)) {
    const found = findAggregateRating(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** `aggregateRating` publicado por el sitio en JSON-LD; undefined si no lo hay o no se puede leer. */
export function extractSelfDeclaredRating(html: string): { rating: number; reviews: number } | undefined {
  JSON_LD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSON_LD_RE.exec(html)) !== null) {
    try {
      const found = findAggregateRating(JSON.parse(match[1].trim()));
      if (found) return found;
    } catch { /* un bloque roto no invalida los demás */ }
  }
  return undefined;
}

function extract(html: string, host: string): ScrapedContact {
  // `mailto:` es la señal más fiable: es una dirección que el propio sitio publica como contacto.
  const mailtos = [...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map(m => decodeURIComponent(m[1]));
  const plain = html.match(EMAIL_RE) ?? [];
  return {
    email: pickBestEmail([...mailtos, ...plain], host),
    instagram: pickInstagram(html),
  };
}

/**
 * Lee la portada y, si allí no aparece el correo, una página de contacto del MISMO dominio. Nunca
 * sigue a otro dominio: el correo de un tercero no es el del proveedor.
 */
export async function scrapeProviderContact(
  websiteUrl: string,
  options: { timeoutMs?: number; maxPages?: number } = {},
): Promise<ScrapedContact> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxPages = Math.max(1, options.maxPages ?? 3);

  let base: URL;
  try {
    base = new URL(websiteUrl.includes('://') ? websiteUrl : `https://${websiteUrl}`);
  } catch {
    return {};
  }
  if (!['http:', 'https:'].includes(base.protocol)) return {};

  const result: ScrapedContact = {};
  const visited = new Set<string>();
  const queue = [base.toString(), ...CONTACT_PATHS.map(path => new URL(path, base).toString())];

  for (const url of queue) {
    if (visited.size >= maxPages) break;
    if (visited.has(url)) continue;
    visited.add(url);
    const html = await fetchText(url, timeoutMs);
    if (!html) continue;
    const found = extract(html, base.host);
    if (found.email && !result.email) { result.email = found.email; result.foundAt = url; }
    if (found.instagram && !result.instagram) result.instagram = found.instagram;
    if (!result.selfDeclaredRating) {
      const declared = extractSelfDeclaredRating(html);
      if (declared) result.selfDeclaredRating = { ...declared, foundAt: url };
    }
    // El correo es lo caro de encontrar; con él ya podemos parar.
    if (result.email) break;
  }
  return result;
}
