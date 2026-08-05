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

/**
 * ACP extension request methods for Grok's billing/credit read, in
 * preference order. The underscore-prefixed form is what the agent actually
 * dispatches today — verified live against `grok agent stdio`, where
 * `x.ai/billing` returns -32601 "Method not found" while `_x.ai/billing`
 * answers with the billing config. The plain form is kept as a fallback for
 * the day xAI stabilizes the method name (their `ask_user_question`
 * extension already ships both spellings).
 */
const GROK_BILLING_METHODS = ["_x.ai/billing", "x.ai/billing"] as const;
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
  method: string,
  payload: unknown,
): Effect.Effect<Option.Option<unknown>> =>
  runtime.request(method, payload).pipe(
    Effect.timeoutOption(GROK_BILLING_TIMEOUT_MS),
    Effect.flatMap((result) =>
      Option.isNone(result)
        ? Effect.logDebug("grok billing ext request timed out", { method, payload }).pipe(
            Effect.as(Option.none<unknown>()),
          )
        : Effect.succeed(Option.some<unknown>(result.value)),
    ),
    Effect.catch((error: EffectAcpErrors.AcpError) =>
      Effect.logDebug("grok billing ext request failed", {
        method,
        payload,
        error: error.message,
      }).pipe(Effect.as(Option.none<unknown>())),
    ),
  );

/**
 * Per-connection memo of which method spelling that agent answers, so a
 * long-lived session probes the alternatives once rather than on every
 * five-minute poll. Keyed by the runtime object itself and weak, so it dies
 * with the session — a new session re-probes, which is what lets a client
 * updated mid-session pick up the working spelling without a restart.
 */
const billingMethodByRuntime = new WeakMap<object, string>();

/**
 * Read Grok account billing/credit telemetry over an active `grok agent
 * stdio` ACP connection. Empty params suffice (verified live). Tries the
 * spelling this connection already answered, else each of
 * `GROK_BILLING_METHODS` in order, remembering the winner. Fail-open on
 * every path: returns `Option.none()` for an unsupported method, a timeout,
 * or a malformed/rejected response — never throws. The response body arrives
 * wrapped as `{ config: { creditUsagePercent, currentPeriod, ... } }`; the
 * normalizer unwraps it.
 */
export const readGrokBillingOverAcp = Effect.fn("readGrokBillingOverAcp")(function* (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
): Effect.fn.Return<Option.Option<unknown>, never, never> {
  const remembered = billingMethodByRuntime.get(runtime);
  const methods =
    remembered === undefined
      ? GROK_BILLING_METHODS
      : [remembered, ...GROK_BILLING_METHODS.filter((method) => method !== remembered)];
  for (const method of methods) {
    const response = yield* requestGrokBilling(runtime, method, {});
    if (Option.isSome(response)) {
      billingMethodByRuntime.set(runtime, method);
      return response;
    }
    // The winner stopped working (agent restarted behind the same runtime,
    // method renamed): forget it so the next poll re-probes from the top
    // instead of pinning a now-dead spelling.
    if (remembered === method) {
      billingMethodByRuntime.delete(runtime);
    }
  }
  return Option.none();
});
