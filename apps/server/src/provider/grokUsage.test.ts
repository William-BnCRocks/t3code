import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as EffectAcpErrors from "effect-acp/errors";

import { readGrokBillingOverAcp } from "./grokUsage.ts";

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
      expect(calls).toEqual([{ method: "x.ai/billing", payload: {} }]);
    }),
  );

  it.effect('retries with { format: "credits" } when the empty-params attempt fails', () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const runtime = fakeRuntime((method, payload) => {
        calls.push({ method, payload });
        if (calls.length === 1) {
          return Effect.fail(
            new EffectAcpErrors.AcpRequestError({
              code: -32601,
              errorMessage: "Method not supported with empty params",
            }),
          );
        }
        return Effect.succeed({ creditUsagePercent: 40 });
      });

      const result = yield* readGrokBillingOverAcp(runtime);

      expect(result).toEqual(Option.some({ creditUsagePercent: 40 }));
      expect(calls).toEqual([
        { method: "x.ai/billing", payload: {} },
        { method: "x.ai/billing", payload: { format: "credits" } },
      ]);
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
