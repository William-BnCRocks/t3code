import { describe, expect, it } from "@effect/vitest";

import * as DesktopOidcLogin from "./DesktopOidcLogin.ts";

const REDIRECT_URI = DesktopOidcLogin.oidcLoopbackRedirectUri();

function callbackUrl(query: string): URL {
  return new URL(`${REDIRECT_URI}${query}`);
}

describe("resolveOidcCallback", () => {
  it("resolves with the code when the state matches", () => {
    const outcome = DesktopOidcLogin.resolveOidcCallback(
      callbackUrl("?code=abc123&state=state-1"),
      "state-1",
    );
    expect(outcome).toEqual({ _tag: "success", result: { code: "abc123" } });
  });

  it("reports a state mismatch without leaking which state was expected", () => {
    const outcome = DesktopOidcLogin.resolveOidcCallback(
      callbackUrl("?code=abc123&state=unexpected"),
      "expected",
    );
    expect(outcome._tag).toBe("state-mismatch");
    if (outcome._tag !== "state-mismatch") throw new Error("unreachable");
    expect(outcome.error).toBeInstanceOf(DesktopOidcLogin.DesktopOidcLoginStateMismatchError);
  });

  it("reports denial with the provider's error_description as the reason", () => {
    const outcome = DesktopOidcLogin.resolveOidcCallback(
      callbackUrl("?error=access_denied&error_description=User+cancelled"),
      "state-1",
    );
    expect(outcome._tag).toBe("denied");
    if (outcome._tag !== "denied") throw new Error("unreachable");
    expect(outcome.error).toBeInstanceOf(DesktopOidcLogin.DesktopOidcLoginDeniedError);
    expect(outcome.error.reason).toBe("User cancelled");
  });

  it("falls back to the bare error code when no error_description is present", () => {
    const outcome = DesktopOidcLogin.resolveOidcCallback(
      callbackUrl("?error=access_denied"),
      "state-1",
    );
    expect(outcome._tag).toBe("denied");
    if (outcome._tag !== "denied") throw new Error("unreachable");
    expect(outcome.error.reason).toBe("access_denied");
  });

  it("treats a denial as taking priority over a missing or mismatched state", () => {
    const outcome = DesktopOidcLogin.resolveOidcCallback(
      callbackUrl("?error=access_denied"),
      "state-1",
    );
    expect(outcome._tag).toBe("denied");
  });

  it("is malformed when the code is missing", () => {
    expect(DesktopOidcLogin.resolveOidcCallback(callbackUrl("?state=state-1"), "state-1")).toEqual({
      _tag: "malformed",
    });
  });

  it("is malformed when the state is missing", () => {
    expect(DesktopOidcLogin.resolveOidcCallback(callbackUrl("?code=abc123"), "state-1")).toEqual({
      _tag: "malformed",
    });
  });
});

describe("error messages", () => {
  it("describe each failure in user-facing terms", () => {
    expect(new DesktopOidcLogin.DesktopOidcLoginAlreadyInProgressError({}).message).toMatch(
      /already in progress/,
    );
    expect(new DesktopOidcLogin.DesktopOidcLoginSupersededError({}).message).toMatch(
      /replaced by a newer attempt/,
    );
    expect(
      new DesktopOidcLogin.DesktopOidcLoginPortUnavailableError({
        port: DesktopOidcLogin.OIDC_LOOPBACK_PORT,
        cause: new Error("EADDRINUSE"),
      }).message,
    ).toContain(String(DesktopOidcLogin.OIDC_LOOPBACK_PORT));
    expect(new DesktopOidcLogin.DesktopOidcLoginBrowserOpenError({}).message).toMatch(/browser/);
    expect(new DesktopOidcLogin.DesktopOidcLoginTimedOutError({}).message).toMatch(/timed out/i);
    expect(new DesktopOidcLogin.DesktopOidcLoginStateMismatchError({}).message).toMatch(
      /did not match/,
    );
    expect(
      new DesktopOidcLogin.DesktopOidcLoginDeniedError({ reason: "denied" }).message,
    ).toContain("denied");
  });
});
