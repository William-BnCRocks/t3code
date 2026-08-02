/**
 * providerRateLimits — pure normalizer that folds raw provider account
 * rate-limit telemetry into the `ServerProviderRateLimits` shape carried on
 * `ServerProvider.rateLimits`.
 *
 * Three distinct raw shapes arrive in `event.payload.rateLimits` depending
 * on the driver that emitted the `account.rate-limits.updated` runtime
 * event:
 *
 *  1. Claude — the whole Claude Agent SDK `rate_limit_event` message:
 *     `{ type: "rate_limit_event", rate_limit_info: {...}, uuid, session_id }`.
 *     Exactly one rate-limit window arrives per event, so a snapshot must
 *     accumulate the latest window per `rateLimitType` across events.
 *  2. Codex — the `account/rateLimits/updated` notification params,
 *     double-nested: `{ rateLimits: { primary, secondary, credits,
 *     planType, ... } }`. Per the generated schema's annotation these are
 *     sparse rolling updates: merge non-null fields over the previous
 *     snapshot rather than replacing it.
 *  3. Flat fallback — `{ primary, secondary }` directly (the shape used by
 *     existing test fixtures): treated identically to Codex's inner
 *     snapshot.
 *
 * This module never throws: malformed or unrecognized payloads fall back to
 * the previous snapshot (or `undefined` when there is none) so a single bad
 * event can never crash ingestion or wipe out prior telemetry.
 *
 * @module providerRateLimits
 */
import type {
  ServerProviderRateLimits,
  ServerProviderRateLimitWindow,
  ServerProviderRateLimitWindowStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export interface MergeProviderRateLimitsInput {
  readonly previous: ServerProviderRateLimits | undefined;
  /** Driver kind that emitted the event, e.g. "claudeAgent" / "codex". Informs tie-breaks only — shape detection is structural. */
  readonly provider: string;
  /** Raw `event.payload.rateLimits` value. Untrusted; every access is guarded. */
  readonly payload: unknown;
  readonly observedAt: string;
}

const EPOCH_SECONDS_MAX = 1_000_000_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const RATE_LIMIT_WINDOW_STATUSES: ReadonlySet<string> = new Set([
  "allowed",
  "allowed_warning",
  "rejected",
]);

const asWindowStatus = (value: unknown): ServerProviderRateLimitWindowStatus | undefined =>
  typeof value === "string" && RATE_LIMIT_WINDOW_STATUSES.has(value)
    ? (value as ServerProviderRateLimitWindowStatus)
    : undefined;

/** Epoch seconds or milliseconds (per the < 10^12 heuristic) -> ISO string. */
const toIsoFromEpoch = (value: unknown): string | undefined => {
  if (!isFiniteNumber(value)) {
    return undefined;
  }
  const millis = value < EPOCH_SECONDS_MAX ? value * 1000 : value;
  return Option.match(DateTime.make(millis), {
    onNone: () => undefined,
    onSome: (dateTime) => DateTime.formatIso(dateTime),
  });
};

interface WindowFields {
  readonly usedPercent?: number | undefined;
  readonly resetsAt?: string | undefined;
  readonly windowDurationMins?: number | undefined;
  readonly status?: ServerProviderRateLimitWindowStatus | undefined;
}

const buildWindow = (kind: string, fields: WindowFields): ServerProviderRateLimitWindow => ({
  kind,
  ...(fields.usedPercent !== undefined ? { usedPercent: fields.usedPercent } : {}),
  ...(fields.resetsAt !== undefined ? { resetsAt: fields.resetsAt } : {}),
  ...(fields.windowDurationMins !== undefined
    ? { windowDurationMins: fields.windowDurationMins }
    : {}),
  ...(fields.status !== undefined ? { status: fields.status } : {}),
});

const upsertWindow = (
  windows: ReadonlyArray<ServerProviderRateLimitWindow>,
  next: ServerProviderRateLimitWindow,
): ReadonlyArray<ServerProviderRateLimitWindow> => {
  const index = windows.findIndex((window) => window.kind === next.kind);
  if (index === -1) {
    return [...windows, next];
  }
  const copy = windows.slice();
  copy[index] = next;
  return copy;
};

/** Sparse-merge one Codex/flat window patch over the previous window of the same kind. */
const mergeSparseWindow = (
  windows: ReadonlyArray<ServerProviderRateLimitWindow>,
  kind: string,
  patch: WindowFields,
): ReadonlyArray<ServerProviderRateLimitWindow> => {
  const previous = windows.find((window) => window.kind === kind);
  return upsertWindow(
    windows,
    buildWindow(kind, {
      usedPercent: patch.usedPercent ?? previous?.usedPercent,
      resetsAt: patch.resetsAt ?? previous?.resetsAt,
      windowDurationMins: patch.windowDurationMins ?? previous?.windowDurationMins,
      status: patch.status ?? previous?.status,
    }),
  );
};

const normalizeClaudeRateLimitInfo = (
  windows: ReadonlyArray<ServerProviderRateLimitWindow>,
  info: Record<string, unknown>,
): ReadonlyArray<ServerProviderRateLimitWindow> => {
  const kind = isNonEmptyString(info.rateLimitType) ? info.rateLimitType : "unknown";
  let nextWindows = upsertWindow(
    windows,
    buildWindow(kind, {
      usedPercent: isFiniteNumber(info.utilization) ? info.utilization : undefined,
      resetsAt: toIsoFromEpoch(info.resetsAt),
      status: asWindowStatus(info.status),
    }),
  );

  const hasOverageSignal =
    info.isUsingOverage === true ||
    info.overageStatus !== undefined ||
    info.overageResetsAt !== undefined;
  if (hasOverageSignal) {
    nextWindows = upsertWindow(
      nextWindows,
      buildWindow("overage", {
        status: asWindowStatus(info.overageStatus),
        resetsAt: toIsoFromEpoch(info.overageResetsAt),
      }),
    );
  }

  return nextWindows;
};

const capitalize = (value: string): string =>
  value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;

const deriveCreditsLabel = (credits: unknown): string | undefined => {
  if (!isRecord(credits)) {
    return undefined;
  }
  if (credits.unlimited === true) {
    return "Credits: unlimited";
  }
  if (isNonEmptyString(credits.balance) || isFiniteNumber(credits.balance)) {
    return `Credits: ${String(credits.balance)}`;
  }
  if (credits.hasCredits === false) {
    return "No credits";
  }
  return undefined;
};

const normalizeCodexWindowPatch = (raw: unknown): WindowFields | undefined => {
  if (!isRecord(raw)) {
    return undefined;
  }
  return {
    usedPercent: isFiniteNumber(raw.usedPercent) ? raw.usedPercent : undefined,
    resetsAt: toIsoFromEpoch(raw.resetsAt),
    windowDurationMins: isFiniteNumber(raw.windowDurationMins) ? raw.windowDurationMins : undefined,
  };
};

const normalizeCodexSnapshot = (
  previous: ServerProviderRateLimits | undefined,
  observedAt: string,
  snapshot: Record<string, unknown>,
): ServerProviderRateLimits => {
  let windows = previous?.windows ?? [];

  const primaryPatch = normalizeCodexWindowPatch(snapshot.primary);
  if (primaryPatch) {
    windows = mergeSparseWindow(windows, "primary", primaryPatch);
  }
  const secondaryPatch = normalizeCodexWindowPatch(snapshot.secondary);
  if (secondaryPatch) {
    windows = mergeSparseWindow(windows, "secondary", secondaryPatch);
  }

  const planLabel = isNonEmptyString(snapshot.planType)
    ? capitalize(snapshot.planType)
    : previous?.planLabel;
  const creditsLabel =
    snapshot.credits !== undefined && snapshot.credits !== null
      ? (deriveCreditsLabel(snapshot.credits) ?? previous?.creditsLabel)
      : previous?.creditsLabel;

  return {
    observedAt,
    windows,
    ...(planLabel !== undefined ? { planLabel } : {}),
    ...(creditsLabel !== undefined ? { creditsLabel } : {}),
  };
};

/**
 * Fold one raw `event.payload.rateLimits` value onto the previous
 * `ServerProviderRateLimits` snapshot for a provider instance. Detects the
 * raw shape structurally (never solely by `provider` name) and never
 * throws: unrecognized payloads return `previous` unchanged (or `undefined`
 * when there is no previous snapshot to fall back to).
 */
export const mergeProviderRateLimits = (
  input: MergeProviderRateLimitsInput,
): ServerProviderRateLimits | undefined => {
  const { previous, payload, observedAt } = input;

  if (!isRecord(payload)) {
    return previous;
  }

  // Shape 1: Claude — the raw SDK `rate_limit_event` message.
  if (isRecord(payload.rate_limit_info)) {
    const windows = normalizeClaudeRateLimitInfo(previous?.windows ?? [], payload.rate_limit_info);
    return {
      observedAt,
      windows,
      ...(previous?.planLabel !== undefined ? { planLabel: previous.planLabel } : {}),
      ...(previous?.creditsLabel !== undefined ? { creditsLabel: previous.creditsLabel } : {}),
    };
  }

  // Shape 2: Codex — double-nested `{ rateLimits: { primary, secondary, ... } }`.
  if (isRecord(payload.rateLimits)) {
    return normalizeCodexSnapshot(previous, observedAt, payload.rateLimits);
  }

  // Shape 3: flat fallback — `{ primary, secondary }` directly.
  if ("primary" in payload || "secondary" in payload) {
    return normalizeCodexSnapshot(previous, observedAt, payload);
  }

  return previous;
};
