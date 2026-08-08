import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  completeOidcSignIn,
  computeOidcCodeChallenge,
  discoverOidcMetadata,
  generateOidcCodeVerifier,
  getOidcAccessToken,
  oidcSignIn,
  oidcSignOut,
  readOidcAuthSnapshot,
} from "./oidcAuth";

// This project's unit tests run without a DOM (see hooks/useLocalStorage.test.ts
// for the same pattern), so `window` and its storages are stubbed rather than
// provided by jsdom.
function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  } as Storage;
}

const ORIGIN = "https://app.example.test";
let locationAssign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  locationAssign = vi.fn();
  vi.stubGlobal("window", {
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    location: { href: `${ORIGIN}/`, origin: ORIGIN, assign: locationAssign },
    addEventListener: vi.fn(),
  });
});

afterEach(() => {
  oidcSignOut();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function base64UrlEncodeJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeIdToken(claims: Record<string, unknown>): string {
  return `${base64UrlEncodeJson({ alg: "none", typ: "JWT" })}.${base64UrlEncodeJson(claims)}.sig`;
}

function discoveryResponse(issuer: string): Response {
  return new Response(
    JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function stubFetch(
  issuer: string,
  handleTokenRequest: (params: URLSearchParams) => Response,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return discoveryResponse(issuer);
    }
    if (url === `${issuer}/token`) {
      return handleTokenRequest(new URLSearchParams(init?.body as string));
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PKCE material", () => {
  it("computes the S256 challenge for a known verifier (RFC 7636 appendix B)", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await computeOidcCodeChallenge(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates unpadded base64url verifiers with enough entropy", () => {
    const a = generateOidcCodeVerifier();
    const b = generateOidcCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(a).not.toBe(b);
  });
});

describe("discovery caching", () => {
  it("shares one in-flight lookup across callers for the same issuer", async () => {
    const issuer = "https://auth-cache.example.test";
    const fetchMock = stubFetch(issuer, () => new Response(null, { status: 500 }));

    const [first, second] = await Promise.all([
      discoverOidcMetadata(issuer),
      discoverOidcMetadata(issuer),
    ]);

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("callback exchange", () => {
  it("exchanges the authorization code using the verifier stashed by signIn", async () => {
    vi.stubEnv("VITE_OIDC_ISSUER_URL", "https://auth-exchange.example.test");
    vi.stubEnv("VITE_OIDC_WEB_CLIENT_ID", "web-client");
    const issuer = "https://auth-exchange.example.test";

    let capturedVerifier: string | null = null;
    stubFetch(issuer, (params) => {
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("client_id")).toBe("web-client");
      capturedVerifier = params.get("code_verifier");
      return new Response(
        JSON.stringify({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          id_token: fakeIdToken({ sub: "user-1", email: "user@example.test" }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await oidcSignIn(`${ORIGIN}/settings/connections`);
    expect(locationAssign).toHaveBeenCalledTimes(1);
    const authorizeUrl = new URL(String(locationAssign.mock.calls[0]?.[0]));
    const state = authorizeUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");

    const returnTo = await completeOidcSignIn(
      new URL(`${ORIGIN}/oidc/callback?code=auth-code-1&state=${state}`),
    );

    expect(returnTo).toBe(`${ORIGIN}/settings/connections`);
    expect(capturedVerifier).toBeTruthy();

    const snapshot = readOidcAuthSnapshot();
    expect(snapshot).toEqual({
      isSignedIn: true,
      userId: "user-1",
      displayIdentity: "user@example.test",
    });
  });

  it("fails closed when the callback state does not match a pending request", async () => {
    await expect(
      completeOidcSignIn(new URL(`${ORIGIN}/oidc/callback?code=auth-code-1&state=unknown-state`)),
    ).rejects.toThrow(/does not match/);
    expect(readOidcAuthSnapshot().isSignedIn).toBe(false);
  });

  it("surfaces the provider's error instead of attempting an exchange", async () => {
    await expect(
      completeOidcSignIn(
        new URL(`${ORIGIN}/oidc/callback?error=access_denied&error_description=User+cancelled`),
      ),
    ).rejects.toThrow("User cancelled");
  });
});

describe("access token refresh", () => {
  async function signInWithExpiry(issuer: string, expiresIn: number): Promise<void> {
    vi.stubEnv("VITE_OIDC_ISSUER_URL", issuer);
    vi.stubEnv("VITE_OIDC_WEB_CLIENT_ID", "web-client");
    stubFetch(
      issuer,
      () =>
        new Response(
          JSON.stringify({
            access_token: "initial-access",
            refresh_token: "initial-refresh",
            expires_in: expiresIn,
            id_token: fakeIdToken({ sub: "user-1", email: "user@example.test" }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await oidcSignIn();
    const state = new URL(String(locationAssign.mock.calls[0]?.[0])).searchParams.get("state");
    await completeOidcSignIn(new URL(`${ORIGIN}/oidc/callback?code=auth-code-1&state=${state}`));
  }

  it("returns the stored token without a network call when it is not near expiry", async () => {
    await signInWithExpiry("https://auth-fresh.example.test", 3600);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await getOidcAccessToken()).toBe("initial-access");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes when within the expiry margin and keeps the session signed in", async () => {
    const issuer = "https://auth-refresh.example.test";
    await signInWithExpiry(issuer, 30);

    stubFetch(issuer, (params) => {
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("initial-refresh");
      return new Response(JSON.stringify({ access_token: "refreshed-access", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    expect(await getOidcAccessToken()).toBe("refreshed-access");
    const snapshot = readOidcAuthSnapshot();
    expect(snapshot.isSignedIn).toBe(true);
    expect(snapshot.userId).toBe("user-1");
  });

  it("clears the session and reports signed-out when the refresh fails", async () => {
    const issuer = "https://auth-refresh-fail.example.test";
    await signInWithExpiry(issuer, 30);

    stubFetch(issuer, () => new Response(null, { status: 400 }));

    expect(await getOidcAccessToken()).toBeNull();
    expect(readOidcAuthSnapshot().isSignedIn).toBe(false);
  });
});
