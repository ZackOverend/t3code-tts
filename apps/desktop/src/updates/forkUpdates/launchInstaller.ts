// @effect-diagnostics nodeBuiltinImport:off -- The installer must detach from Electron and survive its shutdown scope.
import * as NodeChildProcess from "node:child_process";

export function launchInstaller(input: {
  readonly script: string;
  readonly homeDirectory: string;
  readonly stateDir: string;
  readonly appDest: string;
}) {
  return new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn("/bin/bash", [input.script], {
      cwd: input.homeDirectory,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        INSTALL_STAGED: "1",
        WAIT_PID: String(process.pid),
        DRY_RUN: "0",
        STATE: input.stateDir,
        APP_DEST: input.appDest,
      },
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
