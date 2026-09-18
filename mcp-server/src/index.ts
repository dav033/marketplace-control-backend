import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { z } from "zod";

const MAX_LIMIT = 100;
const PROVIDER_STATUSES = [
  "candidate",
  "under_review",
  "approved",
  "rejected",
  "archived",
] as const;
const SUBMISSION_STATUSES = [
  "new",
  "reviewing",
  "approved",
  "rejected",
  "spam",
  "converted",
] as const;
const MAX_IMPORT_ROWS = 50;
const CURATED_CATEGORY_CODES = {
  "Lugar": "01",
  "Comida y Bebida": "02",
  "Música": "03",
  "Servicios Especializados": "04",
  "Entretenimiento": "05",
  "Decoración temática": "06",
  "Fotografía y Video": "07",
  "Invitación digital": "08",
  "Menaje y mantelería": "09",
  "Carpas y mobiliario": "10",
} as const;
const CURATED_CATEGORIES = Object.keys(CURATED_CATEGORY_CODES) as [keyof typeof CURATED_CATEGORY_CODES, ...(keyof typeof CURATED_CATEGORY_CODES)[]];
const CURATED_SEGMENTS = ["Bajo Costo", "Premium", "Sin clasificar"] as const;
const CURATED_ZONES = [
  "Zona Norte / Comercial Alta",
  "Zona Centro / Tradicional",
  "Zona Sur / Occidente Comercial",
  "Zona Campestre / Periferia",
  "Área Metropolitana",
  "Cobertura Nacional",
  "Sin dato",
] as const;
const CURATED_SCALES = [
  "Pequeño (Hasta 50 pers.)",
  "Mediano (50 a 200 pers.)",
  "Masivo (Más de 200 pers.)",
  "Sin dato",
] as const;
const CURATED_FORMALITY = [
  "Formalizado (NIT - Empresa)",
  "Independiente (RUT - Persona Natural)",
  "No verificado",
] as const;
const CURATED_PROVIDER_TYPES = ["type_1_local", "type_2_by_order"] as const;
const CURATED_LEVELS = ["A", "B"] as const;

let pool: Pool | undefined;

function getPool(): Pool {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error("DATABASE_URL no está configurada.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL no es válida.");
  }

  if (!(["postgres:", "postgresql:"] as string[]).includes(parsedUrl.protocol)) {
    throw new Error("DATABASE_URL debe usar postgres:// o postgresql://.");
  }

  pool ??= new Pool({
    connectionString: databaseUrl,
    application_name: "marketplace-control-mcp",
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  });

  return pool;
}

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function errorResult(error: unknown) {
  const knownMessages = new Set([
    "DATABASE_URL no está configurada.",
    "DATABASE_URL no es válida.",
    "DATABASE_URL debe usar postgres:// o postgresql://.",
  ]);
  const message = error instanceof Error && knownMessages.has(error.message)
    ? error.message
    : "Consulta PostgreSQL falló.";

  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

async function execute<T>(work: (db: Pool) => Promise<T>) {
  try {
    return result(await work(getPool()));
  } catch (error) {
    return errorResult(error);
  }
}

function escapedLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 3) return "***";
  return `***${digits.slice(-2)}`;
}

function safeText(maximum: number, minimum = 1) {
  return z.string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), "No puede contener caracteres de control.");
}

const curatedProviderRowSchema = z.object({
  id: z.string().trim().regex(/^[A-Z]{3}-\d{2}-\d{3}$/, "Debe tener formato ABC-01-001."),
  display_name: safeText(200),
  category: z.enum(CURATED_CATEGORIES),
  segment: z.enum(CURATED_SEGMENTS),
  city: safeText(120),
  zone: z.enum(CURATED_ZONES),
  scale: z.enum(CURATED_SCALES),
  formality: z.enum(CURATED_FORMALITY),
  rating: z.number().finite().min(4.5).max(5),
  review_count: z.number().int().min(1).max(1_000_000),
  reputation_platform: safeText(80),
  curation_level: z.enum(CURATED_LEVELS),
  curation_reason: safeText(1_000),
  phone: z.union([
    z.literal("Sin dato"),
    z.string().trim().regex(/^\+57 \d{7,10}$/, "Usa +57 seguido del número, separado por un espacio."),
  ]),
  instagram: z.union([
    z.literal("Sin Redes"),
    z.string().trim().regex(/^@[A-Za-z0-9._]{2,60}$/, "Instagram debe comenzar con @."),
  ]),
  email: z.union([
    z.literal("Sin dato"),
    z.string().trim().toLowerCase().max(320).email(),
  ]),
  source_url: z.string().trim().url().max(2_048),
  verification_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provider_type: z.enum(CURATED_PROVIDER_TYPES),
  event_evidence: safeText(600),
  activity_evidence: safeText(600),
}).strict();

const importCuratedProvidersSchema = z.object({
  batch_id: safeText(120).optional(),
  confirm: z.boolean().default(false),
  rows: z.array(curatedProviderRowSchema).min(1).max(MAX_IMPORT_ROWS),
}).strict();

type CuratedProviderRow = z.infer<typeof curatedProviderRowSchema>;

function normalizeKey(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function isRealDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isDirectSourceUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) return false;
  const path = parsed.pathname.toLowerCase();
  if (path.split("/").includes("search") || path.includes("/maps/search")) return false;
  for (const parameter of ["q", "query", "api", "text"]) {
    if (parsed.searchParams.has(parameter)) return false;
  }
  return true;
}

function validateCuratedBatch(rows: CuratedProviderRow[]) {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  const seenProviders = new Set<string>();
  const emailOwners = new Map<string, string>();
  const first = rows[0];

  for (const [index, row] of rows.entries()) {
    const label = `rows[${index}]`;
    const categoryCode = CURATED_CATEGORY_CODES[row.category];
    const idParts = row.id.match(/^([A-Z]{3})-(\d{2})-(\d{3})$/);
    const providerKey = normalizeKey(`${row.display_name}|${row.city}|${row.category}`);

    if (!isRealDate(row.verification_date)) {
      issues.push(`${label}.verification_date no es una fecha válida.`);
    }
    if (!isDirectSourceUrl(row.source_url)) {
      issues.push(`${label}.source_url debe ser una URL directa de ficha, no una búsqueda.`);
    }
    if (idParts && idParts[2] !== categoryCode) {
      issues.push(`${label}.id usa categoría ${idParts[2]}, pero la categoría requiere ${categoryCode}.`);
    }
    if (seenIds.has(row.id)) issues.push(`${label}.id está repetido dentro del lote.`);
    seenIds.add(row.id);
    if (seenProviders.has(providerKey)) {
      issues.push(`${label} duplica el proveedor por nombre, ciudad y categoría.`);
    }
    seenProviders.add(providerKey);

    const minimumReviews = row.provider_type === "type_1_local" ? 50 : 15;
    if (row.review_count < minimumReviews) {
      issues.push(`${label} no supera el mínimo de ${minimumReviews} reseñas para ${row.provider_type}.`);
    }
    const expectedLevel = row.review_count >= 50 ? "A" : "B";
    if (row.curation_level !== expectedLevel) {
      issues.push(`${label}.curation_level debe ser ${expectedLevel} para ${row.review_count} reseñas.`);
    }
    if (row.provider_type === "type_1_local" && row.curation_level !== "A") {
      issues.push(`${label}: un proveedor Tipo 1 no puede entrar con nivel B.`);
    }

    if (row.email !== "Sin dato") {
      const previousOwner = emailOwners.get(row.email);
      if (previousOwner && previousOwner !== providerKey) {
        issues.push(`${label}.email aparece asociado a más de un proveedor en el lote.`);
      }
      emailOwners.set(row.email, providerKey);
    }
  }

  if (first) {
    for (const [index, row] of rows.entries()) {
      if (row.city !== first.city || row.category !== first.category) {
        issues.push(`rows[${index}] debe compartir ciudad y categoría con todo el lote.`);
      }
    }
  }

  return issues;
}

function curatedRawPayload(row: CuratedProviderRow) {
  return {
    id: row.id,
    category: row.category,
    segment: row.segment,
    city: row.city,
    zone: row.zone,
    scale: row.scale,
    formality: row.formality,
    rating: row.rating,
    review_count: row.review_count,
    reputation_platform: row.reputation_platform,
    curation_level: row.curation_level,
    curation_reason: row.curation_reason,
    instagram: row.instagram,
    source_url: row.source_url,
    verification_date: row.verification_date,
    provider_type: row.provider_type,
    event_evidence: row.event_evidence,
    activity_evidence: row.activity_evidence,
  };
}

async function upsertCuratedContact(
  client: PoolClient,
  row: CuratedProviderRow,
  providerId: string,
): Promise<"missing" | "created" | "updated" | "conflict"> {
  if (row.email === "Sin dato") return "missing";

  const existing = await client.query<{ contact_id: string; provider_id: string | null }>(
    `SELECT contact_id::text, provider_id::text FROM marketplace.contacts WHERE lower(email) = $1 FOR UPDATE`,
    [row.email],
  );
  const phone = row.phone === "Sin dato" ? null : row.phone;

  if (existing.rows[0]) {
    const contact = existing.rows[0];
    await client.query(
      `UPDATE marketplace.contacts
       SET provider_id = COALESCE(provider_id, $2),
           phone = COALESCE($3, phone),
           updated_at = now()
       WHERE contact_id = $1`,
      [contact.contact_id, providerId, phone],
    );
    return contact.provider_id && contact.provider_id !== providerId ? "conflict" : "updated";
  }

  await client.query(
    `INSERT INTO marketplace.contacts (provider_id, email, phone, consent_status)
     VALUES ($1, $2, $3, 'unknown')`,
    [providerId, row.email, phone],
  );
  return "created";
}

type ProviderRow = QueryResultRow & {
  provider_id: string;
  display_name: string;
  legal_name: string | null;
  category: string;
  city: string;
  country_code: string;
  website_url: string | null;
  phone: string | null;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  rating: string | null;
  review_count: number | null;
  status: string;
  discovery_source: string | null;
  first_seen_at: string;
  reviewed_at: string | null;
  source_count?: number;
};

function serializeProvider(row: ProviderRow) {
  return {
    id: row.provider_id,
    display_name: row.display_name,
    legal_name: row.legal_name,
    category: row.category,
    city: row.city,
    country_code: row.country_code,
    website_url: row.website_url,
    phone: row.phone,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    rating: row.rating,
    review_count: row.review_count,
    status: row.status,
    discovery_source: row.discovery_source,
    first_seen_at: row.first_seen_at,
    reviewed_at: row.reviewed_at,
    source_count: row.source_count ?? 0,
  };
}

export function createServer() {
  const server = new McpServer({
    name: "marketplace-control",
    version: "0.1.0",
  });

server.registerTool(
  "search_providers",
  {
    title: "Buscar proveedores",
    description: "Busca proveedores por texto, categoría, ciudad y estado. Solo lectura.",
    inputSchema: {
      text: z.string().trim().max(200).optional(),
      category: z.string().trim().max(120).optional(),
      city: z.string().trim().max(120).optional(),
      status: z.enum(PROVIDER_STATUSES).optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(25),
    },
  },
  async ({ text, category, city, status, limit }) => execute(async (db) => {
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (text) {
      values.push(escapedLike(text));
      const parameter = `$${values.length}`;
      clauses.push(`(
        p.display_name ILIKE ${parameter} ESCAPE '\\'
        OR COALESCE(p.legal_name, '') ILIKE ${parameter} ESCAPE '\\'
        OR p.category ILIKE ${parameter} ESCAPE '\\'
        OR p.city ILIKE ${parameter} ESCAPE '\\'
        OR COALESCE(p.notes, '') ILIKE ${parameter} ESCAPE '\\'
      )`);
    }
    if (category) {
      values.push(category);
      clauses.push(`LOWER(p.category) = LOWER($${values.length})`);
    }
    if (city) {
      values.push(city);
      clauses.push(`LOWER(p.city) = LOWER($${values.length})`);
    }
    if (status) {
      values.push(status);
      clauses.push(`p.status = $${values.length}`);
    }

    values.push(limit);
    const limitParameter = `$${values.length}`;
    const where = clauses.length > 0 ? clauses.join(" AND ") : "TRUE";
    const query = `
      SELECT
        p.provider_id::text,
        p.display_name,
        p.legal_name,
        p.category,
        p.city,
        p.country_code,
        p.website_url,
        p.phone,
        p.address,
        p.latitude::text,
        p.longitude::text,
        p.rating::text,
        p.review_count,
        p.status,
        p.discovery_source,
        p.first_seen_at::text,
        p.reviewed_at::text,
        COUNT(ps.provider_source_id)::int AS source_count
      FROM marketplace.providers p
      LEFT JOIN marketplace.provider_sources ps ON ps.provider_id = p.provider_id
      WHERE ${where}
      GROUP BY p.provider_id
      ORDER BY p.updated_at DESC, p.display_name ASC
      LIMIT ${limitParameter}
    `;
    const response = await db.query<ProviderRow>(query, values);

    return {
      count: response.rows.length,
      limit,
      providers: response.rows.map(serializeProvider),
    };
  }),
);

server.registerTool(
  "get_provider",
  {
    title: "Obtener proveedor",
    description: "Obtiene un proveedor y sus fuentes públicas por UUID. Solo lectura; no devuelve contactos.",
    inputSchema: {
      provider_id: z.string().uuid(),
    },
  },
  async ({ provider_id }) => execute(async (db) => {
    const providerResponse = await db.query<ProviderRow>(
      `
        SELECT
          p.provider_id::text,
          p.display_name,
          p.legal_name,
          p.category,
          p.city,
          p.country_code,
          p.website_url,
          p.phone,
          p.address,
          p.latitude::text,
          p.longitude::text,
          p.rating::text,
          p.review_count,
          p.status,
          p.discovery_source,
          p.first_seen_at::text,
          p.reviewed_at::text,
          COUNT(ps.provider_source_id)::int AS source_count
        FROM marketplace.providers p
        LEFT JOIN marketplace.provider_sources ps ON ps.provider_id = p.provider_id
        WHERE p.provider_id = $1
        GROUP BY p.provider_id
      `,
      [provider_id],
    );

    const provider = providerResponse.rows[0];
    if (!provider) return { provider: null };

    const sourcesResponse = await db.query(
      `
        SELECT
          provider_source_id::text AS id,
          source_name,
          source_url,
          source_record_key,
          observed_name,
          observed_rating::text,
          observed_reviews,
          extracted_at::text,
          last_seen_at::text
        FROM marketplace.provider_sources
        WHERE provider_id = $1
        ORDER BY last_seen_at DESC
        LIMIT $2
      `,
      [provider_id, MAX_LIMIT],
    );

    return {
      provider: serializeProvider(provider),
      sources: sourcesResponse.rows,
    };
  }),
);

server.registerTool(
  "pipeline_stats",
  {
    title: "Estadísticas del pipeline",
    description: "Resume estados de proveedores, contactos, envíos y registros. No devuelve datos personales.",
    inputSchema: {},
  },
  async () => execute(async (db) => {
    const [providers, contacts, sends, submissions, clicks] = await Promise.all([
      db.query<{ status: string; count: string }>(
        "SELECT status, COUNT(*)::text AS count FROM marketplace.providers GROUP BY status ORDER BY status",
      ),
      db.query<{ consent_status: string; count: string }>(
        "SELECT consent_status, COUNT(*)::text AS count FROM marketplace.contacts GROUP BY consent_status ORDER BY consent_status",
      ),
      db.query<{ status: string; count: string }>(
        "SELECT status, COUNT(*)::text AS count FROM marketplace.campaign_sends GROUP BY status ORDER BY status",
      ),
      db.query<{ submission_status: string; count: string }>(
        "SELECT submission_status, COUNT(*)::text AS count FROM marketplace.registration_submissions GROUP BY submission_status ORDER BY submission_status",
      ),
      db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM marketplace.email_clicks"),
    ]);

    return {
      providers_by_status: Object.fromEntries(providers.rows.map((row) => [row.status, Number(row.count)])),
      contacts_by_consent: Object.fromEntries(contacts.rows.map((row) => [row.consent_status, Number(row.count)])),
      sends_by_status: Object.fromEntries(sends.rows.map((row) => [row.status, Number(row.count)])),
      submissions_by_status: Object.fromEntries(
        submissions.rows.map((row) => [row.submission_status, Number(row.count)]),
      ),
      email_clicks: Number(clicks.rows[0]?.count ?? 0),
    };
  }),
);

server.registerTool(
  "list_registration_submissions",
  {
    title: "Listar registros",
    description: "Lista registros del formulario. Datos de contacto aparecen enmascarados por defecto; no devuelve form_payload.",
    inputSchema: {
      status: z.enum(SUBMISSION_STATUSES).optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(25),
      include_contact_details: z.boolean().default(false),
    },
  },
  async ({ status, limit, include_contact_details }) => execute(async (db) => {
    const values: unknown[] = [];
    const where = status ? (() => {
      values.push(status);
      return `WHERE r.submission_status = $${values.length}`;
    })() : "";

    values.push(limit);
    const response = await db.query<{
      submission_id: string;
      provider_id: string | null;
      full_name: string | null;
      email: string;
      phone: string | null;
      company_name: string | null;
      submission_status: string;
      privacy_consent: boolean;
      privacy_consent_at: string | null;
      marketing_consent: boolean;
      marketing_consent_at: string | null;
      consent_source: string | null;
      form_version: string | null;
      created_at: string;
    }>(
      `
        SELECT
          r.submission_id::text,
          r.provider_id::text,
          r.full_name,
          r.email,
          r.phone,
          r.company_name,
          r.submission_status,
          r.privacy_consent,
          r.privacy_consent_at::text,
          r.marketing_consent,
          r.marketing_consent_at::text,
          r.consent_source,
          r.form_version,
          r.created_at::text
        FROM marketplace.registration_submissions r
        ${where}
        ORDER BY r.created_at DESC
        LIMIT $${values.length}
      `,
      values,
    );

    return {
      count: response.rows.length,
      limit,
      submissions: response.rows.map((row) => ({
        id: row.submission_id,
        provider_id: row.provider_id,
        full_name: row.full_name,
        company_name: row.company_name,
        email: include_contact_details ? row.email : maskEmail(row.email),
        phone: include_contact_details ? row.phone : maskPhone(row.phone),
        status: row.submission_status,
        privacy_consent: row.privacy_consent,
        privacy_consent_at: row.privacy_consent_at,
        marketing_consent: row.marketing_consent,
        marketing_consent_at: row.marketing_consent_at,
        consent_source: row.consent_source,
        form_version: row.form_version,
        created_at: row.created_at,
      })),
    };
  }),
);

server.registerTool(
  "import_curated_providers",
  {
    title: "Importar proveedores curados",
    description: "Valida y, solo con confirm=true, importa un lote curado por Claude. Crea o actualiza proveedores, fuentes y contactos con consentimiento unknown; nunca envía correo.",
    inputSchema: importCuratedProvidersSchema,
  },
  async ({ batch_id, confirm, rows }) => {
    const issues = validateCuratedBatch(rows);
    if (issues.length > 0) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "VALIDATION_FAILED",
            issues,
            rows_received: rows.length,
            written: false,
          }),
        }],
      };
    }

    const preview = {
      rows: rows.length,
      city: rows[0].city,
      category: rows[0].category,
      candidate_status: "candidate",
      emails_to_link: rows.filter((row) => row.email !== "Sin dato").length,
      source_urls: rows.length,
    };

    if (!confirm) {
      return result({
        ok: true,
        dry_run: true,
        batch_id: batch_id ?? null,
        ...preview,
        next_step: "Repite exactamente el lote con confirm=true para escribirlo.",
        email_sending: "not_supported",
      });
    }

    return execute(async (db) => {
      const client = await db.connect();
      let providersInserted = 0;
      let providersUpdated = 0;
      let sourcesUpserted = 0;
      let contactsCreated = 0;
      let contactsUpdated = 0;
      let contactsMissing = 0;
      let contactsConflicted = 0;

      try {
        await client.query("BEGIN");
        for (const row of rows) {
          const dedupeKey = normalizeKey(`${row.display_name}|${row.city}|${row.category}`);
          const phone = row.phone === "Sin dato" ? null : row.phone;
          const providerResponse = await client.query<{ provider_id: string; inserted: boolean }>(
            `INSERT INTO marketplace.providers
              (dedupe_key, display_name, category, city, website_url, phone, rating, review_count, status, discovery_source, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'candidate', $9, $10)
             ON CONFLICT (dedupe_key) DO UPDATE SET
               website_url = EXCLUDED.website_url,
               phone = COALESCE(EXCLUDED.phone, marketplace.providers.phone),
               rating = EXCLUDED.rating,
               review_count = EXCLUDED.review_count,
               discovery_source = EXCLUDED.discovery_source,
               notes = EXCLUDED.notes,
               updated_at = now()
             RETURNING provider_id::text, (xmax = 0) AS inserted`,
            [
              dedupeKey,
              row.display_name,
              row.category,
              row.city,
              row.source_url,
              phone,
              row.rating,
              row.review_count,
              "MCP Claude curated",
              row.curation_reason,
            ],
          );

          const providerId = providerResponse.rows[0].provider_id;
          if (providerResponse.rows[0].inserted) providersInserted += 1;
          else providersUpdated += 1;

          const sourceFingerprintSeed = `${row.reputation_platform}|${row.source_url}|${row.id}|${dedupeKey}`;
          await client.query(
            `INSERT INTO marketplace.provider_sources
              (provider_id, source_name, source_url, source_record_key, source_fingerprint, observed_name, observed_rating, observed_reviews, raw_payload)
             VALUES ($1, $2, $3, $4, encode(digest($5, 'sha256'), 'hex'), $6, $7, $8, $9)
             ON CONFLICT (source_fingerprint) DO UPDATE SET
               provider_id = EXCLUDED.provider_id,
               source_name = EXCLUDED.source_name,
               source_url = EXCLUDED.source_url,
               observed_name = EXCLUDED.observed_name,
               observed_rating = EXCLUDED.observed_rating,
               observed_reviews = EXCLUDED.observed_reviews,
               raw_payload = EXCLUDED.raw_payload,
               last_seen_at = now()`,
            [
              providerId,
              row.reputation_platform,
              row.source_url,
              row.id,
              sourceFingerprintSeed,
              row.display_name,
              row.rating,
              row.review_count,
              JSON.stringify(curatedRawPayload(row)),
            ],
          );
          sourcesUpserted += 1;

          const contactResult = await upsertCuratedContact(client, row, providerId);
          if (contactResult === "created") contactsCreated += 1;
          if (contactResult === "updated") contactsUpdated += 1;
          if (contactResult === "missing") contactsMissing += 1;
          if (contactResult === "conflict") contactsConflicted += 1;
        }

        const summary = {
          batch_id: batch_id ?? null,
          rows_received: rows.length,
          providers_inserted: providersInserted,
          providers_updated: providersUpdated,
          sources_upserted: sourcesUpserted,
          contacts_created: contactsCreated,
          contacts_updated: contactsUpdated,
          contacts_missing: contactsMissing,
          contacts_conflicted: contactsConflicted,
          city: rows[0].city,
          category: rows[0].category,
          email_sending: "not_supported",
        };
        await client.query(
          `INSERT INTO marketplace.audit_log (actor_id, action, entity_type, after_state, metadata)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
          [
            "mcp:claude",
            "import_curated_providers",
            "provider_batch",
            JSON.stringify(summary),
            JSON.stringify({ transport: "stdio", write_scope: ["providers", "provider_sources", "contacts"] }),
          ],
        );
        await client.query("COMMIT");

        return {
          ok: true,
          dry_run: false,
          ...summary,
          provider_status: "candidate",
          consent_policy: "new contacts remain unknown; existing consent is never changed",
          note: "No email was sent. This MCP write tool only imports curated data.",
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  },
);

  return server;
}

const server = createServer();

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("marketplace-control MCP listo en stdio");
}

export async function closePool() {
  if (pool) await pool.end();
}

process.once("SIGINT", () => {
  void closePool().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void closePool().finally(() => process.exit(0));
});

if (process.env.MCP_TRANSPORT !== "http") {
  main().catch(() => {
    console.error("marketplace-control MCP no pudo iniciar.");
    process.exitCode = 1;
  });
}
