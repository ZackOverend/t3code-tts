import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import type { DesktopUpdates } from "../DesktopUpdates.ts";
import * as IpcChannels from "../../ipc/channels.ts";
import { createInitialDesktopUpdateState } from "../updateMachine.ts";
import { resolveForkUpdateStatus, toDesktopUpdateState } from "./state.ts";
import { launchInstaller } from "./launchInstaller.ts";

class ForkInstallerLaunchError extends Schema.TaggedError<ForkInstallerLaunchError>()(
  "ForkInstallerLaunchError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Fork update: Could not start the installer. Your installed app is unchanged. Try again.";
  }
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const config = yield* DesktopConfig.DesktopConfig;
  const fs = yield* FileSystem.FileSystem;
  const script = environment.path.join(
    environment.homeDirectory,
    "Development/t3code-tts-update.sh",
  );
  if (
    environment.platform !== "darwin" ||
    !environment.isPackaged ||
    environment.isDevelopment ||
    config.disableAutoUpdate ||
    config.mockUpdates ||
    (yield* fs.exists(environment.appUpdateYmlPath).pipe(Effect.orElseSucceed(() => true))) ||
    !(yield* fs.exists(script).pipe(Effect.orElseSucceed(() => false)))
  )
    return Option.none();

  const app = yield* ElectronApp.ElectronApp;
  const window = yield* ElectronWindow.ElectronWindow;
  const stateDir = environment.path.join(environment.homeDirectory, ".local/share/t3code-tts");
  const stagedApp = environment.path.join(stateDir, "staged/T3 Code (Beta).app");
  const appDest = environment.path.resolve(environment.resourcesPath, "../..");
  const base = createInitialDesktopUpdateState(
    environment.appVersion,
    environment.runtimeInfo,
    "latest",
  );
  const state = yield* Ref.make(toDesktopUpdateState(base, { status: "nothing" }));
  const installing = yield* Ref.make(false);
  const configured = yield* Ref.make(false);
  const changes = yield* PubSub.sliding<DesktopUpdateState>(16);
  const mutex = yield* Semaphore.make(1);
  const emitState = Ref.get(state).pipe(
    Effect.flatMap((value) => window.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, value)),
  );
  const publish = Effect.fn("ForkUpdates.publish")(function* (value: DesktopUpdateState) {
    yield* mutex.withPermits(1)(
      Ref.set(state, value).pipe(Effect.andThen(PubSub.publish(changes, value))),
    );
    yield* emitState;
    return value;
  });
  const read = Effect.fn("ForkUpdates.read")(function (name: string) {
    return fs
      .readFileString(environment.path.join(stateDir, name))
      .pipe(Effect.orElseSucceed(() => undefined));
  });
  const refresh = Effect.fn("ForkUpdates.refresh")(function* () {
    const files = yield* Effect.all({
      installedSha: read("installed-sha"),
      installedTag: read("installed-tag"),
      stagedSha: read("staged-sha"),
      stagedTag: read("staged-tag"),
      conflictTag: read("conflict-tag"),
      stagedAppPresent: Effect.all([
        fs
          .stat(environment.path.join(stagedApp, "Contents/MacOS"))
          .pipe(Effect.map((info) => info.type === "Directory")),
        fs
          .stat(environment.path.join(stagedApp, "Contents/Info.plist"))
          .pipe(Effect.map((info) => info.type === "File")),
      ]).pipe(
        Effect.map(([hasExecutableDirectory, hasInfo]) => hasExecutableDirectory && hasInfo),
        Effect.orElseSucceed(() => false),
      ),
    });
    const next = toDesktopUpdateState(base, resolveForkUpdateStatus(files));
    const previous = yield* Ref.get(state);
    if (next.status !== previous.status || next.message !== previous.message) yield* publish(next);
    return next;
  });

  const install = Effect.fn("ForkUpdates.install")(function* (expectedVersion?: string) {
    const current = yield* refresh();
    if (
      current.status !== "downloaded" ||
      (expectedVersion !== undefined && expectedVersion !== current.downloadedVersion)
    ) {
      return { accepted: false, completed: false, failed: false, state: current };
    }
    if (yield* Ref.getAndSet(installing, true)) {
      return { accepted: false, completed: false, failed: false, state: current };
    }
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () =>
          launchInstaller({ script, homeDirectory: environment.homeDirectory, stateDir, appDest }),
        catch: (cause) => new ForkInstallerLaunchError({ cause }),
      });
      yield* app.quit;
      return { accepted: true, completed: true, failed: false, state: current };
    }).pipe(
      Effect.catchTags({
        ForkInstallerLaunchError: (error) =>
          publish({
            ...current,
            status: "error",
            errorContext: "install",
            message: error.message,
          }).pipe(
            Effect.map((value) => ({
              accepted: true,
              completed: false,
              failed: true,
              state: value,
            })),
            Effect.ensuring(Ref.set(installing, false)),
          ),
      }),
    );
  });

  return Option.some({
    getState: Ref.get(state),
    isActionActive: Ref.get(installing),
    isInstallActive: Ref.get(installing),
    emitState,
    disabledReason: Effect.succeedNone,
    subscribe: mutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        return { latest: yield* Ref.get(state), changes: Stream.fromSubscription(subscription) };
      }),
    ),
    configure: Effect.gen(function* () {
      if (yield* Ref.getAndSet(configured, true)) return;
      yield* refresh();
      yield* Effect.sleep("1 minute").pipe(
        Effect.andThen(refresh()),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
    setChannel: () => refresh(),
    check: Effect.fn("ForkUpdates.check")(function* () {
      return { checked: true, state: yield* refresh() };
    }),
    download: refresh().pipe(
      Effect.map((value) => ({ accepted: false, completed: false, state: value })),
    ),
    install: install(),
    installPrepared: install,
  } satisfies DesktopUpdates["Service"]);
});
