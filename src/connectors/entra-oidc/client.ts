/**
 * Microsoft Entra ID (Azure AD) — USER sign-in via OpenID Connect.
 *
 * This is the org-SSO front door for the field PWA and the Light admin. It is
 * DISTINCT from src/connectors/azure-ad (which does client-credentials
 * service-to-service auth for the external KB): that app registration has no
 * user redirect URIs. Same Entra directory, different app.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STATUS: INERT UNTIL CONFIGURED.
 *
 *   isEntraOidcConfigured() === false  ⇒  every route no-ops with a clear
 *   "not configured" response and the PWA never shows a Microsoft button.
 *
 * It cannot be verified end-to-end without a real Azure App Registration
 * (redirect URI + client), so it is deliberately NOT wired as any client's
 * default login. Enabling it is: (1) create the app registration, (2) set the
 * ENTRA_OIDC_* env vars, (3) run one live sign-in and confirm the id_token
 * validates. Until then this is scaffold — real transport, no live proof.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Flow: server-side Authorization Code + PKCE. The shim owns the whole OIDC
 * dance (matches the architecture rule: identity is server-side, clients are
 * thin); clients just get redirected. No client secret ever reaches a browser.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";

export interface EntraOidcConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string; // optional for a pure-PKCE public client; blank is allowed
  authority: string; // e.g. https://login.microsoftonline.com
  redirectUri: string; // must exactly match an app-registration redirect URI
  allowedDomains: string[]; // empty = allow any verified account in the tenant
}

function cfg(): EntraOidcConfig {
  const authority = (process.env.ENTRA_OIDC_AUTHORITY?.trim() || "https://login.microsoftonline.com").replace(/\/$/, "");
  return {
    // Tenant defaults to the KB connector's tenant — it's the same directory.
    tenantId: process.env.ENTRA_OIDC_TENANT_ID?.trim() || process.env.AZURE_TENANT_ID?.trim() || "",
    clientId: process.env.ENTRA_OIDC_CLIENT_ID?.trim() || "",
    clientSecret: process.env.ENTRA_OIDC_CLIENT_SECRET?.trim() || "",
    authority,
    redirectUri: process.env.ENTRA_OIDC_REDIRECT_URI?.trim() || "",
    allowedDomains: (process.env.ENTRA_OIDC_ALLOWED_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  };
}

/**
 * Configured = enough to run the flow: a tenant AND a client ID. The client
 * secret is intentionally NOT required (a public PKCE client is valid), and the
 * redirect URI is validated at request time so a misconfig produces a clear
 * error rather than silently disabling SSO.
 */
export function isEntraOidcConfigured(): boolean {
  const c = cfg();
  return Boolean(c.tenantId && c.clientId);
}

/** Public-safe status for the admin/login UI. Never returns the secret. */
export function entraOidcStatus(): {
  configured: boolean;
  tenantId: string | null;
  clientId: string | null;
  redirectUri: string | null;
  hasSecret: boolean;
} {
  const c = cfg();
  return {
    configured: isEntraOidcConfigured(),
    tenantId: c.tenantId || null,
    clientId: c.clientId || null,
    redirectUri: c.redirectUri || null,
    hasSecret: Boolean(c.clientSecret),
  };
}

function endpoints(c: EntraOidcConfig) {
  const base = `${c.authority}/${encodeURIComponent(c.tenantId)}`;
  return {
    authorize: `${base}/oauth2/v2.0/authorize`,
    token: `${base}/oauth2/v2.0/token`,
    jwks: `${base}/discovery/v2.0/keys`,
    // Entra v2 issuer for a tenant-scoped app.
    issuer: `${base}/v2.0`,
  };
}

// --- PKCE -------------------------------------------------------------------
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function newState(): string {
  return base64url(randomBytes(16));
}

/** Build the Entra authorize URL to 302 the browser to. */
export function buildAuthorizeUrl(opts: {
  state: string;
  codeChallenge: string;
  redirectUri?: string;
}): string {
  const c = cfg();
  const e = endpoints(c);
  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri || c.redirectUri,
    response_mode: "query",
    scope: "openid profile email",
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${e.authorize}?${params.toString()}`;
}

/** Exchange the authorization code for tokens. Returns the raw id_token. */
export async function exchangeCodeForIdToken(opts: {
  code: string;
  codeVerifier: string;
  redirectUri?: string;
}): Promise<string> {
  const c = cfg();
  const e = endpoints(c);
  const body = new URLSearchParams({
    client_id: c.clientId,
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri || c.redirectUri,
    code_verifier: opts.codeVerifier,
    scope: "openid profile email",
  });
  // Confidential client if a secret is configured; otherwise pure PKCE.
  if (c.clientSecret) body.set("client_secret", c.clientSecret);

  const resp = await fetch(e.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !json?.id_token) {
    const detail = json?.error_description || json?.error || `HTTP ${resp.status}`;
    throw new Error(`Entra token exchange failed: ${String(detail).slice(0, 200)}`);
  }
  return String(json.id_token);
}

// --- id_token verification --------------------------------------------------
type Jwk = { kid: string; kty: string; n: string; e: string; alg?: string; use?: string };
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h — Entra rotates slowly; refetch on kid miss anyway.

async function getJwks(force = false): Promise<Jwk[]> {
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const c = cfg();
  const resp = await fetch(endpoints(c).jwks);
  if (!resp.ok) throw new Error(`Entra JWKS fetch failed: HTTP ${resp.status}`);
  const json: any = await resp.json();
  const keys: Jwk[] = Array.isArray(json?.keys) ? json.keys : [];
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

function decodeSegment(seg: string): Buffer {
  return Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export interface EntraIdentity {
  email: string;
  name?: string;
  oid?: string; // Entra object id (stable per-user)
  tid?: string;
}

/**
 * Verify an Entra id_token and return the identity. Throws on ANY failure —
 * signature, issuer, audience, expiry, tenant, or a missing email. Fail closed:
 * a token we can't fully validate is not an identity.
 */
export async function verifyIdToken(idToken: string): Promise<EntraIdentity> {
  const c = cfg();
  const e = endpoints(c);

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token is not a well-formed JWT");
  const header = JSON.parse(decodeSegment(parts[0]).toString("utf8"));
  const payload = JSON.parse(decodeSegment(parts[1]).toString("utf8"));
  const signature = decodeSegment(parts[2]);

  if (header.alg !== "RS256") throw new Error(`Unexpected id_token alg: ${header.alg}`);

  // Find the signing key by kid; refetch JWKS once on a miss (key rotation).
  const findKey = async (force: boolean): Promise<Jwk | undefined> =>
    (await getJwks(force)).find((k) => k.kid === header.kid);
  let jwk = await findKey(false);
  if (!jwk) jwk = await findKey(true);
  if (!jwk) throw new Error(`id_token kid '${header.kid}' not found in Entra JWKS`);

  const pubKey = createPublicKey({ key: jwk as any, format: "jwk" });
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sigOk = cryptoVerify("RSA-SHA256", signingInput, pubKey, signature);
  if (!sigOk) throw new Error("id_token signature verification failed");

  // Claims.
  const now = Math.floor(Date.now() / 1000);
  const skew = 120; // 2 min clock skew tolerance
  if (typeof payload.exp === "number" && payload.exp + skew < now) throw new Error("id_token expired");
  if (typeof payload.nbf === "number" && payload.nbf - skew > now) throw new Error("id_token not yet valid");
  if (payload.iss !== e.issuer) throw new Error(`id_token issuer mismatch (got ${payload.iss})`);
  if (payload.aud !== c.clientId) throw new Error("id_token audience mismatch");
  if (c.tenantId && payload.tid && payload.tid !== c.tenantId) {
    throw new Error("id_token tenant mismatch");
  }

  // Entra puts the address in email, else preferred_username / upn (the UPN).
  const email = String(payload.email || payload.preferred_username || payload.upn || "")
    .trim()
    .toLowerCase();
  if (!email) throw new Error("id_token carried no email/preferred_username");

  if (c.allowedDomains.length > 0) {
    const domain = email.split("@")[1] ?? "";
    if (!c.allowedDomains.includes(domain)) {
      throw new Error(`Email domain '${domain}' not in ENTRA_OIDC_ALLOWED_DOMAINS`);
    }
  }

  return {
    email,
    name: typeof payload.name === "string" ? payload.name : undefined,
    oid: typeof payload.oid === "string" ? payload.oid : undefined,
    tid: typeof payload.tid === "string" ? payload.tid : undefined,
  };
}
