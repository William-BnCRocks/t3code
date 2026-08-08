import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const secureStore = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        oidc: { issuerUrl: "https://issuer.example.test", clientId: "t3-mobile" },
        relay: { url: "https://relay.example.test" },
      },
    },
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn((key: string) => Promise.resolve(secureStore.get(key) ?? null)),
  setItemAsync: vi.fn((key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: vi.fn((key: string) => {
    secureStore.delete(key);
    return Promise.resolve();
  }),
}));

const { MockTokenError } = vi.hoisted(() => {
  class MockTokenError extends Error {}
  return { MockTokenError };
});

vi.mock("expo-auth-session", () => ({
  fetchDiscoveryAsync: vi.fn(() =>
    Promise.resolve({ tokenEndpoint: "https://issuer.example.test/token" }),
  ),
  refreshAsync: vi.fn(),
  exchangeCodeAsync: vi.fn(),
  makeRedirectUri: vi.fn(() => "t3code://oidc-callback"),
  AuthRequest: vi.fn(),
  TokenError: MockTokenError,
}));

import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  __resetOidcSessionForTest,
  getOidcAccessToken,
  isOidcAccessTokenFresh,
  oidcSessionAtom,
  signOutOidc,
} from "./oidcSession";

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

const ACCESS_TOKEN = jwt({ sub: "user-1" });
const ID_TOKEN = jwt({ sub: "user-1", email: "person@example.test" });

function seedPersistedRecord(overrides: {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAtEpochMs: number;
  readonly idTokenClaims?: Record<string, unknown>;
}): void {
  secureStore.set(
    "t3code.cloud.oidc-session",
    JSON.stringify({
      accessToken: ACCESS_TOKEN,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  secureStore.clear();
  __resetOidcSessionForTest();
  vi.clearAllMocks();
});

afterEach(() => {
  __resetOidcSessionForTest();
});

describe("oidc session storage", () => {
  it("round-trips a persisted token record into signed-in session state", async () => {
    seedPersistedRecord({
      refreshToken: "refresh-1",
      expiresAtEpochMs: Date.now() + 3_600_000,
      idTokenClaims: { sub: "user-1", email: "person@example.test" },
    });

    const token = await getOidcAccessToken();

    expect(token).toBe(ACCESS_TOKEN);
    expect(appAtomRegistry.get(oidcSessionAtom)).toEqual({
      isLoaded: true,
      isSignedIn: true,
      userId: "user-1",
      displayIdentity: "person@example.test",
    });
  });

  it("treats missing persisted state as signed out", async () => {
    const token = await getOidcAccessToken();

    expect(token).toBeNull();
    expect(appAtomRegistry.get(oidcSessionAtom)).toMatchObject({
      isLoaded: true,
      isSignedIn: false,
    });
  });

  it("falls back to an empty session when persisted data is invalid", async () => {
    secureStore.set("t3code.cloud.oidc-session", "not-json");

    expect(await getOidcAccessToken()).toBeNull();
    expect(appAtomRegistry.get(oidcSessionAtom).isSignedIn).toBe(false);
  });

  it("clears persisted state and session on sign-out", async () => {
    seedPersistedRecord({ refreshToken: "refresh-1", expiresAtEpochMs: Date.now() + 3_600_000 });
    await getOidcAccessToken();

    await signOutOidc();

    expect(vi.mocked(SecureStore.deleteItemAsync)).toHaveBeenCalledWith(
      "t3code.cloud.oidc-session",
    );
    expect(secureStore.has("t3code.cloud.oidc-session")).toBe(false);
    expect(appAtomRegistry.get(oidcSessionAtom)).toEqual({
      isLoaded: true,
      isSignedIn: false,
      userId: null,
      displayIdentity: null,
    });
  });
});

describe("isOidcAccessTokenFresh", () => {
  it("is fresh well before expiry and stale within the refresh margin", () => {
    const now = 1_000_000;
    expect(isOidcAccessTokenFresh({ expiresAtEpochMs: now + 120_000 }, now)).toBe(true);
    expect(isOidcAccessTokenFresh({ expiresAtEpochMs: now + 30_000 }, now)).toBe(false);
    expect(isOidcAccessTokenFresh({ expiresAtEpochMs: now - 1 }, now)).toBe(false);
  });
});

describe("getOidcAccessToken refresh behavior", () => {
  it("returns the cached token without refreshing when it is still fresh", async () => {
    seedPersistedRecord({ refreshToken: "refresh-1", expiresAtEpochMs: Date.now() + 3_600_000 });

    const token = await getOidcAccessToken();

    expect(token).toBe(ACCESS_TOKEN);
    expect(AuthSession.refreshAsync).not.toHaveBeenCalled();
  });

  it("refreshes and persists a new token when the cached one is near expiry", async () => {
    seedPersistedRecord({ refreshToken: "refresh-1", expiresAtEpochMs: Date.now() + 1_000 });
    const refreshedAccessToken = jwt({ sub: "user-1" });
    vi.mocked(AuthSession.refreshAsync).mockResolvedValueOnce({
      accessToken: refreshedAccessToken,
      refreshToken: "refresh-2",
      expiresIn: 3600,
      idToken: ID_TOKEN,
    } as unknown as AuthSession.TokenResponse);

    const token = await getOidcAccessToken();

    expect(token).toBe(refreshedAccessToken);
    expect(AuthSession.refreshAsync).toHaveBeenCalledWith(
      { clientId: "t3-mobile", refreshToken: "refresh-1" },
      { tokenEndpoint: "https://issuer.example.test/token" },
    );
    expect(vi.mocked(SecureStore.setItemAsync)).toHaveBeenCalledWith(
      "t3code.cloud.oidc-session",
      expect.stringContaining(refreshedAccessToken),
    );
    expect(appAtomRegistry.get(oidcSessionAtom)).toMatchObject({
      isSignedIn: true,
      displayIdentity: "person@example.test",
    });
  });

  it("reuses a single in-flight refresh for concurrent callers", async () => {
    seedPersistedRecord({ refreshToken: "refresh-1", expiresAtEpochMs: Date.now() + 1_000 });
    let resolveRefresh!: (value: AuthSession.TokenResponse) => void;
    vi.mocked(AuthSession.refreshAsync).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const first = getOidcAccessToken();
    const second = getOidcAccessToken();
    resolveRefresh({
      accessToken: jwt({ sub: "user-1" }),
      expiresIn: 3600,
    } as unknown as AuthSession.TokenResponse);

    await Promise.all([first, second]);
    expect(AuthSession.refreshAsync).toHaveBeenCalledTimes(1);
  });

  it("signs out without a network call when there is no refresh token", async () => {
    seedPersistedRecord({ expiresAtEpochMs: Date.now() + 1_000 });

    const token = await getOidcAccessToken();

    expect(token).toBeNull();
    expect(AuthSession.refreshAsync).not.toHaveBeenCalled();
    expect(secureStore.has("t3code.cloud.oidc-session")).toBe(false);
    expect(appAtomRegistry.get(oidcSessionAtom).isSignedIn).toBe(false);
  });

  it("keeps the session when the refresh fails transiently", async () => {
    seedPersistedRecord({ refreshToken: "refresh-1", expiresAtEpochMs: Date.now() + 1_000 });
    vi.mocked(AuthSession.refreshAsync).mockRejectedValueOnce(new Error("network request failed"));

    const token = await getOidcAccessToken();

    expect(token).toBeNull();
    expect(secureStore.has("t3code.cloud.oidc-session")).toBe(true);
    expect(appAtomRegistry.get(oidcSessionAtom).isSignedIn).toBe(true);
  });

  it("signs out when the token endpoint rejects the refresh token", async () => {
    seedPersistedRecord({ refreshToken: "refresh-1", expiresAtEpochMs: Date.now() + 1_000 });
    vi.mocked(AuthSession.refreshAsync).mockRejectedValueOnce(
      new MockTokenError("refresh_token revoked"),
    );

    const token = await getOidcAccessToken();

    expect(token).toBeNull();
    expect(secureStore.has("t3code.cloud.oidc-session")).toBe(false);
    expect(appAtomRegistry.get(oidcSessionAtom).isSignedIn).toBe(false);
  });
});
