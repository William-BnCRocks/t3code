import { decodeRelayJwt } from "@t3tools/shared/relayJwt";
import { Atom } from "effect/unstable/reactivity";
import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";

import { appAtomRegistry } from "../../state/atom-registry";
import { resolveOidcPublicConfig } from "./publicConfig";

const OIDC_TOKEN_STORAGE_KEY = "t3code.cloud.oidc-session";
const OIDC_REDIRECT_PATH = "oidc-callback";
const OIDC_SCOPES = ["openid", "profile", "email", "offline_access"];
const OIDC_REFRESH_MARGIN_MS = 60_000;

export interface OidcTokenRecord {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAtEpochMs: number;
  readonly idTokenClaims?: Record<string, unknown>;
}

export interface OidcSessionState {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly displayIdentity: string | null;
}

type OidcTokenResponseLike = Pick<
  AuthSession.TokenResponse,
  "accessToken" | "expiresIn" | "issuedAt" | "refreshToken" | "idToken"
>;

const UNLOADED_SESSION_STATE: OidcSessionState = {
  isLoaded: false,
  isSignedIn: false,
  userId: null,
  displayIdentity: null,
};

// Mirrors connectOnboardingRequestAtom / managedRelaySessionAtom: a registry
// atom is the app's existing pattern for state that both React components and
// plain imperative callers (CloudAuthProvider) need to read.
export const oidcSessionAtom = Atom.make<OidcSessionState>(UNLOADED_SESSION_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:oidc-session"),
);

let currentTokenRecord: OidcTokenRecord | null = null;
let initialization: Promise<void> | null = null;
let refreshInFlight: Promise<string | null> | null = null;
let discoveryDocument: Promise<AuthSession.DiscoveryDocument> | null = null;

function tokenSubject(accessToken: string): string | null {
  try {
    const sub = decodeRelayJwt(accessToken).sub;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

function displayIdentityFromClaims(
  claims: Record<string, unknown> | undefined,
  fallback: string | null,
): string | null {
  for (const key of ["email", "preferred_username"] as const) {
    const value = claims?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const sub = claims?.sub;
  return typeof sub === "string" && sub.trim() ? sub.trim() : fallback;
}

function sessionStateFromRecord(record: OidcTokenRecord | null): OidcSessionState {
  if (!record) {
    return { isLoaded: true, isSignedIn: false, userId: null, displayIdentity: null };
  }
  // The relay caches accounts by the bearer token's own `sub`, so this must
  // read the access token (what the relay actually sees), not the ID token.
  const userId = tokenSubject(record.accessToken);
  return {
    isLoaded: true,
    isSignedIn: userId !== null,
    userId,
    displayIdentity: displayIdentityFromClaims(record.idTokenClaims, userId),
  };
}

function publishSessionState(record: OidcTokenRecord | null): void {
  currentTokenRecord = record;
  appAtomRegistry.set(oidcSessionAtom, sessionStateFromRecord(record));
}

function parsePersistedTokenRecord(raw: string): OidcTokenRecord | null {
  try {
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    const parsed = JSON.parse(raw) as Partial<OidcTokenRecord> | null;
    if (
      !parsed ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.expiresAtEpochMs !== "number"
    ) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      expiresAtEpochMs: parsed.expiresAtEpochMs,
      ...(typeof parsed.refreshToken === "string" ? { refreshToken: parsed.refreshToken } : {}),
      ...(parsed.idTokenClaims && typeof parsed.idTokenClaims === "object"
        ? { idTokenClaims: parsed.idTokenClaims }
        : {}),
    };
  } catch {
    return null;
  }
}

async function loadPersistedTokenRecord(): Promise<OidcTokenRecord | null> {
  const raw = await SecureStore.getItemAsync(OIDC_TOKEN_STORAGE_KEY);
  return raw ? parsePersistedTokenRecord(raw) : null;
}

async function savePersistedTokenRecord(record: OidcTokenRecord): Promise<void> {
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  await SecureStore.setItemAsync(OIDC_TOKEN_STORAGE_KEY, JSON.stringify(record));
}

async function clearPersistedTokenRecord(): Promise<void> {
  await SecureStore.deleteItemAsync(OIDC_TOKEN_STORAGE_KEY);
}

/** Loads any persisted session once per process and publishes it to the atom. */
export function ensureOidcSessionInitialized(): Promise<void> {
  if (!initialization) {
    initialization = loadPersistedTokenRecord()
      .catch(() => null)
      .then((record) => {
        publishSessionState(record);
      });
  }
  return initialization;
}

function loadDiscovery(issuerUrl: string): Promise<AuthSession.DiscoveryDocument> {
  if (!discoveryDocument) {
    discoveryDocument = AuthSession.fetchDiscoveryAsync(issuerUrl).catch((error: unknown) => {
      discoveryDocument = null;
      throw error;
    });
  }
  return discoveryDocument;
}

function computeExpiresAtEpochMs(tokenResponse: OidcTokenResponseLike): number {
  const issuedAtMs = tokenResponse.issuedAt ? tokenResponse.issuedAt * 1000 : Date.now();
  const expiresInMs = (tokenResponse.expiresIn ?? 3600) * 1000;
  return issuedAtMs + expiresInMs;
}

function decodeIdTokenClaims(idToken: string | undefined): Record<string, unknown> | undefined {
  if (!idToken) {
    return undefined;
  }
  try {
    return decodeRelayJwt(idToken);
  } catch {
    return undefined;
  }
}

async function applyTokenResponse(
  tokenResponse: OidcTokenResponseLike,
  previousIdTokenClaims?: Record<string, unknown>,
): Promise<string> {
  const idTokenClaims = decodeIdTokenClaims(tokenResponse.idToken) ?? previousIdTokenClaims;
  const record: OidcTokenRecord = {
    accessToken: tokenResponse.accessToken,
    expiresAtEpochMs: computeExpiresAtEpochMs(tokenResponse),
    ...(tokenResponse.refreshToken ? { refreshToken: tokenResponse.refreshToken } : {}),
    ...(idTokenClaims ? { idTokenClaims } : {}),
  };
  await savePersistedTokenRecord(record);
  publishSessionState(record);
  return record.accessToken;
}

/** Whether a token is fresh enough to hand out without refreshing first. */
export function isOidcAccessTokenFresh(
  record: Pick<OidcTokenRecord, "expiresAtEpochMs">,
  nowEpochMs: number,
  marginMs: number = OIDC_REFRESH_MARGIN_MS,
): boolean {
  return record.expiresAtEpochMs - nowEpochMs > marginMs;
}

async function refreshTokenRecord(record: OidcTokenRecord): Promise<string | null> {
  if (!record.refreshToken) {
    await signOutOidc();
    return null;
  }
  const config = resolveOidcPublicConfig();
  if (!config) {
    await signOutOidc();
    return null;
  }
  try {
    const discovery = await loadDiscovery(config.issuerUrl);
    const refreshed = await AuthSession.refreshAsync(
      { clientId: config.clientId, refreshToken: record.refreshToken },
      discovery,
    );
    return await applyTokenResponse(
      { ...refreshed, refreshToken: refreshed.refreshToken ?? record.refreshToken },
      record.idTokenClaims,
    );
  } catch (error) {
    // Only a definitive rejection from the token endpoint (revoked or expired
    // refresh token) proves the session is unrecoverable. Anything else is
    // most likely transient network loss on a moving device, so keep the
    // stored session and let a later call retry the refresh.
    if (error instanceof AuthSession.TokenError) {
      await signOutOidc();
    }
    return null;
  }
}

/**
 * Returns a valid access token, refreshing it first if it is within
 * `OIDC_REFRESH_MARGIN_MS` of expiring. Returns null when signed out or when
 * refreshing turns out to be impossible (treated as signed out).
 */
export async function getOidcAccessToken(): Promise<string | null> {
  await ensureOidcSessionInitialized();
  const record = currentTokenRecord;
  if (!record) {
    return null;
  }
  if (isOidcAccessTokenFresh(record, Date.now())) {
    return record.accessToken;
  }
  if (!refreshInFlight) {
    refreshInFlight = refreshTokenRecord(record).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Launches the PKCE authorization-code flow in the system browser. */
export async function signInWithOidc(): Promise<void> {
  const config = resolveOidcPublicConfig();
  if (!config) {
    return;
  }
  const discovery = await loadDiscovery(config.issuerUrl);
  const redirectUri = AuthSession.makeRedirectUri({ path: OIDC_REDIRECT_PATH });
  const request = new AuthSession.AuthRequest({
    clientId: config.clientId,
    redirectUri,
    scopes: [...OIDC_SCOPES],
    usePKCE: true,
  });
  const result = await request.promptAsync(discovery);
  if (result.type !== "success" || !result.params.code) {
    return;
  }
  const tokenResponse = await AuthSession.exchangeCodeAsync(
    {
      clientId: config.clientId,
      code: result.params.code,
      redirectUri,
      extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : {},
    },
    discovery,
  );
  await applyTokenResponse(tokenResponse);
}

/**
 * Clears the local session. The end_session_endpoint is intentionally not
 * used: ending the IdP's own browser session would require a further
 * redirect round-trip through the system browser for little benefit here, so
 * signing out of T3 Connect only ever signs this device out.
 */
export async function signOutOidc(): Promise<void> {
  await clearPersistedTokenRecord().catch(() => undefined);
  publishSessionState(null);
}

export function __resetOidcSessionForTest(): void {
  currentTokenRecord = null;
  initialization = null;
  refreshInFlight = null;
  discoveryDocument = null;
  appAtomRegistry.set(oidcSessionAtom, UNLOADED_SESSION_STATE);
}
