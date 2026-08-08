import { describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  cloudAuthMode,
  hasTracingPublicConfig,
  resolveCloudPublicConfig,
  resolveOidcPublicConfig,
  resolveRelayClerkTokenOptions,
} from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("reports the missing Clerk JWT template as structured configuration", () => {
    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" }),
    );
  });

  it("returns no cloud configuration for an unconfigured build", () => {
    expect(resolveCloudPublicConfig({})).toEqual({
      clerk: {
        publishableKey: null,
        jwtTemplate: null,
      },
      oidc: {
        issuerUrl: null,
        clientId: null,
      },
      relay: {
        url: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });

  it("normalizes statically injected cloud configuration", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "  pk_test_example  ", jwtTemplate: "  t3-relay  " },
        oidc: { issuerUrl: "  https://issuer.example.test//  ", clientId: "  t3-mobile  " },
        relay: { url: " https://relay.example.test/// " },
        observability: {
          tracesUrl: " https://api.axiom.co/v1/traces ",
          tracesDataset: " mobile-traces ",
          tracesToken: " public-ingest-token ",
        },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      oidc: {
        issuerUrl: "https://issuer.example.test",
        clientId: "t3-mobile",
      },
      relay: {
        url: "https://relay.example.test",
      },
      observability: {
        tracesUrl: "https://api.axiom.co/v1/traces",
        tracesDataset: "mobile-traces",
        tracesToken: "public-ingest-token",
      },
    });
  });

  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      oidc: {
        issuerUrl: null,
        clientId: null,
      },
      relay: {
        url: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });

  it("rejects an insecure OIDC issuer URL", () => {
    expect(
      resolveCloudPublicConfig({
        oidc: { issuerUrl: "http://issuer.example.test", clientId: "t3-mobile" },
      }).oidc,
    ).toEqual({
      issuerUrl: null,
      clientId: "t3-mobile",
    });
  });

  it("rejects an insecure traces URL", () => {
    expect(
      resolveCloudPublicConfig({
        observability: {
          tracesUrl: "http://api.axiom.co/v1/traces",
          tracesDataset: "mobile-traces",
          tracesToken: "public-ingest-token",
        },
      }).observability,
    ).toEqual({
      tracesUrl: null,
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    });
  });

  it("keeps tracing disabled unless every public tracing value is configured", () => {
    expect(hasTracingPublicConfig(resolveCloudPublicConfig({}))).toBe(false);
    expect(
      hasTracingPublicConfig(
        resolveCloudPublicConfig({
          observability: {
            tracesUrl: "https://api.axiom.co/v1/traces",
            tracesDataset: "mobile-traces",
          },
        }),
      ),
    ).toBe(false);
    expect(
      hasTracingPublicConfig(
        resolveCloudPublicConfig({
          observability: {
            tracesUrl: "https://api.axiom.co/v1/traces",
            tracesDataset: "mobile-traces",
            tracesToken: "public-ingest-token",
          },
        }),
      ),
    ).toBe(true);
  });
});

describe("cloudAuthMode", () => {
  const clerkExtra = {
    clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
    relay: { url: "https://relay.example.test" },
  };
  const oidcExtra = {
    oidc: { issuerUrl: "https://issuer.example.test", clientId: "t3-mobile" },
    relay: { url: "https://relay.example.test" },
  };

  it("is null without a relay URL, even with an auth provider configured", () => {
    expect(cloudAuthMode(resolveCloudPublicConfig({ clerk: clerkExtra.clerk }))).toBe(null);
  });

  it("selects clerk when only Clerk is configured", () => {
    expect(cloudAuthMode(resolveCloudPublicConfig(clerkExtra))).toBe("clerk");
  });

  it("selects oidc when only OIDC is configured", () => {
    expect(cloudAuthMode(resolveCloudPublicConfig(oidcExtra))).toBe("oidc");
  });

  it("prefers oidc when both providers are configured", () => {
    expect(
      cloudAuthMode(
        resolveCloudPublicConfig({
          clerk: clerkExtra.clerk,
          oidc: oidcExtra.oidc,
          relay: clerkExtra.relay,
        }),
      ),
    ).toBe("oidc");
  });

  it("is null when neither provider is configured", () => {
    expect(cloudAuthMode(resolveCloudPublicConfig({ relay: clerkExtra.relay }))).toBe(null);
  });
});

describe("resolveOidcPublicConfig", () => {
  it("returns null unless both the issuer and client id are present", () => {
    expect(resolveOidcPublicConfig(resolveCloudPublicConfig({}))).toBe(null);
    expect(
      resolveOidcPublicConfig(
        resolveCloudPublicConfig({ oidc: { issuerUrl: "https://issuer.example.test" } }),
      ),
    ).toBe(null);
  });

  it("returns the normalized issuer and client id when both are present", () => {
    expect(
      resolveOidcPublicConfig(
        resolveCloudPublicConfig({
          oidc: { issuerUrl: " https://issuer.example.test/ ", clientId: " t3-mobile " },
        }),
      ),
    ).toEqual({ issuerUrl: "https://issuer.example.test", clientId: "t3-mobile" });
  });
});
