import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { closePool, createServer } from "./index.js";

const MCP_PATH = "/mcp";
const AUTH_SCOPE = "marketplace";
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

type OAuthClient = {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
};

type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  expiresAt: number;
};

type TokenClaims = {
  clientId: string;
  scope: string;
  type: "access" | "refresh";
  expiresAt: number;
};

const clients = new Map<string, OAuthClient>();
const authorizationCodes = new Map<string, AuthorizationCode>();

function publicBaseUrl(request?: express.Request) {
  const configured = process.env.MCP_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;

  if (!request) throw new Error("MCP_PUBLIC_BASE_URL no está configurada.");
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "https").split(",")[0].trim();
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(",")[0].trim();
  if (!forwardedHost) throw new Error("No se pudo determinar el host público del MCP.");
  return `${forwardedProto}://${forwardedHost}`;
}

function configuredAdminKey() {
  const key = process.env.ADMIN_ACCESS_KEY?.trim();
  if (!key) throw new Error("ADMIN_ACCESS_KEY no está configurada.");
  return key;
}

function base64Url(value: Buffer | string) {
  return Buffer.from(value).toString("base64url");
}

function constantTimeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function authSecret() {
  return createHash("sha256").update(configuredAdminKey()).digest();
}

function signToken(claims: TokenClaims) {
  const payload = base64Url(JSON.stringify(claims));
  const signature = createHmac("sha256", authSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function readToken(token: string): TokenClaims | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = createHmac("sha256", authSecret()).update(payload).digest("base64url");
  if (!constantTimeEquals(signature, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
    if (!claims.clientId || claims.type !== "access" && claims.type !== "refresh") return null;
    if (!claims.expiresAt || claims.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

function issueToken(clientId: string, type: TokenClaims["type"], ttlSeconds: number) {
  return signToken({
    clientId,
    scope: AUTH_SCOPE,
    type,
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
}

function errorJson(res: express.Response, status: number, error: string, description?: string) {
  res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
}

function redirectError(res: express.Response, redirectUri: string, error: string, state?: string) {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("error", error);
  if (state) redirect.searchParams.set("state", state);
  res.redirect(302, redirect.toString());
}

function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function getClient(clientId: string) {
  return clients.get(clientId);
}

function renderAuthorizePage(params: URLSearchParams, error?: string) {
  const hidden = ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "resource", "scope"]
    .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) ?? "")}">`)
    .join("");
  const errorMarkup = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizar Marketplace Control</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#172033}form{display:grid;gap:1rem}input{font:inherit;padding:.7rem;border:1px solid #b8c0cc;border-radius:.4rem}button{font:inherit;padding:.7rem;border:0;border-radius:.4rem;background:#173b72;color:#fff;cursor:pointer}.error{color:#a21b1b}</style></head>
<body><h1>Marketplace Control</h1><p>Autoriza a Claude Web a consultar el pipeline y ejecutar las herramientas MCP permitidas.</p>${errorMarkup}
<form method="post" action="/oauth/authorize">${hidden}<label>Clave de acceso administrativa<input type="password" name="admin_access_key" autocomplete="current-password" required></label><button type="submit">Autorizar Claude</button></form></body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function bearerToken(request: express.Request) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function requireBearer(request: express.Request, response: express.Response) {
  const token = bearerToken(request);
  if (!token) return false;
  const claims = readToken(token);
  if (!claims || claims.type !== "access") return false;
  return true;
}

function sendUnauthorized(request: express.Request, response: express.Response) {
  const metadata = `${publicBaseUrl(request)}/.well-known/oauth-protected-resource`;
  response.setHeader("WWW-Authenticate", `Bearer realm="marketplace-control", resource_metadata="${metadata}", scope="${AUTH_SCOPE}"`);
  response.status(401).json({ error: "unauthorized", error_description: "Se requiere un token OAuth válido." });
}

function ensureClientFromRegistration(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const input = body as { redirect_uris?: unknown; client_name?: unknown };
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0 || !input.redirect_uris.every(isAllowedRedirectUri)) return null;
  const clientId = `mcp_${randomBytes(18).toString("hex")}`;
  const client: OAuthClient = {
    clientId,
    clientName: typeof input.client_name === "string" ? input.client_name.slice(0, 200) : undefined,
    redirectUris: input.redirect_uris,
  };
  clients.set(clientId, client);
  return client;
}

const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? "54-167-34-107.sslip.io,marketplace.sempertex.com,127.0.0.1,localhost")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts });
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

app.get("/health", (_request, response) => response.json({ ok: true, service: "marketplace-control-mcp" }));

app.get("/.well-known/oauth-protected-resource", (request, response) => {
  const base = publicBaseUrl(request);
  response.json({
    resource: `${base}${MCP_PATH}`,
    authorization_servers: [base],
    scopes_supported: [AUTH_SCOPE],
    bearer_methods_supported: ["header"],
  });
});

app.get("/.well-known/oauth-authorization-server", (request, response) => {
  const base = publicBaseUrl(request);
  response.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [AUTH_SCOPE],
  });
});

app.post("/oauth/register", (request, response) => {
  const client = ensureClientFromRegistration(request.body);
  if (!client) return errorJson(response, 400, "invalid_client_metadata", "redirect_uris debe contener URLs HTTPS o localhost válidas.");
  return response.status(201).json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
});

app.get("/oauth/authorize", (request, response) => {
  const params = new URLSearchParams(request.query as Record<string, string>);
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const client = getClient(clientId);
  if (params.get("response_type") !== "code" || !client || !client.redirectUris.includes(redirectUri)) {
    return errorJson(response, 400, "invalid_request", "La solicitud OAuth no es válida o el cliente no está registrado.");
  }
  if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) {
    return errorJson(response, 400, "invalid_request", "Se requiere PKCE con S256.");
  }
  return response.type("html").send(renderAuthorizePage(params));
});

app.post("/oauth/authorize", (request, response) => {
  const params = new URLSearchParams(request.body as Record<string, string>);
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? undefined;
  const client = getClient(clientId);
  if (params.get("response_type") !== "code" || !client || !client.redirectUris.includes(redirectUri)) {
    return errorJson(response, 400, "invalid_request", "La solicitud OAuth no es válida.");
  }
  if (!constantTimeEquals(String(request.body?.admin_access_key ?? ""), configuredAdminKey())) {
    return response.status(401).type("html").send(renderAuthorizePage(params, "La clave no es válida."));
  }

  const code = randomBytes(32).toString("base64url");
  authorizationCodes.set(code, {
    clientId,
    redirectUri,
    codeChallenge: params.get("code_challenge") ?? "",
    resource: params.get("resource") ?? undefined,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);
  return response.redirect(302, redirect.toString());
});

app.post("/oauth/token", (request, response) => {
  const grantType = String(request.body?.grant_type ?? "");
  if (grantType === "refresh_token") {
    const refreshToken = String(request.body?.refresh_token ?? "");
    const claims = readToken(refreshToken);
    if (!claims || claims.type !== "refresh") return errorJson(response, 400, "invalid_grant", "El refresh token no es válido.");
    return response.json({
      token_type: "Bearer",
      access_token: issueToken(claims.clientId, "access", ACCESS_TOKEN_TTL_SECONDS),
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: issueToken(claims.clientId, "refresh", REFRESH_TOKEN_TTL_SECONDS),
      scope: AUTH_SCOPE,
    });
  }

  if (grantType !== "authorization_code") return errorJson(response, 400, "unsupported_grant_type");
  const code = String(request.body?.code ?? "");
  const stored = authorizationCodes.get(code);
  authorizationCodes.delete(code);
  if (!stored || stored.expiresAt <= Date.now()) return errorJson(response, 400, "invalid_grant", "El código OAuth no es válido o expiró.");
  if (String(request.body?.client_id ?? "") !== stored.clientId || String(request.body?.redirect_uri ?? "") !== stored.redirectUri) {
    return errorJson(response, 400, "invalid_grant", "El cliente o redirect_uri no coinciden.");
  }
  const verifier = String(request.body?.code_verifier ?? "");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  if (!verifier || !constantTimeEquals(challenge, stored.codeChallenge)) return errorJson(response, 400, "invalid_grant", "PKCE no es válido.");
  return response.json({
    token_type: "Bearer",
    access_token: issueToken(stored.clientId, "access", ACCESS_TOKEN_TTL_SECONDS),
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: issueToken(stored.clientId, "refresh", REFRESH_TOKEN_TTL_SECONDS),
    scope: AUTH_SCOPE,
  });
});

app.post(MCP_PATH, async (request, response) => {
  if (!requireBearer(request, response)) return sendUnauthorized(request, response);

  const mcpServer = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(request, response, request.body);
    response.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
  } catch (error) {
    console.error("MCP HTTP request failed", error instanceof Error ? error.message : "unknown error");
    if (!response.headersSent) errorJson(response, 500, "server_error", "No se pudo procesar la solicitud MCP.");
  }
});

app.get(MCP_PATH, (request, response) => {
  if (!requireBearer(request, response)) return sendUnauthorized(request, response);
  response.setHeader("Allow", "POST");
  return response.status(405).json({ error: "method_not_allowed" });
});

app.delete(MCP_PATH, (request, response) => {
  if (!requireBearer(request, response)) return sendUnauthorized(request, response);
  response.setHeader("Allow", "POST");
  return response.status(405).json({ error: "method_not_allowed" });
});

const port = Number(process.env.MCP_HTTP_PORT ?? 4322);
const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
const httpServer = createHttpServer(app);

httpServer.listen(port, host, () => {
  console.error(`marketplace-control MCP HTTP listo en http://${host}:${port}${MCP_PATH}`);
});

async function shutdown() {
  httpServer.close();
  await closePool();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
