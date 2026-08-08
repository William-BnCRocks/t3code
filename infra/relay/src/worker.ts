import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  clientApi,
  dpopClientApi,
  healthApi,
  metadataApi,
  mobileApi,
  relayClientAuthLayer,
  relayDpopClientAuthLayer,
  relayCors,
  relayDocsRedirectRoute,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  traceRelayHttpRequestWith,
  tokenApi,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./zone.ts";
import { makeRelayTraceLayer, RelayObservability } from "./observability.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as RelayDb from "./db.ts";
import { RelayApnsDeliveryDeadLetterQueue, RelayApnsDeliveryQueue } from "./queues.ts";
import * as RelayConfiguration from "./Config.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";

export type ResolvedApnsConfig =
  | { readonly ok: true; readonly apns: RelayConfiguration.ApnsCredentials | undefined }
  | { readonly ok: false; readonly message: string };

// APNs credentials are optional so a self-hosted relay can run without Apple
// push access; if any of the five variables is set, all of them must be, so a
// typo or partial rollout fails loudly instead of silently dropping push.
export function resolveApnsConfig(input: {
  readonly environment: Option.Option<RelayConfiguration.ApnsEnvironment>;
  readonly teamId: Option.Option<string>;
  readonly keyId: Option.Option<string>;
  readonly bundleId: Option.Option<string>;
  readonly privateKey: Option.Option<RelayConfiguration.ApnsCredentials["privateKey"]>;
}): ResolvedApnsConfig {
  const missingVars = [
    Option.isNone(input.environment) ? "APNS_ENVIRONMENT" : undefined,
    Option.isNone(input.teamId) ? "APNS_TEAM_ID" : undefined,
    Option.isNone(input.keyId) ? "APNS_KEY_ID" : undefined,
    Option.isNone(input.bundleId) ? "APNS_BUNDLE_ID" : undefined,
    Option.isNone(input.privateKey) ? "APNS_PRIVATE_KEY" : undefined,
  ].filter((name) => name !== undefined);

  if (missingVars.length === 5) {
    return { ok: true, apns: undefined };
  }
  if (missingVars.length > 0) {
    return {
      ok: false,
      message: `Relay APNs configuration is incomplete; missing ${missingVars.join(", ")}.`,
    };
  }

  return {
    ok: true,
    apns: {
      environment: Option.getOrThrow(input.environment),
      teamId: Option.getOrThrow(input.teamId),
      keyId: Option.getOrThrow(input.keyId),
      bundleId: Option.getOrThrow(input.bundleId),
      privateKey: Option.getOrThrow(input.privateKey),
    },
  };
}

type ResolvedAuthConfig =
  | {
      readonly ok: true;
      readonly clerk:
        | {
            readonly clerkSecretKey: RelayConfiguration.RelayConfiguration["Service"]["clerkSecretKey"];
            readonly clerkPublishableKey: string;
            readonly clerkJwtAudience: string;
          }
        | undefined;
      readonly oidc: RelayConfiguration.OidcConfiguration | undefined;
    }
  | { readonly ok: false; readonly message: string };

// A self-hosted relay may trust Clerk, a standard OIDC provider, or both at
// once (OIDC is tried first at the call sites); it must trust at least one.
function resolveAuthConfig(input: {
  readonly clerkSecretKey: Option.Option<
    RelayConfiguration.RelayConfiguration["Service"]["clerkSecretKey"]
  >;
  readonly clerkPublishableKey: Option.Option<string>;
  readonly clerkJwtAudience: Option.Option<string>;
  readonly oidcIssuerUrl: Option.Option<string>;
  readonly oidcAudiences: Option.Option<ReadonlyArray<string>>;
  readonly oidcJwksUrl: string | undefined;
}): ResolvedAuthConfig {
  const missingClerkVars = [
    Option.isNone(input.clerkSecretKey) ? "CLERK_SECRET_KEY" : undefined,
    Option.isNone(input.clerkPublishableKey) ? "CLERK_PUBLISHABLE_KEY" : undefined,
    Option.isNone(input.clerkJwtAudience) ? "CLERK_JWT_AUDIENCE" : undefined,
  ].filter((name) => name !== undefined);
  const clerkConfigured = missingClerkVars.length < 3;
  const clerkComplete = missingClerkVars.length === 0;

  const oidcAudiences = Option.getOrElse(input.oidcAudiences, (): ReadonlyArray<string> => []);
  const missingOidcVars = [
    Option.isNone(input.oidcIssuerUrl) ? "OIDC_ISSUER_URL" : undefined,
    oidcAudiences.length === 0 ? "OIDC_AUDIENCES" : undefined,
  ].filter((name) => name !== undefined);
  const oidcConfigured = Option.isSome(input.oidcIssuerUrl) || oidcAudiences.length > 0;
  const oidcComplete = missingOidcVars.length === 0;

  if (clerkConfigured && !clerkComplete) {
    return {
      ok: false,
      message: `Relay Clerk configuration is incomplete; missing ${missingClerkVars.join(", ")}.`,
    };
  }
  if (oidcConfigured && !oidcComplete) {
    return {
      ok: false,
      message: `Relay OIDC configuration is incomplete; missing ${missingOidcVars.join(", ")}.`,
    };
  }
  if (!clerkComplete && !oidcComplete) {
    return {
      ok: false,
      message:
        "Relay requires either a complete Clerk configuration (CLERK_SECRET_KEY, " +
        "CLERK_PUBLISHABLE_KEY, CLERK_JWT_AUDIENCE) or a complete OIDC configuration " +
        "(OIDC_ISSUER_URL, OIDC_AUDIENCES).",
    };
  }

  return {
    ok: true,
    clerk: clerkComplete
      ? {
          clerkSecretKey: Option.getOrThrow(input.clerkSecretKey),
          clerkPublishableKey: Option.getOrThrow(input.clerkPublishableKey),
          clerkJwtAudience: Option.getOrThrow(input.clerkJwtAudience),
        }
      : undefined,
    oidc: oidcComplete
      ? {
          issuerUrl: Option.getOrThrow(input.oidcIssuerUrl),
          audiences: oidcAudiences,
          jwksUrl: input.oidcJwksUrl,
        }
      : undefined,
  };
}

const webcryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const httpPlatformNotSupportedLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  tokenApi,
  dpopClientApi,
  serverApi,
);

const CloudMintKeyPair = Alchemy.KeyPair("CloudMintKeyPair");
const ApnsDeliveryJobSigningSecret = Alchemy.makeRandom("ApnsDeliveryJobSigningSecret", {
  bytes: 32,
});

export class Api extends Cloudflare.Worker<Api, {}>()("Api") {}

export const ApiLive = Api.make(
  RelayDeploymentConfig.pipe(
    Effect.map(({ relayPublicDomain }) => ({
      main: import.meta.filename,
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      domain: relayPublicDomain,
    })),
    Effect.orDie,
  ),
  Effect.gen(function* () {
    //
    // 1. Provision Infrastructure for the Worker to use
    //
    const { relayPublicOrigin, stage } = yield* RelayDeploymentConfig;
    const apnsDeliveryQueue = yield* RelayApnsDeliveryQueue;
    const apnsDeliveryDeadLetterQueue = yield* RelayApnsDeliveryDeadLetterQueue;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const relayApiZone = yield* RelayApiZone;
    const managedEndpointZone = yield* ManagedEndpointZone;
    const randomApnsDeliveryJobSigningSecret = yield* ApnsDeliveryJobSigningSecret;
    const observability = yield* RelayObservability;

    //
    // 2. Create bindings
    //
    const apnsEnvironment = yield* Config.schema(
      RelayConfiguration.ApnsEnvironment,
      "APNS_ENVIRONMENT",
    ).pipe(Config.option);
    const apnsTeamId = yield* Config.string("APNS_TEAM_ID").pipe(Config.option);
    const apnsKeyId = yield* Config.string("APNS_KEY_ID").pipe(Config.option);
    const apnsBundleId = yield* Config.string("APNS_BUNDLE_ID").pipe(Config.option);
    const apnsPrivateKey = yield* Config.redacted("APNS_PRIVATE_KEY").pipe(Config.option);
    const apnsDeliveryJobSigningSecret = yield* randomApnsDeliveryJobSigningSecret;
    const apnsDeliveryQueueSender = yield* Cloudflare.Queues.WriteQueue(apnsDeliveryQueue);

    const clerkSecretKey = yield* Config.redacted("CLERK_SECRET_KEY").pipe(Config.option);
    const clerkPublishableKey = yield* Config.string("CLERK_PUBLISHABLE_KEY").pipe(Config.option);
    const clerkJwtAudience = yield* Config.string("CLERK_JWT_AUDIENCE").pipe(Config.option);
    const oidcIssuerUrl = yield* Config.string("OIDC_ISSUER_URL").pipe(
      Config.option,
      Config.map(Option.map((value) => value.trim().replace(/\/+$/u, ""))),
    );
    const oidcAudiences = yield* Config.string("OIDC_AUDIENCES").pipe(
      Config.option,
      Config.map(
        Option.map((value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        ),
      ),
    );
    const oidcJwksUrl = yield* Config.string("OIDC_JWKS_URL").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );

    const authConfig = resolveAuthConfig({
      clerkSecretKey,
      clerkPublishableKey,
      clerkJwtAudience,
      oidcIssuerUrl,
      oidcAudiences,
      oidcJwksUrl,
    });
    if (!authConfig.ok) {
      return yield* Effect.die(new Error(authConfig.message));
    }

    const apnsConfig = resolveApnsConfig({
      environment: apnsEnvironment,
      teamId: apnsTeamId,
      keyId: apnsKeyId,
      bundleId: apnsBundleId,
      privateKey: apnsPrivateKey,
    });
    if (!apnsConfig.ok) {
      return yield* Effect.die(new Error(apnsConfig.message));
    }

    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(yield* RelayDb.RelayHyperdrive);
    const db = yield* Drizzle.Postgres(hyperdrive.connectionString);

    const managedEndpointTunnelBinding = yield* Cloudflare.Tunnel.ReadWriteTunnel();
    // Keep Worker custom-domain reconciliation ordered after API zone provisioning.
    yield* yield* relayApiZone.zoneId;
    const managedEndpointDnsBinding = yield* Cloudflare.DNS.ReadWriteDns(managedEndpointZone);
    const managedEndpointZoneName = yield* managedEndpointZone.name;

    //
    // 3. Runtime layers and app construction
    //
    const alchemyRuntimeContext: Alchemy.BaseRuntimeContext = yield* Cloudflare.Worker;

    const loadSettings = Effect.gen(function* () {
      return RelayConfiguration.RelayConfiguration.of({
        relayIssuer: relayPublicOrigin,
        apns: apnsConfig.apns,
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        clerkSecretKey: authConfig.clerk?.clerkSecretKey,
        clerkPublishableKey: authConfig.clerk?.clerkPublishableKey,
        clerkJwtAudience: authConfig.clerk?.clerkJwtAudience,
        oidc: authConfig.oidc,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        managedEndpointBaseDomain: yield* managedEndpointZoneName,
        managedEndpointNamespace: stage,
      });
    });

    const relayTraceLayer = observability.enabled
      ? Layer.unwrap(
          Effect.all({
            tracesDatasetName: yield* observability.traces.name,
            tracesEndpoint: yield* observability.traces.otelTracesEndpoint,
            ingestToken: yield* observability.workerIngestToken.token,
          }).pipe(Effect.map(makeRelayTraceLayer)),
        )
      : Layer.empty;

    const runtimeLayer = Layer.empty.pipe(
      Layer.provideMerge(MobileRegistrations.layer),
      Layer.provideMerge(AgentActivityPublisher.layer),
      Layer.provideMerge(EnvironmentConnector.layer),
      Layer.provideMerge(EnvironmentLinker.layer),
      Layer.provideMerge(EnvironmentPublishSignatures.layer),
      Layer.provideMerge(
        ManagedEndpointProvider.layerCloudflareBindings(
          managedEndpointTunnelBinding,
          managedEndpointDnsBinding,
          alchemyRuntimeContext,
        ),
      ),
      Layer.provideMerge(DpopProofs.layer),
      Layer.provideMerge(ApnsDeliveries.layer),
      Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
      Layer.provideMerge(
        ApnsDeliveryQueue.layerCloudflareQueues(apnsDeliveryQueueSender, alchemyRuntimeContext),
      ),
      Layer.provideMerge(AgentActivityRows.layer),
      Layer.provideMerge(Devices.layer),
      Layer.provideMerge(EnvironmentCredentials.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          EnvironmentLinks.layer,
          ManagedEndpointAllocations.layer,
          ManagedTunnelLimits.layer,
        ),
      ),
      Layer.provideMerge(LiveActivities.layer),
      Layer.provideMerge(DeliveryAttempts.layer),
      Layer.provideMerge(RelayTokens.layer),
      Layer.provideMerge(
        RelayDb.RelayTransactions.layer.pipe(
          Layer.provideMerge(Layer.succeed(RelayDb.RelayDb, db)),
        ),
      ),
      Layer.provideMerge(Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings)),
      Layer.provideMerge(webcryptoLayer),
    );

    const appLayer = relayApiLayer.pipe(
      Layer.provideMerge(relayClientAuthLayer),
      Layer.provideMerge(relayDpopClientAuthLayer),
      Layer.provideMerge(relayEnvironmentAuthLayer),
      Layer.provide(runtimeLayer),
    );

    yield* Cloudflare.Queues.consumeQueueMessages<unknown>(
      apnsDeliveryQueue,
      {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "5 seconds",
        retryDelay: "30 seconds",
        deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
      },
      (stream) =>
        stream.pipe(
          Stream.withSpan("relay.apn_delivery_queue.process_batch"),
          Stream.runForEach((message) =>
            ApnsDeliveries.ApnsDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
              Effect.withSpan("relay.apn_delivery_queue.process_message"),
            ),
          ),
          Effect.provide(runtimeLayer),
        ),
    );

    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      DpopProofs.DpopProofReplay.pipe(
        Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
        // Terminal thread rows are kept briefly so finished agents show as
        // Done/Failed in the Live Activity; sweep them once they age out.
        Effect.andThen(
          Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
            Effect.flatMap(([activityRows, now]) =>
              activityRows.pruneTerminal({
                updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
              }),
            ),
          ),
        ),
        Effect.withSpan("relay.cron.prune_expired_state"),
        Effect.provide(runtimeLayer),
      ),
    );

    const fetch = Layer.merge(
      Layer.mergeAll(
        HttpApiBuilder.layer(RelayApi, { openapiPath: "/openapi.json" }).pipe(
          Layer.provide(appLayer),
        ),
        HttpApiScalar.layer(RelayApi, { path: "/docs" }),
        relayDocsRedirectRoute,
      ).pipe(Layer.provide([Etag.layerWeak, httpPlatformNotSupportedLayer, relayCors])),
      relayNotFoundRoute,
    ).pipe(
      HttpRouter.toHttpEffect,
      withoutCapturedParentSpan,
      Effect.flatMap((httpEffect) => traceRelayHttpRequestWith(httpEffect, relayTraceLayer)),
    );

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(Cloudflare.Hyperdrive.ConnectBinding),
        Layer.provideMerge(Cloudflare.Workers.CronEventSourceLive),
        Layer.provideMerge(Cloudflare.Queues.WriteQueueBinding),
        Layer.provideMerge(Cloudflare.Queues.EventSourceLive),
        Layer.provideMerge(Cloudflare.Tunnel.ReadWriteTunnelBinding),
        Layer.provideMerge(Cloudflare.DNS.ReadWriteDnsHttp),
      ),
    ),
  ),
);

export default ApiLive;
