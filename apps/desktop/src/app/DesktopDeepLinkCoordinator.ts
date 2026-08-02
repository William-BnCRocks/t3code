import type { DesktopDeepLinkPayload } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

// Minimal, dependency-free mailbox shared between DesktopClerk's
// second-instance handler (which cannot depend on DesktopWindow -- see the
// clerk/application layer split in main.ts) and DesktopWindow (which owns the
// actual delivery + "flush once the main window finishes loading" logic).
// Producers write the most recently received deep link; DesktopWindow reads
// and clears it once it manages to deliver it to the renderer. A second link
// arriving before the first was delivered simply replaces it -- last one
// wins, matching how a real OS would only ever hand off the most recent
// launch request anyway.
export class DesktopDeepLinkCoordinator extends Context.Service<
  DesktopDeepLinkCoordinator,
  {
    readonly pending: Ref.Ref<Option.Option<DesktopDeepLinkPayload>>;
  }
>()("@t3tools/desktop/app/DesktopDeepLinkCoordinator") {}

const make = Effect.all({
  pending: Ref.make<Option.Option<DesktopDeepLinkPayload>>(Option.none()),
});

export const layer = Layer.effect(DesktopDeepLinkCoordinator, make);
