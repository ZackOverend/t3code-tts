// @effect-diagnostics nodeBuiltinImport:off -- Detached builds must survive Electron shutdown.
import * as NodeChildProcess from "node:child_process";

export function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function launchBuild(
  input: {
    script: string;
    homeDirectory: string;
    stateDir: string;
    appDest: string;
  },
  spawn: (
    command: string,
    args: readonly string[],
    options: NodeChildProcess.SpawnOptions,
  ) => NodeChildProcess.ChildProcess = NodeChildProcess.spawn,
) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("/bin/bash", [input.script], {
      cwd: input.homeDirectory,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        DRY_RUN: "1",
        INSTALL_STAGED: "0",
        WAIT_PID: "",
        STATE: input.stateDir,
        APP_DEST: input.appDest,
      },
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid!);
    });
  });
}
