/**
 * EventLogCompactionLive - periodic truncation of fully-projected, expired
 * `orchestration_events` rows.
 *
 * Lifecycle mirrors other self-starting background layers in this codebase
 * (e.g. `ProviderRegistry.ts`): the compaction floor is loaded from
 * `orchestration_log_compaction` synchronously at layer construction, then a
 * `forkScoped` loop sleeps briefly to let the server settle, runs a
 * compaction pass, and repeats every 24 hours. Loop failures are logged and
 * swallowed — a bad cycle never crashes the server, and the next cycle
 * retries from scratch.
 *
 * See docs/architecture/event-log-compaction.md for the delete predicate,
 * the per-stream tip invariant, and the ws.ts replay guards that depend on
 * the floor this layer maintains.
 *
 * @module EventLogCompactionLive
 */
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  EventLogCompaction,
  type CompactionReport,
  type EventLogCompactionError,
  type EventLogCompactionShape,
} from "../Services/EventLogCompaction.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";

// Bounds each DELETE's row count so a single statement never holds a long
// write against a hot table. Batches run as their own implicit (autocommit)
// transactions — the loop deliberately never wraps the whole run in one
// transaction, or WAL growth would be unbounded for the run's duration.
const COMPACTION_BATCH_SIZE = 5000;

// Let the rest of server startup settle before the first compaction pass.
const INITIAL_COMPACTION_DELAY = Duration.seconds(30);
const COMPACTION_INTERVAL = Duration.hours(24);

// VACUUM only when the freelist is both large in absolute terms and a
// meaningful fraction of the file — small/sparse freelists get reused by
// new events anyway, so vacuuming them would just trade disk churn for no
// lasting benefit.
const FREELIST_BYTES_VACUUM_THRESHOLD = 256 * 1024 * 1024;
const FREELIST_RATIO_VACUUM_THRESHOLD = 0.2;

interface PageStats {
  readonly pageCount: number;
  readonly freelistCount: number;
  readonly pageSize: number;
}

const makeEventLogCompaction = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectionStateRepository = yield* ProjectionStateRepository;
  const serverSettings = yield* ServerSettingsService;

  const readPageStats = (): Effect.Effect<PageStats, EventLogCompactionError> =>
    sql<PageStats>`
      SELECT
        (SELECT page_count FROM pragma_page_count()) AS "pageCount",
        (SELECT freelist_count FROM pragma_freelist_count()) AS "freelistCount",
        (SELECT page_size FROM pragma_page_size()) AS "pageSize"
    `.pipe(
      Effect.mapError(toPersistenceSqlError("EventLogCompaction.run:readPageStats")),
      Effect.map((rows) => rows[0] ?? { pageCount: 0, freelistCount: 0, pageSize: 0 }),
    );

  // Bare Effect value (not a function) per the service Shape — reusable,
  // re-executed fresh on every `yield*`/repeat, exactly like
  // `OrchestrationProjectionPipelineShape["bootstrap"]`.
  const runCompaction: EventLogCompactionShape["runCompaction"] = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const retentionDays = settings.eventLogRetentionDays;

    if (retentionDays <= 0) {
      const floorSequence = yield* Ref.get(floorRef);
      const report: CompactionReport = {
        deletedEvents: 0,
        floorSequence,
        vacuumed: false,
        skippedReason: "retention-disabled",
      };
      yield* Effect.logInfo("event log compaction skipped").pipe(
        Effect.annotateLogs({ ...report }),
      );
      return report;
    }

    const projectorRows = yield* projectionStateRepository.listAll();
    const watermarkByProjector = new Map(
      projectorRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
    );

    // cutoffSequence = min(last_applied_sequence) over all 9 projectors —
    // events at or above it have not been seen by every projector yet, so
    // they are never eligible no matter how old they are.
    let cutoffSequence = Number.POSITIVE_INFINITY;
    let missingProjector: string | undefined;
    for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
      const watermark = watermarkByProjector.get(projector);
      if (watermark === undefined) {
        missingProjector = projector;
        break;
      }
      if (watermark < cutoffSequence) {
        cutoffSequence = watermark;
      }
    }

    if (missingProjector !== undefined) {
      const floorSequence = yield* Ref.get(floorRef);
      const report: CompactionReport = {
        deletedEvents: 0,
        floorSequence,
        vacuumed: false,
        skippedReason: "projector-watermarks-incomplete",
      };
      yield* Effect.logInfo("event log compaction skipped").pipe(
        Effect.annotateLogs({ ...report, missingProjector }),
      );
      return report;
    }

    const now = yield* DateTime.now;
    // occurred_at is ISO TEXT, so lexicographic comparison is chronological.
    const cutoffIso = DateTime.formatIso(DateTime.subtract(now, { days: retentionDays }));

    // Retaining each stream's newest event keeps the append path's
    // `COALESCE(MAX(stream_version) + 1, 0)` subquery producing
    // monotonically increasing versions with zero changes to the event
    // store — compaction is invisible to that invariant. The retained-tip
    // set is materialized ONCE per run: recomputing the GROUP BY inside
    // every batch costs seconds per batch on a large table, all spent on
    // the connection the live server shares. Freezing it is conservative —
    // a tip superseded by a mid-run append is merely retained one extra
    // cycle, and brand-new events can never become candidates because
    // their sequences are at or above every projector watermark, hence
    // >= cutoffSequence.
    //
    // Row count and the floor both come from `RETURNING` rather than
    // `SELECT changes()` or an upfront MAX estimate: this connection is
    // shared with the rest of the live server, so any second statement
    // would race whatever else executes between the two calls. `RETURNING`
    // reports exactly what each statement deleted, so the floor below is
    // exact by construction.
    let deletedEvents = 0;
    let maxDeletedSequence = 0;
    yield* sql`DROP TABLE IF EXISTS temp.compaction_retained_tips`.pipe(
      Effect.mapError(toPersistenceSqlError("EventLogCompaction.run:dropTipsTable")),
    );
    yield* sql`
      CREATE TEMP TABLE compaction_retained_tips AS
      SELECT MAX(sequence) AS sequence
      FROM orchestration_events
      GROUP BY aggregate_kind, stream_id
    `.pipe(Effect.mapError(toPersistenceSqlError("EventLogCompaction.run:createTipsTable")));
    yield* Effect.gen(function* () {
      while (true) {
        const deletedRows = yield* sql<{ readonly sequence: number }>`
          DELETE FROM orchestration_events
          WHERE rowid IN (
            SELECT rowid FROM orchestration_events
            WHERE sequence < ${cutoffSequence}
              AND occurred_at < ${cutoffIso}
              AND sequence NOT IN (SELECT sequence FROM temp.compaction_retained_tips)
            LIMIT ${COMPACTION_BATCH_SIZE}
          )
          RETURNING sequence
        `.pipe(Effect.mapError(toPersistenceSqlError("EventLogCompaction.run:deleteBatch")));
        deletedEvents += deletedRows.length;
        for (const row of deletedRows) {
          if (row.sequence > maxDeletedSequence) {
            maxDeletedSequence = row.sequence;
          }
        }
        if (deletedRows.length === 0) {
          break;
        }
      }
    }).pipe(
      // The temp table lives on the shared long-lived connection, so drop it
      // even when a batch fails — the next run recreates it from scratch.
      Effect.ensuring(sql`DROP TABLE IF EXISTS temp.compaction_retained_tips`.pipe(Effect.ignore)),
    );

    let floorSequence = yield* Ref.get(floorRef);
    let vacuumed = false;

    if (deletedEvents > 0) {
      floorSequence = Math.max(floorSequence, maxDeletedSequence);
      const nowIso = DateTime.formatIso(now);
      yield* sql`
        INSERT INTO orchestration_log_compaction (id, floor_sequence, last_run_at)
        VALUES (1, ${floorSequence}, ${nowIso})
        ON CONFLICT (id) DO UPDATE SET
          floor_sequence = excluded.floor_sequence,
          last_run_at = excluded.last_run_at
      `.pipe(Effect.mapError(toPersistenceSqlError("EventLogCompaction.run:upsertFloor")));
      yield* Ref.set(floorRef, floorSequence);

      yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(
        Effect.mapError(toPersistenceSqlError("EventLogCompaction.run:checkpoint")),
      );

      const pageStatsBefore = yield* readPageStats();
      const freelistBytes = pageStatsBefore.freelistCount * pageStatsBefore.pageSize;
      const freelistRatio =
        pageStatsBefore.pageCount > 0
          ? pageStatsBefore.freelistCount / pageStatsBefore.pageCount
          : 0;

      if (
        freelistBytes > FREELIST_BYTES_VACUUM_THRESHOLD &&
        freelistRatio > FREELIST_RATIO_VACUUM_THRESHOLD
      ) {
        yield* sql`VACUUM`.pipe(
          Effect.mapError(toPersistenceSqlError("EventLogCompaction.run:vacuum")),
        );
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(
          Effect.mapError(toPersistenceSqlError("EventLogCompaction.run:postVacuumCheckpoint")),
        );
        const pageStatsAfter = yield* readPageStats();
        vacuumed = true;
        yield* Effect.logInfo("event log compaction vacuumed").pipe(
          Effect.annotateLogs({
            pageCountBefore: pageStatsBefore.pageCount,
            pageCountAfter: pageStatsAfter.pageCount,
          }),
        );
      }
    }

    const report: CompactionReport = { deletedEvents, floorSequence, vacuumed };
    yield* Effect.logInfo("event log compaction run completed").pipe(
      Effect.annotateLogs({ ...report }),
    );
    return report;
  }).pipe(Effect.withSpan("EventLogCompaction.run"));

  const floorRows = yield* sql<{ readonly floorSequence: number }>`
    SELECT floor_sequence AS "floorSequence" FROM orchestration_log_compaction WHERE id = 1
  `.pipe(Effect.mapError(toPersistenceSqlError("EventLogCompaction.make:readFloor")));
  const initialFloor = floorRows[0]?.floorSequence ?? 0;
  const floorRef = yield* Ref.make(initialFloor);

  // Diagnostic-only: a projector behind the persisted floor means events it
  // still needs to catch up on may already be gone. This never blocks
  // layer construction — it only warns so the gap gets noticed and fixed
  // with a backfill migration (see the module doc comment).
  yield* Effect.gen(function* () {
    if (initialFloor === 0) {
      return;
    }
    const projectorRows = yield* projectionStateRepository.listAll();
    const watermarkByProjector = new Map(
      projectorRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
    );
    for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
      const watermark = watermarkByProjector.get(projector) ?? 0;
      if (watermark < initialFloor) {
        yield* Effect.logWarning(
          "projection older than compaction floor — a backfill migration is required; see docs/architecture/event-log-compaction.md",
        ).pipe(Effect.annotateLogs({ projector, watermark, compactionFloor: initialFloor }));
      }
    }
  }).pipe(
    Effect.catch((error: unknown) =>
      Effect.logWarning("event log compaction startup watermark check failed", { error }),
    ),
  );

  const compactionLoopPass = runCompaction.pipe(
    Effect.catch((error: EventLogCompactionError) =>
      Effect.logWarning("event log compaction run failed", { error }),
    ),
    Effect.catchDefect((defect: unknown) =>
      Effect.logWarning("event log compaction run defect", { defect }),
    ),
  );

  yield* Effect.forkScoped(
    Effect.sleep(INITIAL_COMPACTION_DELAY).pipe(
      Effect.andThen(compactionLoopPass.pipe(Effect.repeat(Schedule.spaced(COMPACTION_INTERVAL)))),
    ),
  );

  return {
    compactionFloor: Ref.get(floorRef),
    runCompaction,
  } satisfies EventLogCompactionShape;
});

export const EventLogCompactionLive = Layer.effect(EventLogCompaction, makeEventLogCompaction);
