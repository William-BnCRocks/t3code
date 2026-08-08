import { describe, expect, it } from "vite-plus/test";

import { describeMissingTokenFailure } from "./useCloudLinkController";

describe("describeMissingTokenFailure", () => {
  it("asks a signed-out user to sign in", () => {
    expect(describeMissingTokenFailure(false)).toBe("Sign in to T3 Connect before enabling this.");
  });

  it("reports a refresh failure instead of a sign-out prompt when already signed in", () => {
    expect(describeMissingTokenFailure(true)).toBe(
      "Could not refresh your T3 Connect session. Check your connection and try again.",
    );
  });
});
