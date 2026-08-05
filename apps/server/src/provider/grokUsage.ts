/**
 * grokUsage — ACP-native read of Grok account billing/credit telemetry.
 *
 * The previous implementation of this module polled the Grok CLI's HTTP
 * billing endpoint (`GET {GROK_CODE_BACKEND_URL}/billing?format=credits`)
 * directly, using a bearer token read out of `$GROK_HOME/auth.json`. That
 * endpoint 404s even with a valid token (verified live against a running
 * Grok CLI installation) — it is not a supported integration surface. This
 * module instead reads billing over the same `grok agent stdio` ACP
 * connection a session already has open, via the ACP extension request
 * `x.ai/billing`. There is no HTTP client and no credential file read here
 * anymore: the ACP connection is already authenticated by the running Grok
 * session.
 *
 * Verified response field names (extracted from the `grok` binary's embedded
 * serde field-name strings, not a captured live payload — this environment
 * never observed a real `x.ai/billing` response):
 *
 * ```
 * creditUsagePercent, currentPeriod { start, end, month }, monthlyLimit,
 * onDemandCap, onDemandUsed, prepaidBalance, includedUsed, totalUsed,
 * billingPeriodStart, billingCycle, isUnifiedBillingUser, on_demand_enabled,
 * subscription_tier
 * ```
 *
 * `subscription_tier` observed enum values: `supergrok_heavy`,
 * `supergrok_plus`, `supergrok`, `supergrok_lite`, `x_premium_plus`,
 * `x_premium`, `x_basic`, `api_key`. The normalizer in `providerRateLimits.ts`
 * treats every field access as untrusted/guarded, same as the Claude branch,
 * so an imprecise guess here degrades to "field omitted" rather than a crash
 * or a wrong render.
 *
 * This module never refreshes credentials and never logs a credential value
 * — there are none to manage here; auth lives entirely inside the spawned
 * Grok CLI process behind the ACP connection.
 *
 * @module grokUsage
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "./acp/AcpSessionRuntime.ts";

/** ACP extension request method for Grok's billing/credit read. */
const GROK_BILLING_METHOD = "x.ai/billing";
const GROK_BILLING_TIMEOUT_MS = 10_000;

/**
 * Issue one `x.ai/billing` ACP extension request over an already-started
 * session's connection and return its raw (unvalidated) response body.
 * `payload` shape is a guess — the CLI's own client serializes "billing
 * params" but no source documents the request shape — so any failure
 * (unsupported method, timeout, malformed/rejected request) degrades to
 * `Option.none()` with one debug log rather than throwing or retrying
 * forever.
 */
const requestGrokBilling = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
  payload: unknown,
): Effect.Effect<Option.Option<unknown>> =>
  runtime.request(GROK_BILLING_METHOD, payload).pipe(
    Effect.timeoutOption(GROK_BILLING_TIMEOUT_MS),
    Effect.flatMap((result) =>
      Option.isNone(result)
        ? Effect.logDebug("grok x.ai/billing ext request timed out", { payload }).pipe(
            Effect.as(Option.none<unknown>()),
          )
        : Effect.succeed(Option.some<unknown>(result.value)),
    ),
    Effect.catch((error: EffectAcpErrors.AcpError) =>
      Effect.logDebug("grok x.ai/billing ext request failed", {
        payload,
        error: error.message,
      }).pipe(Effect.as(Option.none<unknown>())),
    ),
  );

/**
 * Read Grok account billing/credit telemetry over an active `grok agent
 * stdio` ACP connection. Tries an empty params object first (the CLI's own
 * client is not confirmed to require any particular shape); if the agent
 * rejects that, retries once with `{ format: "credits" }` (the query string
 * the CLI's now-removed HTTP path used) before giving up. Fail-open on every
 * path: returns `Option.none()` for an unsupported method, a timeout, or a
 * malformed/rejected response — never throws.
 */
export const readGrokBillingOverAcp = Effect.fn("readGrokBillingOverAcp")(function* (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
): Effect.fn.Return<Option.Option<unknown>, never, never> {
  const withEmptyParams = yield* requestGrokBilling(runtime, {});
  if (Option.isSome(withEmptyParams)) {
    return withEmptyParams;
  }
  return yield* requestGrokBilling(runtime, { format: "credits" });
});
