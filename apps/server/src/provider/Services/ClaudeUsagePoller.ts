import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ClaudeUsagePollerShape {
  /**
   * Start the background Claude usage poller within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ClaudeUsagePoller extends Context.Service<ClaudeUsagePoller, ClaudeUsagePollerShape>()(
  "t3/provider/Services/ClaudeUsagePoller",
) {}
