/**
 * ProviderUsageLog — best-effort JSONL capture of provider account
 * rate-limit telemetry (`account.rate-limits.updated` runtime events).
 *
 * This is intentionally not part of the persisted orchestration state
 * (SQLite): rate-limit snapshots are diagnostic/observability data, not
 * domain state, so they are appended to `<stateDir>/usage/` instead of going
 * through the event store. Files self-rotate monthly by filename
 * (`rate-limits-YYYYMM.jsonl`) rather than via size-based rotation, since
 * volume here is expected to be low (one line per distinct snapshot per
 * provider instance).
 *
 * Capture must never disrupt ingestion or the provider session: `record` and
 * `recordSnapshot` both swallow all failures (directory creation, encoding,
 * disk I/O) behind a warning log. Every JSON line carries a `source` field
 * (`"event"` for passive runtime events, `"poll"` for active poller
 * snapshots) so history stays attributable to how it was observed.
 *
 * @module ProviderUsageLog
 */
import type { ProviderRuntimeAccountRateLimitsUpdatedEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";

const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

export interface ProviderUsageLogSnapshotInput {
  readonly provider: string;
  readonly providerInstanceId: string;
  readonly rateLimits: unknown;
  readonly observedAt: string;
}

export interface ProviderUsageLogShape {
  /**
   * Appends one JSON line for the event's rate-limit snapshot, unless it is
   * byte-for-byte identical to the last snapshot recorded for the same
   * provider instance (chatty adapters re-emit unchanged snapshots).
   */
  readonly record: (event: ProviderRuntimeAccountRateLimitsUpdatedEvent) => Effect.Effect<void>;

  /**
   * Appends one JSON line for an actively-polled rate-limit snapshot (e.g.
   * `ClaudeUsagePoller`'s `GET /api/oauth/usage` sweep), using the same
   * dedupe-per-instance and monthly-rotation rules as `record`. Marked
   * `source: "poll"` to distinguish it from passively-ingested events.
   */
  readonly recordSnapshot: (input: ProviderUsageLogSnapshotInput) => Effect.Effect<void>;
}

/**
 * ProviderUsageLog - Service tag for the rate-limit usage log sink.
 */
export class ProviderUsageLog extends Context.Service<ProviderUsageLog, ProviderUsageLogShape>()(
  "t3/orchestration/Layers/ProviderUsageLog",
) {}

function monthSuffix(parts: DateTime.DateTime.PartsWithWeekday): string {
  return `${parts.year.toString().padStart(4, "0")}${parts.month.toString().padStart(2, "0")}`;
}

/** Groups dedupe/rotation by the account the snapshot describes, not by thread or turn. */
function instanceKeyFor(provider: string, providerInstanceId: string | undefined): string {
  return `${provider}:${providerInstanceId ?? "default"}`;
}

function instanceKey(event: ProviderRuntimeAccountRateLimitsUpdatedEvent): string {
  return instanceKeyFor(event.provider, event.providerInstanceId);
}

export const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const usageDir = path.join(stateDir, "usage");

  let usageDirEnsured = false;
  const lastPayloadByInstance = new Map<string, string>();

  const ensureUsageDirectory = Effect.suspend(() =>
    usageDirEnsured
      ? Effect.void
      : fs
          .makeDirectory(usageDir, { recursive: true })
          .pipe(Effect.tap(() => Effect.sync(() => (usageDirEnsured = true)))),
  );

  const record: ProviderUsageLogShape["record"] = (event) =>
    Effect.gen(function* () {
      const key = instanceKey(event);
      const serializedPayload = yield* encodeUnknownJsonString(event.payload.rateLimits);
      if (lastPayloadByInstance.get(key) === serializedPayload) {
        return;
      }

      const now = yield* DateTime.now;
      const observedAt = DateTime.formatIso(now);
      const filePath = path.join(
        usageDir,
        `rate-limits-${monthSuffix(DateTime.toPartsUtc(now))}.jsonl`,
      );
      const encodedRecord = yield* encodeUnknownJsonString({
        observedAt,
        eventId: event.eventId,
        provider: event.provider,
        ...(event.providerInstanceId !== undefined
          ? { providerInstanceId: event.providerInstanceId }
          : {}),
        threadId: event.threadId,
        rateLimits: event.payload.rateLimits,
        source: "event",
      });

      yield* ensureUsageDirectory;
      yield* fs.writeFileString(filePath, `${encodedRecord}\n`, { flag: "a" });
      lastPayloadByInstance.set(key, serializedPayload);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider usage log failed to persist rate-limit snapshot", {
          eventId: event.eventId,
          eventType: event.type,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const recordSnapshot: ProviderUsageLogShape["recordSnapshot"] = (input) =>
    Effect.gen(function* () {
      const key = instanceKeyFor(input.provider, input.providerInstanceId);
      const serializedPayload = yield* encodeUnknownJsonString(input.rateLimits);
      if (lastPayloadByInstance.get(key) === serializedPayload) {
        return;
      }

      // Buckets the file by the snapshot's own `observedAt` (falling back to
      // the current time if it fails to parse) rather than the write-time
      // clock `record` uses, since the poller already computed `observedAt`
      // once for `applyProviderAccountRateLimits` and passes the same value
      // here.
      const now = yield* DateTime.now;
      const observedAtDateTime = Option.getOrElse(DateTime.make(input.observedAt), () => now);
      const filePath = path.join(
        usageDir,
        `rate-limits-${monthSuffix(DateTime.toPartsUtc(observedAtDateTime))}.jsonl`,
      );
      const encodedRecord = yield* encodeUnknownJsonString({
        observedAt: input.observedAt,
        provider: input.provider,
        providerInstanceId: input.providerInstanceId,
        rateLimits: input.rateLimits,
        source: "poll",
      });

      yield* ensureUsageDirectory;
      yield* fs.writeFileString(filePath, `${encodedRecord}\n`, { flag: "a" });
      lastPayloadByInstance.set(key, serializedPayload);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider usage log failed to persist polled rate-limit snapshot", {
          provider: input.provider,
          providerInstanceId: input.providerInstanceId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  return ProviderUsageLog.of({ record, recordSnapshot });
});

export const ProviderUsageLogLive = Layer.effect(ProviderUsageLog, make);
