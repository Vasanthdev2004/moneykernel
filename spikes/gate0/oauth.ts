/**
 * Minimal OAuth 2.1 authorization-code + PKCE flow for the Gate 0 spike.
 *
 * The Binance authorization server advertises no dynamic client registration
 * but does advertise `client_id_metadata_document_supported: true`, so this
 * public client identifies itself with the HTTPS URL of a hosted client
 * metadata document (docs/oauth-client.json, served by GitHub Pages).
 *
 * The human operator performs the login and consent in their own browser. This
 * code never sees or asks for Binance credentials; it only receives the
 * authorization code on a loopback redirect and exchanges it with PKCE.
 *
 * Tokens are stored in ./raw/oauth-tokens.json, which is gitignored. Never
 * commit, print, or export them.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(HERE, "raw", "oauth-tokens.json");

export const RESOURCE = process.env.MCP_ENDPOINT ?? "https://agent.binance.com/mcp/agentic";
export const AS_ISSUER = process.env.MCP_OAUTH_ISSUER ?? "https://agent.binance.com";
export const CLIENT_ID =
  process.env.MCP_OAUTH_CLIENT_ID ?? "https://vasanthdev2004.github.io/moneykernel/oauth-client.json";
const REDIRECT_PORT = Number(process.env.MCP_OAUTH_REDIRECT_PORT ?? "8765");
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPE = process.env.MCP_OAUTH_SCOPE; // intentionally unset by default: scope names are not documented
const CALLBACK_TIMEOUT_MS = 10 * 60_000;

export type AsMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
  scopes_supported?: string[];
};

export type Tokens = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  obtained_at: string;
  expires_at: string | null;
  issuer: string;
  client_id: string;
  resource: string;
};

const b64url = (b: Buffer): string => b.toString("base64url");
const nowIso = (): string => new Date().toISOString();

export async function discover(): Promise<AsMetadata> {
  const res = await fetch(`${AS_ISSUER}/.well-known/oauth-authorization-server`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`authorization server metadata: HTTP ${res.status}`);
  const md = (await res.json()) as AsMetadata;
  if (md.issuer !== AS_ISSUER) throw new Error("authorization server metadata issuer does not match configured issuer");
  if (!md.authorization_endpoint || !md.token_endpoint) throw new Error("authorization server metadata lacks endpoints");
  if (md.code_challenge_methods_supported && !md.code_challenge_methods_supported.includes("S256")) {
    throw new Error("authorization server does not advertise PKCE S256");
  }
  return md;
}

export function loadTokens(): Tokens | null {
  if (!existsSync(TOKEN_FILE)) return null;
  return JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as Tokens;
}

function saveTokens(t: Tokens): void {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2) + "\n");
}

function isExpired(t: Tokens): boolean {
  return t.expires_at !== null && Date.parse(t.expires_at) - 30_000 < Date.now();
}

function assertTokenBinding(t: Tokens): void {
  const expected = { resource: RESOURCE, issuer: AS_ISSUER, client_id: CLIENT_ID };
  for (const field of ["resource", "issuer", "client_id"] as const) {
    if (t[field] !== expected[field]) {
      throw new Error(`stored OAuth tokens do not match configured ${field}; run login again for this configuration`);
    }
  }
}

async function exchange(md: AsMetadata, params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(md.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token endpoint HTTP ${res.status}: ${text.slice(0, 600)}`);
  const body = JSON.parse(text) as Partial<Tokens>;
  if (!body.access_token) throw new Error(`token endpoint returned no access_token: ${text.slice(0, 300)}`);
  const obtainedAt = nowIso();
  return {
    access_token: body.access_token,
    token_type: body.token_type ?? "Bearer",
    expires_in: body.expires_in,
    refresh_token: body.refresh_token,
    scope: body.scope,
    obtained_at: obtainedAt,
    expires_at: body.expires_in ? new Date(Date.parse(obtainedAt) + body.expires_in * 1000).toISOString() : null,
    issuer: md.issuer,
    client_id: CLIENT_ID,
    resource: RESOURCE,
  };
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // printing the URL is the fallback
  }
}

function waitForCallback(authorizeUrl: URL, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${REDIRECT_PORT}`);
      const finish = (status: number, msg: string): void => {
        res.statusCode = status;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(msg);
      };
      if (u.pathname !== "/callback") {
        finish(404, "not found");
        return;
      }
      const error = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (error) {
        const detail = u.searchParams.get("error_description") ?? "";
        finish(400, `authorization failed: ${error} ${detail}`);
        server.close();
        reject(new Error(`authorization server returned error=${error} ${detail}`));
        return;
      }
      if (!code || state !== expectedState) {
        finish(400, "missing code or state mismatch");
        server.close();
        reject(new Error("callback missing code or state mismatch"));
        return;
      }
      finish(200, "MoneyKernel Gate 0 spike: authorization received. You can close this tab.");
      server.close();
      resolve(code);
    });
    server.on("error", (e) => reject(e));
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      console.log("\nOpen this URL in your browser on this machine, log in to Binance, and consent:\n");
      console.log(authorizeUrl.toString());
      console.log(`\nWaiting up to ${CALLBACK_TIMEOUT_MS / 60_000} minutes for the redirect on ${REDIRECT_URI} ...`);
      openBrowser(authorizeUrl.toString());
    });
    setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for the authorization callback"));
    }, CALLBACK_TIMEOUT_MS).unref();
  });
}

export async function login(): Promise<Tokens> {
  const md = await discover();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const url = new URL(md.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", RESOURCE);
  if (SCOPE) url.searchParams.set("scope", SCOPE);

  const code = await waitForCallback(url, state);
  const tokens = await exchange(md, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  saveTokens(tokens);
  return tokens;
}

export async function refresh(t: Tokens): Promise<Tokens> {
  assertTokenBinding(t);
  if (!t.refresh_token) throw new Error("no refresh_token stored; run login again");
  const md = await discover();
  const next = await exchange(md, {
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: CLIENT_ID,
    resource: RESOURCE,
  });
  if (!next.refresh_token) next.refresh_token = t.refresh_token;
  saveTokens(next);
  return next;
}

/** Returns a usable token, refreshing when possible; null when never logged in. */
export async function getAccessToken(): Promise<Tokens | null> {
  const t = loadTokens();
  if (!t) return null;
  assertTokenBinding(t);
  if (!isExpired(t)) return t;
  if (t.refresh_token) return refresh(t);
  throw new Error("stored access token expired and no refresh_token available; run login again");
}

/** Safe-to-print summary: no token material. */
export function describe(t: Tokens): Record<string, unknown> {
  return {
    token_type: t.token_type,
    scope: t.scope ?? null,
    obtained_at: t.obtained_at,
    expires_at: t.expires_at,
    has_refresh_token: Boolean(t.refresh_token),
    issuer: t.issuer,
    client_id: t.client_id,
    resource: t.resource,
  };
}
