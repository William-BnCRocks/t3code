import { CONNECT_OAUTH_SCOPES, DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

declare const __T3CODE_BUILD_RELAY_URL__: string | undefined;
declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;
declare const __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: string | undefined;
declare const __T3CODE_BUILD_OIDC_ISSUER_URL__: string | undefined;
declare const __T3CODE_BUILD_OIDC_CLI_CLIENT_ID__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: string | undefined;
declare const __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: string | undefined;

const CLOUD_CLI_OAUTH_REDIRECT_URI = "http://127.0.0.1:34338/callback";
const CLOUD_CLI_OAUTH_SCOPES = CONNECT_OAUTH_SCOPES;
const OIDC_CLOUD_CLI_OAUTH_SCOPES = [...CONNECT_OAUTH_SCOPES, "offline_access"] as const;

function validateRelayUrl(value: string) {
  const relayUrl = normalizeSecureRelayUrl(value);
  return relayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue(Option.some(value), {
              message: "Relay URL must be a secure absolute HTTPS origin.",
            }),
          ),
        ),
      )
    : Effect.succeed(relayUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export const buildTimeRelayUrl =
  typeof __T3CODE_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeSecureRelayUrl(__T3CODE_BUILD_RELAY_URL__) ?? "");
export const buildTimeClerkPublishableKey = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);
export const buildTimeClerkCliOAuthClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__,
);
export const buildTimeOidcIssuerUrl = readBuildTimeValue(
  typeof __T3CODE_BUILD_OIDC_ISSUER_URL__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_OIDC_ISSUER_URL__,
);
export const buildTimeOidcCliClientId = readBuildTimeValue(
  typeof __T3CODE_BUILD_OIDC_CLI_CLIENT_ID__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_OIDC_CLI_CLIENT_ID__,
);
export const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__,
  ),
  tracesDataset: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__,
  ),
  tracesToken: readBuildTimeValue(
    typeof __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__,
  ),
} as const;

export function resolveRelayClientTracingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback = buildTimeRelayClientTracing,
) {
  const tracesUrl = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() || fallback.tracesUrl;
  const tracesDataset =
    env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() || fallback.tracesDataset;
  const tracesToken = env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() || fallback.tracesToken;
  const normalizedTracesUrl = normalizeSecureUrl(tracesUrl);
  return normalizedTracesUrl && tracesDataset && tracesToken
    ? { tracesUrl: normalizedTracesUrl, tracesDataset, tracesToken }
    : null;
}

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.nonEmptyString("T3CODE_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapOrFail(validateRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

/**
 * Hosted app origin used for out-of-band OAuth on headless
 * machines. Overridable so staging/nightly builds can point their CLIs at a
 * matching hosted deployment.
 */
export const hostedAppUrlConfig = makePublicValueConfig(
  "T3CODE_HOSTED_APP_URL",
  DEFAULT_HOSTED_APP_URL,
).pipe(Config.mapOrFail(validateHostedAppUrl));

function validateHostedAppUrl(value: string) {
  try {
    const url = new URL(value);
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid hosted app origin");
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue(Option.some(value), {
            message: "Hosted app URL must be an absolute HTTPS origin (or HTTP loopback origin).",
          }),
        ),
      ),
    );
  }
}

function makePublicValueConfig(name: string, fallback: string) {
  const runtimeConfig = Config.nonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
}

export interface CloudCliOAuthClerkConfig {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

export interface CloudCliOAuthOidcConfig {
  readonly mode: "oidc";
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: typeof OIDC_CLOUD_CLI_OAUTH_SCOPES;
}

export type CloudCliOAuthConfig = CloudCliOAuthClerkConfig | CloudCliOAuthOidcConfig;

export function isOidcCloudCliOAuthConfig(
  config: CloudCliOAuthConfig,
): config is CloudCliOAuthOidcConfig {
  return "mode" in config;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function makeOidcCloudCliOAuthConfig(issuerUrlFallback: string, clientIdFallback: string) {
  return Config.all({
    issuerUrl: makePublicValueConfig("T3CODE_OIDC_ISSUER_URL", issuerUrlFallback),
    clientId: makePublicValueConfig("T3CODE_OIDC_CLI_CLIENT_ID", clientIdFallback),
  }).pipe(
    Config.map(
      ({ issuerUrl, clientId }) =>
        ({
          mode: "oidc",
          issuerUrl: stripTrailingSlash(issuerUrl),
          clientId,
          redirectUri: CLOUD_CLI_OAUTH_REDIRECT_URI,
          scopes: OIDC_CLOUD_CLI_OAUTH_SCOPES,
        }) satisfies CloudCliOAuthOidcConfig,
    ),
  );
}

function makeClerkCloudCliOAuthConfig(publishableKeyFallback: string, clientIdFallback: string) {
  return Config.all({
    clerkPublishableKey: makePublicValueConfig(
      "T3CODE_CLERK_PUBLISHABLE_KEY",
      publishableKeyFallback,
    ),
    clientId: makePublicValueConfig("T3CODE_CLERK_CLI_OAUTH_CLIENT_ID", clientIdFallback),
  }).pipe(
    Config.mapOrFail(({ clerkPublishableKey, clientId }) =>
      Effect.try({
        try: () => clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey),
        catch: (cause) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "Failed to derive Clerk Frontend API URL from the publishable key.",
              cause,
            }),
          ),
      }).pipe(
        Effect.map(
          (clerkFrontendApiUrl) =>
            ({
              authorizationEndpoint: `${clerkFrontendApiUrl}/oauth/authorize`,
              tokenEndpoint: `${clerkFrontendApiUrl}/oauth/token`,
              clientId,
              redirectUri: CLOUD_CLI_OAUTH_REDIRECT_URI,
              scopes: CLOUD_CLI_OAUTH_SCOPES,
            }) satisfies CloudCliOAuthClerkConfig,
        ),
      ),
    ),
  );
}

/**
 * OIDC config takes precedence when both are present: it is tried first and
 * only falls back to deriving Clerk endpoints when the OIDC issuer/client
 * pair is not fully configured.
 */
export function makeCloudCliOAuthConfig({
  clerkPublishableKeyFallback = buildTimeClerkPublishableKey,
  clerkCliOAuthClientIdFallback = buildTimeClerkCliOAuthClientId,
  oidcIssuerUrlFallback = buildTimeOidcIssuerUrl,
  oidcCliClientIdFallback = buildTimeOidcCliClientId,
}: {
  readonly clerkPublishableKeyFallback?: string;
  readonly clerkCliOAuthClientIdFallback?: string;
  readonly oidcIssuerUrlFallback?: string;
  readonly oidcCliClientIdFallback?: string;
} = {}): Config.Config<CloudCliOAuthConfig> {
  return makeOidcCloudCliOAuthConfig(oidcIssuerUrlFallback, oidcCliClientIdFallback).pipe(
    Config.orElse(() =>
      makeClerkCloudCliOAuthConfig(clerkPublishableKeyFallback, clerkCliOAuthClientIdFallback),
    ),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

export function resolveHasCloudPublicConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback: {
    readonly relayUrl?: string;
    readonly clerkPublishableKey?: string;
    readonly clerkCliOAuthClientId?: string;
    readonly oidcIssuerUrl?: string;
    readonly oidcCliClientId?: string;
  } = {},
): boolean {
  const {
    relayUrl = buildTimeRelayUrl,
    clerkPublishableKey = buildTimeClerkPublishableKey,
    clerkCliOAuthClientId = buildTimeClerkCliOAuthClientId,
    oidcIssuerUrl = buildTimeOidcIssuerUrl,
    oidcCliClientId = buildTimeOidcCliClientId,
  } = fallback;
  const hasRelayUrl = Boolean(normalizeSecureRelayUrl(env.T3CODE_RELAY_URL ?? "") ?? relayUrl);
  const hasOidcCliConfig = Boolean(
    (env.T3CODE_OIDC_ISSUER_URL?.trim() || oidcIssuerUrl) &&
    (env.T3CODE_OIDC_CLI_CLIENT_ID?.trim() || oidcCliClientId),
  );
  const hasClerkCliConfig = Boolean(
    (env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() || clerkPublishableKey) &&
    (env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || clerkCliOAuthClientId),
  );
  return hasRelayUrl && (hasOidcCliConfig || hasClerkCliConfig);
}

export const hasCloudPublicConfig = resolveHasCloudPublicConfig();
