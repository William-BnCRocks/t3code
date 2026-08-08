/// <reference types="vite-plus/client" />

import type { DesktopBridge } from "@t3tools/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly VITE_HOSTED_APP_CHANNEL: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
  readonly VITE_CLERK_JWT_TEMPLATE: string;
  readonly VITE_CLERK_CLI_OAUTH_CLIENT_ID: string;
  readonly VITE_OIDC_ISSUER_URL: string;
  readonly VITE_OIDC_WEB_CLIENT_ID: string;
  readonly VITE_OIDC_CLI_CLIENT_ID: string;
  readonly VITE_RELAY_OTLP_TRACES_URL: string;
  readonly VITE_RELAY_OTLP_TRACES_DATASET: string;
  readonly VITE_RELAY_OTLP_TRACES_TOKEN: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
    /**
     * Desktop-only OIDC bridge: opens `authorizeUrl` in the system browser and
     * resolves with the authorization code once the loopback listener in the
     * Electron main process receives the callback (or rejects with a
     * human-readable message on timeout, state mismatch, or cancellation).
     */
    desktopOidcLogin?: (authorizeUrl: string, state: string) => Promise<{ code: string }>;
  }
}
