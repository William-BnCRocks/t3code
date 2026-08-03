/**
 * Provider usage overlay — pure derivation layer.
 *
 * Projects the wire `ServerProvider.rateLimits` snapshots (one per configured,
 * enabled, available instance) into a view model the usage ring/panel can
 * render directly: environment -> instance -> window, plus a single "worst"
 * candidate used to color the composer-footer summary ring.
 *
 * Mirrors the instance-projection pattern in `providerInstances.ts` and the
 * environment-enumeration pattern in `ProviderUpdateLaunchNotification.environments.ts`,
 * widened to every catalog environment (remote backends included).
 *
 * @module providerUsage
 */
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderRateLimitWindow,
  ServerProviderRateLimitWindowStatus,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { deriveEnvironmentDisplayLabel } from "./components/ProviderUpdateLaunchNotification.logic";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "./providerInstances";
import { useEnvironments, usePrimaryEnvironmentId } from "./state/environments";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/** Instance data older than this is dimmed but still counted (usage is monotonic). */
export const USAGE_STALE_AFTER_MS = 30 * 60_000;
export const USAGE_WARNING_PERCENT = 75;
/** Matches ContextWindowMeter's `isOverloaded` boundary (strictly greater than). */
export const USAGE_CRITICAL_PERCENT = 90;

/**
 * Ring/bar fill color per severity (§4.6). "ok" is byte-identical to
 * ContextWindowMeter's non-overloaded color; "critical" is byte-identical to
 * its overloaded color. "warning" is new for this overlay's 75-90 band.
 */
export function usageSeverityColor(severity: UsageSeverity): string {
  switch (severity) {
    case "critical":
      return "var(--color-red-500)";
    case "warning":
      return "var(--color-warning)";
    case "ok":
      return "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
  }
}

// ----------------------------------------------------------------------------
// View types
// ----------------------------------------------------------------------------

export type UsageSeverity = "ok" | "warning" | "critical";

export interface UsageWindowView {
  readonly kind: string;
  readonly label: string;
  readonly longLabel: string;
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
  readonly isExpired: boolean;
  readonly status: ServerProviderRateLimitWindowStatus | null;
  readonly severity: UsageSeverity;
}

export interface UsageInstanceView {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly state: "ok" | "absent" | "unauthenticated";
  readonly observedAt: string | null;
  readonly isStale: boolean;
  readonly windows: readonly UsageWindowView[];
  readonly worst: UsageWindowView | null;
  readonly extras: readonly string[];
}

export interface UsageEnvironmentView {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly phase: EnvironmentConnectionPhase;
  readonly statusText: string;
  readonly isReachable: boolean;
  readonly instances: readonly UsageInstanceView[];
}

export interface UsageWorstCandidate {
  readonly severity: UsageSeverity;
  readonly usedPercent: number | null;
  readonly window: UsageWindowView;
  readonly instance: UsageInstanceView;
  readonly environment: UsageEnvironmentView;
}

export interface UsageOverview {
  readonly environments: readonly UsageEnvironmentView[];
  readonly showEnvironmentChrome: boolean;
  readonly worst: UsageWorstCandidate | null;
  readonly hasAnyData: boolean;
  /**
   * The primary environment's `ServerConfig.usageLogDir`, if it reported
   * one. Only ever sourced from the primary/local environment — a remote
   * backend's usage log lives on a different machine, so its directory is
   * never surfaced here even if present on that environment's input.
   */
  readonly usageLogDir: string | undefined;
}

/** Plain-object environment input, decoupled from the atom-backed presentation type so derivation stays unit-testable. */
export interface UsageEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPrimary: boolean;
  readonly phase: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly usageLogDir?: string | undefined;
}

// ----------------------------------------------------------------------------
// Window label resolution
// ----------------------------------------------------------------------------

const KIND_LABEL: Readonly<Record<string, string>> = {
  five_hour: "5h",
  seven_day: "Week",
  seven_day_opus: "Week",
  seven_day_sonnet: "Week",
  session: "5h",
  weekly: "Week",
  weekly_all: "Week",
  weekly_scoped: "Week",
  overage: "Overage",
  primary: "5h",
  secondary: "Week",
};

const KIND_LONG_LABEL: Readonly<Record<string, string>> = {
  five_hour: "5 hour window",
  seven_day: "Weekly window",
  seven_day_opus: "Weekly window",
  seven_day_sonnet: "Weekly window",
  session: "5 hour window",
  weekly: "Weekly window",
  weekly_all: "Weekly window",
  weekly_scoped: "Weekly window",
  overage: "Overage",
  primary: "5 hour window",
  secondary: "Weekly window",
};

/**
 * Splits a window `kind` slug into title-cased words, mirroring
 * `humanizeInstanceId` (providerInstances.ts:96) but for rate-limit window
 * kinds rather than instance ids.
 */
function humanizeWindowKind(kind: string): string {
  const words: string[] = [];
  for (const token of kind
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")) {
    if (token.length === 0) continue;
    words.push(token.charAt(0).toUpperCase() + token.slice(1));
  }
  return words.join(" ");
}

/**
 * Model qualifier for kinds that only differ by an `_opus`/`_sonnet` suffix
 * (e.g. `seven_day_opus` vs `seven_day_sonnet`, which both resolve to the
 * same base "Week" label via `KIND_LABEL`). Only applied when the base label
 * came from the duration- or kind-map tiers — the humanized fallback tier
 * already spells the qualifier out as a word, so appending it there would
 * duplicate it (e.g. "Custom Window Opus · Opus").
 */
// Order matters: longer bases first so `weekly_scoped_fable` matches
// `weekly_scoped` (qualifier "Fable") before the bare `weekly` base would
// claim `scoped_fable`. `weekly_all`/`weekly_scoped`/`session` are the kinds
// the live oauth/usage endpoint actually reports (verified from captured
// responses); the `five_hour`/`seven_day` family comes from the SDK's
// passive event stream.
const QUALIFIER_BASE_KINDS = [
  "weekly_scoped",
  "weekly",
  "five_hour",
  "seven_day",
  "session",
  "primary",
  "secondary",
] as const;

function modelQualifierSuffix(kind: string): string | null {
  for (const base of QUALIFIER_BASE_KINDS) {
    const prefix = `${base}_`;
    if (kind.startsWith(prefix) && kind.length > prefix.length) {
      // Model-scoped windows arrive as `<base>_<slugified model name>`
      // (e.g. seven_day_opus, seven_day_fable_5). Humanize the slug so two
      // otherwise-identical "Week" rows read as "Week · Fable 5" etc.
      const qualifier = kind
        .slice(prefix.length)
        .split("_")
        .filter((token) => token.length > 0)
        .map((token) => `${token.charAt(0).toUpperCase()}${token.slice(1)}`)
        .join(" ");
      return qualifier.length > 0 ? ` · ${qualifier}` : null;
    }
  }
  return null;
}

function withQualifier(
  kind: string,
  base: { readonly label: string; readonly longLabel: string },
): { label: string; longLabel: string } {
  const suffix = modelQualifierSuffix(kind);
  if (!suffix) return { label: base.label, longLabel: base.longLabel };
  return { label: `${base.label}${suffix}`, longLabel: `${base.longLabel}${suffix}` };
}

/**
 * Resolves a window's short (row label, `w-14` truncated) and long
 * (accessible / aria-label) label per the priority order:
 *   1. `windowDurationMins` when present (minutes / hours / days, 7d -> "Week").
 *   2. `KIND_LABEL` lookup for well-known kinds.
 *   3. Humanized `kind` fallback for anything else.
 */
export function resolveWindowLabels(
  kind: string,
  windowDurationMins: number | undefined,
): { label: string; longLabel: string } {
  if (windowDurationMins !== undefined && Number.isFinite(windowDurationMins)) {
    if (windowDurationMins <= 90) {
      const minutes = Math.round(windowDurationMins);
      return withQualifier(kind, {
        label: `${minutes}m`,
        longLabel: `${minutes} minute window`,
      });
    }
    if (windowDurationMins < 1440) {
      const hours = Math.round(windowDurationMins / 60);
      return withQualifier(kind, { label: `${hours}h`, longLabel: `${hours} hour window` });
    }
    const days = Math.round(windowDurationMins / 1440);
    if (days === 7) {
      return withQualifier(kind, { label: "Week", longLabel: "Weekly window" });
    }
    return withQualifier(kind, { label: `${days}d`, longLabel: `${days} day window` });
  }

  const kindLabel = KIND_LABEL[kind];
  if (kindLabel) {
    return withQualifier(kind, { label: kindLabel, longLabel: KIND_LONG_LABEL[kind] ?? kindLabel });
  }

  // Model-scoped kinds (`seven_day_fable_5`) miss the exact-kind map; resolve
  // the base kind's label and let withQualifier append the model name.
  for (const base of QUALIFIER_BASE_KINDS) {
    if (kind.startsWith(`${base}_`) && KIND_LABEL[base]) {
      return withQualifier(kind, {
        label: KIND_LABEL[base],
        longLabel: KIND_LONG_LABEL[base] ?? KIND_LABEL[base],
      });
    }
  }

  const humanized = humanizeWindowKind(kind);
  return { label: humanized, longLabel: humanized };
}

/** Sort order: known duration ascending, unknown-duration after known, overage always last. */
function windowSortKey(window: ServerProviderRateLimitWindow): readonly [number, number] {
  if (window.kind === "overage") return [2, 0];
  if (window.windowDurationMins !== undefined) return [0, window.windowDurationMins];
  return [1, 0];
}

function sortWindows(
  windows: ReadonlyArray<ServerProviderRateLimitWindow>,
): ReadonlyArray<ServerProviderRateLimitWindow> {
  return windows
    .map((window, index) => ({ window, index }))
    .toSorted((a, b) => {
      const [groupA, durationA] = windowSortKey(a.window);
      const [groupB, durationB] = windowSortKey(b.window);
      if (groupA !== groupB) return groupA - groupB;
      if (durationA !== durationB) return durationA - durationB;
      return a.index - b.index;
    })
    .map(({ window }) => window);
}

// ----------------------------------------------------------------------------
// Severity
// ----------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<UsageSeverity, number>> = { ok: 0, warning: 1, critical: 2 };

function severityFromPercent(usedPercent: number | null): UsageSeverity {
  if (usedPercent === null) return "ok";
  if (usedPercent > USAGE_CRITICAL_PERCENT) return "critical";
  if (usedPercent >= USAGE_WARNING_PERCENT) return "warning";
  return "ok";
}

/**
 * Window severity. Checked in this order (matching the state matrix's
 * first-match-wins framing, §5 rules 4/5/6): expired windows are always
 * "ok" and excluded from ranking regardless of a stale `status`; a rejected
 * window is always critical; `allowed_warning` floors the percent-derived
 * severity at "warning" (it can still be promoted to critical by percent);
 * otherwise severity follows the plain percent thresholds.
 */
export function computeWindowSeverity(input: {
  readonly usedPercent: number | null;
  readonly status: ServerProviderRateLimitWindowStatus | null;
  readonly isExpired: boolean;
}): UsageSeverity {
  if (input.isExpired) return "ok";
  if (input.status === "rejected") return "critical";
  const base = severityFromPercent(input.usedPercent);
  if (input.status === "allowed_warning") {
    return base === "critical" ? "critical" : "warning";
  }
  return base;
}

function preferWindow(
  best: UsageWindowView | null,
  candidate: UsageWindowView,
): UsageWindowView | null {
  if (!best) return candidate;
  const bestRank = SEVERITY_RANK[best.severity];
  const candidateRank = SEVERITY_RANK[candidate.severity];
  if (candidateRank !== bestRank) return candidateRank > bestRank ? candidate : best;
  const bestPercent = best.usedPercent ?? -1;
  const candidatePercent = candidate.usedPercent ?? (candidate.status === "rejected" ? 100 : -1);
  return candidatePercent > bestPercent ? candidate : best;
}

// ----------------------------------------------------------------------------
// Derivation
// ----------------------------------------------------------------------------

function deriveWindowView(window: ServerProviderRateLimitWindow, nowMs: number): UsageWindowView {
  const { label, longLabel } = resolveWindowLabels(window.kind, window.windowDurationMins);
  const resetsAt = window.resetsAt ?? null;
  const isExpired = resetsAt !== null && Date.parse(resetsAt) <= nowMs;
  const status = window.status ?? null;
  const usedPercent = window.usedPercent ?? null;
  const severity = computeWindowSeverity({ usedPercent, status, isExpired });
  return {
    kind: window.kind,
    label,
    longLabel,
    usedPercent,
    resetsAt,
    isExpired,
    status,
    severity,
  };
}

function deriveInstanceView(entry: ProviderInstanceEntry, nowMs: number): UsageInstanceView {
  const base = {
    instanceId: entry.instanceId,
    driverKind: entry.driverKind,
    displayName: entry.displayName,
    accentColor: entry.accentColor,
  };

  if (entry.snapshot.auth.status === "unauthenticated") {
    return {
      ...base,
      state: "unauthenticated",
      observedAt: null,
      isStale: false,
      windows: [],
      worst: null,
      extras: [],
    };
  }

  const rateLimits = entry.snapshot.rateLimits;
  if (!rateLimits) {
    return {
      ...base,
      state: "absent",
      observedAt: null,
      isStale: false,
      windows: [],
      worst: null,
      extras: [],
    };
  }

  const observedAtMs = Date.parse(rateLimits.observedAt);
  const isStale = Number.isFinite(observedAtMs) && nowMs - observedAtMs > USAGE_STALE_AFTER_MS;
  // Expired blocks are history, not state: they drop out of the panel
  // entirely (the JSONL usage log keeps them) instead of lingering as dimmed
  // rows beside the block that replaced them.
  const windows = sortWindows(rateLimits.windows)
    .map((window) => deriveWindowView(window, nowMs))
    .filter((window) => !window.isExpired);
  const worst = windows.reduce<UsageWindowView | null>(
    (current, window) => preferWindow(current, window),
    null,
  );

  const extras: string[] = [];
  if (rateLimits.planLabel) extras.push(rateLimits.planLabel);
  if (rateLimits.creditsLabel) extras.push(`Credits: ${rateLimits.creditsLabel}`);

  return {
    ...base,
    state: "ok",
    observedAt: rateLimits.observedAt,
    isStale,
    windows,
    worst,
    extras,
  };
}

function deriveEnvironmentView(
  environment: UsageEnvironmentInput,
  nowMs: number,
): UsageEnvironmentView {
  const isReachable = environment.phase === "connected";
  const statusText = connectionStatusText({
    phase: environment.phase,
    error: environment.connectionError,
    traceId: null,
  });
  const entries = sortProviderInstanceEntries(
    deriveProviderInstanceEntries(environment.providers),
  ).filter((entry) => entry.enabled && entry.isAvailable);
  const instances = entries.map((entry) => deriveInstanceView(entry, nowMs));

  return {
    environmentId: environment.environmentId,
    label: environment.label,
    isPrimary: environment.isPrimary,
    phase: environment.phase,
    statusText,
    isReachable,
    instances,
  };
}

/**
 * Pure projection of local-environment inputs into the usage overview view
 * model. Kept free of atoms/hooks so §3.3-3.4's derivation rules (labels,
 * thresholds, staleness/expiry math, window ordering, worst selection) are
 * unit-testable without a React tree.
 */
export function deriveUsageOverview(
  environments: ReadonlyArray<UsageEnvironmentInput>,
  nowMs: number,
): UsageOverview {
  const environmentViews = environments.map((environment) =>
    deriveEnvironmentView(environment, nowMs),
  );
  const showEnvironmentChrome = environmentViews.length > 1;
  const hasAnyData = environmentViews.some((environment) => environment.instances.length > 0);
  const usageLogDir = environments.find((environment) => environment.isPrimary)?.usageLogDir;

  let worst: UsageWorstCandidate | null = null;
  for (const environment of environmentViews) {
    // Anti-flap: connecting/reconnecting/disconnected/errored environments
    // still render (last-known rows or a status line) but never drive the
    // trigger ring, so it doesn't flicker while a secondary backend settles.
    if (!environment.isReachable) continue;
    for (const instance of environment.instances) {
      if (instance.state !== "ok") continue;
      for (const window of instance.windows) {
        if (window.isExpired) continue;
        const candidateRank = SEVERITY_RANK[window.severity];
        const currentRank = worst ? SEVERITY_RANK[worst.severity] : -1;
        const candidatePercent = window.usedPercent ?? (window.status === "rejected" ? 100 : -1);
        const currentPercent = worst?.usedPercent ?? -1;
        const isBetter =
          !worst || candidateRank !== currentRank
            ? candidateRank > currentRank
            : candidatePercent > currentPercent;
        if (isBetter) {
          worst = {
            severity: window.severity,
            usedPercent: window.usedPercent ?? (window.status === "rejected" ? 100 : null),
            window,
            instance,
            environment,
          };
        }
      }
    }
  }

  return { environments: environmentViews, showEnvironmentChrome, worst, hasAnyData, usageLogDir };
}

/**
 * Percent formatting shared by the ring, trigger aria-label, and window row
 * value column — copied from ContextWindowMeter's `formatPercentage`
 * (sub-10% keeps one decimal, otherwise rounds to a whole number).
 */
export function formatUsagePercent(usedPercent: number): string {
  if (usedPercent < 10) {
    return `${usedPercent.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(usedPercent)}%`;
}

/**
 * §5 rule 1 ("Loading"): the catalog hasn't reported ready yet, or every
 * qualifying environment is still connecting and has surfaced zero
 * instances (i.e. no `serverConfig` has arrived for it yet).
 */
export function isUsageOverviewLoading(overview: UsageOverview, isReady: boolean): boolean {
  if (!isReady) return true;
  if (overview.environments.length === 0) return false;
  return overview.environments.every(
    (environment) => environment.instances.length === 0 && environment.phase !== "connected",
  );
}

// ----------------------------------------------------------------------------
// Hook
// ----------------------------------------------------------------------------

/**
 * Reactive usage overview built from `useEnvironments()`, spanning EVERY
 * catalog environment — the primary backend, desktop-local secondaries, and
 * connected remote backends alike — each projected through
 * `deriveProviderInstanceEntries` + `sortProviderInstanceEntries`.
 * Unlike `ProviderUpdateLaunchNotification`'s local-only grouping, remote
 * environments belong here: their account windows are precisely what the
 * overlay exists to show. Unreachable environments still appear and degrade
 * per the state matrix (status line instead of instance rows).
 * Deliberately does not use `primaryServerProvidersAtom`, which is
 * primary-only and would drop every other environment's usage entirely.
 */
export function useProviderUsageOverview(): UsageOverview {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  return useMemo(() => {
    const inputs: UsageEnvironmentInput[] = [];

    for (const environment of environments) {
      const isPrimary = environment.environmentId === primaryEnvironmentId;
      inputs.push({
        environmentId: environment.environmentId,
        label: isPrimary
          ? deriveEnvironmentDisplayLabel({
              isWsl: false,
              wslDistro: null,
              platformOs: environment.serverConfig?.environment.platform.os,
              fallbackLabel: environment.label,
            })
          : environment.label,
        isPrimary,
        phase: environment.connection.phase,
        connectionError: environment.connection.error,
        providers: environment.serverConfig?.providers ?? [],
        usageLogDir: environment.serverConfig?.usageLogDir,
      });
    }

    // Primary first, then the rest in catalog order (matches
    // useLocalEnvironmentUpdateGroups).
    inputs.sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));

    return deriveUsageOverview(inputs, Date.now());
  }, [environments, primaryEnvironmentId]);
}
