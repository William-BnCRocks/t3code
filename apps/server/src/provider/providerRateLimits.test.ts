import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderRateLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { mergeProviderRateLimits } from "./providerRateLimits.ts";

const OBSERVED_AT = "2026-04-11T00:00:00.000Z";
const isoFromEpochMillis = (millis: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(millis));

describe("mergeProviderRateLimits", () => {
  it("accumulates a Claude five_hour window then a seven_day window into two windows", () => {
    const fiveHour = mergeProviderRateLimits({
      previous: undefined,
      provider: "claudeAgent",
      payload: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 42,
          resetsAt: 1_800_000_000,
        },
        uuid: "uuid-1",
        session_id: "session-1",
      },
      observedAt: OBSERVED_AT,
    });

    expect(fiveHour).toEqual({
      observedAt: OBSERVED_AT,
      windows: [
        {
          kind: "five_hour",
          usedPercent: 42,
          resetsAt: isoFromEpochMillis(1_800_000_000 * 1000),
          status: "allowed",
        },
      ],
    });

    const sevenDay = mergeProviderRateLimits({
      previous: fiveHour,
      provider: "claudeAgent",
      payload: {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 88,
        },
        uuid: "uuid-2",
        session_id: "session-1",
      },
      observedAt: "2026-04-11T01:00:00.000Z",
    });

    expect(sevenDay?.windows).toHaveLength(2);
    expect(sevenDay?.windows.map((window) => window.kind).toSorted()).toEqual([
      "five_hour",
      "seven_day",
    ]);
    expect(sevenDay?.windows.find((window) => window.kind === "seven_day")).toEqual({
      kind: "seven_day",
      usedPercent: 88,
      status: "allowed_warning",
    });
    // Prior window survives untouched.
    expect(sevenDay?.windows.find((window) => window.kind === "five_hour")).toEqual(
      fiveHour?.windows[0],
    );
  });

  it("replaces the window for a Claude event that reuses the same rateLimitType", () => {
    const first = mergeProviderRateLimits({
      previous: undefined,
      provider: "claudeAgent",
      payload: {
        rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 10 },
      },
      observedAt: OBSERVED_AT,
    });

    const second = mergeProviderRateLimits({
      previous: first,
      provider: "claudeAgent",
      payload: {
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 100 },
      },
      observedAt: "2026-04-11T02:00:00.000Z",
    });

    expect(second?.windows).toEqual([{ kind: "five_hour", usedPercent: 100, status: "rejected" }]);
  });

  it("maps Claude overage signals onto a dedicated overage window", () => {
    const merged = mergeProviderRateLimits({
      previous: undefined,
      provider: "claudeAgent",
      payload: {
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 5,
          isUsingOverage: true,
          overageStatus: "allowed_warning",
          overageResetsAt: 1_800_000_000,
        },
      },
      observedAt: OBSERVED_AT,
    });

    expect(merged?.windows).toEqual([
      { kind: "five_hour", usedPercent: 5, status: "allowed" },
      {
        kind: "overage",
        status: "allowed_warning",
        resetsAt: isoFromEpochMillis(1_800_000_000 * 1000),
      },
    ]);
  });

  it("suppresses the overage window when overage is disabled for the account", () => {
    const merged = mergeProviderRateLimits({
      previous: undefined,
      provider: "claudeAgent",
      payload: {
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 12,
          overageStatus: "rejected",
          overageDisabledReason: "overage_not_provisioned",
        },
      },
      observedAt: OBSERVED_AT,
    });

    expect(merged?.windows).toEqual([{ kind: "five_hour", usedPercent: 12, status: "allowed" }]);
  });

  it("scrubs a previously accumulated overage window once a disabled reason arrives", () => {
    const previous: ServerProviderRateLimits = {
      observedAt: "2026-04-10T00:00:00.000Z",
      windows: [
        { kind: "five_hour", usedPercent: 12, status: "allowed" },
        { kind: "overage", status: "rejected" },
      ],
    };

    const merged = mergeProviderRateLimits({
      previous,
      provider: "claudeAgent",
      payload: {
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          utilization: 14,
          overageStatus: "rejected",
          overageDisabledReason: "overage_not_provisioned",
        },
      },
      observedAt: OBSERVED_AT,
    });

    expect(merged?.windows).toEqual([{ kind: "five_hour", usedPercent: 14, status: "allowed" }]);
  });

  it("sparse-merges a Codex double-nested update over the previous snapshot (null primary keeps previous)", () => {
    const previous: ServerProviderRateLimits = {
      observedAt: "2026-04-10T00:00:00.000Z",
      windows: [
        { kind: "primary", usedPercent: 10, windowDurationMins: 300 },
        { kind: "secondary", usedPercent: 20, windowDurationMins: 10_080 },
      ],
      planLabel: "Pro",
    };

    const merged = mergeProviderRateLimits({
      previous,
      provider: "codex",
      payload: {
        rateLimits: {
          primary: null,
          secondary: { usedPercent: 55, resetsAt: 1_700_000_000, windowDurationMins: 10_080 },
          planType: null,
          credits: null,
        },
      },
      observedAt: OBSERVED_AT,
    });

    expect(merged?.planLabel).toBe("Pro");
    expect(merged?.windows.find((window) => window.kind === "primary")).toEqual(
      previous.windows[0],
    );
    expect(merged?.windows.find((window) => window.kind === "secondary")).toEqual({
      kind: "secondary",
      usedPercent: 55,
      resetsAt: isoFromEpochMillis(1_700_000_000 * 1000),
      windowDurationMins: 10_080,
    });
  });

  it("normalizes the flat { primary, secondary } fallback shape identically to Codex nesting", () => {
    const merged = mergeProviderRateLimits({
      previous: undefined,
      provider: "codex",
      payload: {
        primary: { usedPercent: 33, windowDurationMins: 300 },
        secondary: { usedPercent: 66, windowDurationMins: 10_080 },
        planType: "pro",
        credits: { unlimited: true },
      },
      observedAt: OBSERVED_AT,
    });

    expect(merged).toEqual({
      observedAt: OBSERVED_AT,
      windows: [
        { kind: "primary", usedPercent: 33, windowDurationMins: 300 },
        { kind: "secondary", usedPercent: 66, windowDurationMins: 10_080 },
      ],
      planLabel: "Pro",
      creditsLabel: "Credits: unlimited",
    });
  });

  it("derives credits labels from balance and hasCredits", () => {
    const withBalance = mergeProviderRateLimits({
      previous: undefined,
      provider: "codex",
      payload: { primary: null, secondary: null, credits: { hasCredits: true, balance: "12.50" } },
      observedAt: OBSERVED_AT,
    });
    expect(withBalance?.creditsLabel).toBe("Credits: 12.50");

    const withoutCredits = mergeProviderRateLimits({
      previous: undefined,
      provider: "codex",
      payload: { primary: null, secondary: null, credits: { hasCredits: false } },
      observedAt: OBSERVED_AT,
    });
    expect(withoutCredits?.creditsLabel).toBe("No credits");
  });

  it("returns undefined for a garbage payload with no previous snapshot, and never throws", () => {
    expect(
      mergeProviderRateLimits({
        previous: undefined,
        provider: "codex",
        payload: { totallyUnrelated: true },
        observedAt: OBSERVED_AT,
      }),
    ).toBeUndefined();

    expect(
      mergeProviderRateLimits({
        previous: undefined,
        provider: "codex",
        payload: "not an object",
        observedAt: OBSERVED_AT,
      }),
    ).toBeUndefined();

    expect(
      mergeProviderRateLimits({
        previous: undefined,
        provider: "codex",
        payload: null,
        observedAt: OBSERVED_AT,
      }),
    ).toBeUndefined();

    expect(() =>
      mergeProviderRateLimits({
        previous: undefined,
        provider: "codex",
        payload: 12345,
        observedAt: OBSERVED_AT,
      }),
    ).not.toThrow();
  });

  it("returns the previous snapshot unchanged for a garbage payload when one exists", () => {
    const previous: ServerProviderRateLimits = {
      observedAt: "2026-04-10T00:00:00.000Z",
      windows: [{ kind: "primary", usedPercent: 10 }],
    };

    const merged = mergeProviderRateLimits({
      previous,
      provider: "codex",
      payload: { totallyUnrelated: true },
      observedAt: OBSERVED_AT,
    });

    expect(merged).toBe(previous);
  });

  it("treats numeric resetsAt below 10^12 as epoch seconds and above as epoch milliseconds", () => {
    const secondsWindow = mergeProviderRateLimits({
      previous: undefined,
      provider: "codex",
      payload: { primary: { usedPercent: 1, resetsAt: 1_700_000_000 } },
      observedAt: OBSERVED_AT,
    });
    expect(secondsWindow?.windows[0]?.resetsAt).toBe(isoFromEpochMillis(1_700_000_000 * 1000));

    const millisWindow = mergeProviderRateLimits({
      previous: undefined,
      provider: "codex",
      payload: { primary: { usedPercent: 1, resetsAt: 1_700_000_000_000 } },
      observedAt: OBSERVED_AT,
    });
    expect(millisWindow?.windows[0]?.resetsAt).toBe(isoFromEpochMillis(1_700_000_000_000));
  });
});
