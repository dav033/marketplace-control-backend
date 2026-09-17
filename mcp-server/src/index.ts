import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Pool, type QueryResultRow } from "pg";
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("marketplace-control MCP listo en stdio");
}

async function closePool() {
  if (pool) await pool.end();
}

process.once("SIGINT", () => {
  void closePool().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void closePool().finally(() => process.exit(0));
});

main().catch(() => {
  console.error("marketplace-control MCP no pudo iniciar.");
  process.exitCode = 1;
});
