import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface GrokUsagePollerShape {
  /**
   * Start the background Grok usage poller within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class GrokUsagePoller extends Context.Service<GrokUsagePoller, GrokUsagePollerShape>()(
  "t3/provider/Services/GrokUsagePoller",
) {}
