import { CommandId, EventId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { EventLogCompaction } from "../Services/EventLogCompaction.ts";
import { EventLogCompactionLive } from "./EventLogCompaction.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";

const testLayer = (overrides: Parameters<typeof serverSettingsLayerTest>[0] = {}) =>
  EventLogCompactionLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ProjectionStateRepositoryLive),
    Layer.provideMerge(serverSettingsLayerTest(overrides)),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

// Pure — takes an already-resolved `now` (each test reads it once via
// `DateTime.now`, the Clock-backed API `runCompaction` itself uses) rather
// than reaching for `Date`/`Date.now()` directly, per this repo's
// `effect(globalDate)` rule.
const isoDaysBefore = (now: DateTime.Utc, days: number): string =>
  DateTime.formatIso(DateTime.subtract(now, { days }));

const appendMessage = (
  eventStore: OrchestrationEventStore["Service"],
  input: { readonly streamId: string; readonly eventId: string; readonly occurredAt: string },
) =>
  eventStore.append({
    type: "thread.message-sent",
    eventId: EventId.make(input.eventId),
    aggregateKind: "thread",
    aggregateId: ThreadId.make(input.streamId),
    occurredAt: input.occurredAt,
    commandId: CommandId.make(`cmd-${input.eventId}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${input.eventId}`),
    metadata: {},
    payload: {
      threadId: ThreadId.make(input.streamId),
      messageId: MessageId.make(`msg-${input.eventId}`),
      role: "assistant",
      text: "hello",
      turnId: null,
      streaming: false,
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt,
    },
  });

const appendProjectCreated = (
  eventStore: OrchestrationEventStore["Service"],
  input: { readonly projectId: string; readonly eventId: string; readonly occurredAt: string },
) =>
  eventStore.append({
    type: "project.created",
    eventId: EventId.make(input.eventId),
    aggregateKind: "project",
    aggregateId: ProjectId.make(input.projectId),
    occurredAt: input.occurredAt,
    commandId: CommandId.make(`cmd-${input.eventId}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${input.eventId}`),
    metadata: {},
    payload: {
      projectId: ProjectId.make(input.projectId),
      title: "Project",
      workspaceRoot: `/tmp/${input.projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: input.occurredAt,
      updatedAt: input.occurredAt,
    },
  });

const appendProjectMetaUpdated = (
  eventStore: OrchestrationEventStore["Service"],
  input: { readonly projectId: string; readonly eventId: string; readonly occurredAt: string },
) =>
  eventStore.append({
    type: "project.meta-updated",
    eventId: EventId.make(input.eventId),
    aggregateKind: "project",
    aggregateId: ProjectId.make(input.projectId),
    occurredAt: input.occurredAt,
    commandId: CommandId.make(`cmd-${input.eventId}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${input.eventId}`),
    metadata: {},
    payload: {
      projectId: ProjectId.make(input.projectId),
      updatedAt: input.occurredAt,
    },
  });

// Seeds every one of the 9 projectors compaction requires to the same
// watermark, matching the common case where nothing is straggling behind.
const seedAllProjectorWatermarks = (
  sql: SqlClient.SqlClient,
  lastAppliedSequence: number,
  updatedAt: string,
) =>
  sql`
    INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
    VALUES
      (${ORCHESTRATION_PROJECTOR_NAMES.projects}, ${lastAppliedSequence}, ${updatedAt}),
      (${ORCHESTRATION_PROJECTOR_NAMES.threads}, ${lastAppliedSequence}, ${updatedAt}),
      (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, ${lastAppliedSequence}, ${updatedAt}),
      (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, ${lastAppliedSequence}, ${updatedAt}),
      (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, ${lastAppliedSequence}, ${updatedAt}),
      (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, ${lastAppliedSequence}, ${updatedAt}),
      (${ORCHESTRATION_PROJECTOR_NAMES.threadTurns}, ${lastAppliedSequence}, ${updatedAt}),
      (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, ${lastAppliedSequence}, ${updatedAt}),
      (${ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals}, ${lastAppliedSequence}, ${updatedAt})
  `;

it.layer(testLayer({ eventLogRetentionDays: 7 }))(
  "EventLogCompaction.runCompaction — delete predicate",
  (it) => {
    it.effect(
      "deletes old fully-projected non-tip events; retains at/above-watermark, young, and per-stream tip events; advances the floor",
      () =>
        Effect.gen(function* () {
          const eventStore = yield* OrchestrationEventStore;
          const compaction = yield* EventLogCompaction;
          const sql = yield* SqlClient.SqlClient;
          const now = yield* DateTime.now;

          // thread-old: sequence 1, 2 are old + non-tip (eligible). Sequence 3
          // is old too but is the stream's tip — retained regardless of age.
          yield* appendMessage(eventStore, {
            streamId: "thread-old",
            eventId: "evt-1",
            occurredAt: isoDaysBefore(now, 30),
          });
          yield* appendMessage(eventStore, {
            streamId: "thread-old",
            eventId: "evt-2",
            occurredAt: isoDaysBefore(now, 20),
          });
          yield* appendMessage(eventStore, {
            streamId: "thread-old",
            eventId: "evt-3",
            occurredAt: isoDaysBefore(now, 15),
          });

          // thread-active: sequence 4 is old + non-tip (eligible). Sequence 5
          // is below the watermark too but younger than retention — retained
          // regardless of sequence. Sequence 8 (appended below, after the
          // project events) is old but is the tip — retained regardless of age.
          yield* appendMessage(eventStore, {
            streamId: "thread-active",
            eventId: "evt-4",
            occurredAt: isoDaysBefore(now, 30),
          });
          yield* appendMessage(eventStore, {
            streamId: "thread-active",
            eventId: "evt-5",
            occurredAt: isoDaysBefore(now, 1),
          });

          // project-a: sequence 6 is old but sits exactly at the watermark
          // cutoff (not below it) — retained regardless of age. Sequence 7 is
          // old and above the watermark, and also the tip — retained twice over.
          yield* appendProjectCreated(eventStore, {
            projectId: "project-a",
            eventId: "evt-6",
            occurredAt: isoDaysBefore(now, 30),
          });
          yield* appendProjectMetaUpdated(eventStore, {
            projectId: "project-a",
            eventId: "evt-7",
            occurredAt: isoDaysBefore(now, 25),
          });

          yield* appendMessage(eventStore, {
            streamId: "thread-active",
            eventId: "evt-8",
            occurredAt: isoDaysBefore(now, 25),
          });

          // Every projector has applied through sequence 6 -> cutoffSequence
          // = 6. Only sequence < 6 is even watermark-eligible.
          yield* seedAllProjectorWatermarks(sql, 6, isoDaysBefore(now, 0));

          const report = yield* compaction.runCompaction;

          assert.equal(report.skippedReason, undefined);
          assert.equal(report.deletedEvents, 3);
          assert.equal(report.floorSequence, 4);
          assert.equal(report.vacuumed, false);

          const remaining = yield* sql<{ readonly sequence: number }>`
            SELECT sequence FROM orchestration_events ORDER BY sequence ASC
          `;
          assert.deepEqual(
            remaining.map((row) => row.sequence),
            [3, 5, 6, 7, 8],
          );

          const floorRows = yield* sql<{ readonly floorSequence: number }>`
            SELECT floor_sequence AS "floorSequence" FROM orchestration_log_compaction WHERE id = 1
          `;
          assert.equal(floorRows[0]?.floorSequence, 4);

          const compactionFloor = yield* compaction.compactionFloor;
          assert.equal(compactionFloor, 4);
        }),
    );
  },
);

it.layer(testLayer({ eventLogRetentionDays: 1 }))(
  "EventLogCompaction.runCompaction — append after compaction",
  (it) => {
    it.effect(
      "continues stream_version from the surviving tip after its earlier events are compacted away",
      () =>
        Effect.gen(function* () {
          const eventStore = yield* OrchestrationEventStore;
          const compaction = yield* EventLogCompaction;
          const sql = yield* SqlClient.SqlClient;
          const now = yield* DateTime.now;

          yield* appendMessage(eventStore, {
            streamId: "thread-append-check",
            eventId: "evt-1",
            occurredAt: isoDaysBefore(now, 10),
          });
          yield* appendMessage(eventStore, {
            streamId: "thread-append-check",
            eventId: "evt-2",
            occurredAt: isoDaysBefore(now, 10),
          });
          yield* appendMessage(eventStore, {
            streamId: "thread-append-check",
            eventId: "evt-3",
            occurredAt: isoDaysBefore(now, 10),
          });

          // Comfortably above all 3 seeded sequences: every one is
          // watermark-eligible, so only the tip-protection rule survives.
          yield* seedAllProjectorWatermarks(sql, 100, isoDaysBefore(now, 0));

          const report = yield* compaction.runCompaction;
          assert.equal(report.deletedEvents, 2);

          const remainingBefore = yield* sql<{
            readonly sequence: number;
            readonly streamVersion: number;
          }>`
            SELECT sequence, stream_version AS "streamVersion"
            FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = 'thread-append-check'
            ORDER BY sequence ASC
          `;
          assert.deepEqual(
            remainingBefore.map((row) => row.sequence),
            [3],
          );
          assert.equal(remainingBefore[0]?.streamVersion, 2);

          yield* appendMessage(eventStore, {
            streamId: "thread-append-check",
            eventId: "evt-4",
            occurredAt: isoDaysBefore(now, 0),
          });

          const rowsAfter = yield* sql<{ readonly streamVersion: number }>`
            SELECT stream_version AS "streamVersion"
            FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = 'thread-append-check'
            ORDER BY sequence ASC
          `;
          assert.deepEqual(
            rowsAfter.map((row) => row.streamVersion),
            [2, 3],
          );
        }),
    );
  },
);

it.layer(testLayer({ eventLogRetentionDays: 0 }))(
  "EventLogCompaction.runCompaction — retention disabled",
  (it) => {
    it.effect("skips without deleting anything when eventLogRetentionDays <= 0", () =>
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        const compaction = yield* EventLogCompaction;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;

        yield* appendMessage(eventStore, {
          streamId: "thread-a",
          eventId: "evt-1",
          occurredAt: isoDaysBefore(now, 999),
        });
        yield* seedAllProjectorWatermarks(sql, 100, isoDaysBefore(now, 0));

        const report = yield* compaction.runCompaction;
        assert.equal(report.skippedReason, "retention-disabled");
        assert.equal(report.deletedEvents, 0);
        assert.equal(report.floorSequence, 0);
        assert.equal(report.vacuumed, false);

        const remaining = yield* sql<{ readonly sequence: number }>`
          SELECT sequence FROM orchestration_events
        `;
        assert.equal(remaining.length, 1);
      }),
    );
  },
);

it.layer(testLayer({ eventLogRetentionDays: 14 }))(
  "EventLogCompaction.runCompaction — incomplete projector watermarks",
  (it) => {
    it.effect(
      "skips without deleting anything when a projector has no projection_state row yet",
      () =>
        Effect.gen(function* () {
          const eventStore = yield* OrchestrationEventStore;
          const compaction = yield* EventLogCompaction;
          const sql = yield* SqlClient.SqlClient;
          const now = yield* DateTime.now;

          yield* appendMessage(eventStore, {
            streamId: "thread-a",
            eventId: "evt-1",
            occurredAt: isoDaysBefore(now, 999),
          });

          // Seed only 8 of the 9 required projectors — omit pendingApprovals.
          const updatedAt = isoDaysBefore(now, 0);
          yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES
            (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 100, ${updatedAt}),
            (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 100, ${updatedAt}),
            (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 100, ${updatedAt}),
            (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 100, ${updatedAt}),
            (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 100, ${updatedAt}),
            (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 100, ${updatedAt}),
            (${ORCHESTRATION_PROJECTOR_NAMES.threadTurns}, 100, ${updatedAt}),
            (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 100, ${updatedAt})
        `;

          const report = yield* compaction.runCompaction;
          assert.equal(report.skippedReason, "projector-watermarks-incomplete");
          assert.equal(report.deletedEvents, 0);

          const remaining = yield* sql<{ readonly sequence: number }>`
          SELECT sequence FROM orchestration_events
        `;
          assert.equal(remaining.length, 1);
        }),
    );
  },
);

it.layer(testLayer({ eventLogRetentionDays: 1 }))(
  "EventLogCompaction.runCompaction — floor monotonicity",
  (it) => {
    it.effect("keeps the previous floor when a later run deletes nothing", () =>
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        const compaction = yield* EventLogCompaction;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;

        yield* appendMessage(eventStore, {
          streamId: "thread-mono",
          eventId: "evt-1",
          occurredAt: isoDaysBefore(now, 10),
        });
        yield* appendMessage(eventStore, {
          streamId: "thread-mono",
          eventId: "evt-2",
          occurredAt: isoDaysBefore(now, 10),
        });
        yield* seedAllProjectorWatermarks(sql, 100, isoDaysBefore(now, 0));

        const firstReport = yield* compaction.runCompaction;
        assert.equal(firstReport.deletedEvents, 1);
        assert.equal(firstReport.floorSequence, 1);

        const secondReport = yield* compaction.runCompaction;
        assert.equal(secondReport.deletedEvents, 0);
        assert.equal(secondReport.floorSequence, 1);
        assert.equal(secondReport.skippedReason, undefined);

        const compactionFloor = yield* compaction.compactionFloor;
        assert.equal(compactionFloor, 1);
      }),
    );
  },
);
