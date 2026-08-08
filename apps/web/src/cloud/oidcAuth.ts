import { buildConnectClerkAuthorizeUrl } from "@t3tools/shared/connectAuth";
import { type OidcProviderMetadata } from "@t3tools/shared/oidcDiscovery";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { decodeJwt } from "jose";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { resolveOidcWebAuthConfig } from "./publicConfig";

const OIDC_SESSION_STORAGE_KEY = "t3code-oidc-session";
const OIDC_PENDING_REQUEST_STORAGE_KEY = "t3code-oidc-pending-request";
const OIDC_SCOPES = ["openid", "profile", "email", "offline_access"] as const;
const OIDC_ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;

export class OidcAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

interface OidcStoredSession {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: number;
  readonly userId: string;
  readonly displayIdentity: string | null;
}

interface OidcPendingRequest {
  readonly state: string;
  readonly verifier: string;
  readonly returnTo: string;
}

export interface OidcAuthSnapshot {
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly displayIdentity: string | null;
}

const SIGNED_OUT_SNAPSHOT: OidcAuthSnapshot = {
  isSignedIn: false,
  userId: null,
  displayIdentity: null,
};

function snapshotFromSession(session: OidcStoredSession | null): OidcAuthSnapshot {
  return session
    ? { isSignedIn: true, userId: session.userId, displayIdentity: session.displayIdentity }
    : SIGNED_OUT_SNAPSHOT;
}

function readStoredSession(): OidcStoredSession | null {
  try {
    const raw = window.localStorage.getItem(OIDC_SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OidcStoredSession) : null;
  } catch {
    return null;
  }
}

const oidcAuthSnapshotAtom = Atom.make(snapshotFromSession(readStoredSession())).pipe(
  Atom.keepAlive,
  Atom.withLabel("cloud:oidc:session"),
);

export function useOidcAuthSnapshot(): OidcAuthSnapshot {
  return useAtomValue(oidcAuthSnapshotAtom);
}

export function readOidcAuthSnapshot(): OidcAuthSnapshot {
  return appAtomRegistry.get(oidcAuthSnapshotAtom);
}

function writeStoredSession(session: OidcStoredSession): void {
  try {
    window.localStorage.setItem(OIDC_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage can be unavailable (e.g. private browsing); the in-memory atom
    // still reflects the session for the current tab.
  }
  appAtomRegistry.set(oidcAuthSnapshotAtom, snapshotFromSession(session));
}

function clearStoredSession(): void {
  try {
    window.localStorage.removeItem(OIDC_SESSION_STORAGE_KEY);
  } catch {
    // See writeStoredSession.
  }
  appAtomRegistry.set(oidcAuthSnapshotAtom, SIGNED_OUT_SNAPSHOT);
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === OIDC_SESSION_STORAGE_KEY) {
      appAtomRegistry.set(oidcAuthSnapshotAtom, snapshotFromSession(readStoredSession()));
    }
  });
}

function writePendingRequest(pending: OidcPendingRequest): void {
  try {
    window.sessionStorage.setItem(OIDC_PENDING_REQUEST_STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // A blocked sessionStorage means the callback cannot verify state and
    // will fail closed instead of completing the sign-in.
  }
}

function readPendingRequest(): OidcPendingRequest | null {
  try {
    const raw = window.sessionStorage.getItem(OIDC_PENDING_REQUEST_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as OidcPendingRequest) : null;
  } catch {
    return null;
  }
}

function clearPendingRequest(): void {
  try {
    window.sessionStorage.removeItem(OIDC_PENDING_REQUEST_STORAGE_KEY);
  } catch {
    // See writePendingRequest.
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateOidcCodeVerifier(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function computeOidcCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function generateOidcState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

export function oidcCallbackUrl(): string {
  return new URL("/oidc/callback", window.location.origin).toString();
}

/**
 * Fixed loopback contract with the Electron main process's OIDC listener
 * (see apps/desktop's DesktopOidcLogin.ts) -- the OIDC client allowlists this
 * exact redirect URI. There's no shared package between web and desktop for
 * this, so both sides hardcode the port and path independently.
 */
const OIDC_DESKTOP_LOOPBACK_REDIRECT_URI = "http://127.0.0.1:34339/callback";

export function hasDesktopOidcLoginBridge(): boolean {
  return typeof window !== "undefined" && typeof window.desktopOidcLogin === "function";
}

// Discovery is per-issuer and effectively static for the app's lifetime, so a
// single in-flight/failed lookup is shared across every caller rather than
// re-fetched per sign-in attempt or token refresh.
const discoveryCache = new Map<string, Promise<OidcProviderMetadata>>();

// A plain browser fetch of the discovery document, not the Effect HttpClient:
// that client injects a `traceparent` header, which turns this into a
// preflighted cross-origin request that the issuer's CORS policy rejects. A
// bare GET with no custom headers stays CORS-simple against any provider.
async function fetchOidcMetadata(issuerUrl: string): Promise<OidcProviderMetadata> {
  const normalizedIssuer = issuerUrl.replace(/\/+$/u, "");
  const response = await fetch(`${normalizedIssuer}/.well-known/openid-configuration`);
  if (!response.ok) {
    throw new OidcAuthError(
      `The OIDC discovery document request returned ${response.status}.`,
      response.status,
    );
  }
  const document = (await response.json()) as {
    readonly issuer?: unknown;
    readonly authorization_endpoint?: unknown;
    readonly token_endpoint?: unknown;
  };
  if (
    typeof document.issuer !== "string" ||
    typeof document.authorization_endpoint !== "string" ||
    typeof document.token_endpoint !== "string"
  ) {
    throw new OidcAuthError("The OIDC discovery document is missing required fields.");
  }
  if (document.issuer.replace(/\/+$/u, "") !== normalizedIssuer) {
    throw new OidcAuthError("The OIDC discovery document issuer does not match the configuration.");
  }
  return {
    issuer: document.issuer,
    authorizationEndpoint: document.authorization_endpoint,
    tokenEndpoint: document.token_endpoint,
  };
}

export function discoverOidcMetadata(issuerUrl: string): Promise<OidcProviderMetadata> {
  const cached = discoveryCache.get(issuerUrl);
  if (cached) return cached;
  const pending = fetchOidcMetadata(issuerUrl).catch((cause) => {
    discoveryCache.delete(issuerUrl);
    throw cause;
  });
  discoveryCache.set(issuerUrl, pending);
  return pending;
}

interface OidcTokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly id_token?: string;
}

async function requestOidcToken(
  tokenEndpoint: string,
  params: Record<string, string>,
): Promise<OidcTokenResponse> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new OidcAuthError(
      `The OIDC token endpoint returned ${response.status}.`,
      response.status,
    );
  }
  return (await response.json()) as OidcTokenResponse;
}

function accessTokenSubject(accessToken: string): string | null {
  try {
    const sub = decodeJwt(accessToken).sub;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

interface OidcSessionRefreshFallback {
  readonly refreshToken: string | null;
  readonly userId: string;
  readonly displayIdentity: string | null;
}

function sessionFromTokenResponse(
  response: OidcTokenResponse,
  fallback: OidcSessionRefreshFallback | null,
): OidcStoredSession {
  const claims = response.id_token ? decodeJwt(response.id_token) : {};
  const userId =
    typeof claims.sub === "string"
      ? claims.sub
      : (fallback?.userId ?? accessTokenSubject(response.access_token) ?? "");
  const displayIdentity =
    (typeof claims.email === "string" ? claims.email : null) ??
    (typeof claims.preferred_username === "string" ? claims.preferred_username : null) ??
    fallback?.displayIdentity ??
    (userId || null);
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? fallback?.refreshToken ?? null,
    expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
    userId,
    displayIdentity,
  };
}

/**
 * Desktop counterpart to the redirect flow below: the authorization-code
 * round trip happens in the system browser via a loopback listener owned by
 * the Electron main process, so there is no page navigation and nothing to
 * stash in sessionStorage -- the verifier just stays in this async call's
 * memory until the code comes back.
 */
async function oidcSignInViaDesktopBridge(
  config: { readonly issuerUrl: string; readonly clientId: string },
  metadata: OidcProviderMetadata,
): Promise<void> {
  const bridge = window.desktopOidcLogin;
  if (!bridge) {
    throw new OidcAuthError("The desktop sign-in bridge is unavailable.");
  }
  const verifier = generateOidcCodeVerifier();
  const challenge = await computeOidcCodeChallenge(verifier);
  const state = generateOidcState();
  const authorizeUrl = buildConnectClerkAuthorizeUrl({
    authorizationEndpoint: metadata.authorizationEndpoint,
    clientId: config.clientId,
    redirectUri: OIDC_DESKTOP_LOOPBACK_REDIRECT_URI,
    scopes: OIDC_SCOPES,
    state,
    challenge,
  });
  const { code } = await bridge(authorizeUrl, state);
  const tokenResponse = await requestOidcToken(metadata.tokenEndpoint, {
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: OIDC_DESKTOP_LOOPBACK_REDIRECT_URI,
    code_verifier: verifier,
  });
  writeStoredSession(sessionFromTokenResponse(tokenResponse, null));
}

/**
 * Starts the authorization-code + PKCE redirect. Resolves the issuer's
 * discovery document, stashes the verifier/state/return path in
 * sessionStorage, then leaves the page — nothing after the call runs. On
 * Electron with the loopback bridge available, delegates to
 * `oidcSignInViaDesktopBridge` instead and returns once that sign-in
 * completes (or throws).
 */
export async function oidcSignIn(returnTo?: string): Promise<void> {
  const config = resolveOidcWebAuthConfig();
  if (!config) return;
  const metadata = await discoverOidcMetadata(config.issuerUrl);
  if (hasDesktopOidcLoginBridge()) {
    await oidcSignInViaDesktopBridge(config, metadata);
    return;
  }
  const verifier = generateOidcCodeVerifier();
  const challenge = await computeOidcCodeChallenge(verifier);
  const state = generateOidcState();
  writePendingRequest({ state, verifier, returnTo: returnTo ?? window.location.href });
  const authorizeUrl = buildConnectClerkAuthorizeUrl({
    authorizationEndpoint: metadata.authorizationEndpoint,
    clientId: config.clientId,
    redirectUri: oidcCallbackUrl(),
    scopes: OIDC_SCOPES,
    state,
    challenge,
  });
  window.location.assign(authorizeUrl);
}

/**
 * Completes the redirect: exchanges the authorization code for tokens and
 * returns the path the user was on before `oidcSignIn` sent them away.
 */
export async function completeOidcSignIn(
  url: URL = new URL(window.location.href),
): Promise<string> {
  const pending = readPendingRequest();
  clearPendingRequest();

  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    throw new OidcAuthError(url.searchParams.get("error_description") ?? errorParam);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!pending || !code || !state || state !== pending.state) {
    throw new OidcAuthError(
      "This sign-in response does not match a request started in this browser.",
    );
  }
  const config = resolveOidcWebAuthConfig();
  if (!config) {
    throw new OidcAuthError("OIDC sign-in is not configured.");
  }
  const metadata = await discoverOidcMetadata(config.issuerUrl);
  const tokenResponse = await requestOidcToken(metadata.tokenEndpoint, {
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: oidcCallbackUrl(),
    code_verifier: pending.verifier,
  });
  writeStoredSession(sessionFromTokenResponse(tokenResponse, null));
  return pending.returnTo;
}

/**
 * Returns a usable access token, refreshing it first when it is within
 * `OIDC_ACCESS_TOKEN_REFRESH_MARGIN_MS` of expiring. Any refresh failure
 * (revoked session, network error, missing config) clears local state and
 * reports signed-out rather than surfacing a stale token.
 */
export async function getOidcAccessToken(): Promise<string | null> {
  const session = readStoredSession();
  if (!session) return null;
  if (session.expiresAt - Date.now() > OIDC_ACCESS_TOKEN_REFRESH_MARGIN_MS) {
    return session.accessToken;
  }
  if (!session.refreshToken) {
    clearStoredSession();
    return null;
  }
  const config = resolveOidcWebAuthConfig();
  if (!config) {
    clearStoredSession();
    return null;
  }
  // Refresh-token grants may rotate the token, so concurrent callers must
  // share one request instead of racing each other with the same token.
  if (!refreshInFlight) {
    refreshInFlight = refreshStoredSession(config, {
      ...session,
      refreshToken: session.refreshToken,
    }).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

let refreshInFlight: Promise<string | null> | null = null;

async function refreshStoredSession(
  config: { readonly issuerUrl: string; readonly clientId: string },
  session: OidcStoredSession & { readonly refreshToken: string },
): Promise<string | null> {
  try {
    const metadata = await discoverOidcMetadata(config.issuerUrl);
    const tokenResponse = await requestOidcToken(metadata.tokenEndpoint, {
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: session.refreshToken,
    });
    const refreshed = sessionFromTokenResponse(tokenResponse, {
      refreshToken: session.refreshToken,
      userId: session.userId,
      displayIdentity: session.displayIdentity,
    });
    writeStoredSession(refreshed);
    return refreshed.accessToken;
  } catch (error) {
    // Only a definitive token-endpoint rejection (4xx: revoked or expired
    // refresh token) proves the session is dead. Discovery failures, network
    // loss, and 5xx responses are transient — keep the session and let a
    // later call retry.
    if (error instanceof OidcAuthError && error.status !== undefined && error.status < 500) {
      clearStoredSession();
    }
    return null;
  }
}

export function oidcSignOut(): void {
  clearStoredSession();
}
