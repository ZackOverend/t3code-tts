// @effect-diagnostics nodeBuiltinImport:off -- This fixture verifies detached subprocess execution.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { launchBuild } from "./launchBuild.ts";

it("runs a detached stage-only script with isolated destinations", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fork-build-"));
  try {
    const script = NodePath.join(dir, "fake.sh");
    await NodeFSP.writeFile(
      script,
      'printf "%s\\n" "$DRY_RUN" "$INSTALL_STAGED" "$WAIT_PID" "$APP_DEST" > "$STATE/result"\n',
    );
    let complete: Promise<number | null> | undefined;
    await launchBuild(
      { script, homeDirectory: dir, stateDir: dir, appDest: NodePath.join(dir, "app") },
      (...args) => {
        expect(args[2]).toMatchObject({ detached: true, stdio: "ignore" });
        const child = NodeChildProcess.spawn(...args);
        complete = new Promise((resolve, reject) => {
          child.once("exit", resolve);
          child.once("error", reject);
        });
        return child;
      },
    );
    expect(await complete).toBe(0);
    expect(await NodeFSP.readFile(NodePath.join(dir, "result"), "utf8")).toBe(
      `1\n0\n\n${NodePath.join(dir, "app")}\n`,
    );
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
