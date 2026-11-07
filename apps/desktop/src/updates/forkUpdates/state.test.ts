import { describe, expect, it } from "vite-plus/test";

import { createInitialDesktopUpdateState } from "../updateMachine.ts";
import { resolveForkUpdateStatus, toDesktopUpdateState } from "./state.ts";

const staged = { stagedSha: "a".repeat(40), stagedTag: "v0.2.0", stagedAppPresent: true };
const base = createInitialDesktopUpdateState(
  "0.1.0",
  {
    appArch: "arm64",
    hostArch: "arm64",
    runningUnderArm64Translation: false,
  },
  "latest",
);

describe("fork update status", () => {
  it("has no update when there is no updater state", () => {
    expect(resolveForkUpdateStatus({})).toEqual({ status: "nothing" });
  });

  it("offers a complete staged build that is not installed", () => {
    expect(
      resolveForkUpdateStatus({
        stagedSha: "a".repeat(40),
        stagedTag: "v0.2.0\n",
        stagedAppPresent: true,
        installedSha: "b".repeat(40),
        installedTag: "v0.1.0",
      }),
    ).toEqual({ status: "ready", tag: "v0.2.0" });
  });

  it("asks for a rebase fix when a newer release conflicted, even with an older staged build", () => {
    expect(
      resolveForkUpdateStatus({
        stagedSha: "a".repeat(40),
        stagedTag: "v0.2.0",
        stagedAppPresent: true,
        installedTag: "v0.1.0",
        conflictTag: "v0.10.0\n",
      }),
    ).toEqual({ status: "needs-fixing", tag: "v0.10.0" });
  });

  it("hides the staged build once its SHA is installed", () => {
    expect(resolveForkUpdateStatus({ ...staged, installedSha: `${"A".repeat(40)}\n` })).toEqual({
      status: "nothing",
    });
  });

  it("ignores a conflict superseded by an installed release", () => {
    expect(resolveForkUpdateStatus({ installedTag: "v0.10.0", conflictTag: "v0.2.0" })).toEqual({
      status: "nothing",
    });
  });

  it("offers a newer staged release after an older conflict", () => {
    expect(resolveForkUpdateStatus({ ...staged, conflictTag: "v0.1.0" })).toEqual({
      status: "ready",
      tag: "v0.2.0",
    });
  });

  it("does not let a missing staged app hide a conflict", () => {
    expect(
      resolveForkUpdateStatus({ ...staged, stagedAppPresent: false, conflictTag: "v0.1.0" }),
    ).toEqual({ status: "needs-fixing", tag: "v0.1.0" });
  });

  it.each([
    { stagedAppPresent: false },
    { stagedSha: undefined },
    { stagedSha: "" },
    { stagedSha: "not-a-sha" },
    { stagedTag: undefined },
    { stagedTag: "garbage" },
    { stagedTag: "v0.2.0-nightly.1" },
    { stagedTag: "v0.2.0\nv0.3.0" },
  ])("ignores incomplete or invalid staged state: %j", (invalid) => {
    expect(resolveForkUpdateStatus({ ...staged, ...invalid })).toEqual({ status: "nothing" });
  });

  it.each(["", "garbage", "v0.2.0-beta", "v0.2.0\nv0.3.0"])(
    "ignores malformed conflict tag %j",
    (conflictTag) => {
      expect(resolveForkUpdateStatus({ conflictTag })).toEqual({ status: "nothing" });
    },
  );

  it("offers a valid staged build even if installed markers are missing or garbage", () => {
    expect(resolveForkUpdateStatus({ ...staged, installedSha: "?", installedTag: "?" })).toEqual({
      status: "ready",
      tag: "v0.2.0",
    });
  });

  it("feeds an installable ready state to the desktop surface", () => {
    expect(toDesktopUpdateState(base, resolveForkUpdateStatus(staged))).toMatchObject({
      enabled: true,
      status: "downloaded",
      downloadedVersion: "0.2.0",
      canRetry: true,
      message: "Fork update: v0.2.0 ready. Restart to update.",
    });
  });

  it("feeds a visible non-installable conflict and recovery instruction to the desktop surface", () => {
    expect(
      toDesktopUpdateState(base, resolveForkUpdateStatus({ conflictTag: "v0.2.0" })),
    ).toMatchObject({
      enabled: true,
      status: "error",
      downloadedVersion: null,
      errorContext: "check",
      canRetry: false,
      message:
        "Fork update: v0.2.0 needs fixing. Have an agent fix the rebase. Your installed app is unchanged.",
    });
  });

  it("removes the install action when there is nothing new", () => {
    expect(toDesktopUpdateState(base, resolveForkUpdateStatus({}))).toMatchObject({
      status: "up-to-date",
      availableVersion: null,
      downloadedVersion: null,
      canRetry: false,
    });
  });
});
