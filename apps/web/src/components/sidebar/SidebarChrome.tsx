import { ServerIcon, SettingsIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useUiStateStore } from "../../uiStateStore";
import { deriveSidebarMachineToggles } from "../Sidebar.logic";
import { deriveEnvironmentDisplayLabel } from "../ProviderUpdateLaunchNotification.logic";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "[:hover,[data-pressed]]:bg-white/15 focus-visible:ring-white/90 focus-visible:ring-offset-blue-700 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white!",
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 rounded-full px-1.5 text-muted-foreground"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "sidebar-brand relative z-10 ml-[var(--workspace-titlebar-content-left)] h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <T3Wordmark />
      <span
        className={cn(
          "truncate text-sm font-medium tracking-tight",
          onBackdrop ? "text-white/70" : "text-muted-foreground",
        )}
      >
        Code
      </span>
    </Link>
  );
}

function T3Wordmark() {
  return (
    <svg
      aria-label="T3"
      className="h-2.5 w-auto shrink-0"
      viewBox="15.5309 37 94.3941 56.96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-2">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <div className="flex items-center gap-1">
        <SidebarMenu className="min-w-0 flex-1">
          <SidebarMenuItem>
            <SidebarMenuButton onClick={handleSettingsClick}>
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarChromeMachinesMenu />
      </div>
    </SidebarFooter>
  );
});

// Machines menu: lives beside Settings in the sidebar's bottom bar rather
// than inside the project-scope dropdown (a prior attempt nested it there,
// which broke — see below). Only renders once there's more than one
// environment; a single-machine setup has nothing to toggle.
const SidebarChromeMachinesMenu = memo(function SidebarChromeMachinesMenu() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const hiddenEnvironmentIdList = useUiStateStore((store) => store.hiddenEnvironmentIds);
  const setEnvironmentHidden = useUiStateStore((store) => store.setEnvironmentHidden);
  const hiddenEnvironmentIds = useMemo(
    () => new Set(hiddenEnvironmentIdList),
    [hiddenEnvironmentIdList],
  );
  // Same display-label resolution as the usage overview (primary gets its
  // OS/WSL label, others keep their catalog label) so the two surfaces never
  // disagree.
  const machineToggles = useMemo(
    () =>
      deriveSidebarMachineToggles({
        environments: environments.map((environment) => ({
          environmentId: environment.environmentId,
          label:
            environment.environmentId === primaryEnvironmentId
              ? deriveEnvironmentDisplayLabel({
                  isWsl: false,
                  wslDistro: null,
                  platformOs: environment.serverConfig?.environment.platform.os,
                  fallbackLabel: environment.label,
                })
              : environment.label,
        })),
        hiddenEnvironmentIds,
        primaryEnvironmentId,
      }),
    [environments, hiddenEnvironmentIds, primaryEnvironmentId],
  );

  if (machineToggles.length <= 1) {
    return null;
  }

  const hiddenCount = machineToggles.filter((machine) => !machine.checked).length;

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <SidebarMenuButton
                  size="icon"
                  className="relative shrink-0"
                  aria-label="Machines"
                />
              }
            />
          }
        >
          <ServerIcon />
          {hiddenCount > 0 ? (
            <span
              aria-hidden
              className="pointer-events-none absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-sidebar"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">Machines</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="top" className="min-w-48">
        <MenuGroup>
          <MenuGroupLabel>Machines</MenuGroupLabel>
          {machineToggles.map((machine) => (
            <MenuCheckboxItem
              key={machine.environmentId}
              checked={machine.checked}
              closeOnClick={false}
              onCheckedChange={(checked) => setEnvironmentHidden(machine.environmentId, !checked)}
            >
              <span className="min-w-0 truncate text-sm">{machine.label}</span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
