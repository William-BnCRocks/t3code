import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const OidcDiscoveryDocument = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
});

export interface OidcProviderMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

export class OidcDiscoveryError extends Schema.TaggedErrorClass<OidcDiscoveryError>()(
  "OidcDiscoveryError",
  {
    issuerUrl: Schema.String,
    reason: Schema.Literals(["fetch_failed", "invalid_document", "issuer_mismatch"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not discover the OIDC configuration for issuer (${this.issuerUrl}; ${this.reason}).`;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

/**
 * Fetches and validates the standard OIDC discovery document for an issuer,
 * per https://openid.net/specs/openid-connect-discovery-1_0.html. Used by the
 * CLI's generic-OIDC login mode to resolve authorize/token endpoints from a
 * single issuer URL instead of hardcoding a provider.
 */
export const discoverOidcConfiguration = Effect.fn("shared.oidc_discovery.discover")(function* (
  issuerUrl: string,
) {
  const normalizedIssuerUrl = stripTrailingSlash(issuerUrl);
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const response = yield* HttpClientRequest.get(
    `${normalizedIssuerUrl}/.well-known/openid-configuration`,
  ).pipe(
    httpClient.execute,
    Effect.mapError(
      (cause) =>
        new OidcDiscoveryError({ issuerUrl: normalizedIssuerUrl, reason: "fetch_failed", cause }),
    ),
  );
  const document = yield* HttpClientResponse.schemaBodyJson(OidcDiscoveryDocument)(response).pipe(
    Effect.mapError(
      (cause) =>
        new OidcDiscoveryError({
          issuerUrl: normalizedIssuerUrl,
          reason: "invalid_document",
          cause,
        }),
    ),
  );
  if (stripTrailingSlash(document.issuer) !== normalizedIssuerUrl) {
    return yield* new OidcDiscoveryError({
      issuerUrl: normalizedIssuerUrl,
      reason: "issuer_mismatch",
    });
  }

  return {
    issuer: document.issuer,
    authorizationEndpoint: document.authorization_endpoint,
    tokenEndpoint: document.token_endpoint,
  } satisfies OidcProviderMetadata;
});
