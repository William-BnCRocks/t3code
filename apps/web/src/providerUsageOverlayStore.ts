import { create } from "zustand";

/**
 * Non-persisted open/closed state for the provider usage overlay, shared
 * between the composer-footer `ProviderUsageMeter` trigger and the global
 * `ProviderUsageOverlay` fallback (mod+shift+u / command palette).
 *
 * `triggerCount` lets the global overlay know whether a composer trigger is
 * currently mounted: when it is, the overlay renders nothing (the composer's
 * own popover owns the UI); when it drops to zero (composer unmounted, or no
 * thread open) the overlay renders its own anchored popover instead. See
 * `previewMiniPlayerStore.ts` for the sibling non-persisted store pattern.
 */
interface ProviderUsageOverlayStoreState {
  readonly isOpen: boolean;
  readonly triggerCount: number;
  readonly open: () => void;
  readonly close: () => void;
  readonly toggle: () => void;
  readonly setOpen: (open: boolean) => void;
  readonly registerTrigger: () => () => void;
}

export const useProviderUsageOverlayStore = create<ProviderUsageOverlayStoreState>()((set) => ({
  isOpen: false,
  triggerCount: 0,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  setOpen: (open) => set({ isOpen: open }),
  registerTrigger: () => {
    set((state) => ({ triggerCount: state.triggerCount + 1 }));
    return () => set((state) => ({ triggerCount: Math.max(0, state.triggerCount - 1) }));
  },
}));
