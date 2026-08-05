/**
 * GrokUsagePollerLive — periodically polls the Grok billing endpoint
 * (`GET /billing?format=credits`, the same endpoint the CLI's own `/cost`
 * slash command reads) for every configured Grok instance and feeds the raw
 * response through the same `applyProviderAccountRateLimits` sink the
 * Claude usage poller uses. See `grokUsage.ts` for the endpoint client and
 * credential resolution, and `providerRateLimits.ts` for the normalizer that
 * turns the raw response into a rate-limit window.
 *
 * Lifecycle mirrors `ClaudeUsagePollerLive`: a scoped sweep loop forked from
 * `start()`, `Effect.repeat(Schedule.spaced(...))` runs the wrapped effect
 * immediately then on the interval, so the first sweep doubles as "poll once
 * at server start". A second forked fiber watches `ProviderRegistry.streamChanges`
 * for a Grok instance's `auth.status` transitioning into `"authenticated"`
 * and fires one immediate poll of just that instance.
 *
 * Every external effect (settings read, session directory read, credential
 * file read, HTTP fetch) is fail-open: a failure anywhere skips gracefully
 * to the next instance/tick and never crashes the loop.
 *
 * @module GrokUsagePollerLive
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import {
  ProviderUsageLog,
  ProviderUsageLogLive,
} from "../../orchestration/Layers/ProviderUsageLog.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { fetchGrokUsage, readGrokAccessToken, resolveGrokAuthPath } from "../grokUsage.ts";
import type { ProviderRuntimeBindingWithMetadata } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { GrokUsagePoller, type GrokUsagePollerShape } from "../Services/GrokUsagePoller.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const GROK_DRIVER = ProviderDriverKind.make("grok");
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

export interface GrokUsagePollerLiveOptions {
  readonly pollIntervalMs?: number;
}

interface GrokInstanceTarget {
  readonly instanceId: ProviderInstanceId;
  readonly homePath: string;
}

const extractHomePath = (config: unknown): string => {
  if (typeof config !== "object" || config === null) {
    return "";
  }
  const homePath = (config as Record<string, unknown>).homePath;
  return typeof homePath === "string" ? homePath : "";
};

const listGrokInstanceTargets = (settings: ServerSettings): ReadonlyArray<GrokInstanceTarget> => {
  const configMap = deriveProviderInstanceConfigMap(settings);
  const targets: GrokInstanceTarget[] = [];
  for (const [instanceId, entry] of Object.entries(configMap)) {
    if (entry.driver !== GROK_DRIVER) {
      continue;
    }
    targets.push({
      instanceId: instanceId as ProviderInstanceId,
      homePath: extractHomePath(entry.config),
    });
  }
  return targets;
};

const activeGrokInstanceIds = (
  bindings: ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
): ReadonlySet<ProviderInstanceId> => {
  const active = new Set<ProviderInstanceId>();
  for (const binding of bindings) {
    if (binding.provider !== GROK_DRIVER || binding.status === "stopped") {
      continue;
    }
    // `ProviderSessionDirectoryLive.listBindings()` already promotes legacy
    // null instance ids to the driver's default instance id before
    // returning, so this fallback is defensive/redundant in practice today
    // — kept in case a future caller bypasses that promotion.
    active.add(binding.providerInstanceId ?? defaultInstanceIdForDriver(GROK_DRIVER));
  }
  return active;
};

const makeGrokUsagePoller = (options?: GrokUsagePollerLiveOptions) =>
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry;
    const providerUsageLog = yield* ProviderUsageLog;
    const serverSettings = yield* ServerSettingsService;
    const providerSessionDirectory = yield* ProviderSessionDirectory;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;

    const pollIntervalMs = Math.max(1, options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const firstTickRef = yield* Ref.make(true);
    const failingInstancesRef = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());

    const recordFailure = (
      instanceId: ProviderInstanceId,
      reason: string,
      cause?: Cause.Cause<unknown>,
    ) =>
      Effect.gen(function* () {
        const wasFailing = (yield* Ref.get(failingInstancesRef)).has(instanceId);
        yield* Ref.update(failingInstancesRef, (previous) => new Set(previous).add(instanceId));
        const logFields = {
          instanceId,
          reason,
          ...(cause ? { cause: Cause.pretty(cause) } : {}),
        };
        yield* wasFailing
          ? Effect.logDebug("grok usage poller instance still failing", logFields)
          : Effect.logWarning("grok usage poller instance fetch failed", logFields);
      });

    const clearFailure = (instanceId: ProviderInstanceId) =>
      Ref.update(failingInstancesRef, (previous) => {
        if (!previous.has(instanceId)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(instanceId);
        return next;
      });

    // Fully discharges the `Path.Path` / `FileSystem.FileSystem` /
    // `HttpClient.HttpClient` requirements of the `grokUsage.ts` helpers
    // against the concrete instances resolved once at layer build, so the
    // returned effect is `Effect.Effect<void>` — required for `start()` to
    // type-check as `Effect.Effect<void, never, Scope.Scope>`.
    const pollOneInstance = (target: GrokInstanceTarget) =>
      Effect.gen(function* () {
        const authPath = yield* resolveGrokAuthPath(target.homePath).pipe(
          Effect.provideService(Path.Path, path),
        );
        const tokenOption = yield* readGrokAccessToken(authPath).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
        if (Option.isNone(tokenOption)) {
          yield* recordFailure(target.instanceId, "no usable Grok credentials");
          return;
        }

        const usageOption = yield* fetchGrokUsage(tokenOption.value).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
        if (Option.isNone(usageOption)) {
          yield* recordFailure(target.instanceId, "grok billing endpoint fetch failed");
          return;
        }

        yield* clearFailure(target.instanceId);
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* providerRegistry.applyProviderAccountRateLimits({
          instanceId: target.instanceId,
          provider: GROK_DRIVER,
          payload: usageOption.value,
          observedAt,
        });
        // `recordSnapshot` is already fail-open (swallows its own errors
        // behind a warning log), so a history-write failure never disrupts
        // polling.
        yield* providerUsageLog.recordSnapshot({
          provider: GROK_DRIVER,
          providerInstanceId: target.instanceId,
          rateLimits: usageOption.value,
          observedAt,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          recordFailure(target.instanceId, "unexpected poll error", cause),
        ),
      );

    const sweep = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.tapError((error) =>
          Effect.logWarning("grok usage poller failed to read settings", { error }),
        ),
        Effect.orElseSucceed(() => undefined),
      );
      if (settings === undefined) {
        return;
      }

      const targets = listGrokInstanceTargets(settings);
      if (targets.length === 0) {
        return;
      }

      const isFirstTick = yield* Ref.get(firstTickRef);
      let targetsToPoll = targets;
      if (!isFirstTick) {
        const bindings = yield* providerSessionDirectory
          .listBindings()
          .pipe(Effect.catchCause(() => Effect.succeed([])));
        const activeIds = activeGrokInstanceIds(bindings);
        targetsToPoll = targets.filter((target) => activeIds.has(target.instanceId));
      }
      yield* Ref.set(firstTickRef, false);

      yield* Effect.forEach(targetsToPoll, pollOneInstance, {
        concurrency: "unbounded",
        discard: true,
      });
    });

    // Reacts to a configured Grok instance's `auth.status` transitioning
    // into `"authenticated"` by polling just that instance immediately.
    // Seeded from the current snapshot so the initial `streamChanges`
    // subscription doesn't treat every already-authenticated instance at
    // boot as a fresh transition (the sweep loop's first tick already
    // covers boot-time polling for every configured instance).
    const authTransitionWatcher = Effect.gen(function* () {
      const initialProviders = yield* providerRegistry.getProviders;
      const initialAuthByInstance = new Map<ProviderInstanceId, string>();
      for (const provider of initialProviders) {
        if (provider.driver === GROK_DRIVER) {
          initialAuthByInstance.set(provider.instanceId, provider.auth.status);
        }
      }
      const previousAuthRef =
        yield* Ref.make<ReadonlyMap<ProviderInstanceId, string>>(initialAuthByInstance);

      yield* Stream.runForEach(providerRegistry.streamChanges, (providers) =>
        Effect.gen(function* () {
          const previousAuth = yield* Ref.get(previousAuthRef);
          const nextAuth = new Map(previousAuth);
          const grokProviders = providers.filter((provider) => provider.driver === GROK_DRIVER);

          const newlyAuthenticated = grokProviders.filter((provider) => {
            const previousStatus = previousAuth.get(provider.instanceId);
            nextAuth.set(provider.instanceId, provider.auth.status);
            return provider.auth.status === "authenticated" && previousStatus !== "authenticated";
          });
          yield* Ref.set(previousAuthRef, nextAuth);

          if (newlyAuthenticated.length === 0) {
            return;
          }

          const settings = yield* serverSettings.getSettings.pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (settings === undefined) {
            return;
          }
          const targetsById = new Map(
            listGrokInstanceTargets(settings).map((target) => [target.instanceId, target] as const),
          );

          yield* Effect.forEach(
            newlyAuthenticated,
            (provider) => {
              const target = targetsById.get(provider.instanceId);
              return target ? pollOneInstance(target) : Effect.void;
            },
            { concurrency: "unbounded", discard: true },
          );
        }),
      );
    });

    const start: GrokUsagePollerShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("grok usage poller sweep failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("grok usage poller sweep defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(pollIntervalMs))),
          ),
        );

        yield* Effect.forkScoped(
          authTransitionWatcher.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("grok usage poller auth-transition watcher failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("grok usage poller auth-transition watcher defect", { defect }),
            ),
          ),
        );

        yield* Effect.logInfo("grok usage poller started", { pollIntervalMs });
      });

    return {
      start,
    } satisfies GrokUsagePollerShape;
  });

export const makeGrokUsagePollerLive = (options?: GrokUsagePollerLiveOptions) =>
  // `ProviderUsageLogLive` is provided privately here (mirroring
  // `ClaudeUsagePollerLive`'s own private provision), so the poller gets its
  // own `ProviderUsageLog` instance with its own dedupe map rather than
  // sharing the ingestion tap's or Claude poller's. That's acceptable: dedupe
  // only needs to catch back-to-back identical writes from the *same* sink,
  // and the shared JSONL file + `source` field still make the independently-
  // deduped streams attributable.
  Layer.effect(GrokUsagePoller, makeGrokUsagePoller(options)).pipe(
    Layer.provide(ProviderUsageLogLive),
  );

export const GrokUsagePollerLive = makeGrokUsagePollerLive();
