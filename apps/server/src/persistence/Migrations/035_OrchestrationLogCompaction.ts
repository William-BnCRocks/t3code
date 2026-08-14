import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Single-row table (id is always 1) tracking the compaction watermark:
  // the highest orchestration_events.sequence ever deleted by
  // EventLogCompaction, plus when compaction last ran. Absence of the row
  // means compaction has never run (floor 0 — nothing has been deleted).
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_log_compaction (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      floor_sequence INTEGER NOT NULL,
      last_run_at TEXT NOT NULL
    )
  `;

  // Supports the compaction delete predicate's `occurred_at < cutoffIso` filter.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_occurred_at
    ON orchestration_events(occurred_at)
  `;
});
