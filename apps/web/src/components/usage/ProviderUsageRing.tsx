import { type ProviderDriverKind } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { usageSeverityColor, type UsageSeverity } from "~/providerUsage";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { providerInstanceInitials } from "../chat/ProviderInstanceIcon";

// Geometry copied from ContextWindowMeter.tsx:22-24,52-79 so the twin rings
// in the composer footer read as one system.
const RADIUS = 9.75;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const TRACK_COLOR = "color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)";

export interface ProviderUsageRingProps {
  /** Null renders a track-only ring (no progress arc). */
  usedPercent: number | null;
  severity: UsageSeverity;
  /** Driver of the worst window's instance, for the centered glyph. Null renders no glyph. */
  driverKind?: ProviderDriverKind | null;
  displayName?: string | null;
  className?: string;
}

export function ProviderUsageRing(props: ProviderUsageRingProps) {
  const { usedPercent, severity, driverKind, displayName, className } = props;
  const normalizedPercent = usedPercent === null ? 0 : Math.max(0, Math.min(100, usedPercent));
  const dashOffset = CIRCUMFERENCE - (normalizedPercent / 100) * CIRCUMFERENCE;
  const color = usageSeverityColor(severity);
  const Icon = driverKind ? (PROVIDER_ICON_BY_PROVIDER[driverKind] ?? null) : null;

  return (
    <span className={cn("relative flex size-5 items-center justify-center", className)}>
      <svg
        viewBox="0 0 24 24"
        className="-rotate-90 absolute inset-0 size-full transform-gpu"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r={RADIUS} fill="none" stroke={TRACK_COLOR} strokeWidth="3" />
        {usedPercent === null ? null : (
          <circle
            cx="12"
            cy="12"
            r={RADIUS}
            fill="none"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
          />
        )}
      </svg>
      {driverKind && displayName ? (
        Icon ? (
          <Icon className="relative size-2.5 shrink-0" aria-hidden />
        ) : (
          <span className="relative text-[7px] font-semibold leading-none text-muted-foreground/70">
            {providerInstanceInitials(displayName).slice(0, 1)}
          </span>
        )
      ) : null}
    </span>
  );
}
