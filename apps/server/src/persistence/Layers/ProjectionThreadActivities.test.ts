import { EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadActivityRepository", (it) => {
  it.effect("listUserInputActivitiesByThreadId returns [] for a thread with no activities", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-user-input-activities-empty");

      const rows = yield* repository.listUserInputActivitiesByThreadId({ threadId });
      assert.deepEqual(rows, []);
    }),
  );

  it.effect(
    "listUserInputActivitiesByThreadId excludes other kinds, other threads, and preserves order",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadActivityRepository;
        const threadId = ThreadId.make("thread-user-input-activities-mixed");
        const otherThreadId = ThreadId.make("thread-user-input-activities-other");

        yield* repository.upsert({
          activityId: EventId.make("evt-user-input-requested"),
          threadId,
          turnId: null,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: { requestId: "req-1", questions: [] },
          createdAt: "2026-03-06T00:00:00.000Z",
        });
        // Excluded kind, even though it carries a requestId-shaped payload.
        yield* repository.upsert({
          activityId: EventId.make("evt-approval-requested"),
          threadId,
          turnId: null,
          tone: "approval",
          kind: "approval.requested",
          summary: "Approval requested",
          payload: { requestId: "req-approval-1" },
          createdAt: "2026-03-06T00:00:01.000Z",
        });
        yield* repository.upsert({
          activityId: EventId.make("evt-user-input-resolved"),
          threadId,
          turnId: null,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: { requestId: "req-1", answers: [] },
          createdAt: "2026-03-06T00:00:02.000Z",
        });
        // Different thread — must not be returned even though the kind matches.
        yield* repository.upsert({
          activityId: EventId.make("evt-user-input-requested-other-thread"),
          threadId: otherThreadId,
          turnId: null,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: { requestId: "req-other", questions: [] },
          createdAt: "2026-03-06T00:00:03.000Z",
        });
        yield* repository.upsert({
          activityId: EventId.make("evt-user-input-respond-failed"),
          threadId,
          turnId: null,
          tone: "error",
          kind: "provider.user-input.respond.failed",
          summary: "Runtime error",
          payload: { requestId: "req-2", detail: "unknown pending user-input request" },
          createdAt: "2026-03-06T00:00:04.000Z",
        });
        // Excluded kind unrelated to user input.
        yield* repository.upsert({
          activityId: EventId.make("evt-tool-completed"),
          threadId,
          turnId: null,
          tone: "tool",
          kind: "tool.completed",
          summary: "Tool",
          payload: {},
          createdAt: "2026-03-06T00:00:05.000Z",
        });

        const rows = yield* repository.listUserInputActivitiesByThreadId({ threadId });
        assert.deepEqual(
          rows.map((row) => row.activityId),
          ["evt-user-input-requested", "evt-user-input-resolved", "evt-user-input-respond-failed"],
        );
        assert.deepEqual(
          rows.map((row) => row.kind),
          ["user-input.requested", "user-input.resolved", "provider.user-input.respond.failed"],
        );
      }),
  );
});
