/**
 * EventLogCompaction - Service interface for orchestration event-log compaction.
 *
 * `orchestration_events` is append-only in the sense that nothing ever
 * mutates a row, but it is not retained forever: this service periodically
 * deletes events that every projector watermark has already passed and that
 * are older than the configured retention window. Projections in
 * `projection_state` are the durable snapshot the engine rebuilds from at
 * startup — events below every projector's watermark exist only for client
 * replay and audit, so removing them once they are also past retention does
 * not lose any state the engine depends on.
 *
 * See docs/architecture/event-log-compaction.md for the full design,
 * including why each stream's newest event is always retained and why new
 * projectors need a backfill migration instead of a sequence-0 replay.
 *
 * @module EventLogCompaction
 */
import type { ServerSettingsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export type EventLogCompactionError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | ServerSettingsError;

/**
 * Outcome of one `runCompaction` pass.
 */
export interface CompactionReport {
  /** Number of `orchestration_events` rows deleted this run. */
  readonly deletedEvents: number;
  /**
   * The compaction floor after this run — the highest sequence ever
   * deleted. Unchanged from the prior run when this run deleted nothing.
   */
  readonly floorSequence: number;
  /** Whether this run also ran `VACUUM` to reclaim freed pages. */
  readonly vacuumed: boolean;
  /**
   * Set when the run did no deletion work by design rather than because
   * there was nothing eligible: `"retention-disabled"` (retention <= 0) or
   * `"projector-watermarks-incomplete"` (fewer than all 9 projector rows
   * exist in `projection_state` yet).
   */
  readonly skippedReason?: string;
}

/**
 * EventLogCompactionShape - Service API for orchestration event-log compaction.
 */
export interface EventLogCompactionShape {
  /**
   * The current compaction floor: the highest `orchestration_events.sequence`
   * ever deleted. Zero means compaction has never deleted anything.
   *
   * A replay from `afterSequence` is only guaranteed complete when
   * `afterSequence >= compactionFloor` — events at or below the floor may
   * have been deleted, even though each stream's newest event always
   * survives compaction regardless of the floor.
   */
  readonly compactionFloor: Effect.Effect<number>;

  /**
   * Run one compaction pass: delete fully-projected, expired events in
   * bounded batches, advance the floor row when anything was deleted, and
   * checkpoint/vacuum the WAL when reclaimable space is large. The periodic
   * loop started at layer construction calls this on a schedule; call it
   * directly to compact on demand (e.g. in tests).
   */
  readonly runCompaction: Effect.Effect<CompactionReport, EventLogCompactionError>;
}

/**
 * EventLogCompaction - Service tag for orchestration event-log compaction.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const compaction = yield* EventLogCompaction
 *   const floor = yield* compaction.compactionFloor
 *   return floor
 * })
 * ```
 */
export class EventLogCompaction extends Context.Service<
  EventLogCompaction,
  EventLogCompactionShape
>()("t3/orchestration/Services/EventLogCompaction") {}
