import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { makeGrokEnvironment, resolveGrokHomePath } from "./GrokHome.ts";

it.layer(NodeServices.layer)("GrokHome", (it) => {
  describe("Grok home resolution", () => {
    it.effect("uses the process home when no Grok home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveGrokHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeGrokEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Grok HOME and sets GROK_HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.grok-work";
        const resolved = path.resolve(NodeOS.homedir(), ".grok-work");

        expect(yield* resolveGrokHomePath({ homePath })).toBe(resolved);
        expect((yield* makeGrokEnvironment({ homePath })).GROK_HOME).toBe(resolved);
      }),
    );

    it.effect("preserves the rest of the base environment when GROK_HOME is set", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.grok-work";
        const resolved = path.resolve(NodeOS.homedir(), ".grok-work");
        const baseEnv = { XAI_API_KEY: "secret", PATH: "/usr/bin" };

        const env = yield* makeGrokEnvironment({ homePath }, baseEnv);
        expect(env).toEqual({ ...baseEnv, GROK_HOME: resolved });
      }),
    );
  });
});
