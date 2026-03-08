import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { sign, createPrivateKey, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type {
  ServiceAccountKey,
  OAuthClientConfig,
  OAuthTokenData,
  TokenProvider,
} from "./types.js";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_LIFETIME_SEC = 3600;
const REFRESH_MARGIN_SEC = 300;

const READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const WRITE_SCOPE = "https://www.googleapis.com/auth/webmasters";

const DEFAULT_TOKEN_DIR = join(homedir(), ".config", "gsc-mcp");
const DEFAULT_TOKEN_FILE = "oauth-token.json";

// ---------------------------------------------------------------------------
// Scope helpers (shared by both auth methods)
// ---------------------------------------------------------------------------

export function getScopes(): string {
  const custom = process.env["GSC_SCOPES"];
  if (custom) return custom;
  return READONLY_SCOPE;
}

export function hasWriteScope(): boolean {
  const scopeList = getScopes().split(" ");
  return scopeList.includes(WRITE_SCOPE);
}

// ---------------------------------------------------------------------------
// Service Account auth (existing, now wrapped behind TokenProvider)
// ---------------------------------------------------------------------------

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let saCachedToken: CachedToken | null = null;
let saPendingRefresh: Promise<string> | null = null;

function validateServiceAccountKey(data: unknown): ServiceAccountKey {
  if (typeof data !== "object" || data === null) {
    throw new Error("Service account key must be a JSON object.");
  }

  const obj = data as Record<string, unknown>;
  const required = ["private_key", "client_email", "private_key_id"] as const;

  for (const field of required) {
    if (typeof obj[field] !== "string" || (obj[field] as string).length === 0) {
      throw new Error(
        `Service account key is missing or has invalid field: "${field}". Check your key file.`,
      );
    }
  }

  const pk = obj["private_key"] as string;
  if (!pk.includes("-----BEGIN") || !pk.includes("PRIVATE KEY-----")) {
    throw new Error(
      "Service account key has an invalid private_key format. Expected PEM-encoded key.",
    );
  }

  return data as ServiceAccountKey;
}

export async function loadServiceAccountKey(): Promise<ServiceAccountKey> {
  const inline = process.env["GSC_SERVICE_ACCOUNT_KEY"];
  if (inline) {
    delete process.env["GSC_SERVICE_ACCOUNT_KEY"];
    return validateServiceAccountKey(JSON.parse(inline));
  }

  const filePath = process.env["GSC_SERVICE_ACCOUNT_KEY_FILE"];
  if (!filePath) {
    throw new Error(
      "Missing service account credentials. Set GSC_SERVICE_ACCOUNT_KEY_FILE (path to JSON key) or GSC_SERVICE_ACCOUNT_KEY (inline JSON).",
    );
  }

  const raw = await readFile(filePath, "utf-8");
  return validateServiceAccountKey(JSON.parse(raw));
}

function createJwt(key: ServiceAccountKey, scope: string): string {
  try {
    const now = Math.floor(Date.now() / 1000);

    const header = { alg: "RS256", typ: "JWT", kid: key.private_key_id };
    const payload = {
      iss: key.client_email,
      scope,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + TOKEN_LIFETIME_SEC,
    };

    const segments = [
      Buffer.from(JSON.stringify(header)).toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
    ];
    const signingInput = segments.join(".");

    const privateKey = createPrivateKey(key.private_key);
    const signature = sign("sha256", Buffer.from(signingInput), privateKey).toString("base64url");

    return `${signingInput}.${signature}`;
  } catch {
    throw new Error("Failed to create JWT. Check service account key format.");
  }
}

async function fetchSaAccessToken(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const scope = getScopes();
  const jwt = createJwt(key, scope);

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };

  if (!data.access_token) {
    throw new Error("Token response missing access_token field.");
  }

  saCachedToken = {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in ?? TOKEN_LIFETIME_SEC),
  };

  return saCachedToken.accessToken;
}

/** Get a valid SA access token, using cache and coalescing concurrent refreshes. */
export async function getSaAccessToken(key: ServiceAccountKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (saCachedToken && saCachedToken.expiresAt > now + REFRESH_MARGIN_SEC) {
    return saCachedToken.accessToken;
  }

  if (!saPendingRefresh) {
    saPendingRefresh = fetchSaAccessToken(key).finally(() => {
      saPendingRefresh = null;
    });
  }

  return saPendingRefresh;
}

/** Create a TokenProvider from a service account key. */
export function createSaTokenProvider(key: ServiceAccountKey): TokenProvider {
  return () => getSaAccessToken(key);
}

// ---------------------------------------------------------------------------
// OAuth2 "Installed App" auth
// ---------------------------------------------------------------------------

export function getOAuthTokenPath(): string {
  const override = process.env["GSC_OAUTH_TOKEN_FILE"];
  if (override) return override;
  return join(DEFAULT_TOKEN_DIR, DEFAULT_TOKEN_FILE);
}

export async function loadOAuthConfig(filePath: string): Promise<OAuthClientConfig> {
  const raw = await readFile(filePath, "utf-8");
  const data = JSON.parse(raw) as OAuthClientConfig;

  if (!data.installed?.client_id || !data.installed?.client_secret) {
    throw new Error(
      `OAuth client config at "${filePath}" is invalid. Expected "installed" type with client_id and client_secret.`,
    );
  }

  return data;
}

export async function loadSavedToken(): Promise<OAuthTokenData | null> {
  const tokenPath = getOAuthTokenPath();
  try {
    const raw = await readFile(tokenPath, "utf-8");
    const data = JSON.parse(raw) as OAuthTokenData;
    if (!data.refresh_token) return null;
    return data;
  } catch {
    return null;
  }
}

async function saveToken(token: OAuthTokenData): Promise<void> {
  const tokenPath = getOAuthTokenPath();
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  await writeFile(tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
}

export async function refreshOAuthToken(
  config: OAuthClientConfig,
  refreshToken: string,
): Promise<OAuthTokenData> {
  const { client_id, client_secret, token_uri } = config.installed;

  const res = await fetch(token_uri || GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id,
      client_secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token refresh failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  };

  if (!data.access_token) {
    throw new Error("OAuth token refresh response missing access_token.");
  }

  const now = Math.floor(Date.now() / 1000);
  const token: OAuthTokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken, // Google may not return a new refresh token
    expires_at: now + (data.expires_in ?? TOKEN_LIFETIME_SEC),
    scope: data.scope ?? getScopes(),
  };

  await saveToken(token);
  return token;
}

async function exchangeCodeForToken(
  config: OAuthClientConfig,
  code: string,
  redirectUri: string,
): Promise<OAuthTokenData> {
  const { client_id, client_secret, token_uri } = config.installed;

  const res = await fetch(token_uri || GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id,
      client_secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth code exchange failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!data.access_token || !data.refresh_token) {
    throw new Error("OAuth code exchange response missing access_token or refresh_token.");
  }

  const now = Math.floor(Date.now() / 1000);
  const token: OAuthTokenData = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: now + (data.expires_in ?? TOKEN_LIFETIME_SEC),
    scope: data.scope ?? getScopes(),
  };

  await saveToken(token);
  return token;
}

const CALLBACK_PORT = 3847;

/**
 * Build the redirect URI for the OAuth callback.
 * Google "installed" apps allow any localhost port, so we always use our fixed port.
 * The redirect_uri sent to Google must match exactly where we listen.
 */
function buildRedirectUri(): string {
  return `http://localhost:${CALLBACK_PORT}`;
}

/**
 * Run interactive OAuth consent flow:
 * 1. Print auth URL to stderr
 * 2. Start local HTTP server to receive the callback
 * 3. Exchange code for tokens
 */
export async function runInteractiveOAuthFlow(
  config: OAuthClientConfig,
): Promise<OAuthTokenData> {
  const redirectUri = buildRedirectUri();
  const port = CALLBACK_PORT;

  const state = randomBytes(16).toString("hex");
  const scope = getScopes();

  const authUrl = new URL(config.installed.auth_uri || GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", config.installed.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  console.error("\n[gsc-mcp] OAuth setup required. Open this URL in your browser:\n");
  console.error(`  ${authUrl.toString()}\n`);
  console.error(`[gsc-mcp] Waiting for authorization callback on port ${port}...\n`);

  const code = await waitForAuthCode(port, state);
  return exchangeCodeForToken(config, code, redirectUri);
}

function waitForAuthCode(port: number, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);

      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Authorization failed</h1><p>${error}</p><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(`OAuth authorization denied: ${error}`));
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Missing authorization code</h1><p>You can close this tab.</p>");
        return; // Don't close server — might be a favicon request etc.
      }

      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>State mismatch</h1><p>Possible CSRF attack. You can close this tab.</p>");
        server.close();
        reject(new Error("OAuth state mismatch — possible CSRF."));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>",
      );
      server.close();
      resolve(code);
    });

    server.listen(port, "127.0.0.1");

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth authorization timed out after 5 minutes."));
    }, 5 * 60 * 1000);

    server.on("close", () => clearTimeout(timeout));
  });
}

// ---------------------------------------------------------------------------
// OAuth TokenProvider — caches in memory, refreshes automatically
// ---------------------------------------------------------------------------

let oauthCachedToken: OAuthTokenData | null = null;
let oauthPendingRefresh: Promise<string> | null = null;

export function createOAuthTokenProvider(config: OAuthClientConfig): TokenProvider {
  return async () => {
    const now = Math.floor(Date.now() / 1000);

    // Return cached token if still valid
    if (oauthCachedToken && oauthCachedToken.expires_at > now + REFRESH_MARGIN_SEC) {
      return oauthCachedToken.access_token;
    }

    // Coalesce concurrent refreshes
    if (oauthPendingRefresh) return oauthPendingRefresh;

    oauthPendingRefresh = (async () => {
      // Try in-memory token first, then disk
      const token = oauthCachedToken ?? (await loadSavedToken());

      if (!token?.refresh_token) {
        throw new Error(
          "No OAuth refresh token available. Re-run the server to complete the authorization flow.",
        );
      }

      const refreshed = await refreshOAuthToken(config, token.refresh_token);
      oauthCachedToken = refreshed;
      return refreshed.access_token;
    })().finally(() => {
      oauthPendingRefresh = null;
    });

    return oauthPendingRefresh;
  };
}

// ---------------------------------------------------------------------------
// Credential resolution — creates the right TokenProvider
// ---------------------------------------------------------------------------

export async function createTokenProvider(): Promise<{ provider: TokenProvider; label: string }> {
  // Priority 1: OAuth
  const oauthFile = process.env["GSC_OAUTH_CLIENT_FILE"];
  if (oauthFile) {
    const config = await loadOAuthConfig(oauthFile);
    let savedToken = await loadSavedToken();

    if (!savedToken) {
      // Run interactive flow to get initial tokens
      savedToken = await runInteractiveOAuthFlow(config);
    }

    // Seed the in-memory cache
    oauthCachedToken = savedToken;

    return {
      provider: createOAuthTokenProvider(config),
      label: `OAuth (${config.installed.client_id.slice(0, 12)}...)`,
    };
  }

  // Priority 2: Service Account
  const saInline = process.env["GSC_SERVICE_ACCOUNT_KEY"];
  const saFile = process.env["GSC_SERVICE_ACCOUNT_KEY_FILE"];

  if (saInline || saFile) {
    const key = await loadServiceAccountKey();
    return {
      provider: createSaTokenProvider(key),
      label: `Service Account (${key.client_email})`,
    };
  }

  throw new Error(
    "No credentials configured. Set GSC_OAUTH_CLIENT_FILE (recommended) or GSC_SERVICE_ACCOUNT_KEY_FILE / GSC_SERVICE_ACCOUNT_KEY.",
  );
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Reset all token caches (for testing) */
export function resetTokenCache(): void {
  saCachedToken = null;
  saPendingRefresh = null;
  oauthCachedToken = null;
  oauthPendingRefresh = null;
}
