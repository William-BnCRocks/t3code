import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider as ElectronClerkProvider } from "@clerk/electron/react";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@fontsource-variable/dm-sans/index.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { ManagedRelayAuthProvider, OidcManagedRelayAuthProvider } from "./cloud/managedAuth";
import { hasDesktopOidcLoginBridge } from "./cloud/oidcAuth";
import { cloudAuthMode } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const authMode = cloudAuthMode();

const app = <AppRoot router={router} />;

// On Electron, generic OIDC sign-in goes through a system-browser + loopback
// listener (apps/desktop's DesktopOidcLogin.ts) instead of the in-app
// redirect the web bundle uses, since a redirect would leave the app's
// window entirely with no way back. The provider only mounts once the
// preload bridge that drives that flow is actually present.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {authMode === "clerk" && clerkPublishableKey ? (
      isElectron ? (
        <ElectronClerkProvider publishableKey={clerkPublishableKey} passkeys={passkeys}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ElectronClerkProvider>
      ) : (
        <ClerkProvider publishableKey={clerkPublishableKey}>
          <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
        </ClerkProvider>
      )
    ) : authMode === "oidc" && (!isElectron || hasDesktopOidcLoginBridge()) ? (
      <OidcManagedRelayAuthProvider>{app}</OidcManagedRelayAuthProvider>
    ) : (
      app
    )}
  </React.StrictMode>,
);
