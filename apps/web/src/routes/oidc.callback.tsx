import { createFileRoute, redirect } from "@tanstack/react-router";

import { cloudAuthMode } from "../cloud/publicConfig";
import { OidcCallbackSurface } from "../components/cloud/OidcCallbackSurface";

export const Route = createFileRoute("/oidc/callback")({
  beforeLoad: () => {
    if (cloudAuthMode() !== "oidc") {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: OidcCallbackSurface,
});
