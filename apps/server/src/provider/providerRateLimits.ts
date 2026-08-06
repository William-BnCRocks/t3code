/**
 * providerRateLimits — pure normalizer that folds raw provider account
 * rate-limit telemetry into the `ServerProviderRateLimits` shape carried on
 * `ServerProvider.rateLimits`.
 *
 * Four distinct raw shapes arrive in `event.payload.rateLimits` (or, for
 * shape 2.5, are fed directly as the raw usage-endpoint response by the
 * active Claude usage poller) depending on the source:
 *
 *  1. Claude event — the whole Claude Agent SDK `rate_limit_event` message:
 *     `{ type: "rate_limit_event", rate_limit_info: {...}, uuid, session_id }`.
 *     Exactly one rate-limit window arrives per event, so a snapshot must
 *     accumulate the latest window per `rateLimitType` across events. This
 *     passive stream frequently omits `utilization` altogether.
 *  2. Codex — the `account/rateLimits/updated` notification params,
 *     double-nested: `{ rateLimits: { primary, secondary, credits,
 *     planType, ... } }`. Per the generated schema's annotation these are
 *     sparse rolling updates: merge non-null fields over the previous
 *     snapshot rather than replacing it.
 *  2.5. Claude pull — the raw JSON body from `GET /api/oauth/usage` (the
 *     same endpoint Claude Code's own `/status` command polls), fed by
 *     `ClaudeUsagePoller`. Structurally detected: `limits` is an array, or
 *     a top-level `five_hour`/`seven_day` object carries a finite
 *     `utilization`. Unlike shapes 1-3, this is a complete authoritative
 *     account-state read, not a delta — it REPLACES the entire `windows`
 *     array and `planLabel`/`creditsLabel` outright rather than
 *     sparse-merging, so stale carried-over labels never survive a fresh
 *     poll. See `normalizeClaudeUsagePullPayload` for the field mapping.
 *  3. Grok billing — the raw JSON body from the ACP extension request
 *     `x.ai/billing` on a live `grok agent stdio` session (see
 *     `grokUsage.readGrokBillingOverAcp`, polled per-session by
 *     `GrokAdapter`). Structurally detected by the presence of
 *     `creditUsagePercent` or `currentPeriod` — field names unique to this
 *     shape. Like the Claude pull shape, this is a complete authoritative
 *     account-state read, not a delta: it REPLACES the entire `windows`
 *     array and `planLabel` outright with a single `"monthly"` window. See
 *     `normalizeGrokBillingPayload` for the field mapping.
 *  4. Flat fallback — `{ primary, secondary }` directly (the shape used by
 *     existing test fixtures): treated identically to Codex's inner
 *     snapshot.
 *  5. Grok weekly-limit session signal — `{ retry_state: { is_rate_limited,
 *     error_type, ... } }`, synthesized by `GrokAdapter` when a live ACP
 *     session observes xAI's `RetryState` signal with `is_rate_limited` and
 *     `exhausted` both true (see `GrokAdapter.ts` and `XAiAcpExtension.ts`).
 *     Grok's weekly limit has no queryable HTTP/ACP source — it only ever
 *     appears as this in-session signal — so unlike shape 3 this is NOT an
 *     authoritative full-account read: it additively upserts a single
 *     `"weekly"` window over `previous`, leaving the monthly credits window
 *     and any labels untouched. See `normalizeGrokRetryStateSignal` for the
 *     field mapping.
 *  6. Grok subscription fallback — the raw ACP `x.ai/auth/check_subscription`
 *     response body, read per-session by `GrokAdapter` only when that poll's
 *     shape-3 billing read came back empty (verified live: some accounts,
 *     e.g. a team-member account with no personal team of its own, can never
 *     answer `x.ai/billing` at all — see `grokUsage.readGrokSubscriptionOverAcp`).
 *     Structurally detected by a top-level `authenticated` field alongside a
 *     `meta` object carrying `subscription_tier`. Carries no quota number at
 *     all, so it normalizes to an EMPTY `windows` array plus a `planLabel` of
 *     `subscription_tier` verbatim (team-appended when `meta.team_name` is
 *     also non-empty, e.g. `"SuperGrok · BnC"`) — never email or team_id.
 *     This means "billing is unreadable, here's what we know", so like shape
 *     3 it's an authoritative replace of the labels, EXCEPT it must never
 *     downgrade a `previous` snapshot that already has real windows (a
 *     working shape-3 billing read, or a shape-5 weekly signal riding on top
 *     of one): when `previous.windows` is non-empty, those windows are kept
 *     as-is and only the labels are refreshed. See
 *     `normalizeGrokSubscriptionPayload` for the field mapping.
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
  readonly isActive?: boolean | undefined;
}

const buildWindow = (kind: string, fields: WindowFields): ServerProviderRateLimitWindow => ({
  kind,
  ...(fields.usedPercent !== undefined ? { usedPercent: fields.usedPercent } : {}),
  ...(fields.resetsAt !== undefined ? { resetsAt: fields.resetsAt } : {}),
  ...(fields.windowDurationMins !== undefined
    ? { windowDurationMins: fields.windowDurationMins }
    : {}),
  ...(fields.status !== undefined ? { status: fields.status } : {}),
  ...(fields.isActive !== undefined ? { isActive: fields.isActive } : {}),
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

  // A disabled reason (overage_not_provisioned, org_level_disabled, ...)
  // means the account has no "extra usage" at all — Claude still reports
  // overageStatus: "rejected" for those, which would render a scary but
  // meaningless red "limit" row. Suppress the window entirely, and scrub one
  // accumulated before the disabled reason was first seen. A rejected status
  // WITHOUT a disabled reason is real (provisioned overage, exhausted) and
  // stays visible.
  const overageDisabled = info.overageDisabledReason !== undefined;
  const hasOverageSignal =
    info.isUsingOverage === true ||
    info.overageInUse === true ||
    info.overageStatus !== undefined ||
    info.overageResetsAt !== undefined;
  if (overageDisabled) {
    nextWindows = nextWindows.filter((window) => window.kind !== "overage");
  } else if (hasOverageSignal) {
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

/** `session` -> 5h, `weekly` -> 7d. Unknown/missing groups omit the field (safe: display falls back to KIND_LABEL/humanized kind client-side). */
const CLAUDE_PULL_GROUP_DURATION_MINS: Readonly<Record<string, number>> = {
  session: 300,
  weekly: 10_080,
};

/** Lowercase, non-alphanumeric runs -> `_`, collapse/trim. Small enough not to warrant a shared dependency. */
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const isParsableIsoString = (value: unknown): value is string =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

/** `severity` -> window status, per the spec's substring rules. Unmatched strings omit the field (percent-derived severity still renders correctly downstream). */
const asClaudePullWindowStatus = (
  severity: unknown,
): ServerProviderRateLimitWindowStatus | undefined => {
  if (typeof severity !== "string") {
    return undefined;
  }
  const normalized = severity.toLowerCase();
  if (normalized === "normal") {
    return "allowed";
  }
  if (normalized.includes("warn")) {
    return "allowed_warning";
  }
  if (
    ["critical", "exceeded", "rejected", "blocked"].some((needle) => normalized.includes(needle))
  ) {
    return "rejected";
  }
  return undefined;
};

/** One `payload.limits[]` entry -> a window, or `undefined` when malformed (missing/empty `kind`, non-finite `percent`). */
const buildWindowFromClaudePullLimitsEntry = (
  entry: unknown,
): ServerProviderRateLimitWindow | undefined => {
  if (!isRecord(entry) || !isNonEmptyString(entry.kind) || !isFiniteNumber(entry.percent)) {
    return undefined;
  }

  const scope = isRecord(entry.scope) ? entry.scope : undefined;
  const model = scope && isRecord(scope.model) ? scope.model : undefined;
  const displayName =
    model && isNonEmptyString(model.display_name) ? model.display_name : undefined;
  // Model-scoped windows get a unique kind so two scoped entries (e.g. a
  // future opus + sonnet pair) never collide under the same base `kind` and
  // silently drop one in `upsertWindow`'s dedup-by-kind map.
  const kind = displayName ? `${entry.kind}_${slugify(displayName)}` : entry.kind;

  const group = isNonEmptyString(entry.group) ? entry.group : undefined;

  return buildWindow(kind, {
    usedPercent: entry.percent,
    resetsAt: isParsableIsoString(entry.resets_at) ? entry.resets_at : undefined,
    windowDurationMins: group ? CLAUDE_PULL_GROUP_DURATION_MINS[group] : undefined,
    status: asClaudePullWindowStatus(entry.severity),
    // Only an explicit false is meaningful: Anthropic marks non-binding
    // limits (e.g. an exhausted model-scoped weekly whose usage spills into
    // the open general weekly) with is_active: false, and the UI must not
    // paint those critical off raw percent.
    isActive: entry.is_active === false ? false : undefined,
  });
};

/** Top-level `payload.five_hour`/`payload.seven_day` -> a window, used only when `limits` is absent/not-an-array/empty. */
const buildWindowFromClaudePullTopLevelUsage = (
  kind: string,
  windowDurationMins: number,
  raw: unknown,
): ServerProviderRateLimitWindow | undefined => {
  if (!isRecord(raw) || !isFiniteNumber(raw.utilization)) {
    return undefined;
  }
  return buildWindow(kind, {
    usedPercent: raw.utilization,
    resetsAt: isParsableIsoString(raw.resets_at) ? raw.resets_at : undefined,
    windowDurationMins,
  });
};

/**
 * `payload.extra_usage` -> a credits label, only when `is_enabled === true`
 * (mirrors the existing `overageDisabledReason` "disabled renders nothing"
 * precedent for the Claude event branch). `payload.spend` is available in
 * the live response but intentionally not mapped here — out of scope.
 */
const deriveClaudePullCreditsLabel = (extraUsage: unknown): string | undefined => {
  if (!isRecord(extraUsage) || extraUsage.is_enabled !== true) {
    return undefined;
  }
  const used = extraUsage.used_credits;
  const limit = extraUsage.monthly_limit;
  if (isFiniteNumber(used) && isFiniteNumber(limit)) {
    return `Extra usage: ${used}/${limit}`;
  }
  return "Extra usage: enabled";
};

/**
 * Normalize one raw `GET /api/oauth/usage` response body into windows +
 * labels. `limits[]` is primary when present and non-empty; the top-level
 * `five_hour`/`seven_day` objects are the fallback. Returns `undefined` when
 * neither source yields any usable window (e.g. `limits` was present but
 * every entry was malformed and the fallback objects were also unusable) —
 * callers should keep `previous` unchanged in that case rather than
 * replacing it with an empty snapshot. `planLabel` is intentionally never
 * set: nothing in the observed response maps to a plan-name string.
 */
export const normalizeClaudeUsagePullPayload = (
  payload: Record<string, unknown>,
):
  | { windows: ServerProviderRateLimitWindow[]; planLabel?: string; creditsLabel?: string }
  | undefined => {
  let windows: ReadonlyArray<ServerProviderRateLimitWindow> = [];

  const limits = payload.limits;
  if (Array.isArray(limits) && limits.length > 0) {
    for (const entry of limits) {
      const window = buildWindowFromClaudePullLimitsEntry(entry);
      if (window) {
        windows = upsertWindow(windows, window);
      }
    }
  } else {
    const fiveHour = buildWindowFromClaudePullTopLevelUsage("five_hour", 300, payload.five_hour);
    if (fiveHour) {
      windows = upsertWindow(windows, fiveHour);
    }
    const sevenDay = buildWindowFromClaudePullTopLevelUsage("seven_day", 10_080, payload.seven_day);
    if (sevenDay) {
      windows = upsertWindow(windows, sevenDay);
    }
  }

  if (windows.length === 0) {
    return undefined;
  }

  const creditsLabel = deriveClaudePullCreditsLabel(payload.extra_usage);
  return {
    windows: [...windows],
    ...(creditsLabel !== undefined ? { creditsLabel } : {}),
  };
};

/**
 * `payload.currentPeriod.end` -> a monthly window's `resetsAt`, when present
 * and a parseable ISO string. `currentPeriod` also carries a `month` field
 * per the field names observed in the `grok` binary, which nothing here maps
 * (no target in `ServerProviderRateLimitWindow`).
 */
const buildGrokMonthlyWindow = (
  payload: Record<string, unknown>,
): ServerProviderRateLimitWindow | undefined => {
  if (!isFiniteNumber(payload.creditUsagePercent)) {
    return undefined;
  }
  const currentPeriod = isRecord(payload.currentPeriod) ? payload.currentPeriod : undefined;
  const resetsAt =
    currentPeriod && isParsableIsoString(currentPeriod.end) ? currentPeriod.end : undefined;
  // Don't assume the billing cycle is monthly: derive the window length from
  // the period itself when both bounds parse, so a tier whose allowance runs
  // on a weekly cycle labels itself "Week" (the UI's duration tier wins over
  // the kind map). The "monthly" kind remains only the no-period fallback.
  const startMs =
    currentPeriod && isParsableIsoString(currentPeriod.start)
      ? Date.parse(currentPeriod.start)
      : undefined;
  const endMs = resetsAt !== undefined ? Date.parse(resetsAt) : undefined;
  const windowDurationMins =
    startMs !== undefined && endMs !== undefined && endMs > startMs
      ? Math.round((endMs - startMs) / 60_000)
      : undefined;
  return buildWindow("monthly", {
    usedPercent: payload.creditUsagePercent,
    resetsAt,
    windowDurationMins,
  });
};

/**
 * Normalize one raw `GET /billing?format=credits` response body into a
 * single `"monthly"` window + plan label. Returns `undefined` when
 * `creditUsagePercent` is missing or not a finite number — callers should
 * keep `previous` unchanged in that case rather than replacing it with an
 * empty snapshot.
 *
 * `creditsLabel` is intentionally never set here: the response's
 * `prepaidBalance` field (dollars? cents? "ticks"?) has no confirmed unit —
 * this environment's billing endpoint was unreachable at authoring time, so
 * there was no live payload to check against. Rendering a wrong-by-100x
 * dollar figure is worse than omitting the label, so it's left unmapped
 * pending a captured response.
 */
export const normalizeGrokBillingPayload = (
  payload: Record<string, unknown>,
):
  | { windows: ServerProviderRateLimitWindow[]; planLabel?: string; creditsLabel?: string }
  | undefined => {
  const window = buildGrokMonthlyWindow(payload);
  if (!window) {
    return undefined;
  }

  const planLabel = isNonEmptyString(payload.subscription_tier)
    ? capitalize(payload.subscription_tier)
    : undefined;

  return {
    windows: [window],
    ...(planLabel !== undefined ? { planLabel } : {}),
  };
};

/**
 * `payload.retry_state` -> a sparse `"weekly"` window patch, or `undefined`
 * when the object doesn't carry a truthy rate-limited signal. Accepts both
 * the snake_case field names extracted from the `grok` binary's embedded
 * serde strings (`is_rate_limited`, `exhausted`) and a camelCase fallback,
 * since this environment never captured a live payload to confirm wire
 * casing. Only `exhausted && is_rate_limited` both true counts as the
 * signal: a `retry_state` seen mid-backoff (rate-limited but still retrying)
 * is not yet a confirmed "you hit your weekly limit" rejection — see
 * `xAiRetryStateIsWeeklyLimitSignal` in `XAiAcpExtension.ts`, which applies
 * the same gate before `GrokAdapter` ever emits this shape. `resetsAt` is
 * never set: xAI's `RetryState` carries no reset timestamp.
 */
const normalizeGrokRetryStateSignal = (raw: unknown): WindowFields | undefined => {
  if (!isRecord(raw)) {
    return undefined;
  }
  const isRateLimited = raw.is_rate_limited ?? raw.isRateLimited;
  if (isRateLimited !== true) {
    return undefined;
  }
  return { status: "rejected" };
};

/**
 * `payload.meta` -> an empty-windows snapshot plus a plan label, or
 * `undefined` when `subscription_tier` is missing/empty (garbled response —
 * callers should keep `previous` unchanged rather than replacing it with a
 * blank snapshot). `subscription_tier` is used verbatim, NOT capitalized
 * like the shape-3 billing branch's `subscription_tier` — this field arrives
 * already display-cased from `check_subscription` (e.g. `"SuperGrok"`,
 * observed live), unlike billing's lowercase enum (`"supergrok"`). The team
 * name is appended when non-empty (`"SuperGrok · BnC"`); `team_id` and
 * `email` are never read here — they have no display value and one is PII.
 */
const normalizeGrokSubscriptionPayload = (
  meta: Record<string, unknown>,
): { windows: ServerProviderRateLimitWindow[]; planLabel?: string } | undefined => {
  if (!isNonEmptyString(meta.subscription_tier)) {
    return undefined;
  }
  const planLabel = isNonEmptyString(meta.team_name)
    ? `${meta.subscription_tier} · ${meta.team_name}`
    : meta.subscription_tier;
  return { windows: [], planLabel };
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

  // Shape 2.5: Claude pull — the raw `GET /api/oauth/usage` response body,
  // fed by `ClaudeUsagePoller`. Detected structurally (never solely by
  // `provider`): `limits` is an array, or a top-level `five_hour`/`seven_day`
  // object carries a finite `utilization`. Authoritative and replaces the
  // whole snapshot (see the module doc comment and
  // `normalizeClaudeUsagePullPayload`'s doc comment for why); a payload that
  // fails to yield any usable window falls back to `previous` unchanged so
  // one garbled poll can't wipe good data.
  const isClaudeUsagePullShape =
    Array.isArray(payload.limits) ||
    (isRecord(payload.five_hour) && isFiniteNumber(payload.five_hour.utilization)) ||
    (isRecord(payload.seven_day) && isFiniteNumber(payload.seven_day.utilization));
  if (isClaudeUsagePullShape) {
    const normalized = normalizeClaudeUsagePullPayload(payload);
    if (normalized === undefined) {
      return previous;
    }
    return {
      observedAt,
      windows: normalized.windows,
      ...(normalized.planLabel !== undefined ? { planLabel: normalized.planLabel } : {}),
      ...(normalized.creditsLabel !== undefined ? { creditsLabel: normalized.creditsLabel } : {}),
    };
  }

  // Shape 3: Grok billing — the raw ACP `x.ai/billing` response body, read
  // per-session by `GrokAdapter` (see `grokUsage.readGrokBillingOverAcp`).
  // Detected structurally by the presence of `creditUsagePercent` or
  // `currentPeriod` (field names unique to this shape). Authoritative and
  // replaces the whole snapshot with a single
  // `"monthly"` window (see the module doc comment and
  // `normalizeGrokBillingPayload`'s doc comment for why); a payload that
  // fails to yield a usable window falls back to `previous` unchanged so one
  // garbled poll can't wipe good data.
  // The live agent wraps the billing body one level deeper than the raw
  // backend response: `{ config: { creditUsagePercent, ... } }` (verified
  // against `_x.ai/billing` on grok agent stdio). Unwrap before detecting.
  const grokBillingBody =
    isRecord(payload.config) &&
    ("creditUsagePercent" in payload.config || "currentPeriod" in payload.config)
      ? payload.config
      : payload;
  const isGrokBillingShape =
    "creditUsagePercent" in grokBillingBody || "currentPeriod" in grokBillingBody;
  if (isGrokBillingShape) {
    const normalized = normalizeGrokBillingPayload(grokBillingBody);
    if (normalized === undefined) {
      return previous;
    }
    return {
      observedAt,
      windows: normalized.windows,
      ...(normalized.planLabel !== undefined ? { planLabel: normalized.planLabel } : {}),
      ...(normalized.creditsLabel !== undefined ? { creditsLabel: normalized.creditsLabel } : {}),
    };
  }

  // Shape 4: flat fallback — `{ primary, secondary }` directly.
  if ("primary" in payload || "secondary" in payload) {
    return normalizeCodexSnapshot(previous, observedAt, payload);
  }

  // Shape 5: Grok weekly-limit session signal — `{ retry_state: {...} }`,
  // synthesized by `GrokAdapter` from xAI's in-session `RetryState` signal
  // (see the module doc comment and `normalizeGrokRetryStateSignal`'s doc
  // comment for why this is additive rather than authoritative-replace like
  // shape 3). A `retry_state` object that doesn't carry a confirmed
  // rate-limited signal falls back to `previous` unchanged.
  if (isRecord(payload.retry_state)) {
    const patch = normalizeGrokRetryStateSignal(payload.retry_state);
    if (patch === undefined) {
      return previous;
    }
    const windows = upsertWindow(previous?.windows ?? [], buildWindow("weekly", patch));
    return {
      observedAt,
      windows,
      ...(previous?.planLabel !== undefined ? { planLabel: previous.planLabel } : {}),
      ...(previous?.creditsLabel !== undefined ? { creditsLabel: previous.creditsLabel } : {}),
    };
  }

  // Shape 6: Grok subscription fallback — the raw ACP
  // `x.ai/auth/check_subscription` response body, read by `GrokAdapter`
  // only when that poll's shape-3 billing read came back empty (see the
  // module doc comment and `normalizeGrokSubscriptionPayload`'s doc comment
  // for the field mapping). Detected structurally by a top-level
  // `authenticated` field alongside a `meta` object carrying
  // `subscription_tier` (never solely by `provider`). A `meta` that fails to
  // yield a usable plan label falls back to `previous` unchanged. This
  // shape carries no quota data at all, so — unlike shape 3 — it must never
  // downgrade a `previous` snapshot that already has real windows (a
  // working billing read, or a weekly-limit signal riding on top of one):
  // when `previous.windows` is non-empty, those windows are kept as-is and
  // only the labels refresh.
  const grokSubscriptionMeta = isRecord(payload.meta) ? payload.meta : undefined;
  const isGrokSubscriptionShape =
    "authenticated" in payload &&
    grokSubscriptionMeta !== undefined &&
    "subscription_tier" in grokSubscriptionMeta;
  if (isGrokSubscriptionShape && grokSubscriptionMeta !== undefined) {
    const normalized = normalizeGrokSubscriptionPayload(grokSubscriptionMeta);
    if (normalized === undefined) {
      return previous;
    }
    const windows =
      previous?.windows !== undefined && previous.windows.length > 0
        ? previous.windows
        : normalized.windows;
    return {
      observedAt,
      windows,
      ...(normalized.planLabel !== undefined ? { planLabel: normalized.planLabel } : {}),
    };
  }

  return previous;
};
