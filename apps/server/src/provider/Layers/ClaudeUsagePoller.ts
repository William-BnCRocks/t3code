/**
 * ClaudeUsagePollerLive — periodically polls the Claude usage endpoint
 * (`GET /api/oauth/usage`, the same endpoint Claude Code's own `/status`
 * command reads) for every configured Claude instance and feeds the raw
 * response through the same `applyProviderAccountRateLimits` sink the
 * passive Claude Agent SDK event stream already uses. See `claudeUsage.ts`
 * for the endpoint client and credential resolution, and
 * `providerRateLimits.ts` (Shape 2.5, `normalizeClaudeUsagePullPayload`) for
 * the normalizer that turns the raw response into rate-limit windows.
 *
 * Lifecycle mirrors `ProviderSessionReaper`: a scoped sweep loop forked from
 * `start()`, `Effect.repeat(Schedule.spaced(...))` runs the wrapped effect
 * immediately then on the interval, so the first sweep doubles as "poll
 * once at server start". A second forked fiber watches
 * `ProviderRegistry.streamChanges` for a Claude instance's `auth.status`
 * transitioning into `"authenticated"` and fires one immediate poll of just
 * that instance, so usage shows up the moment login completes rather than
 * waiting for the next 5-minute tick.
 *
 * Every external effect (settings read, session directory read, credential
 * file read, HTTP fetch) is fail-open: a failure anywhere skips gracefully
 * to the next instance/tick and never crashes the loop.
 *
 * @module ClaudeUsagePollerLive
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
import {
  fetchClaudeUsage,
  readClaudeAccessToken,
  resolveClaudeCredentialsPath,
} from "../claudeUsage.ts";
import type { ProviderRuntimeBindingWithMetadata } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ClaudeUsagePoller, type ClaudeUsagePollerShape } from "../Services/ClaudeUsagePoller.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

export interface ClaudeUsagePollerLiveOptions {
  readonly pollIntervalMs?: number;
}

interface ClaudeInstanceTarget {
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

const listClaudeInstanceTargets = (
  settings: ServerSettings,
): ReadonlyArray<ClaudeInstanceTarget> => {
  const configMap = deriveProviderInstanceConfigMap(settings);
  const targets: ClaudeInstanceTarget[] = [];
  for (const [instanceId, entry] of Object.entries(configMap)) {
    if (entry.driver !== CLAUDE_DRIVER) {
      continue;
    }
    targets.push({
      instanceId: instanceId as ProviderInstanceId,
      homePath: extractHomePath(entry.config),
    });
  }
  return targets;
};

const activeClaudeInstanceIds = (
  bindings: ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
): ReadonlySet<ProviderInstanceId> => {
  const active = new Set<ProviderInstanceId>();
  for (const binding of bindings) {
    if (binding.provider !== CLAUDE_DRIVER || binding.status === "stopped") {
      continue;
    }
    // `ProviderSessionDirectoryLive.listBindings()` already promotes legacy
    // null instance ids to the driver's default instance id before
    // returning, so this fallback is defensive/redundant in practice today
    // — kept in case a future caller bypasses that promotion.
    active.add(binding.providerInstanceId ?? defaultInstanceIdForDriver(CLAUDE_DRIVER));
  }
  return active;
};

const makeClaudeUsagePoller = (options?: ClaudeUsagePollerLiveOptions) =>
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
          ? Effect.logDebug("claude usage poller instance still failing", logFields)
          : Effect.logWarning("claude usage poller instance fetch failed", logFields);
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
    // `HttpClient.HttpClient` requirements of the `claudeUsage.ts` helpers
    // against the concrete instances resolved once at layer build, so the
    // returned effect is `Effect.Effect<void>` — required for `start()` to
    // type-check as `Effect.Effect<void, never, Scope.Scope>`.
    const pollOneInstance = (target: ClaudeInstanceTarget) =>
      Effect.gen(function* () {
        const credentialsPath = yield* resolveClaudeCredentialsPath(target.homePath).pipe(
          Effect.provideService(Path.Path, path),
        );
        const tokenOption = yield* readClaudeAccessToken(credentialsPath).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
        if (Option.isNone(tokenOption)) {
          yield* recordFailure(target.instanceId, "no usable Claude credentials");
          return;
        }

        const usageOption = yield* fetchClaudeUsage(tokenOption.value).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
        if (Option.isNone(usageOption)) {
          yield* recordFailure(target.instanceId, "claude usage endpoint fetch failed");
          return;
        }

        yield* clearFailure(target.instanceId);
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* providerRegistry.applyProviderAccountRateLimits({
          instanceId: target.instanceId,
          provider: CLAUDE_DRIVER,
          payload: usageOption.value,
          observedAt,
        });
        // `recordSnapshot` is already fail-open (swallows its own errors
        // behind a warning log), so a history-write failure never disrupts
        // polling.
        yield* providerUsageLog.recordSnapshot({
          provider: CLAUDE_DRIVER,
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
          Effect.logWarning("claude usage poller failed to read settings", { error }),
        ),
        Effect.orElseSucceed(() => undefined),
      );
      if (settings === undefined) {
        return;
      }

      const targets = listClaudeInstanceTargets(settings);
      if (targets.length === 0) {
        return;
      }

      const isFirstTick = yield* Ref.get(firstTickRef);
      let targetsToPoll = targets;
      if (!isFirstTick) {
        const bindings = yield* providerSessionDirectory
          .listBindings()
          .pipe(Effect.catchCause(() => Effect.succeed([])));
        const activeIds = activeClaudeInstanceIds(bindings);
        targetsToPoll = targets.filter((target) => activeIds.has(target.instanceId));
      }
      yield* Ref.set(firstTickRef, false);

      yield* Effect.forEach(targetsToPoll, pollOneInstance, {
        concurrency: "unbounded",
        discard: true,
      });
    });

    // Reacts to a configured Claude instance's `auth.status` transitioning
    // into `"authenticated"` by polling just that instance immediately.
    // Seeded from the current snapshot so the initial `streamChanges`
    // subscription doesn't treat every already-authenticated instance at
    // boot as a fresh transition (the sweep loop's first tick already
    // covers boot-time polling for every configured instance).
    const authTransitionWatcher = Effect.gen(function* () {
      const initialProviders = yield* providerRegistry.getProviders;
      const initialAuthByInstance = new Map<ProviderInstanceId, string>();
      for (const provider of initialProviders) {
        if (provider.driver === CLAUDE_DRIVER) {
          initialAuthByInstance.set(provider.instanceId, provider.auth.status);
        }
      }
      const previousAuthRef =
        yield* Ref.make<ReadonlyMap<ProviderInstanceId, string>>(initialAuthByInstance);

      yield* Stream.runForEach(providerRegistry.streamChanges, (providers) =>
        Effect.gen(function* () {
          const previousAuth = yield* Ref.get(previousAuthRef);
          const nextAuth = new Map(previousAuth);
          const claudeProviders = providers.filter((provider) => provider.driver === CLAUDE_DRIVER);

          const newlyAuthenticated = claudeProviders.filter((provider) => {
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
            listClaudeInstanceTargets(settings).map(
              (target) => [target.instanceId, target] as const,
            ),
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

    const start: ClaudeUsagePollerShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("claude usage poller sweep failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("claude usage poller sweep defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(pollIntervalMs))),
          ),
        );

        yield* Effect.forkScoped(
          authTransitionWatcher.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("claude usage poller auth-transition watcher failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("claude usage poller auth-transition watcher defect", { defect }),
            ),
          ),
        );

        yield* Effect.logInfo("claude usage poller started", { pollIntervalMs });
      });

    return {
      start,
    } satisfies ClaudeUsagePollerShape;
  });

export const makeClaudeUsagePollerLive = (options?: ClaudeUsagePollerLiveOptions) =>
  // `ProviderUsageLogLive` is provided privately here (mirroring
  // `ProviderRuntimeIngestionLive`'s own private provision in
  // ProviderRuntimeIngestion.ts), so the poller gets its own `ProviderUsageLog`
  // instance with its own dedupe map rather than sharing the ingestion tap's.
  // That's acceptable: dedupe only needs to catch back-to-back identical
  // writes from the *same* sink, and the shared JSONL file + `source` field
  // still make the two independently-deduped streams attributable.
  Layer.effect(ClaudeUsagePoller, makeClaudeUsagePoller(options)).pipe(
    Layer.provide(ProviderUsageLogLive),
  );

export const ClaudeUsagePollerLive = makeClaudeUsagePollerLive();
