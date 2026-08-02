import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { resolveShortcutCommand } from "~/keybindings";
import { getTerminalFocusOwner } from "~/lib/terminalFocus";
import { isUsageOverviewLoading, useProviderUsageOverview } from "~/providerUsage";
import { useProviderUsageOverlayStore } from "~/providerUsageOverlayStore";
import { useEnvironments } from "~/state/environments";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ProviderUsagePanel } from "./ProviderUsagePanel";

/**
 * Global always-reachable shell for the provider usage overlay (mod+shift+u
 * / command palette), mirroring `apps/web/src/routes/_chat.tsx`'s own
 * window keydown listener: it owns its own capture-phase listener reading
 * `primaryServerKeybindingsAtom`, resolves the shortcut via
 * `resolveShortcutCommand`, and bails while the command palette is open.
 *
 * Renders nothing while a composer `ProviderUsageMeter` trigger is mounted
 * (`triggerCount > 0`) — that trigger owns the popover in that case. When no
 * trigger is mounted (no thread open, or the composer isn't rendered), this
 * is the only way to reach the panel, so it renders its own popover anchored
 * to the bottom-right corner of the viewport.
 *
 * Deviation from §4.1/tree: the spec suggests anchoring to a virtual
 * bottom-right rect via the popover's `anchor` prop. This codebase has no
 * existing example of a base-ui `Popover.Root` driven purely by a virtual
 * anchor with no `Trigger` mounted, and the failure mode (broken focus/
 * dismiss wiring) isn't worth risking sight-unseen. Per the spec's own
 * fallback allowance, this instead mounts a real (invisible, non-interactive)
 * `PopoverTrigger` pinned to the bottom-right corner — same visual anchor
 * point, guaranteed-correct base-ui wiring.
 */
export function ProviderUsageOverlay() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const isOpen = useProviderUsageOverlayStore((state) => state.isOpen);
  const triggerCount = useProviderUsageOverlayStore((state) => state.triggerCount);
  const toggle = useProviderUsageOverlayStore((state) => state.toggle);
  const setOpen = useProviderUsageOverlayStore((state) => state.setOpen);
  const overview = useProviderUsageOverview();
  const { isReady } = useEnvironments();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: getTerminalFocusOwner() !== null },
      });
      if (isCommandPaletteOpen()) return;
      if (command === "providerUsage.toggle") {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
  }, [keybindings, toggle]);

  if (triggerCount > 0) {
    return null;
  }

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none fixed right-3 bottom-3 size-px opacity-0"
          />
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
          isLoading={isUsageOverviewLoading(overview, isReady)}
        />
      </PopoverPopup>
    </Popover>
  );
}
