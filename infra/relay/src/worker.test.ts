import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { resolveApnsConfig } from "./worker.ts";

const complete = {
  environment: Option.some("sandbox" as const),
  teamId: Option.some("team-id"),
  keyId: Option.some("key-id"),
  bundleId: Option.some("com.t3tools.t3code"),
  privateKey: Option.some(Redacted.make("private-key")),
};

const none = {
  environment: Option.none(),
  teamId: Option.none(),
  keyId: Option.none(),
  bundleId: Option.none(),
  privateKey: Option.none(),
};

describe("resolveApnsConfig", () => {
  it("returns undefined credentials when no APNs variable is set", () => {
    const result = resolveApnsConfig(none);
    expect(result).toEqual({ ok: true, apns: undefined });
  });

  it("returns a credentials object when every APNs variable is set", () => {
    const result = resolveApnsConfig(complete);
    if (!result.ok || result.apns === undefined) {
      throw new Error("expected resolved APNs credentials");
    }
    expect(result.apns.environment).toBe("sandbox");
    expect(result.apns.teamId).toBe("team-id");
    expect(result.apns.keyId).toBe("key-id");
    expect(result.apns.bundleId).toBe("com.t3tools.t3code");
    expect(Redacted.value(result.apns.privateKey)).toBe("private-key");
  });

  it("fails startup naming the single missing variable", () => {
    const result = resolveApnsConfig({ ...complete, teamId: Option.none() });
    expect(result).toEqual({
      ok: false,
      message: "Relay APNs configuration is incomplete; missing APNS_TEAM_ID.",
    });
  });

  it("fails startup naming every missing variable", () => {
    const result = resolveApnsConfig({
      ...complete,
      keyId: Option.none(),
      privateKey: Option.none(),
    });
    expect(result).toEqual({
      ok: false,
      message: "Relay APNs configuration is incomplete; missing APNS_KEY_ID, APNS_PRIVATE_KEY.",
    });
  });
});
