import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { beforeEach, vi } from "vite-plus/test";

import type * as Electron from "electron";

const { createClerkBridgeMock, storageAdapter, storageMock } = vi.hoisted(() => ({
  createClerkBridgeMock: vi.fn(),
  storageAdapter: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  storageMock: vi.fn(),
}));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));

import { DEEP_LINK_CHANNEL } from "../ipc/channels.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopDeepLinkCoordinator from "./DesktopDeepLinkCoordinator.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const makeDesktopClerkLayer = (isDevelopment = true) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  return DesktopClerk.layer.pipe(
    Layer.provide(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment)),
  );
};

function makeFakeMainWindow(isLoadingMainFrame: boolean) {
  const send = vi.fn();
  const window = {
    isDestroyed: () => false,
    webContents: {
      isLoadingMainFrame: () => isLoadingMainFrame,
      send,
    },
  } as unknown as Electron.BrowserWindow;
  return { window, send };
}

// Builds everything `configure`'s second-instance handling needs: a fake
// ElectronApp that records the "second-instance" listener so the test can
// invoke it directly, a fake ElectronWindow exposing/reveal-tracking a
// configurable "current main window", and the real
// DesktopDeepLinkCoordinator layer so the test can assert what got stashed.
function makeSecondInstanceScenario(input: {
  readonly isDevelopment: boolean;
  readonly mainWindow: Electron.BrowserWindow | null;
}) {
  const secondInstanceListeners: Array<(event: Electron.Event, argv: string[]) => void> = [];
  const revealedWindows: Electron.BrowserWindow[] = [];

  const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    getAppMetrics: Effect.succeed([]),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () =>
      Effect.acquireRelease(Effect.void, () => Effect.void).pipe(Effect.asVoid),
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (eventName === "second-instance") {
            secondInstanceListeners.push(
              listener as unknown as (event: Electron.Event, argv: string[]) => void,
            );
          }
        }),
        () => Effect.void,
      ).pipe(Effect.asVoid),
  } satisfies ElectronApp.ElectronApp["Service"]);

  const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected window create"),
    main: Effect.succeed(Option.fromNullishOr(input.mainWindow)),
    currentMainOrFirst: Effect.succeed(Option.fromNullishOr(input.mainWindow)),
    focusedMainOrFirst: Effect.succeed(Option.fromNullishOr(input.mainWindow)),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: (window) =>
      Effect.sync(() => {
        revealedWindows.push(window);
      }),
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    stateDir: "/tmp/t3-state",
    isDevelopment: input.isDevelopment,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const layer = DesktopClerk.layer.pipe(
    Layer.provideMerge(electronAppLayer),
    Layer.provideMerge(electronWindowLayer),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(DesktopDeepLinkCoordinator.layer),
  );

  return {
    layer,
    revealedWindows,
    fireSecondInstance: (argv: string[]) => {
      const event = { preventDefault: () => {} } as Electron.Event;
      for (const listener of secondInstanceListeners) {
        listener(event, argv);
      }
    },
  };
}

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
  });

  it("derives the Clerk Frontend API hostname used by the desktop CSP", () => {
    const publishableKey = `pk_test_${btoa("clerk.t3.codes$")}`;

    assert.equal(
      DesktopClerk.resolveDesktopClerkFrontendApiHostname(publishableKey),
      "clerk.t3.codes",
    );
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname(""), undefined);
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname("invalid"), undefined);
  });

  it.effect("acquires and releases the SDK bridge with the layer", () => {
    const cleanup = vi.fn();
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(makeDesktopClerkLayer()));

      assert.deepEqual(createClerkBridgeMock.mock.calls, [
        [
          {
            storage: storageAdapter,
            passkeys: true,
            renderer: { scheme: "t3code-dev", host: "app" },
          },
        ],
      ]);
      assert.equal(cleanup.mock.calls.length, 1);
      storageMock.mockClear();
      createClerkBridgeMock.mockClear();
    });
  });

  it.effect("preserves bridge initialization failures", () => {
    const cause = new Error("bridge initialization failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementationOnce(() => {
      throw cause;
    });

    return Effect.gen(function* () {
      const error = yield* Effect.scoped(Layer.build(makeDesktopClerkLayer())).pipe(Effect.flip);

      assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeInitializationError);
      assert.equal(error.stateDir, "/tmp/t3-state");
      assert.equal(error.isDevelopment, true);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        'Failed to initialize the desktop Clerk bridge for state directory "/tmp/t3-state" (development: true).',
      );
    });
  });

  it.effect("preserves bridge cleanup failures", () => {
    const cause = new Error("bridge cleanup failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({
      cleanup: () => {
        throw cause;
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(makeDesktopClerkLayer(false))));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeCleanupError);
        assert.equal(error.stateDir, "/tmp/t3-state");
        assert.equal(error.isDevelopment, false);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          'Failed to clean up the desktop Clerk bridge for state directory "/tmp/t3-state" (development: false).',
        );
      }
    });
  });

  it.each([
    { isDevelopment: true, scheme: "t3code-dev" },
    { isDevelopment: false, scheme: "t3code" },
  ])("configures the SDK with the $scheme renderer origin", ({ isDevelopment, scheme }) => {
    const bridge = { cleanup: vi.fn() };
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue(bridge);

    assert.equal(DesktopClerk.createDesktopClerkBridge("/tmp/t3-state", isDevelopment), bridge);
    assert.deepEqual(storageMock.mock.calls, [[{ path: "/tmp/t3-state" }]]);
    assert.deepEqual(createClerkBridgeMock.mock.calls, [
      [
        {
          storage: storageAdapter,
          passkeys: true,
          renderer: { scheme, host: "app" },
        },
      ],
    ]);
    storageMock.mockClear();
    createClerkBridgeMock.mockClear();
  });

  describe("second-instance deep links", () => {
    it.effect(
      "delivers a deep link from second-instance argv directly to an already-loaded main window",
      () => {
        storageMock.mockReturnValue(storageAdapter);
        createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn() });
        const main = makeFakeMainWindow(false);
        const scenario = makeSecondInstanceScenario({
          isDevelopment: false,
          mainWindow: main.window,
        });

        return Effect.scoped(
          Effect.gen(function* () {
            const clerk = yield* DesktopClerk.DesktopClerk;
            yield* clerk.configure;

            scenario.fireSecondInstance([
              "/usr/bin/t3code",
              "t3code://new?prompt=build%20me%20a%20thing",
            ]);

            assert.deepEqual(main.send.mock.calls, [
              [DEEP_LINK_CHANNEL, { kind: "new-thread", prompt: "build me a thing" }],
            ]);
            assert.deepEqual(scenario.revealedWindows, [main.window]);

            const coordinator = yield* DesktopDeepLinkCoordinator.DesktopDeepLinkCoordinator;
            assert.isTrue(Option.isNone(yield* Ref.get(coordinator.pending)));
          }),
        ).pipe(Effect.provide(scenario.layer));
      },
    );

    it.effect("only reveals the window for second-instance argv without a deep link", () => {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn() });
      const main = makeFakeMainWindow(false);
      const scenario = makeSecondInstanceScenario({
        isDevelopment: false,
        mainWindow: main.window,
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const clerk = yield* DesktopClerk.DesktopClerk;
          yield* clerk.configure;

          scenario.fireSecondInstance(["/usr/bin/t3code", "--some-flag"]);

          assert.equal(main.send.mock.calls.length, 0);
          assert.deepEqual(scenario.revealedWindows, [main.window]);
        }),
      ).pipe(Effect.provide(scenario.layer));
    });

    it.effect("stashes a second-instance deep link when no main window exists yet", () => {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn() });
      const scenario = makeSecondInstanceScenario({ isDevelopment: false, mainWindow: null });

      return Effect.scoped(
        Effect.gen(function* () {
          const clerk = yield* DesktopClerk.DesktopClerk;
          yield* clerk.configure;

          scenario.fireSecondInstance(["/usr/bin/t3code", "t3code://new?prompt=hi"]);

          assert.deepEqual(scenario.revealedWindows, []);
          const coordinator = yield* DesktopDeepLinkCoordinator.DesktopDeepLinkCoordinator;
          assert.deepEqual(
            yield* Ref.get(coordinator.pending),
            Option.some({ kind: "new-thread", prompt: "hi" } as const),
          );
        }),
      ).pipe(Effect.provide(scenario.layer));
    });

    it.effect("stashes a second-instance deep link when the main window is still loading", () => {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn() });
      const main = makeFakeMainWindow(true);
      const scenario = makeSecondInstanceScenario({
        isDevelopment: false,
        mainWindow: main.window,
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const clerk = yield* DesktopClerk.DesktopClerk;
          yield* clerk.configure;

          scenario.fireSecondInstance(["/usr/bin/t3code", "t3code://new?prompt=hi"]);

          assert.equal(main.send.mock.calls.length, 0);
          assert.deepEqual(scenario.revealedWindows, [main.window]);
          const coordinator = yield* DesktopDeepLinkCoordinator.DesktopDeepLinkCoordinator;
          assert.deepEqual(
            yield* Ref.get(coordinator.pending),
            Option.some({ kind: "new-thread", prompt: "hi" } as const),
          );
        }),
      ).pipe(Effect.provide(scenario.layer));
    });

    it.effect("only matches the deep-link scheme for the active build flavor", () => {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn() });
      const main = makeFakeMainWindow(false);
      const scenario = makeSecondInstanceScenario({
        isDevelopment: false,
        mainWindow: main.window,
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const clerk = yield* DesktopClerk.DesktopClerk;
          yield* clerk.configure;

          // Production build (isDevelopment: false): the dev-flavor scheme
          // must not be treated as a deep link.
          scenario.fireSecondInstance(["/usr/bin/t3code", "t3code-dev://new?prompt=hi"]);

          assert.equal(main.send.mock.calls.length, 0);
          assert.deepEqual(scenario.revealedWindows, [main.window]);
        }),
      ).pipe(Effect.provide(scenario.layer));
    });
  });
});
