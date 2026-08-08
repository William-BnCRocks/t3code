import { type EnvironmentId, type ProviderInstanceId } from "@t3tools/contracts";
import { useEffect } from "react";

import { cn } from "~/lib/utils";
import {
  formatUsagePercent,
  isUsageOverviewLoading,
  selectScopedWorst,
  useProviderUsageOverview,
  type UsageWorstCandidate,
} from "~/providerUsage";
import { useProviderUsageOverlayStore } from "~/providerUsageOverlayStore";
import { useEnvironments } from "~/state/environments";
import { formatRelativeTimeUntilLabel } from "~/timestampFormat";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderUsagePanel } from "./ProviderUsagePanel";
import { ProviderUsageRing } from "./ProviderUsageRing";

export interface ProviderUsageMeterProps {
  environmentId?: EnvironmentId | undefined;
  /**
   * The active thread's provider instance. Drives the 1px accent rail on
   * that instance's row inside the panel (§4.4), AND scopes the trigger
   * ring/aria-label to this instance's own worst window via
   * `selectScopedWorst` — a maxed account on another provider or instance
   * must never paint this chat's ring red. Composer-shell only; the global
   * fallback overlay never has an "active" instance, so it keeps rendering
   * the overview-wide worst.
   */
  activeInstanceId?: ProviderInstanceId | undefined;
}

function buildTriggerAriaLabel(worst: UsageWorstCandidate | null, isLoading: boolean): string {
  if (isLoading || !worst) {
    return "Provider usage: no limits reported yet";
  }
  const { instance, window, usedPercent } = worst;
  const resetsClause = window.resetsAt
    ? `, resets ${formatRelativeTimeUntilLabel(window.resetsAt)}`
    : "";
  if (window.status === "rejected") {
    return `Provider usage: ${instance.displayName} ${window.longLabel} limit reached${resetsClause}`;
  }
  const pctLabel = usedPercent !== null ? formatUsagePercent(usedPercent) : "0%";
  return `Provider usage: ${instance.displayName} ${window.longLabel} ${pctLabel} used${resetsClause}`;
}

export function ProviderUsageMeter(props: ProviderUsageMeterProps) {
  const overview = useProviderUsageOverview();
  const { isReady } = useEnvironments();
  const registerTrigger = useProviderUsageOverlayStore((state) => state.registerTrigger);
  const isOpen = useProviderUsageOverlayStore((state) => state.isOpen);
  const setOpen = useProviderUsageOverlayStore((state) => state.setOpen);

  useEffect(() => registerTrigger(), [registerTrigger]);

  if (!overview.hasAnyData) {
    return null;
  }

  const isLoading = isUsageOverviewLoading(overview, isReady);
  const worst = selectScopedWorst(overview, props.environmentId, props.activeInstanceId);
  const ariaLabel = buildTriggerAriaLabel(worst, isLoading);

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "relative inline-flex size-7 cursor-pointer items-center justify-center rounded-full border border-transparent text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              isLoading && "text-muted-foreground/50",
            )}
            aria-label={ariaLabel}
          >
            <ProviderUsageRing
              usedPercent={isLoading ? null : (worst?.usedPercent ?? null)}
              severity={isLoading ? "ok" : (worst?.severity ?? "ok")}
              driverKind={isLoading ? null : (worst?.instance.driverKind ?? null)}
              displayName={isLoading ? null : (worst?.instance.displayName ?? null)}
            />
            {!isLoading && worst?.window.status === "rejected" ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -right-0.5 -top-0.5 size-2 rounded-full bg-destructive"
                style={{ boxShadow: "0 0 0 2px var(--card)" }}
              />
            ) : null}
          </button>
        }
      />
      <PopoverPopup
        side="top"
        align="end"
        sideOffset={8}
        className="dropdown-glass w-80 max-w-none p-0"
        viewportClassName="max-h-[min(26rem,var(--available-height))] p-0 [--viewport-inline-padding:0px]"
      >
        <ProviderUsagePanel
          overview={overview}
          isLoading={isLoading}
          activeEnvironmentId={props.environmentId}
          activeInstanceId={props.activeInstanceId}
        />
      </PopoverPopup>
    </Popover>
  );
}
