import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionPendingApprovalRepository } from "../Services/ProjectionPendingApprovals.ts";
import { ProjectionPendingApprovalRepositoryLive } from "./ProjectionPendingApprovals.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionPendingApprovalRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionPendingApprovalRepository", (it) => {
  it.effect("countPendingByThreadId returns 0 for a thread with no approvals", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingApprovalRepository;
      const threadId = ThreadId.make("thread-pending-approvals-empty");

      const count = yield* repository.countPendingByThreadId({ threadId });
      assert.equal(count, 0);
    }),
  );

  it.effect("countPendingByThreadId counts only pending rows scoped to the thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionPendingApprovalRepository;
      const threadId = ThreadId.make("thread-pending-approvals-mixed");
      const otherThreadId = ThreadId.make("thread-pending-approvals-other");

      // Two pending approvals on the target thread.
      yield* repository.upsert({
        requestId: ApprovalRequestId.make("req-pending-approvals-1"),
        threadId,
        turnId: null,
        status: "pending",
        decision: null,
        createdAt: "2026-03-05T00:00:00.000Z",
        resolvedAt: null,
      });
      yield* repository.upsert({
        requestId: ApprovalRequestId.make("req-pending-approvals-2"),
        threadId,
        turnId: null,
        status: "pending",
        decision: null,
        createdAt: "2026-03-05T00:00:01.000Z",
        resolvedAt: null,
      });
      // A resolved approval on the target thread — must not count.
      yield* repository.upsert({
        requestId: ApprovalRequestId.make("req-pending-approvals-resolved"),
        threadId,
        turnId: null,
        status: "resolved",
        decision: "accept",
        createdAt: "2026-03-05T00:00:02.000Z",
        resolvedAt: "2026-03-05T00:00:03.000Z",
      });
      // A pending approval on a different thread — must not count.
      yield* repository.upsert({
        requestId: ApprovalRequestId.make("req-pending-approvals-other-thread"),
        threadId: otherThreadId,
        turnId: null,
        status: "pending",
        decision: null,
        createdAt: "2026-03-05T00:00:04.000Z",
        resolvedAt: null,
      });

      const count = yield* repository.countPendingByThreadId({ threadId });
      assert.equal(count, 2);

      const otherCount = yield* repository.countPendingByThreadId({ threadId: otherThreadId });
      assert.equal(otherCount, 1);
    }),
  );
});
