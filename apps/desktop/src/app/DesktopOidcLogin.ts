// @effect-diagnostics nodeBuiltinImport:off - The desktop OIDC loopback callback is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as ElectronShell from "../electron/ElectronShell.ts";

export const OIDC_LOOPBACK_HOST = "127.0.0.1";
export const OIDC_LOOPBACK_PORT = 34339;
export const OIDC_LOOPBACK_CALLBACK_PATH = "/callback";

export function oidcLoopbackRedirectUri(): string {
  return `http://${OIDC_LOOPBACK_HOST}:${OIDC_LOOPBACK_PORT}${OIDC_LOOPBACK_CALLBACK_PATH}`;
}

const DEFAULT_OIDC_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export class DesktopOidcLoginAlreadyInProgressError extends Schema.TaggedErrorClass<DesktopOidcLoginAlreadyInProgressError>()(
  "DesktopOidcLoginAlreadyInProgressError",
  {},
) {
  override get message(): string {
    return "A sign-in is already in progress in the browser.";
  }
}

export class DesktopOidcLoginSupersededError extends Schema.TaggedErrorClass<DesktopOidcLoginSupersededError>()(
  "DesktopOidcLoginSupersededError",
  {},
) {
  override get message(): string {
    return "This sign-in was replaced by a newer attempt.";
  }
}

export class DesktopOidcLoginPortUnavailableError extends Schema.TaggedErrorClass<DesktopOidcLoginPortUnavailableError>()(
  "DesktopOidcLoginPortUnavailableError",
  {
    port: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not start the local sign-in listener on port ${this.port}. Close whatever else is using it and try again.`;
  }
}

export class DesktopOidcLoginBrowserOpenError extends Schema.TaggedErrorClass<DesktopOidcLoginBrowserOpenError>()(
  "DesktopOidcLoginBrowserOpenError",
  {},
) {
  override get message(): string {
    return "Could not open the system browser to sign in.";
  }
}

export class DesktopOidcLoginTimedOutError extends Schema.TaggedErrorClass<DesktopOidcLoginTimedOutError>()(
  "DesktopOidcLoginTimedOutError",
  {},
) {
  override get message(): string {
    return "Signing in timed out. Try again.";
  }
}

export class DesktopOidcLoginStateMismatchError extends Schema.TaggedErrorClass<DesktopOidcLoginStateMismatchError>()(
  "DesktopOidcLoginStateMismatchError",
  {},
) {
  override get message(): string {
    return "The sign-in response did not match the request that started it.";
  }
}

export class DesktopOidcLoginDeniedError extends Schema.TaggedErrorClass<DesktopOidcLoginDeniedError>()(
  "DesktopOidcLoginDeniedError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Sign-in was cancelled (${this.reason}).`;
  }
}

export type DesktopOidcLoginError =
  | DesktopOidcLoginAlreadyInProgressError
  | DesktopOidcLoginSupersededError
  | DesktopOidcLoginPortUnavailableError
  | DesktopOidcLoginBrowserOpenError
  | DesktopOidcLoginTimedOutError
  | DesktopOidcLoginStateMismatchError
  | DesktopOidcLoginDeniedError;

export interface DesktopOidcLoginInput {
  readonly authorizeUrl: string;
  readonly state: string;
}

export interface DesktopOidcLoginResult {
  readonly code: string;
}

export class DesktopOidcLogin extends Context.Service<
  DesktopOidcLogin,
  {
    readonly login: (
      input: DesktopOidcLoginInput,
    ) => Effect.Effect<DesktopOidcLoginResult, DesktopOidcLoginError>;
  }
>()("@t3tools/desktop/app/DesktopOidcLogin") {}

function renderCallbackPage(heading: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<title>${heading}</title>
<style>
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: #161616; color: #f1f3f7; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { text-align: center; padding: 2rem; }
h1 { font-size: 1.125rem; font-weight: 600; margin: 0; }
p { font-size: 0.9375rem; color: #9a9a9a; margin: 0.5rem 0 0; }
</style>
</head>
<body><main><h1>${heading}</h1><p>${detail}</p></main></body>
</html>`;
}

const SUCCESS_PAGE = renderCallbackPage("You're signed in", "Return to T3 Code.");
const FAILURE_PAGE = renderCallbackPage(
  "Sign-in didn't complete",
  "Return to T3 Code and try again.",
);

export type DesktopOidcCallbackOutcome =
  | { readonly _tag: "malformed" }
  | { readonly _tag: "denied"; readonly error: DesktopOidcLoginDeniedError }
  | { readonly _tag: "state-mismatch"; readonly error: DesktopOidcLoginStateMismatchError }
  | { readonly _tag: "success"; readonly result: DesktopOidcLoginResult };

/**
 * Pure decision logic for a `/callback` request: what the loopback listener
 * should complete the pending sign-in with, given the query params the
 * provider redirected back with and the state this login started with. Kept
 * free of the HTTP router/response plumbing so it can be unit-tested
 * directly.
 */
export function resolveOidcCallback(url: URL, expectedState: string): DesktopOidcCallbackOutcome {
  const errorParam = url.searchParams.get("error");
  if (errorParam !== null) {
    const reason = url.searchParams.get("error_description") ?? errorParam;
    return { _tag: "denied", error: new DesktopOidcLoginDeniedError({ reason }) };
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null) {
    return { _tag: "malformed" };
  }

  if (state !== expectedState) {
    return { _tag: "state-mismatch", error: new DesktopOidcLoginStateMismatchError() };
  }

  return { _tag: "success", result: { code } };
}

export interface DesktopOidcLoginOptions {
  readonly loginTimeoutMs?: number;
}

export const make = Effect.fn("desktop.oidcLogin.make")(function* (
  options: DesktopOidcLoginOptions = {},
) {
  const shell = yield* ElectronShell.ElectronShell;
  const loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_OIDC_LOGIN_TIMEOUT_MS;
  // The running attempt's fiber. A newer sign-in interrupts the previous one
  // and awaits its teardown (closing its scope, freeing the loopback port)
  // before starting, so overlapping attempts can never collide on the port.
  const activeRef = yield* Ref.make<Fiber.Fiber<
    DesktopOidcLoginResult,
    DesktopOidcLoginError
  > | null>(null);

  const runLogin = Effect.fn("desktop.oidcLogin.run")(function* (input: DesktopOidcLoginInput) {
    const deferred = yield* Deferred.make<DesktopOidcLoginResult, DesktopOidcLoginError>();

    // Close the browser connection as soon as the result page is delivered so
    // the loopback server has no keep-alive socket to wait on when it tears
    // down; without this a graceful shutdown blocks and a preemptive one races
    // the response.
    const resultPage = (page: string) =>
      HttpServerResponse.html(page).pipe(HttpServerResponse.setHeader("connection", "close"));

    const callbackRoute = HttpRouter.add(
      "GET",
      OIDC_LOOPBACK_CALLBACK_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.originalUrl, oidcLoopbackRedirectUri());
        const outcome = resolveOidcCallback(url, input.state);

        switch (outcome._tag) {
          case "malformed":
            return resultPage(FAILURE_PAGE).pipe(HttpServerResponse.setStatus(400));
          case "denied":
          case "state-mismatch":
            yield* Deferred.complete(deferred, Effect.fail(outcome.error));
            return resultPage(FAILURE_PAGE);
          case "success":
            yield* Deferred.complete(deferred, Effect.succeed(outcome.result));
            return resultPage(SUCCESS_PAGE);
        }
      }),
    );

    // A superseded attempt's listener closes asynchronously with its scope,
    // so the replacement may briefly race it for the port; retry the bind
    // before declaring the port unavailable.
    // A prior attempt is fully interrupted (its scope closed, its port freed)
    // before this one is forked, so a bind collision should not happen; the
    // short retry only absorbs the OS releasing the socket a beat late.
    yield* HttpRouter.serve(callbackRoute, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: OIDC_LOOPBACK_HOST,
          port: OIDC_LOOPBACK_PORT,
          gracefulShutdownTimeout: Duration.seconds(1),
        }),
      ),
      Layer.build,
      Effect.retry({
        times: 14,
        schedule: Schedule.spaced(Duration.millis(100)),
      }),
      Effect.mapError(
        (cause) => new DesktopOidcLoginPortUnavailableError({ port: OIDC_LOOPBACK_PORT, cause }),
      ),
    );

    const opened = yield* shell.openExternal(input.authorizeUrl);
    if (!opened) {
      return yield* new DesktopOidcLoginBrowserOpenError();
    }

    return yield* Deferred.await(deferred).pipe(
      Effect.timeout(Duration.millis(loginTimeoutMs)),
      Effect.catchTag("TimeoutError", () => Effect.fail(new DesktopOidcLoginTimedOutError())),
    );
  });

  const login: DesktopOidcLogin["Service"]["login"] = Effect.fn("desktop.oidcLogin.login")(
    function* (input) {
      // Interrupting the previous attempt awaits its finalizers, so its server
      // is fully shut down and its port released before this attempt binds.
      const previous = yield* Ref.getAndSet(activeRef, null);
      if (previous !== null) {
        yield* Fiber.interrupt(previous);
      }

      const fiber = yield* Effect.forkDetach(runLogin(input).pipe(Effect.scoped));
      yield* Ref.set(activeRef, fiber);

      const exit = yield* Fiber.await(fiber);
      yield* Ref.update(activeRef, (current) => (current === fiber ? null : current));

      // This attempt's fiber is only interrupted when a newer sign-in
      // supersedes it; surface that as a clean, typed outcome rather than a
      // raw fiber interruption.
      if (Exit.hasInterrupts(exit)) {
        return yield* new DesktopOidcLoginSupersededError();
      }
      return yield* exit;
    },
  );

  return DesktopOidcLogin.of({ login });
});

export const layer = (options: DesktopOidcLoginOptions = {}) =>
  Layer.effect(DesktopOidcLogin, make(options));
