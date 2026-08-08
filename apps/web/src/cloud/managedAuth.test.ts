import { managedRelaySessionAtom, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  activateManagedRelayAuthentication,
  deactivateManagedRelayAuthentication,
  readManagedRelayClerkToken,
  validateOidcSessionOnMount,
} from "./managedAuth";

const oidcAuth = vi.hoisted(() => ({
  getOidcAccessToken: vi.fn(),
  readOidcAuthSnapshot: vi.fn(),
}));

vi.mock("@clerk/react", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromiseExit: vi.fn(),
  },
}));

vi.mock("../connection/catalog", () => ({
  environmentCatalog: {
    removeRelayEnvironments: {},
  },
}));

vi.mock("./oidcAuth", () => oidcAuth);

afterEach(() => {
  deactivateManagedRelayAuthentication();
  vi.clearAllMocks();
});

describe("validateOidcSessionOnMount", () => {
  it("forces a token validation when the restored snapshot claims signed-in", () => {
    oidcAuth.readOidcAuthSnapshot.mockReturnValue({ isSignedIn: true });

    validateOidcSessionOnMount();

    expect(oidcAuth.getOidcAccessToken).toHaveBeenCalledOnce();
  });

  it("does nothing when the restored snapshot is already signed-out", () => {
    oidcAuth.readOidcAuthSnapshot.mockReturnValue({ isSignedIn: false });

    validateOidcSessionOnMount();

    expect(oidcAuth.getOidcAccessToken).not.toHaveBeenCalled();
  });
});

describe("managed relay authentication", () => {
  it("clears all token access synchronously before account cleanup can fail", async () => {
    activateManagedRelayAuthentication("account-1", async () => "account-1-token");
    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-1");
    expect(await readManagedRelayClerkToken()).toBe("account-1-token");

    deactivateManagedRelayAuthentication();
    const cleanup = Promise.reject(new Error("Persistence removal failed.")).catch(() => undefined);

    expect(appAtomRegistry.get(managedRelaySessionAtom)).toBeNull();
    expect(await readManagedRelayClerkToken()).toBeNull();
    await cleanup;
  });

  it("replaces an existing account session atomically", () => {
    setManagedRelaySession(appAtomRegistry, {
      accountId: "account-1",
      readClerkToken: async () => "account-1-token",
    });

    activateManagedRelayAuthentication("account-2", async () => "account-2-token");

    expect(appAtomRegistry.get(managedRelaySessionAtom)?.accountId).toBe("account-2");
  });
});
