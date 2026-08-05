import * as NodeOS from "node:os";

import type { GrokSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveGrokHomePath = Effect.fn("resolveGrokHomePath")(function* (
  config: Pick<GrokSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeGrokEnvironment = Effect.fn("makeGrokEnvironment")(function* (
  config: Pick<GrokSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveGrokHomePath(config);
  return {
    ...resolvedBaseEnv,
    // GROK_HOME is grok's documented config-dir override (see
    // docs/user-guide/05-configuration.md in the grok install), not a HOME
    // substitute — GROK_HOME overrides the default `~/.grok`, so this instance's
    // auth.json, sessions, and config stay isolated from other instances.
    // No symlink resolution here: grok's sandbox refuses a symlinked GROK_HOME
    // at startup (see docs/user-guide/18-sandbox.md), so the configured path
    // must already be a real directory, seeded by the caller (not by this
    // helper) with symlinks into the managed install's bin/, downloads/, and
    // bundled/ trees.
    GROK_HOME: resolvedHomePath,
  };
});
