// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Planetscale from "alchemy/Planetscale";

import * as RelayDb from "./src/db.ts";
import { RelayObservability, resolveAxiomConfig } from "./src/observability.ts";
import { ManagedEndpointZone, RelayApiZone } from "./src/zone.ts";
import ApiLive, { Api } from "./src/worker.ts";

// Alchemy builds every registered provider's Layer up front, before the stack
// body below runs, so including Axiom.providers() unconditionally would try
// to resolve Axiom credentials (and fail without them) even when
// RelayObservability never creates an Axiom resource. Stand in an empty
// provider collection when Axiom is unconfigured; RelayObservability's
// disabled branch never looks one up, so it's never exercised.
const disabledAxiomProviders = Layer.succeed(Axiom.Providers, {
  kind: "ProviderCollection" as const,
  get: () => undefined,
  providers: {},
});

const axiomProviders = Layer.unwrap(
  Effect.all({
    token: Config.redacted("AXIOM_TOKEN").pipe(Config.option),
    orgId: Config.string("AXIOM_ORG_ID").pipe(Config.option),
  }).pipe(
    Effect.map(({ token, orgId }) => {
      const axiomConfig = resolveAxiomConfig({ token, orgId });
      return axiomConfig.ok && axiomConfig.enabled ? Axiom.providers() : disabledAxiomProviders;
    }),
    Effect.orDie,
  ),
);

export default Alchemy.Stack(
  "T3CodeRelay",
  {
    providers: Layer.mergeAll(
      axiomProviders,
      Cloudflare.providers(),
      Drizzle.providers(),
      Planetscale.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const db = yield* RelayDb.PlanetscaleDatabase;
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = yield* RelayObservability;
    const api = yield* Api;

    return {
      databaseName: db.database.name,
      databaseBranchName: db.branch?.name ?? "main",
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
      tracingEnabled: observability.enabled,
      ...(observability.enabled
        ? {
            mobileTracingUrl: observability.traces.otelTracesEndpoint,
            mobileTracingDataset: observability.traces.name,
            mobileTracingToken: observability.mobileIngestToken.token,
            clientTracingUrl: observability.traces.otelTracesEndpoint,
            clientTracingDataset: observability.traces.name,
            clientTracingToken: observability.clientIngestToken.token,
          }
        : {}),
    };
  }).pipe(Effect.provide(ApiLive)),
);
