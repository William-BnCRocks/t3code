import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );

  it.effect(
    "getLatestUserMessageCreatedAtByThreadId returns null for a thread with no messages",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadMessageRepository;
        const threadId = ThreadId.make("thread-latest-user-message-empty");

        const latestUserMessageCreatedAt =
          yield* repository.getLatestUserMessageCreatedAtByThreadId({ threadId });
        assert.equal(latestUserMessageCreatedAt, null);
      }),
  );

  it.effect(
    "getLatestUserMessageCreatedAtByThreadId ignores assistant messages and later-thread messages",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadMessageRepository;
        const threadId = ThreadId.make("thread-latest-user-message-mixed");
        const otherThreadId = ThreadId.make("thread-latest-user-message-other");

        // Earliest: user message.
        yield* repository.upsert({
          messageId: MessageId.make("message-latest-user-1"),
          threadId,
          turnId: null,
          role: "user",
          text: "first user message",
          isStreaming: false,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        });
        // Latest overall, but assistant-authored — must not count.
        yield* repository.upsert({
          messageId: MessageId.make("message-latest-assistant"),
          threadId,
          turnId: null,
          role: "assistant",
          text: "assistant reply",
          isStreaming: false,
          createdAt: "2026-03-01T00:00:02.000Z",
          updatedAt: "2026-03-01T00:00:02.000Z",
        });
        // Latest user message for this thread.
        yield* repository.upsert({
          messageId: MessageId.make("message-latest-user-2"),
          threadId,
          turnId: null,
          role: "user",
          text: "second user message",
          isStreaming: false,
          createdAt: "2026-03-01T00:00:01.000Z",
          updatedAt: "2026-03-01T00:00:01.000Z",
        });
        // A later user message, but on a different thread — must not count.
        yield* repository.upsert({
          messageId: MessageId.make("message-latest-user-other-thread"),
          threadId: otherThreadId,
          turnId: null,
          role: "user",
          text: "other thread user message",
          isStreaming: false,
          createdAt: "2026-03-01T00:00:03.000Z",
          updatedAt: "2026-03-01T00:00:03.000Z",
        });

        const latestUserMessageCreatedAt =
          yield* repository.getLatestUserMessageCreatedAtByThreadId({ threadId });
        assert.equal(latestUserMessageCreatedAt, "2026-03-01T00:00:01.000Z");
      }),
  );
});
