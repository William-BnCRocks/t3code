import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeAccountRateLimitsUpdatedEvent,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import { ProviderUsageLog, ProviderUsageLogLive } from "./ProviderUsageLog.ts";

const makeServerConfigLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-usage-log-test-" });

const testLayer = () => ProviderUsageLogLive.pipe(Layer.provideMerge(makeServerConfigLayer()));

function makeEvent(
  overrides: Partial<ProviderRuntimeAccountRateLimitsUpdatedEvent> = {},
): ProviderRuntimeAccountRateLimitsUpdatedEvent {
  return {
    eventId: EventId.make("evt-rate-limits-1"),
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex_personal"),
    threadId: ThreadId.make("thread-1"),
    createdAt: "2026-03-15T00:00:00.000Z",
    type: "account.rate-limits.updated",
    payload: { rateLimits: { primary: { usedPercent: 10 } } },
    ...overrides,
  };
}

function readJsonLines(contents: string): Array<Record<string, unknown>> {
  return contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

it.layer(NodeServices.layer)("ProviderUsageLog", (it) => {
  it.effect("writes one JSON line per distinct payload and dedupes identical repeats", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-03-15T12:00:00.000Z"));
      const usageLog = yield* ProviderUsageLog;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;

      const first = makeEvent();
      yield* usageLog.record(first);
      // Identical payload, different eventId: still a duplicate for this instance.
      yield* usageLog.record(makeEvent({ eventId: EventId.make("evt-rate-limits-1-again") }));

      const changed = makeEvent({
        eventId: EventId.make("evt-rate-limits-2"),
        payload: { rateLimits: { primary: { usedPercent: 42 } } },
      });
      yield* usageLog.record(changed);

      const filePath = path.join(stateDir, "usage", "rate-limits-202603.jsonl");
      const contents = yield* fs.readFileString(filePath);
      const lines = readJsonLines(contents);

      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[0]?.eventId, "evt-rate-limits-1");
      assert.strictEqual(lines[0]?.provider, "codex");
      assert.strictEqual(lines[0]?.providerInstanceId, "codex_personal");
      assert.strictEqual(lines[0]?.threadId, "thread-1");
      assert.strictEqual(typeof lines[0]?.observedAt, "string");
      assert.deepStrictEqual(lines[0]?.rateLimits, { primary: { usedPercent: 10 } });

      assert.strictEqual(lines[1]?.eventId, "evt-rate-limits-2");
      assert.deepStrictEqual(lines[1]?.rateLimits, { primary: { usedPercent: 42 } });
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("names the file after the observed month", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-02T00:00:00.000Z"));
      const usageLog = yield* ProviderUsageLog;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;

      yield* usageLog.record(makeEvent());

      const filePath = path.join(stateDir, "usage", "rate-limits-202611.jsonl");
      const exists = yield* fs.exists(filePath);
      assert.isTrue(exists);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("stays fail-open and logs a warning when the write fails", () => {
    const messages: Array<unknown> = [];
    const logger = Logger.make<unknown, void>((options) => {
      if (Array.isArray(options.message)) {
        messages.push(...options.message);
      } else {
        messages.push(options.message);
      }
    });

    const failingFileSystemLayer = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return {
          ...fileSystem,
          writeFileString: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "writeFileString",
                pathOrDescriptor: "rate-limits.jsonl",
                description: "simulated write failure",
              }),
            ),
        } satisfies FileSystem.FileSystem;
      }),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const usageLog = yield* ProviderUsageLog;

      // Must not fail (and must not throw) even though every write fails.
      yield* usageLog.record(makeEvent());

      const warning = messages.find(
        (message): message is string =>
          typeof message === "string" &&
          message.includes("provider usage log failed to persist rate-limit snapshot"),
      );
      assert.exists(warning);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Logger.layer([logger], { mergeWithExisting: false }),
          ProviderUsageLogLive.pipe(
            Layer.provide(makeServerConfigLayer()),
            Layer.provideMerge(failingFileSystemLayer),
          ),
        ),
      ),
    );
  });
});
