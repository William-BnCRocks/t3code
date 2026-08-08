import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildConnectCliClerkAuthorizeUrl,
  buildConnectCliOidcAuthorizeUrl,
  hasConnectCliAuthConfig,
  readConnectCliCallbackResult,
} from "./connectCliAuth";

// Any pk_test_* key decodes to <base64 hostname>.clerk.accounts.dev.
const TEST_PUBLISHABLE_KEY = `pk_test_${btoa("witty-mole-42.clerk.accounts.dev$")}`;

describe("connectCliAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires both the publishable key and the CLI OAuth client id", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.com");
    expect(hasConnectCliAuthConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");
    expect(hasConnectCliAuthConfig()).toBe(true);
  });

  it("builds the Clerk authorize URL with the configured hosted origin's callback", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    vi.stubEnv("VITE_CLERK_CLI_OAUTH_CLIENT_ID", "oauthapp_123");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://nightly.app.t3.codes");

    const authorizeUrl = buildConnectCliClerkAuthorizeUrl({
      state: "state-1",
      challenge: "challenge-1",
    });
    expect(authorizeUrl).not.toBeNull();

    const url = new URL(authorizeUrl!);
    expect(url.hostname).toBe("witty-mole-42.clerk.accounts.dev");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://nightly.app.t3.codes/connect/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("returns null when the CLI OAuth client id is not configured", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", TEST_PUBLISHABLE_KEY);
    expect(
      buildConnectCliClerkAuthorizeUrl({ state: "state-1", challenge: "challenge-1" }),
    ).toBeNull();
  });

  it("reads the code and state Clerk echoes back to the callback", () => {
    expect(
      readConnectCliCallbackResult(
        new URL("https://app.t3.codes/connect/callback?code=abc&state=state-1"),
      ),
    ).toEqual({ code: "abc", state: "state-1" });
    expect(
      readConnectCliCallbackResult(new URL("https://app.t3.codes/connect/callback?code=abc")),
    ).toBeNull();
    expect(
      readConnectCliCallbackResult(new URL("https://app.t3.codes/connect/callback?state=s")),
    ).toBeNull();
  });
});

describe("connectCliAuth in OIDC mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("requires the relay URL, issuer, and CLI client id together", () => {
    vi.stubEnv("VITE_OIDC_ISSUER_URL", "https://auth.example.test");
    vi.stubEnv("VITE_OIDC_WEB_CLIENT_ID", "web-client");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(hasConnectCliAuthConfig()).toBe(false);

    vi.stubEnv("VITE_OIDC_CLI_CLIENT_ID", "cli-client");
    expect(hasConnectCliAuthConfig()).toBe(true);
  });

  it("builds the authorize URL from discovery for the CLI's own client id", async () => {
    vi.stubEnv("VITE_OIDC_ISSUER_URL", "https://auth.example.test");
    vi.stubEnv("VITE_OIDC_WEB_CLIENT_ID", "web-client");
    vi.stubEnv("VITE_OIDC_CLI_CLIENT_ID", "cli-client");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://nightly.app.t3.codes");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              issuer: "https://auth.example.test",
              authorization_endpoint: "https://auth.example.test/authorize",
              token_endpoint: "https://auth.example.test/token",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const authorizeUrl = await buildConnectCliOidcAuthorizeUrl({
      state: "state-1",
      challenge: "challenge-1",
    });
    expect(authorizeUrl).not.toBeNull();

    const url = new URL(authorizeUrl!);
    expect(url.origin).toBe("https://auth.example.test");
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe("cli-client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://nightly.app.t3.codes/connect/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("returns null when the CLI client id is not configured", async () => {
    vi.stubEnv("VITE_OIDC_ISSUER_URL", "https://auth.example.test");
    expect(
      await buildConnectCliOidcAuthorizeUrl({ state: "state-1", challenge: "challenge-1" }),
    ).toBeNull();
  });
});
