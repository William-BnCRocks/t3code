import { assert, describe, it } from "@effect/vitest";

import {
  DEEP_LINK_MAX_PROMPT_LENGTH,
  findDeepLinkInArgv,
  parseDesktopDeepLink,
} from "./desktopDeepLinks.ts";

describe("parseDesktopDeepLink", () => {
  it("parses the production scheme with a query-string prompt", () => {
    const link = parseDesktopDeepLink("t3code://new?prompt=hello%20world", {
      isDevelopment: false,
    });
    assert.deepEqual(link, { kind: "new-thread", prompt: "hello world" });
  });

  it("parses the development scheme", () => {
    const link = parseDesktopDeepLink("t3code-dev://new?prompt=hi", { isDevelopment: true });
    assert.deepEqual(link, { kind: "new-thread", prompt: "hi" });
  });

  it("rejects the production scheme when running in development", () => {
    assert.isNull(parseDesktopDeepLink("t3code://new?prompt=hi", { isDevelopment: true }));
  });

  it("rejects the development scheme when running in production", () => {
    assert.isNull(parseDesktopDeepLink("t3code-dev://new?prompt=hi", { isDevelopment: false }));
  });

  it("rejects the app host (renderer document origin)", () => {
    assert.isNull(parseDesktopDeepLink("t3code://app/", { isDevelopment: false }));
    assert.isNull(parseDesktopDeepLink("t3code://app/settings", { isDevelopment: false }));
    assert.isNull(parseDesktopDeepLink("t3code:app", { isDevelopment: false }));
  });

  it("rejects unknown hosts", () => {
    assert.isNull(parseDesktopDeepLink("t3code://unknown", { isDevelopment: false }));
  });

  it("rejects a completely different scheme", () => {
    assert.isNull(parseDesktopDeepLink("https://new?prompt=hi", { isDevelopment: false }));
  });

  it("rejects malformed URLs", () => {
    assert.isNull(parseDesktopDeepLink("not a url at all", { isDevelopment: false }));
  });

  it("returns a null prompt when the query param is missing", () => {
    const link = parseDesktopDeepLink("t3code://new", { isDevelopment: false });
    assert.deepEqual(link, { kind: "new-thread", prompt: null });
  });

  it("returns a null prompt when the query param is present but empty", () => {
    const link = parseDesktopDeepLink("t3code://new?prompt=", { isDevelopment: false });
    assert.deepEqual(link, { kind: "new-thread", prompt: null });
  });

  it("handles the host form with a trailing slash", () => {
    const link = parseDesktopDeepLink("t3code://new/?prompt=hi", { isDevelopment: false });
    assert.deepEqual(link, { kind: "new-thread", prompt: "hi" });
  });

  it("handles the host form with a bare trailing slash and no query", () => {
    const link = parseDesktopDeepLink("t3code://new/", { isDevelopment: false });
    assert.deepEqual(link, { kind: "new-thread", prompt: null });
  });

  it("handles the opaque (no-slash) form", () => {
    const link = parseDesktopDeepLink("t3code:new?prompt=hi", { isDevelopment: false });
    assert.deepEqual(link, { kind: "new-thread", prompt: "hi" });
  });

  it("decodes encoded spaces, newlines, unicode, and ampersands in the prompt", () => {
    const link = parseDesktopDeepLink("t3code://new?prompt=line1%0Aline2%20%F0%9F%98%80%20a%26b", {
      isDevelopment: false,
    });
    assert.deepEqual(link, { kind: "new-thread", prompt: "line1\nline2 😀 a&b" });
  });

  it("truncates prompts longer than the defensive cap", () => {
    const longPrompt = "x".repeat(DEEP_LINK_MAX_PROMPT_LENGTH + 500);
    const link = parseDesktopDeepLink(`t3code://new?prompt=${encodeURIComponent(longPrompt)}`, {
      isDevelopment: false,
    });
    assert.isNotNull(link);
    assert.equal(link?.prompt?.length, DEEP_LINK_MAX_PROMPT_LENGTH);
  });
});

describe("findDeepLinkInArgv", () => {
  it("finds a deep link among other argv entries", () => {
    const argv = ["/usr/bin/t3code", "--allow-file-access-from-files", "t3code://new?prompt=hi"];
    assert.equal(findDeepLinkInArgv(argv, { isDevelopment: false }), "t3code://new?prompt=hi");
  });

  it("returns null when no argv entry matches the accepted scheme", () => {
    const argv = ["/usr/bin/t3code", "--some-flag", "some/path"];
    assert.isNull(findDeepLinkInArgv(argv, { isDevelopment: false }));
  });

  it("ignores installer/chromium flag noise mixed in with the link", () => {
    const argv = [
      "C:\\Program Files\\T3 Code\\T3 Code.exe",
      "--single-argument-mode",
      "--allow-file-access-from-files",
      "t3code://new?prompt=build%20me%20a%20thing",
      "--original-process-start-time=1234",
    ];
    assert.equal(
      findDeepLinkInArgv(argv, { isDevelopment: false }),
      "t3code://new?prompt=build%20me%20a%20thing",
    );
  });

  it("returns the last matching entry when multiple are present", () => {
    const argv = ["t3code://new?prompt=first", "t3code://new?prompt=second"];
    assert.equal(findDeepLinkInArgv(argv, { isDevelopment: false }), "t3code://new?prompt=second");
  });

  it("only matches the scheme for the active build flavor", () => {
    const argv = ["t3code-dev://new?prompt=hi"];
    assert.isNull(findDeepLinkInArgv(argv, { isDevelopment: false }));
    assert.equal(findDeepLinkInArgv(argv, { isDevelopment: true }), "t3code-dev://new?prompt=hi");
  });
});
