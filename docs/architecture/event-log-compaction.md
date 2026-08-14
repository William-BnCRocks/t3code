# Event Log Compaction

`orchestration_events` is append-only in the sense that nothing ever mutates a row, but it is not
kept forever. `EventLogCompaction` periodically deletes events that are both fully projected and
older than a configurable retention window, so the table stays bounded on a long-lived server
instead of growing every day the server has run.

## Why deleting old events is safe

The engine's command read model is rebuilt at startup from projections
(`ProjectionSnapshotQuery.getCommandReadModel`), not by replaying the event log from sequence 0.
Projections in `projection_state` are the durable snapshot; events below every projector's
watermark exist only for two things once they are applied: client replay on reconnect, and audit.
Deleting an event that every projector has already applied, and that is old enough that a client
is unlikely to still be resuming from before it, removes neither.

## What gets deleted, and what never does

A pass deletes rows matching all three conditions:

```sql
DELETE FROM orchestration_events
WHERE rowid IN (
  SELECT rowid FROM orchestration_events
  WHERE sequence < cutoffSequence
    AND occurred_at < cutoffIso
    AND sequence NOT IN (
      SELECT MAX(sequence) FROM orchestration_events GROUP BY aggregate_kind, stream_id
    )
  LIMIT 5000
)
RETURNING sequence
```

- `cutoffSequence` is the minimum `last_applied_sequence` across all 9 projectors in
  `projection_state` (`ORCHESTRATION_PROJECTOR_NAMES` in `ProjectionPipeline.ts`). An event at or
  above it has not been seen by every projector yet and is never eligible, no matter how old.
- `cutoffIso` is now minus `eventLogRetentionDays`. `occurred_at` is ISO text, so a lexicographic
  comparison is a chronological one.
- The `NOT IN` subquery protects each stream's newest event unconditionally. This is the
  **per-stream tip invariant**: `OrchestrationEventStore`'s append path computes the next
  `stream_version` with `COALESCE((SELECT stream_version + 1 FROM orchestration_events WHERE
aggregate_kind = ... AND stream_id = ... ORDER BY stream_version DESC LIMIT 1), 0)`. As long as
  that row exists, versions keep increasing correctly with zero changes to the event store —
  compaction never has to know about stream versioning, it just never deletes the row that query
  depends on.

Deletion runs in batches of 5000, each its own implicit (autocommit) transaction — the whole pass
is never wrapped in one transaction, which is what keeps WAL growth bounded during a large first
run against an old database. After deleting anything, the pass runs `PRAGMA wal_checkpoint
(TRUNCATE)`, and additionally runs `VACUUM` (then checkpoints again) when the freelist is both
over 256MB and over 20% of the file — small freelists get reused by new events anyway, so
vacuuming them would trade disk churn for no lasting benefit.

## The compaction floor

`orchestration_log_compaction` is a single-row table holding `floor_sequence` (the highest
sequence any pass has ever deleted) and `last_run_at`. `EventLogCompactionService.compactionFloor`
exposes it in memory as a `Ref`, loaded at layer construction and advanced after every pass that
deletes something.

The floor only ever grows, and it is **exact by construction**: every delete batch uses
`RETURNING sequence`, and a pass folds the maximum returned sequence into the floor if anything
was actually deleted. There is no estimate to race. The retained-tip set is materialized once per
pass (recomputing the GROUP BY per batch costs seconds each on a large table, on the connection
the live server shares); freezing it errs conservative — a tip superseded by a mid-run append is
retained one extra cycle and picked up by the next pass.

Semantics for consumers: a replay from `afterSequence` is complete **iff** `afterSequence >=
compactionFloor`. Retained per-stream tip events below the floor do not make an otherwise-stale
replay complete — a client resuming from below the floor may be missing events that were deleted,
even if the one event it cares about happens to still be there.

## The ws.ts resync guards

Two `ws.ts` replay paths read `compactionFloor` before deciding whether a cursor-based resume is
safe:

- **Shell resume** (`subscribeShell`, `shouldFallBackToShellSnapshot`): already fell back to a
  full shell snapshot when the client's cursor was too far behind the head
  (`replayGap > SHELL_RESUME_MAX_GAP`) or invalid (`replayGap < 0`). Compaction adds a third
  condition to the same fallback: `afterSequence < compactionFloor`.
- **Thread catch-up replay** (`subscribeThread`, `canReplayThreadFromCursor`): previously took the
  catch-up branch whenever the client sent any `afterSequence`. It now also requires
  `afterSequence >= compactionFloor`; failing that, the request falls through to the existing
  full-snapshot branch instead of attempting a replay that could be silently missing events.

Both helpers are pure functions exported from `ws.ts` and unit tested directly in `ws.test.ts`, so
the boundary conditions don't need a database.

Engine-internal reads — projection bootstrap and dispatch-failure reconcile — never need this
guard. They always read from at or above the min projector watermark, which only grows, so they
can never land below the compaction floor.

## The retention setting

`eventLogRetentionDays` (in `ServerSettings`, default 14) controls the pass's age cutoff. Setting
it to 0 or less disables compaction entirely — `runCompaction` returns immediately with
`skippedReason: "retention-disabled"` and deletes nothing. A pass also skips (`skippedReason:
"projector-watermarks-incomplete"`) when fewer than all 9 projectors have a row in
`projection_state` yet, which is normal for the first few seconds after a fresh database's
projectors bootstrap.

The background loop sleeps 30 seconds after server start (letting the rest of startup settle),
runs one pass, then repeats every 24 hours. A failed pass is logged and swallowed; the next cycle
retries from scratch rather than crashing the server.

## Adding a new projector later

A new projector's watermark starts before every existing event, but old events below the
compaction floor may already be gone. **Bootstrapping a new projector by replaying from sequence 0
is not safe on a server that has ever compacted.** Follow the established pattern instead: ship a
projection-backfill migration that reconstructs the new projection's state directly from whatever
source data still exists (see `024_BackfillProjectionThreadShellSummary.ts`, which backfills
`projection_pending_approvals` and thread summary columns from `projection_thread_activities` and
`orchestration_events` without needing every historical event). If a projector's watermark is ever
found below the loaded floor at server startup, `EventLogCompactionLive` logs a warning naming it
so the gap doesn't go unnoticed.

## Source Map

- Migration: `apps/server/src/persistence/Migrations/035_OrchestrationLogCompaction.ts`
- Service: `apps/server/src/orchestration/Services/EventLogCompaction.ts`
- Layer: `apps/server/src/orchestration/Layers/EventLogCompaction.ts`
- Projector names: `ORCHESTRATION_PROJECTOR_NAMES` in `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- Event store append path: `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`
- ws.ts guards: `shouldFallBackToShellSnapshot` and `canReplayThreadFromCursor` in `apps/server/src/ws.ts`
- Retention setting: `eventLogRetentionDays` in `packages/contracts/src/settings.ts`
