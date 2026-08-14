import { describe, expect, it } from "vite-plus/test";

import { canReplayThreadFromCursor, shouldFallBackToShellSnapshot } from "./ws.ts";

describe("shouldFallBackToShellSnapshot", () => {
  it("falls back when the gap is negative (cursor ahead of the engine head)", () => {
    expect(shouldFallBackToShellSnapshot(-1, 10, 0)).toBe(true);
  });

  it("falls back when the gap exceeds SHELL_RESUME_MAX_GAP", () => {
    expect(shouldFallBackToShellSnapshot(1_001, 10, 0)).toBe(true);
  });

  it("falls back when the cursor is below the compaction floor", () => {
    expect(shouldFallBackToShellSnapshot(5, 10, 11)).toBe(true);
  });

  it("does not fall back when the cursor equals the compaction floor", () => {
    expect(shouldFallBackToShellSnapshot(5, 10, 10)).toBe(false);
  });

  it("does not fall back for a small, valid, at-or-above-floor gap", () => {
    expect(shouldFallBackToShellSnapshot(5, 10, 0)).toBe(false);
    expect(shouldFallBackToShellSnapshot(1_000, 10, 0)).toBe(false);
  });
});

describe("canReplayThreadFromCursor", () => {
  it("returns false when there is no cursor", () => {
    expect(canReplayThreadFromCursor(undefined, 0)).toBe(false);
  });

  it("returns false when the cursor is below the compaction floor", () => {
    expect(canReplayThreadFromCursor(9, 10)).toBe(false);
  });

  it("returns true when the cursor equals the compaction floor", () => {
    expect(canReplayThreadFromCursor(10, 10)).toBe(true);
  });

  it("returns true when the cursor is above the compaction floor", () => {
    expect(canReplayThreadFromCursor(11, 10)).toBe(true);
  });

  it("returns true for any cursor when the floor is zero (never compacted)", () => {
    expect(canReplayThreadFromCursor(0, 0)).toBe(true);
  });
});
