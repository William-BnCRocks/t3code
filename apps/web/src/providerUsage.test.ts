import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderRateLimits,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computeWindowSeverity,
  deriveUsageOverview,
  resolveWindowLabels,
  USAGE_CRITICAL_PERCENT,
  USAGE_WARNING_PERCENT,
  type UsageEnvironmentInput,
} from "./providerUsage";

const NOW_ISO = "2026-06-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function isoMinutesAgo(minutes: number): string {
  return new Date(NOW_MS - minutes * 60_000).toISOString();
}

function provider(input: {
  instanceId: string;
  driver?: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  authStatus?: ServerProvider["auth"]["status"];
  rateLimits?: ServerProviderRateLimits;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver ?? "claudeAgent"),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: input.authStatus ?? "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.rateLimits ? { rateLimits: input.rateLimits } : {}),
  };
}

function environment(overrides: Partial<UsageEnvironmentInput> = {}): UsageEnvironmentInput {
  return {
    environmentId: EnvironmentId.make("env-primary"),
    label: "Primary",
    isPrimary: true,
    phase: "connected",
    connectionError: null,
    providers: [],
    ...overrides,
  };
}

describe("resolveWindowLabels", () => {
  it("prefers windowDurationMins over kind, choosing minutes/hours/days", () => {
    expect(resolveWindowLabels("anything", 45).label).toBe("45m");
    expect(resolveWindowLabels("anything", 120).label).toBe("2h");
    expect(resolveWindowLabels("anything", 2880).label).toBe("2d");
    expect(resolveWindowLabels("anything", 10_080).label).toBe("Week");
  });

  it("falls back to the kind label map when duration is absent", () => {
    expect(resolveWindowLabels("five_hour", undefined).label).toBe("5h");
    expect(resolveWindowLabels("overage", undefined).label).toBe("Overage");
  });

  it("labels the Grok billing poller's monthly kind", () => {
    expect(resolveWindowLabels("monthly", undefined).label).toBe("Month");
    expect(resolveWindowLabels("monthly", undefined).longLabel).toBe("Monthly credits");
  });

  it("appends a humanized model qualifier for arbitrary model-scoped weekly kinds", () => {
    expect(resolveWindowLabels("seven_day_fable_5", undefined).label).toBe("Week · Fable 5");
    expect(resolveWindowLabels("five_hour_opus", undefined).label).toBe("5h · Opus");
    expect(resolveWindowLabels("seven_day", undefined).label).toBe("Week");
  });

  it("labels the live usage endpoint's session/weekly kinds distinctly", () => {
    // Kinds observed in real GET /api/oauth/usage responses: session,
    // weekly_all, and weekly_scoped_<model slug> from scope.model.display_name.
    expect(resolveWindowLabels("session", 300).label).toBe("5h");
    expect(resolveWindowLabels("weekly_all", 10_080).label).toBe("Week · All");
    expect(resolveWindowLabels("weekly_scoped_fable", 10_080).label).toBe("Week · Fable");
    expect(resolveWindowLabels("weekly_scoped_fable", undefined).label).toBe("Week · Fable");
  });

  it("appends a model qualifier for _opus/_sonnet kind-map hits", () => {
    expect(resolveWindowLabels("seven_day_opus", undefined).label).toBe("Week · Opus");
    expect(resolveWindowLabels("seven_day_sonnet", undefined).label).toBe("Week · Sonnet");
    expect(resolveWindowLabels("seven_day_opus", undefined).longLabel).toBe("Weekly window · Opus");
  });

  it("humanizes unrecognized kinds as a last resort", () => {
    expect(resolveWindowLabels("daily_limit", undefined).label).toBe("Daily Limit");
  });
});

describe("computeWindowSeverity", () => {
  it("treats expired windows as ok regardless of status", () => {
    expect(computeWindowSeverity({ usedPercent: 99, status: "rejected", isExpired: true })).toBe(
      "ok",
    );
  });

  it("treats rejected as always critical", () => {
    expect(computeWindowSeverity({ usedPercent: 10, status: "rejected", isExpired: false })).toBe(
      "critical",
    );
  });

  it("floors allowed_warning at warning but allows promotion to critical by percent", () => {
    expect(
      computeWindowSeverity({ usedPercent: 40, status: "allowed_warning", isExpired: false }),
    ).toBe("warning");
    expect(
      computeWindowSeverity({ usedPercent: 95, status: "allowed_warning", isExpired: false }),
    ).toBe("critical");
  });

  it("applies plain percent thresholds otherwise", () => {
    expect(
      computeWindowSeverity({
        usedPercent: USAGE_CRITICAL_PERCENT + 1,
        status: "allowed",
        isExpired: false,
      }),
    ).toBe("critical");
    expect(
      computeWindowSeverity({
        usedPercent: USAGE_WARNING_PERCENT,
        status: "allowed",
        isExpired: false,
      }),
    ).toBe("warning");
    expect(computeWindowSeverity({ usedPercent: 10, status: "allowed", isExpired: false })).toBe(
      "ok",
    );
  });
});

describe("deriveUsageOverview — environment chrome", () => {
  it("suppresses chrome for a single qualifying environment", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          providers: [
            provider({
              instanceId: "claudeAgent",
              rateLimits: { observedAt: NOW_ISO, windows: [] },
            }),
          ],
        }),
      ],
      NOW_MS,
    );
    expect(overview.showEnvironmentChrome).toBe(false);
  });

  it("shows chrome once a second environment qualifies", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          providers: [
            provider({
              instanceId: "claudeAgent",
              rateLimits: { observedAt: NOW_ISO, windows: [] },
            }),
          ],
        }),
        environment({
          environmentId: EnvironmentId.make("env-secondary"),
          label: "WSL",
          isPrimary: false,
          providers: [
            provider({
              instanceId: "codex",
              driver: "codex",
              rateLimits: { observedAt: NOW_ISO, windows: [] },
            }),
          ],
        }),
      ],
      NOW_MS,
    );
    expect(overview.showEnvironmentChrome).toBe(true);
  });
});

describe("deriveUsageOverview — staleness", () => {
  it("marks an instance stale after 30 minutes without changing window severity", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          providers: [
            provider({
              instanceId: "claudeAgent",
              rateLimits: {
                observedAt: isoMinutesAgo(45),
                windows: [{ kind: "five_hour", usedPercent: 40, status: "allowed" }],
              },
            }),
          ],
        }),
      ],
      NOW_MS,
    );
    const instance = overview.environments[0]?.instances[0];
    expect(instance?.isStale).toBe(true);
    expect(instance?.windows[0]?.severity).toBe("ok");
  });

  it("does not mark a fresh instance stale", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          providers: [
            provider({
              instanceId: "claudeAgent",
              rateLimits: {
                observedAt: isoMinutesAgo(5),
                windows: [{ kind: "five_hour", usedPercent: 40, status: "allowed" }],
              },
            }),
          ],
        }),
      ],
      NOW_MS,
    );
    expect(overview.environments[0]?.instances[0]?.isStale).toBe(false);
  });
});

describe("deriveUsageOverview — expiry", () => {
  it("forces expired windows to ok severity and drops them from worst selection", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          providers: [
            provider({
              instanceId: "claudeAgent",
              rateLimits: {
                observedAt: NOW_ISO,
                windows: [
                  {
                    kind: "five_hour",
                    usedPercent: 95,
                    status: "allowed",
                    resetsAt: isoMinutesAgo(1),
                  },
                  { kind: "seven_day", usedPercent: 20, status: "allowed" },
                ],
              },
            }),
          ],
        }),
      ],
      NOW_MS,
    );
    // Expired blocks drop out of the panel entirely (the usage log keeps
    // history); only the live window remains and drives worst.
    const windows = overview.environments[0]!.instances[0]!.windows;
    expect(windows).toHaveLength(1);
    expect(windows[0]?.kind).toBe("seven_day");
    expect(overview.worst?.window.kind).toBe("seven_day");
  });
});

describe("deriveUsageOverview — worst selection", () => {
  it("ranks by severity desc then usedPercent desc across instances/environments", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          providers: [
            provider({
              instanceId: "claudeAgent",
              rateLimits: {
                observedAt: NOW_ISO,
                windows: [{ kind: "five_hour", usedPercent: 80, status: "allowed" }],
              },
            }),
            provider({
              instanceId: "codex",
              driver: "codex",
              rateLimits: {
                observedAt: NOW_ISO,
                windows: [{ kind: "five_hour", usedPercent: 92, status: "allowed" }],
              },
            }),
          ],
        }),
      ],
      NOW_MS,
    );
    expect(overview.worst?.severity).toBe("critical");
    expect(overview.worst?.usedPercent).toBe(92);
    expect(overview.worst?.instance.instanceId).toBe(ProviderInstanceId.make("codex"));
  });

  it("treats a rejected window (no usedPercent) as a full-ring critical worst candidate", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          providers: [
            provider({
              instanceId: "claudeAgent",
              rateLimits: {
                observedAt: NOW_ISO,
                windows: [{ kind: "five_hour", status: "rejected" }],
              },
            }),
          ],
        }),
      ],
      NOW_MS,
    );
    expect(overview.worst?.severity).toBe("critical");
    expect(overview.worst?.usedPercent).toBe(100);
  });

  it("excludes connecting/reconnecting environments from worst (anti-flap) while still rendering their instances", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          environmentId: EnvironmentId.make("env-secondary"),
          label: "WSL",
          isPrimary: false,
          phase: "connecting",
          providers: [
            provider({
              instanceId: "codex",
              driver: "codex",
              rateLimits: {
                observedAt: NOW_ISO,
                windows: [{ kind: "five_hour", usedPercent: 99, status: "rejected" }],
              },
            }),
          ],
        }),
        environment({
          providers: [
            provider({
              instanceId: "claudeAgent",
              rateLimits: {
                observedAt: NOW_ISO,
                windows: [{ kind: "five_hour", usedPercent: 80, status: "allowed" }],
              },
            }),
          ],
        }),
      ],
      NOW_MS,
    );
    // The connecting environment still renders its (last-known) instance rows...
    const connectingEnv = overview.environments.find((env) => env.phase === "connecting");
    expect(connectingEnv?.instances[0]?.windows[0]?.severity).toBe("critical");
    // ...but never wins worst, even though its severity outranks the connected env's.
    expect(overview.worst?.environment.phase).toBe("connected");
    expect(overview.worst?.severity).toBe("warning");
  });

  it("excludes absent and unauthenticated instances from worst", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          providers: [
            provider({ instanceId: "claudeAgent" }), // absent: no rateLimits
            provider({ instanceId: "codex", driver: "codex", authStatus: "unauthenticated" }),
          ],
        }),
      ],
      NOW_MS,
    );
    expect(overview.environments[0]?.instances.map((i) => i.state)).toEqual([
      "absent",
      "unauthenticated",
    ]);
    expect(overview.worst).toBeNull();
    expect(overview.hasAnyData).toBe(true);
  });

  it("reports no data when no environment has any qualifying instance", () => {
    const overview = deriveUsageOverview([environment({ providers: [] })], NOW_MS);
    expect(overview.hasAnyData).toBe(false);
    expect(overview.worst).toBeNull();
  });
});

describe("deriveUsageOverview — window ordering", () => {
  it("orders by known duration ascending, unknown-duration after known, overage last", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          providers: [
            provider({
              instanceId: "claudeAgent",
              rateLimits: {
                observedAt: NOW_ISO,
                windows: [
                  { kind: "overage", usedPercent: 10, status: "allowed" },
                  {
                    kind: "seven_day",
                    usedPercent: 10,
                    status: "allowed",
                    windowDurationMins: 10_080,
                  },
                  { kind: "mystery", usedPercent: 10, status: "allowed" },
                  {
                    kind: "five_hour",
                    usedPercent: 10,
                    status: "allowed",
                    windowDurationMins: 300,
                  },
                ],
              },
            }),
          ],
        }),
      ],
      NOW_MS,
    );
    expect(overview.environments[0]!.instances[0]!.windows.map((w) => w.kind)).toEqual([
      "five_hour",
      "seven_day",
      "mystery",
      "overage",
    ]);
  });
});

describe("deriveUsageOverview — instance filtering and extras", () => {
  it("skips disabled and unavailable instances entirely", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          providers: [
            provider({ instanceId: "claudeAgent", enabled: false }),
            provider({ instanceId: "codex", driver: "codex", availability: "unavailable" }),
            provider({
              instanceId: "grok",
              driver: "grok",
              rateLimits: { observedAt: NOW_ISO, windows: [] },
            }),
          ],
        }),
      ],
      NOW_MS,
    );
    expect(overview.environments[0]?.instances).toHaveLength(1);
    expect(overview.environments[0]?.instances[0]?.instanceId).toBe(
      ProviderInstanceId.make("grok"),
    );
  });

  it("builds extras from planLabel and creditsLabel", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          providers: [
            provider({
              instanceId: "claudeAgent",
              rateLimits: {
                observedAt: NOW_ISO,
                windows: [],
                planLabel: "Pro",
                creditsLabel: "unlimited",
              },
            }),
          ],
        }),
      ],
      NOW_MS,
    );
    expect(overview.environments[0]?.instances[0]?.extras).toEqual(["Pro", "Credits: unlimited"]);
  });
});

describe("deriveUsageOverview — usageLogDir", () => {
  it("propagates the primary environment's usageLogDir onto the overview", () => {
    const overview = deriveUsageOverview(
      [
        environment({ usageLogDir: "/home/dev/.t3/userdata/usage" }),
        environment({
          environmentId: EnvironmentId.make("env-secondary"),
          label: "WSL",
          isPrimary: false,
          usageLogDir: "/mnt/wsl/.t3/userdata/usage",
        }),
      ],
      NOW_MS,
    );
    expect(overview.usageLogDir).toBe("/home/dev/.t3/userdata/usage");
  });

  it("is undefined when the primary environment reports none", () => {
    const overview = deriveUsageOverview([environment()], NOW_MS);
    expect(overview.usageLogDir).toBeUndefined();
  });

  it("ignores a non-primary environment's usageLogDir when the primary has none", () => {
    const overview = deriveUsageOverview(
      [
        environment(),
        environment({
          environmentId: EnvironmentId.make("env-secondary"),
          label: "WSL",
          isPrimary: false,
          usageLogDir: "/mnt/wsl/.t3/userdata/usage",
        }),
      ],
      NOW_MS,
    );
    expect(overview.usageLogDir).toBeUndefined();
  });
});

describe("deriveUsageOverview — disconnected environments", () => {
  it("marks a disconnected environment unreachable but still enumerates its instances", () => {
    const overview = deriveUsageOverview(
      [
        environment({
          phase: "error",
          connectionError: "boom",
          providers: [
            provider({
              instanceId: "claudeAgent",
              rateLimits: {
                observedAt: NOW_ISO,
                windows: [{ kind: "five_hour", usedPercent: 95, status: "allowed" }],
              },
            }),
          ],
        }),
      ],
      NOW_MS,
    );
    expect(overview.environments[0]?.isReachable).toBe(false);
    expect(overview.environments[0]?.statusText).toContain("Connection failed");
    expect(overview.environments[0]?.instances).toHaveLength(1);
    expect(overview.worst).toBeNull();
  });
});
