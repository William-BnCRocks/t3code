import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { fetchGrokUsage, readGrokAccessToken, resolveGrokAuthPath } from "./grokUsage.ts";

const FAKE_TOKEN = "fake-test-token-not-real";

it.layer(NodeServices.layer)("grokUsage", (it) => {
  describe("resolveGrokAuthPath", () => {
    it.effect("resolves the default <home>/.grok/auth.json path for an empty homePath", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = yield* resolveGrokAuthPath("");
        expect(resolved).toBe(path.join(NodeOS.homedir(), ".grok", "auth.json"));
      }),
    );

    it.effect("resolves <resolved homePath>/auth.json for a configured homePath", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = yield* resolveGrokAuthPath("~/.grok-work");
        expect(resolved).toBe(path.join(path.resolve(NodeOS.homedir(), ".grok-work"), "auth.json"));
      }),
    );
  });

  describe("readGrokAccessToken", () => {
    it.effect("returns None when auth.json is missing", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-usage-" });
        const authPath = path.join(tempDir, "does-not-exist", "auth.json");

        const result = yield* readGrokAccessToken(authPath);
        expect(Option.isNone(result)).toBe(true);
      }),
    );

    it.effect("returns None for malformed JSON", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-usage-" });
        const authPath = path.join(tempDir, "auth.json");
        yield* fs.writeFileString(authPath, "{ not valid json");

        const result = yield* readGrokAccessToken(authPath);
        expect(Option.isNone(result)).toBe(true);
      }),
    );

    it.effect("returns None when the top-level map has no entries", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-usage-" });
        const authPath = path.join(tempDir, "auth.json");
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        yield* fs.writeFileString(authPath, JSON.stringify({}));

        const result = yield* readGrokAccessToken(authPath);
        expect(Option.isNone(result)).toBe(true);
      }),
    );

    it.effect("returns None for an expired token", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-usage-" });
        const authPath = path.join(tempDir, "auth.json");
        const now = yield* Clock.currentTimeMillis;
        const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(now - 60_000));
        yield* fs.writeFileString(
          authPath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            "https://auth.x.ai::client-id": {
              key: FAKE_TOKEN,
              auth_mode: "oidc",
              expires_at: expiresAt,
            },
          }),
        );

        const result = yield* readGrokAccessToken(authPath);
        expect(Option.isNone(result)).toBe(true);
      }),
    );

    it.effect(
      "returns Some(key) for a valid, non-expired token, parsed from the issuer::client_id map key",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-usage-" });
          const authPath = path.join(tempDir, "auth.json");
          const now = yield* Clock.currentTimeMillis;
          const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(now + 60 * 60_000));
          yield* fs.writeFileString(
            authPath,
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
                key: FAKE_TOKEN,
                auth_mode: "oidc",
                expires_at: expiresAt,
              },
            }),
          );

          const result = yield* readGrokAccessToken(authPath);
          expect(result).toEqual(Option.some(FAKE_TOKEN));
        }),
    );
  });
});

describe("fetchGrokUsage", () => {
  it.effect("returns Some(parsed) on HTTP 200 with a valid JSON body", () =>
    Effect.gen(function* () {
      const result = yield* fetchGrokUsage(FAKE_TOKEN, {});
      expect(result).toEqual(Option.some({ creditUsagePercent: 12.5 }));
    }).pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.url).toBe("https://code.grok.com/billing?format=credits");
            expect(request.headers["x-grok-client-mode"]).toBe("agent");
            expect(request.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ creditUsagePercent: 12.5 })),
            );
          }),
        ),
      ),
    ),
  );

  it.effect("honors GROK_CODE_BACKEND_URL when set", () =>
    Effect.gen(function* () {
      yield* fetchGrokUsage(FAKE_TOKEN, { GROK_CODE_BACKEND_URL: "https://custom.example" });
    }).pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.url).toBe("https://custom.example/billing?format=credits");
            return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
          }),
        ),
      ),
    ),
  );

  it.effect("returns None on a non-200 status (e.g. 401 unauthorized)", () =>
    Effect.gen(function* () {
      const result = yield* fetchGrokUsage(FAKE_TOKEN, {});
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
      const result = yield* fetchGrokUsage(FAKE_TOKEN, {});
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
