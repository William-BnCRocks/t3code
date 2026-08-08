import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { discoverOidcConfiguration, OidcDiscoveryError } from "./oidcDiscovery.ts";

const makeStubHttpClientLayer = (handler: (request: { readonly url: string }) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => HttpClientResponse.fromWeb(request, handler(request))),
    ),
  );

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

it.effect("resolves authorize/token endpoints from a matching discovery document", () =>
  Effect.gen(function* () {
    const seenUrls: Array<string> = [];
    const metadata = yield* discoverOidcConfiguration("https://auth.example.test/").pipe(
      Effect.provide(
        makeStubHttpClientLayer((request) => {
          seenUrls.push(request.url);
          return jsonResponse({
            issuer: "https://auth.example.test",
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
          });
        }),
      ),
    );

    assert.deepEqual(seenUrls, ["https://auth.example.test/.well-known/openid-configuration"]);
    assert.deepEqual(metadata, {
      issuer: "https://auth.example.test",
      authorizationEndpoint: "https://auth.example.test/authorize",
      tokenEndpoint: "https://auth.example.test/token",
    });
  }),
);

it.effect("tolerates a trailing slash on the configured issuer when matching the document", () =>
  Effect.gen(function* () {
    const metadata = yield* discoverOidcConfiguration("https://auth.example.test").pipe(
      Effect.provide(
        makeStubHttpClientLayer(() =>
          jsonResponse({
            issuer: "https://auth.example.test/",
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
          }),
        ),
      ),
    );

    assert.equal(metadata.issuer, "https://auth.example.test/");
  }),
);

it.effect("fails with issuer_mismatch when the document names a different issuer", () =>
  Effect.gen(function* () {
    const result = yield* discoverOidcConfiguration("https://auth.example.test").pipe(
      Effect.provide(
        makeStubHttpClientLayer(() =>
          jsonResponse({
            issuer: "https://impostor.example.test",
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
          }),
        ),
      ),
      Effect.result,
    );

    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.instanceOf(result.failure, OidcDiscoveryError);
      assert.equal(result.failure.reason, "issuer_mismatch");
    }
  }),
);

it.effect("fails with invalid_document when required fields are missing", () =>
  Effect.gen(function* () {
    const result = yield* discoverOidcConfiguration("https://auth.example.test").pipe(
      Effect.provide(
        makeStubHttpClientLayer(() => jsonResponse({ issuer: "https://auth.example.test" })),
      ),
      Effect.result,
    );

    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.instanceOf(result.failure, OidcDiscoveryError);
      assert.equal(result.failure.reason, "invalid_document");
    }
  }),
);

it.effect("fails with fetch_failed when the discovery endpoint returns an error status", () =>
  Effect.gen(function* () {
    const result = yield* discoverOidcConfiguration("https://auth.example.test").pipe(
      Effect.provide(makeStubHttpClientLayer(() => new Response("nope", { status: 500 }))),
      Effect.result,
    );

    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.instanceOf(result.failure, OidcDiscoveryError);
      assert.equal(result.failure.reason, "fetch_failed");
    }
  }),
);
