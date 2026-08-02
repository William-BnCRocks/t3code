import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  fetchClaudeUsage,
  readClaudeAccessToken,
  resolveClaudeCredentialsPath,
} from "./claudeUsage.ts";

const FAKE_TOKEN = "fake-test-token-not-real";

it.layer(NodeServices.layer)("claudeUsage", (it) => {
  describe("resolveClaudeCredentialsPath", () => {
    it.effect(
      "resolves the default <home>/.claude/.credentials.json path for an empty homePath",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const resolved = yield* resolveClaudeCredentialsPath("");
          expect(resolved).toBe(path.join(NodeOS.homedir(), ".claude", ".credentials.json"));
        }),
    );

    it.effect(
      "resolves <resolved homePath>/.credentials.json directly (no .claude subdir) for a non-empty homePath",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const resolved = yield* resolveClaudeCredentialsPath("~/.claude-work");
          expect(resolved).toBe(
            path.join(path.resolve(NodeOS.homedir(), ".claude-work"), ".credentials.json"),
          );
        }),
    );
  });

  describe("readClaudeAccessToken", () => {
    it.effect("returns None when the credentials file is missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-usage-" });
        const credsPath = path.join(tempDir, "does-not-exist", ".credentials.json");

        const result = yield* readClaudeAccessToken(credsPath);
        expect(Option.isNone(result)).toBe(true);
      }),
    );

    it.effect("returns None for malformed JSON", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-usage-" });
        const credsPath = path.join(tempDir, ".credentials.json");
        yield* fs.writeFileString(credsPath, "{ not valid json");

        const result = yield* readClaudeAccessToken(credsPath);
        expect(Option.isNone(result)).toBe(true);
      }),
    );

    it.effect("returns None when claudeAiOauth is missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-usage-" });
        const credsPath = path.join(tempDir, ".credentials.json");
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        yield* fs.writeFileString(credsPath, JSON.stringify({ mcpOAuth: {} }));

        const result = yield* readClaudeAccessToken(credsPath);
        expect(Option.isNone(result)).toBe(true);
      }),
    );

    it.effect("returns None for an expired token", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-usage-" });
        const credsPath = path.join(tempDir, ".credentials.json");
        const now = yield* Clock.currentTimeMillis;
        yield* fs.writeFileString(
          credsPath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            claudeAiOauth: {
              accessToken: FAKE_TOKEN,
              refreshToken: "fake-refresh-not-real",
              expiresAt: now - 60_000,
            },
          }),
        );

        const result = yield* readClaudeAccessToken(credsPath);
        expect(Option.isNone(result)).toBe(true);
      }),
    );

    it.effect("returns Some(token) for a valid, non-expired token", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-usage-" });
        const credsPath = path.join(tempDir, ".credentials.json");
        const now = yield* Clock.currentTimeMillis;
        yield* fs.writeFileString(
          credsPath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            claudeAiOauth: {
              accessToken: FAKE_TOKEN,
              refreshToken: "fake-refresh-not-real",
              expiresAt: now + 60 * 60_000,
            },
          }),
        );

        const result = yield* readClaudeAccessToken(credsPath);
        expect(result).toEqual(Option.some(FAKE_TOKEN));
      }),
    );
  });
});

describe("fetchClaudeUsage", () => {
  it.effect("returns Some(parsed) on HTTP 200 with a valid JSON body", () =>
    Effect.gen(function* () {
      const result = yield* fetchClaudeUsage(FAKE_TOKEN);
      expect(result).toEqual(Option.some({ five_hour: {} }));
    }).pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ five_hour: {} }))),
          ),
        ),
      ),
    ),
  );

  it.effect("returns None on a non-200 status", () =>
    Effect.gen(function* () {
      const result = yield* fetchClaudeUsage(FAKE_TOKEN);
      expect(Option.isNone(result)).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("unauthorized", { status: 401 })),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("returns None for a malformed JSON body", () =>
    Effect.gen(function* () {
      const result = yield* fetchClaudeUsage(FAKE_TOKEN);
      expect(Option.isNone(result)).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("not json", {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
