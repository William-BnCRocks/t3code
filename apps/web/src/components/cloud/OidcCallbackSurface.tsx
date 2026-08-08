import { useEffect, useRef, useState } from "react";

import { completeOidcSignIn } from "../../cloud/oidcAuth";
import { AuthSurfaceShell } from "../auth/AuthSurfaceShell";

/**
 * /oidc/callback: the redirect target generic-OIDC providers send the user
 * back to after `oidcSignIn`. Exchanges the authorization code for tokens,
 * then hands the browser back to wherever `oidcSignIn` was opened from.
 */
export function OidcCallbackSurface() {
  const started = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const returnTo = await completeOidcSignIn();
        window.location.replace(returnTo);
      } catch (cause) {
        setErrorMessage(cause instanceof Error ? cause.message : "Could not complete sign-in.");
      }
    })();
  }, []);

  return (
    <AuthSurfaceShell>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        {errorMessage ? "Sign-in did not complete" : "Signing you in…"}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {errorMessage ?? "Finishing the sign-in redirect."}
      </p>
    </AuthSurfaceShell>
  );
}
