import { useAuth, useUser } from "@clerk/expo";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo } from "react";

import {
  ensureOidcSessionInitialized,
  getOidcAccessToken,
  oidcSessionAtom,
  signInWithOidc,
  signOutOidc,
} from "./oidcSession";
import { cloudAuthMode, resolveRelayClerkTokenOptions } from "./publicConfig";

export interface CloudAuthState {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly userId: string | null;
  readonly displayIdentity: string | null;
  readonly getRelayToken: () => Promise<string | null>;
  /** Only set in OIDC mode; Clerk mode uses its own AuthView/UserProfileView UI. */
  readonly signIn?: () => Promise<void>;
  readonly signOut?: () => Promise<void>;
}

const UNCONFIGURED_CLOUD_AUTH_STATE: CloudAuthState = {
  isLoaded: true,
  isSignedIn: false,
  userId: null,
  displayIdentity: null,
  getRelayToken: () => Promise.resolve(null),
};

/**
 * Auth facade so screens don't need to know whether T3 Connect is currently
 * backed by Clerk or a generic OIDC provider. `cloudAuthMode()` comes from
 * build-time config and cannot change for the life of the process, so the
 * branch taken below is stable for every render of a given component.
 */
export function useCloudAuth(): CloudAuthState {
  const mode = cloudAuthMode();
  if (mode === "oidc") {
    return useOidcCloudAuth();
  }
  if (mode === "clerk") {
    return useClerkCloudAuth();
  }
  return UNCONFIGURED_CLOUD_AUTH_STATE;
}

function useOidcCloudAuth(): CloudAuthState {
  useEffect(() => {
    void ensureOidcSessionInitialized();
  }, []);
  const session = useAtomValue(oidcSessionAtom);
  return useMemo(
    (): CloudAuthState => ({
      isLoaded: session.isLoaded,
      isSignedIn: session.isSignedIn,
      userId: session.userId,
      displayIdentity: session.displayIdentity,
      getRelayToken: getOidcAccessToken,
      signIn: signInWithOidc,
      signOut: signOutOidc,
    }),
    [session],
  );
}

function useClerkCloudAuth(): CloudAuthState {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const displayIdentity = user?.primaryEmailAddress?.emailAddress ?? userId ?? null;
  const getRelayToken = useCallback(() => getToken(resolveRelayClerkTokenOptions()), [getToken]);
  return useMemo(
    (): CloudAuthState => ({
      isLoaded,
      isSignedIn: Boolean(isSignedIn),
      userId: userId ?? null,
      displayIdentity,
      getRelayToken,
    }),
    [displayIdentity, getRelayToken, isLoaded, isSignedIn, userId],
  );
}
