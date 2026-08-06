import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as EffectAcpErrors from "effect-acp/errors";

import { readGrokBillingOverAcp, readGrokSubscriptionOverAcp } from "./grokUsage.ts";

function fakeRuntime(
  request: (method: string, payload: unknown) => Effect.Effect<unknown, EffectAcpErrors.AcpError>,
) {
  return { request };
}

describe("readGrokBillingOverAcp", () => {
  it.effect("returns Some(body) when the ext request succeeds on the first attempt", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const runtime = fakeRuntime((method, payload) => {
        calls.push({ method, payload });
        return Effect.succeed({ creditUsagePercent: 12.5 });
      });

      const result = yield* readGrokBillingOverAcp(runtime);

      expect(result).toEqual(Option.some({ creditUsagePercent: 12.5 }));
      // Underscore-prefixed method first — the spelling the live agent
      // actually dispatches (plain x.ai/billing returns Method not found).
      expect(calls).toEqual([{ method: "_x.ai/billing", payload: {} }]);
    }),
  );

  it.effect("falls back to the plain method spelling when the underscore form is unsupported", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const runtime = fakeRuntime((method, payload) => {
        calls.push({ method, payload });
        if (calls.length === 1) {
          return Effect.fail(
            new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage: "Method not found",
            }),
          );
        }
        return Effect.succeed({ config: { creditUsagePercent: 40 } });
      });

      const result = yield* readGrokBillingOverAcp(runtime);

      expect(result).toEqual(Option.some({ config: { creditUsagePercent: 40 } }));
      expect(calls).toEqual([
        { method: "_x.ai/billing", payload: {} },
        { method: "x.ai/billing", payload: {} },
      ]);
    }),
  );

  it.effect("remembers the working method for a connection and reuses it on later reads", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const runtime = fakeRuntime((method) => {
        calls.push(method);
        return method === "_x.ai/billing"
          ? Effect.succeed({ config: { creditUsagePercent: 5 } })
          : Effect.fail(
              new EffectAcpErrors.AcpRequestError({
                code: -32601,
                errorMessage: "Method not found",
              }),
            );
      });

      yield* readGrokBillingOverAcp(runtime);
      yield* readGrokBillingOverAcp(runtime);

      // Second read goes straight to the remembered spelling.
      expect(calls).toEqual(["_x.ai/billing", "_x.ai/billing"]);
    }),
  );

  it.effect("returns None (never throws) when both attempts fail", () =>
    Effect.gen(function* () {
      const runtime = fakeRuntime(() =>
        Effect.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32601,
            errorMessage: "Method not found",
          }),
        ),
      );

      const result = yield* readGrokBillingOverAcp(runtime);

      expect(Option.isNone(result)).toBe(true);
    }),
  );

  it.effect("returns None when the ext request is unsupported by the agent", () =>
    Effect.gen(function* () {
      const runtime = fakeRuntime((method) =>
        Effect.fail(
          new EffectAcpErrors.AcpRequestError({
            code: -32601,
            errorMessage: `Method not found: ${method}`,
          }),
        ),
      );

      const result = yield* readGrokBillingOverAcp(runtime);

      expect(Option.isNone(result)).toBe(true);
    }),
  );
});

describe("readGrokSubscriptionOverAcp", () => {
  it.effect("returns Some(body) when the ext request succeeds on the first attempt", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const runtime = fakeRuntime((method, payload) => {
        calls.push({ method, payload });
        return Effect.succeed({
          authenticated: true,
          meta: { subscription_tier: "SuperGrok", team_name: "BnC" },
        });
      });

      const result = yield* readGrokSubscriptionOverAcp(runtime);

      expect(result).toEqual(
        Option.some({
          authenticated: true,
          meta: { subscription_tier: "SuperGrok", team_name: "BnC" },
        }),
      );
      // Underscore-prefixed method first, mirroring the billing read's
      // verified-live spelling preference.
      expect(calls).toEqual([{ method: "_x.ai/auth/check_subscription", payload: {} }]);
    }),
  );

  it.effect("falls back to the plain method spelling when the underscore form is unsupported", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const runtime = fakeRuntime((method, payload) => {
        calls.push({ method, payload });
        if (calls.length === 1) {
          return Effect.fail(
            new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage: "Method not found",
            }),
          );
        }
        return Effect.succeed({ authenticated: true, meta: { subscription_tier: "SuperGrok" } });
      });

      const result = yield* readGrokSubscriptionOverAcp(runtime);

      expect(result).toEqual(
        Option.some({ authenticated: true, meta: { subscription_tier: "SuperGrok" } }),
      );
      expect(calls).toEqual([
        { method: "_x.ai/auth/check_subscription", payload: {} },
        { method: "x.ai/auth/check_subscription", payload: {} },
      ]);
    }),
  );

  it.effect("remembers the working method for a connection and reuses it on later reads", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const runtime = fakeRuntime((method) => {
        calls.push(method);
        return method === "_x.ai/auth/check_subscription"
          ? Effect.succeed({ authenticated: true, meta: { subscription_tier: "SuperGrok" } })
          : Effect.fail(
              new EffectAcpErrors.AcpRequestError({
                code: -32601,
                errorMessage: "Method not found",
              }),
            );
      });

      yield* readGrokSubscriptionOverAcp(runtime);
      yield* readGrokSubscriptionOverAcp(runtime);

      expect(calls).toEqual(["_x.ai/auth/check_subscription", "_x.ai/auth/check_subscription"]);
    }),
  );

  it.effect(
    "returns None (never throws) when both attempts fail, e.g. no personal team on this account",
    () =>
      Effect.gen(function* () {
        const runtime = fakeRuntime(() =>
          Effect.fail(
            new EffectAcpErrors.AcpRequestError({
              code: -32603,
              errorMessage: "Internal error",
            }),
          ),
        );

        const result = yield* readGrokSubscriptionOverAcp(runtime);

        expect(Option.isNone(result)).toBe(true);
      }),
  );
});
