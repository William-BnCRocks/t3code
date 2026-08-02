import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  formatUsagePercent,
  usageSeverityColor,
  type UsageEnvironmentView,
  type UsageInstanceView,
  type UsageOverview,
  type UsageSeverity,
  type UsageWindowView,
} from "~/providerUsage";
import { formatRelativeTimeLabel, formatRelativeTimeUntil } from "~/timestampFormat";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Spinner } from "../ui/spinner";

const CLAUDE_AGENT_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

export interface ProviderUsagePanelProps {
  overview: UsageOverview;
  isLoading: boolean;
  /**
   * The active thread's environment + provider instance, used only to draw
   * the accent rail on that row (§4.4). Omitted by the global fallback
   * overlay shell, which has no notion of an "active" thread.
   */
  activeEnvironmentId?: EnvironmentId | undefined;
  activeInstanceId?: ProviderInstanceId | undefined;
}

function toneClassForSeverity(severity: UsageSeverity): string {
  switch (severity) {
    case "critical":
      return "text-destructive";
    case "warning":
      return "text-warning";
    case "ok":
      return "text-muted-foreground/70";
  }
}

function connectionDotClasses(phase: EnvironmentConnectionPhase): {
  dotClassName: string;
  pingClassName: string | null;
} {
  // Ladder copied from ConnectionsSettings.tsx:1312-1319/1373-1377.
  if (phase === "connected") return { dotClassName: "bg-success", pingClassName: null };
  if (phase === "connecting" || phase === "reconnecting") {
    return { dotClassName: "bg-warning", pingClassName: "bg-warning/60 duration-2000" };
  }
  if (phase === "error") return { dotClassName: "bg-destructive", pingClassName: null };
  return { dotClassName: "bg-muted-foreground/40", pingClassName: null };
}

function phaseWord(phase: EnvironmentConnectionPhase): string {
  switch (phase) {
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return "Offline";
    case "error":
      return "Error";
    case "available":
      return "Waiting";
    case "connected":
      return "";
  }
}

function buildHeaderSummary(overview: UsageOverview) {
  if (!overview.showEnvironmentChrome && overview.environments[0]) {
    return (
      <div className="text-[11px] text-muted-foreground/60">{overview.environments[0].label}</div>
    );
  }
  if (!overview.worst) return null;
  const { window, usedPercent, severity } = overview.worst;
  const valueText =
    window.status === "rejected"
      ? "limit"
      : usedPercent !== null
        ? formatUsagePercent(usedPercent)
        : "";
  const resetSuffix =
    window.resetsAt && !window.isExpired ? formatRelativeTimeUntil(window.resetsAt)?.value : null;
  return (
    <div className={cn("text-[11px] tabular-nums", toneClassForSeverity(severity))}>
      {window.label} {valueText}
      {resetSuffix ? ` · resets ${resetSuffix}` : ""}
    </div>
  );
}

function WindowRow({ window }: { window: UsageWindowView }) {
  const tone = toneClassForSeverity(window.severity);
  const isRejected = window.status === "rejected";
  const barColor = isRejected ? "var(--color-red-500)" : usageSeverityColor(window.severity);
  const barWidthPercent = isRejected ? 100 : Math.max(0, Math.min(100, window.usedPercent ?? 0));
  const valueText = isRejected
    ? "limit"
    : window.usedPercent !== null
      ? formatUsagePercent(window.usedPercent)
      : "—";
  const valueTone = isRejected ? "text-destructive" : tone;
  const resetRelative = window.resetsAt
    ? (formatRelativeTimeUntil(window.resetsAt)?.value ?? "")
    : "";
  const resetText = window.isExpired ? "reset" : resetRelative;

  return (
    <div className={cn("flex h-4 items-center gap-2", window.isExpired && "opacity-40")}>
      <span className={cn("w-14 shrink-0 truncate text-[11px] leading-4", tone)}>
        {window.label}
      </span>
      <div
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(barWidthPercent)}
        aria-label={window.longLabel}
      >
        <div
          className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${barWidthPercent}%`, backgroundColor: barColor }}
        />
      </div>
      <span className={cn("w-8 shrink-0 text-right text-[11px] leading-4 tabular-nums", valueTone)}>
        {valueText}
      </span>
      <span
        className={cn(
          "w-11 shrink-0 text-right text-[10px] leading-4 tabular-nums",
          window.isExpired ? "text-muted-foreground/45" : "text-muted-foreground/50",
        )}
      >
        {resetText}
      </span>
    </div>
  );
}

function AbsentHint({ instance }: { instance: UsageInstanceView }) {
  const hint =
    instance.driverKind === CLAUDE_AGENT_DRIVER_KIND
      ? "No limits reported yet — Claude reports them while a turn runs."
      : "No limits reported yet — run a turn.";
  return <p className="text-[11px] leading-4 text-muted-foreground/55">{hint}</p>;
}

function InstanceBlock({ instance, isActive }: { instance: UsageInstanceView; isActive: boolean }) {
  const isRejected = instance.windows.some((window) => window.status === "rejected");
  const observedRelative = instance.observedAt
    ? formatRelativeTimeLabel(instance.observedAt)
    : null;

  return (
    <div className={cn("space-y-1", isActive && "relative")}>
      {isActive ? (
        <span className="absolute inset-y-0 left-0 w-0.5 rounded-r-full bg-primary" aria-hidden />
      ) : null}
      <div className="flex items-center gap-1.5">
        <ProviderInstanceIcon
          driverKind={instance.driverKind}
          displayName={instance.displayName}
          accentColor={instance.accentColor}
          className="size-4"
          iconClassName="size-4"
          badgeContent="none"
          showBadge={false}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {instance.displayName}
        </span>
        {isRejected ? (
          <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-destructive" />
        ) : null}
        {observedRelative ? (
          <span
            className={cn(
              "shrink-0 text-[10px] tabular-nums",
              instance.isStale ? "text-warning/80" : "text-muted-foreground/60",
            )}
          >
            {observedRelative}
          </span>
        ) : null}
      </div>
      {instance.state === "unauthenticated" ? (
        <p className="text-[11px] leading-4 text-warning/80">Not authenticated</p>
      ) : instance.state === "absent" ? (
        <AbsentHint instance={instance} />
      ) : (
        <>
          <div className={cn("space-y-1", instance.isStale && "opacity-60")}>
            {instance.windows.map((window) => (
              <WindowRow key={window.kind} window={window} />
            ))}
          </div>
          {instance.extras.length > 0 ? (
            <div className="text-[10px] text-muted-foreground/50">
              {instance.extras.join(" · ")}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function EnvironmentHeader({ environment }: { environment: UsageEnvironmentView }) {
  const { dotClassName, pingClassName } = connectionDotClasses(environment.phase);
  return (
    <div className="flex min-h-5 items-center gap-1.5">
      <ConnectionStatusDot
        tooltipText={environment.statusText}
        dotClassName={dotClassName}
        pingClassName={pingClassName}
      />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
        {environment.label}
      </span>
      {!environment.isReachable ? (
        <span className="shrink-0 text-[10px] text-muted-foreground/60">
          {phaseWord(environment.phase)}
        </span>
      ) : null}
    </div>
  );
}

function EnvironmentGroup({
  environment,
  showChrome,
  isActiveEnvironment,
  activeInstanceId,
}: {
  environment: UsageEnvironmentView;
  showChrome: boolean;
  isActiveEnvironment: boolean;
  activeInstanceId: ProviderInstanceId | undefined;
}) {
  // §5 rule 8: available/offline/error environments collapse to a status
  // line — instance rows are not rendered at all.
  const isDisconnected =
    environment.phase === "available" ||
    environment.phase === "offline" ||
    environment.phase === "error";
  // §5 rule 9: connecting/reconnecting keeps last-known rows, dimmed.
  const isConnectingPhase =
    environment.phase === "connecting" || environment.phase === "reconnecting";

  return (
    <section className="space-y-2 py-2 first:pt-0 last:pb-0">
      {showChrome ? <EnvironmentHeader environment={environment} /> : null}
      {isDisconnected ? (
        <p className="text-[11px] text-muted-foreground/55">{environment.statusText}</p>
      ) : environment.instances.length === 0 ? (
        <p className="text-[11px] leading-4 text-muted-foreground/55">
          No provider usage reported yet.
        </p>
      ) : (
        <div className={cn("space-y-2", isConnectingPhase && "opacity-50")}>
          {environment.instances.map((instance) => (
            <InstanceBlock
              key={instance.instanceId}
              instance={instance}
              isActive={isActiveEnvironment && instance.instanceId === activeInstanceId}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function ProviderUsagePanel(props: ProviderUsagePanelProps) {
  const { overview, isLoading, activeEnvironmentId, activeInstanceId } = props;
  // Single tick, shared by every relative-time label in the panel.
  useRelativeTimeTick(30_000);

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-muted-foreground text-xs">Provider usage</div>
        {buildHeaderSummary(overview)}
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
          <Spinner className="size-3.5" />
          Waiting for connections…
        </div>
      ) : !overview.hasAnyData ? (
        <>
          <p className="text-xs text-muted-foreground/60">No provider usage reported yet.</p>
          <p className="text-[11px] text-muted-foreground/45">
            Limits appear once a provider runs a turn.
          </p>
        </>
      ) : (
        <div className="divide-y divide-border/60">
          {overview.environments.map((environment) => (
            <EnvironmentGroup
              key={environment.environmentId}
              environment={environment}
              showChrome={overview.showEnvironmentChrome}
              isActiveEnvironment={environment.environmentId === activeEnvironmentId}
              activeInstanceId={activeInstanceId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
