import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import { activateCloudRelayAccount, deactivateCloudRelayAccount } from "./CloudAuthProvider";
import { setAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";

vi.mock("@clerk/expo", () => ({
  ClerkProvider: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock("@clerk/expo/token-cache", () => ({
  tokenCache: {},
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}));

vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

vi.mock("./publicConfig", () => ({
  cloudAuthMode: vi.fn(() => null),
  resolveCloudPublicConfig: vi.fn(() => ({
    clerk: { publishableKey: null },
    relay: { url: null },
  })),
  resolveRelayClerkTokenOptions: vi.fn(),
}));

vi.mock("./oidcSession", () => ({
  ensureOidcSessionInitialized: vi.fn(() => Promise.resolve()),
  getOidcAccessToken: vi.fn(() => Promise.resolve(null)),
  oidcSessionAtom: {},
}));

vi.mock("../agent-awareness/remoteRegistration", () => ({
  setAgentAwarenessRelayTokenProvider: vi.fn(),
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
}));

afterEach(() => {
  deactivateCloudRelayAccount();
  vi.clearAllMocks();
});

describe("CloudAuthProvider relay account isolation", () => {
  it("clears relay and agent-awareness credentials before cleanup can fail", async () => {
    const tokenProvider = async () => "account-1-token";
    activateCloudRelayAccount("account-1", tokenProvider);
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");

    deactivateCloudRelayAccount();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(null);
    await cleanup;
  });

  // activateCloudRelayAccount/deactivateCloudRelayAccount are the shared code
  // path CloudAuthBridge drives from either provider (see CloudAuthProvider.tsx's
  // ClerkCloudAuthBridge and OidcCloudAuthBridge) — this only asserts they are
  // just as provider-agnostic when the caller is OIDC-shaped (accountId is a
  // token `sub`, tokenProvider resolves an OIDC access token) as they are for Clerk.
  it("activates and deactivates a relay account driven by an OIDC-style token provider", () => {
    const tokenProvider = async () => "oidc-access-token";
    activateCloudRelayAccount("oidc-user-1", tokenProvider);
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toMatchObject({
      accountId: "oidc-user-1",
    });
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(
      tokenProvider,
      "oidc-user-1",
    );

    deactivateCloudRelayAccount();
    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(vi.mocked(setAgentAwarenessRelayTokenProvider)).toHaveBeenLastCalledWith(null);
  });
});
