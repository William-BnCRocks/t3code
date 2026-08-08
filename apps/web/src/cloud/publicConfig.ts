import { relayClerkTokenOptions } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedErrorClass<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly oidcIssuerUrl: string | null;
  readonly oidcWebClientId: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

/**
 * Which cloud auth backend is active, derived entirely from build-time
 * config. OIDC takes precedence when both are configured (e.g. a Clerk key
 * left over from a previous deployment) so an operator can cut over by
 * setting the OIDC vars alone.
 */
export type CloudAuthMode = "oidc" | "clerk" | null;

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function resolveOidcIssuerUrl(): string | null {
  const raw = trimNonEmpty(import.meta.env.VITE_OIDC_ISSUER_URL as string | undefined);
  return raw ? stripTrailingSlash(raw) : null;
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    clerkPublishableKey: trimNonEmpty(
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined,
    ),
    clerkJwtTemplate: trimNonEmpty(import.meta.env.VITE_CLERK_JWT_TEMPLATE as string | undefined),
    oidcIssuerUrl: resolveOidcIssuerUrl(),
    oidcWebClientId: trimNonEmpty(import.meta.env.VITE_OIDC_WEB_CLIENT_ID as string | undefined),
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ?? "",
    ),
    relayTracing: {
      tracesUrl: normalizeSecureUrl(
        (import.meta.env.VITE_RELAY_OTLP_TRACES_URL as string | undefined) ?? "",
      ),
      tracesDataset: trimNonEmpty(
        import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET as string | undefined,
      ),
      tracesToken: trimNonEmpty(import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN as string | undefined),
    },
  };
}

export function resolveRelayTracingConfig() {
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

export function cloudAuthMode(): CloudAuthMode {
  const config = resolveCloudPublicConfig();
  if (config.oidcIssuerUrl && config.oidcWebClientId && config.relayUrl) {
    return "oidc";
  }
  if (config.clerkPublishableKey && config.clerkJwtTemplate && config.relayUrl) {
    return "clerk";
  }
  return null;
}

export function hasCloudPublicConfig(): boolean {
  return cloudAuthMode() !== null;
}

export function resolveRelayClerkTokenOptions() {
  const { clerkJwtTemplate } = resolveCloudPublicConfig();
  if (!clerkJwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(clerkJwtTemplate);
}

export function resolveOidcWebAuthConfig(): {
  readonly issuerUrl: string;
  readonly clientId: string;
} | null {
  const { oidcIssuerUrl, oidcWebClientId } = resolveCloudPublicConfig();
  return oidcIssuerUrl && oidcWebClientId
    ? { issuerUrl: oidcIssuerUrl, clientId: oidcWebClientId }
    : null;
}
