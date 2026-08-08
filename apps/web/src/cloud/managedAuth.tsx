import { useAuth, useClerk, useUser } from "@clerk/react";
import { ManagedRelay, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { resolveClerkSignInProps } from "../components/clerk/authRedirect";
import { environmentCatalog } from "../connection/catalog";
import { isElectron } from "../env";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { getOidcAccessToken, oidcSignIn, oidcSignOut, useOidcAuthSnapshot } from "./oidcAuth";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

let relayTokenProvider: (() => Promise<string | null>) | null = null;

export async function readManagedRelayClerkToken(): Promise<string | null> {
  return relayTokenProvider?.() ?? null;
}

export function deactivateManagedRelayAuthentication(): void {
  relayTokenProvider = null;
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readClerkToken: () => Promise<string | null>,
): void {
  relayTokenProvider = readClerkToken;
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken,
  });
}

/**
 * Generic facade both cloud auth backends implement, so token/auth-state
 * consumers (the sidebar sign-in, `useCloudLinkController`, the onboarding
 * dialog, the hosted CLI connect page) do not need to know which one is
 * active. `mode` reflects whether a real provider is mounted for the current
 * runtime, not just whether config is present — Electron leaves OIDC
 * unmounted (see main.tsx), so `useCloudAuth()` reports unavailable there
 * even though `cloudAuthMode()` still says "oidc".
 */
export interface CloudAuthState {
  readonly mode: "clerk" | "oidc" | null;
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly displayIdentity: string | null;
  readonly getToken: () => Promise<string | null>;
  readonly signIn: (returnTo?: string) => void | Promise<void>;
  readonly signOut: () => void | Promise<void>;
}

const UNAVAILABLE_CLOUD_AUTH: CloudAuthState = {
  mode: null,
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  displayIdentity: null,
  getToken: () => Promise.resolve(null),
  signIn: () => {},
  signOut: () => {},
};

const CloudAuthContext = createContext<CloudAuthState>(UNAVAILABLE_CLOUD_AUTH);

export function useCloudAuth(): CloudAuthState {
  return useContext(CloudAuthContext);
}

/**
 * Drives the relay session's account lifecycle from a backend-agnostic
 * `{ isLoaded, isSignedIn, userId }` triple. Shared by the Clerk and OIDC
 * providers below so the account-switch/cleanup semantics (queued relay
 * environment removal, atomic session replacement) exist exactly once.
 */
function useManagedRelayAccountLifecycle(input: {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly readToken: () => Promise<string | null>;
}): void {
  const { isLoaded, isSignedIn, userId, readToken } = input;
  const removeRelayEnvironments = useAtomCommand(environmentCatalog.removeRelayEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const observedAccountRef = useRef<string | null | undefined>(undefined);
  const accountTransitionRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    let cancelled = false;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;

    const queueAccountCleanup = () => {
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition.then(async () => {
        const results = await Promise.all([
          removeRelayEnvironments(),
          settleAsyncResult(() =>
            runtime.runPromiseExit(
              ManagedRelay.ManagedRelayClient.pipe(
                Effect.flatMap((client) => client.resetTokenCache),
              ),
            ),
          ),
        ]);
        for (const result of results) {
          reportAtomCommandResult(result, { label: "cloud account cleanup" });
        }
      });
      return accountTransitionRef.current;
    };

    if (!isSignedIn || !userId) {
      deactivateManagedRelayAuthentication();
      if (previousAccount !== null) {
        void queueAccountCleanup();
      }
    } else {
      const activateSession = () => {
        if (!cancelled) {
          activateManagedRelayAuthentication(userId, readToken);
        }
      };
      const activateAfterTransition = (transition: Promise<void>) => {
        void (async () => {
          const result = await settlePromise(async () => {
            await transition;
            activateSession();
          });
          reportAtomCommandResult(result, { label: "cloud account activation" });
        })();
      };
      if (previousAccount !== undefined && previousAccount !== null && previousAccount !== userId) {
        deactivateManagedRelayAuthentication();
        activateAfterTransition(queueAccountCleanup());
      } else {
        activateAfterTransition(accountTransitionRef.current ?? Promise.resolve());
      }
    }
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, readToken, removeRelayEnvironments, userId]);

  useEffect(() => () => deactivateManagedRelayAuthentication(), []);
}

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const { user } = useUser();
  const clerk = useClerk();
  const readToken = useCallback(() => getToken(resolveRelayClerkTokenOptions()), [getToken]);

  useManagedRelayAccountLifecycle({
    isLoaded,
    isSignedIn: Boolean(isSignedIn),
    userId: isSignedIn && userId ? userId : null,
    readToken,
  });

  const cloudAuth = useMemo<CloudAuthState>(
    () => ({
      mode: "clerk",
      isLoaded,
      isSignedIn: Boolean(isSignedIn),
      userId: isSignedIn && userId ? userId : null,
      displayIdentity: user?.primaryEmailAddress?.emailAddress ?? user?.username ?? null,
      getToken: readToken,
      signIn: (returnTo) =>
        clerk.openSignIn(resolveClerkSignInProps(returnTo ?? window.location.href, isElectron)),
      signOut: () => clerk.signOut(),
    }),
    [clerk, isLoaded, isSignedIn, readToken, user, userId],
  );

  return <CloudAuthContext.Provider value={cloudAuth}>{children}</CloudAuthContext.Provider>;
}

/**
 * Web-only counterpart to `ManagedRelayAuthProvider` for generic-OIDC mode
 * (see main.tsx — Electron does not mount this yet). Session state comes
 * from `oidcAuth`'s localStorage-backed atom instead of the Clerk SDK.
 */
export function OidcManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const snapshot = useOidcAuthSnapshot();

  useManagedRelayAccountLifecycle({
    isLoaded: true,
    isSignedIn: snapshot.isSignedIn,
    userId: snapshot.userId,
    readToken: getOidcAccessToken,
  });

  const cloudAuth = useMemo<CloudAuthState>(
    () => ({
      mode: "oidc",
      isLoaded: true,
      isSignedIn: snapshot.isSignedIn,
      userId: snapshot.userId,
      displayIdentity: snapshot.displayIdentity,
      getToken: getOidcAccessToken,
      signIn: oidcSignIn,
      signOut: () => {
        oidcSignOut();
      },
    }),
    [snapshot],
  );

  return <CloudAuthContext.Provider value={cloudAuth}>{children}</CloudAuthContext.Provider>;
}
