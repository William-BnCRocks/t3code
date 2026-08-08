import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  cloudAuthMode,
  hasCloudPublicConfig,
  resolveOidcWebAuthConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasCloudPublicConfig", () => {
  it("requires both public cloud values", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("reports the missing Clerk JWT template as structured configuration", () => {
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");

    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" }),
    );
  });
});

describe("cloudAuthMode", () => {
  it("is null when nothing is configured", () => {
    expect(cloudAuthMode()).toBeNull();
  });

  it("requires the relay URL alongside either backend's credentials", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    expect(cloudAuthMode()).toBeNull();

    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(cloudAuthMode()).toBe("clerk");
  });

  it("prefers OIDC over Clerk when both are fully configured", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_OIDC_ISSUER_URL", "https://auth.example.test");
    vi.stubEnv("VITE_OIDC_WEB_CLIENT_ID", "web-client");

    expect(cloudAuthMode()).toBe("oidc");
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("requires both OIDC values, not just the issuer", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_OIDC_ISSUER_URL", "https://auth.example.test");
    expect(cloudAuthMode()).toBeNull();

    vi.stubEnv("VITE_OIDC_WEB_CLIENT_ID", "web-client");
    expect(cloudAuthMode()).toBe("oidc");
  });

  it("strips a trailing slash from the configured issuer", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_OIDC_ISSUER_URL", "https://auth.example.test/");
    vi.stubEnv("VITE_OIDC_WEB_CLIENT_ID", "web-client");

    expect(resolveOidcWebAuthConfig()).toEqual({
      issuerUrl: "https://auth.example.test",
      clientId: "web-client",
    });
  });
});
