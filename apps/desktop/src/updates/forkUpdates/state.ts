import type { DesktopUpdateState } from "@t3tools/contracts";

interface ForkUpdateFiles {
  readonly installedSha?: string | undefined;
  readonly installedTag?: string | undefined;
  readonly stagedSha?: string | undefined;
  readonly stagedTag?: string | undefined;
  readonly conflictTag?: string | undefined;
  readonly stagedAppPresent?: boolean;
}

type ForkUpdateStatus =
  | { readonly status: "nothing" }
  | { readonly status: "ready"; readonly tag: string }
  | { readonly status: "needs-fixing"; readonly tag: string };

function stableTag(value: string | undefined) {
  const tag = value?.trim();
  return tag && /^v?\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(tag) ? tag : undefined;
}

function sha(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && /^[a-f0-9]{40}$/i.test(normalized) ? normalized.toLowerCase() : undefined;
}

function compareTags(left: string, right: string) {
  const leftParts = left.replace(/^v/, "").split(".").map(Number);
  const rightParts = right.replace(/^v/, "").split(".").map(Number);
  for (const index of [0, 1, 2]) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function resolveForkUpdateStatus(files: ForkUpdateFiles): ForkUpdateStatus {
  const stagedSha = sha(files.stagedSha);
  const stagedTag = stableTag(files.stagedTag);
  const installedTag = stableTag(files.installedTag);
  const conflictTag = stableTag(files.conflictTag);
  if (
    conflictTag &&
    (!installedTag || compareTags(conflictTag, installedTag) > 0) &&
    (!files.stagedAppPresent ||
      !stagedSha ||
      !stagedTag ||
      compareTags(conflictTag, stagedTag) >= 0)
  ) {
    return { status: "needs-fixing", tag: conflictTag };
  }
  if (files.stagedAppPresent && stagedSha && stagedTag && stagedSha !== sha(files.installedSha)) {
    return { status: "ready", tag: stagedTag };
  }
  return { status: "nothing" };
}
export function toDesktopUpdateState(
  base: DesktopUpdateState,
  status: ForkUpdateStatus,
): DesktopUpdateState {
  return {
    ...base,
    enabled: true,
    channel: "latest",
    status:
      status.status === "ready"
        ? "downloaded"
        : status.status === "needs-fixing"
          ? "error"
          : "up-to-date",
    availableVersion: status.status === "nothing" ? null : status.tag.replace(/^v/, ""),
    downloadedVersion: status.status === "ready" ? status.tag.replace(/^v/, "") : null,
    // The prefix identifies fork state without extending upstream's wire contract.
    message:
      status.status === "ready"
        ? `Fork update: ${status.tag} ready. Restart to update.`
        : status.status === "needs-fixing"
          ? `Fork update: ${status.tag} needs fixing. Have an agent fix the rebase. Your installed app is unchanged.`
          : "Fork update: No staged update.",
    errorContext: status.status === "needs-fixing" ? "check" : null,
    canRetry: status.status === "ready",
  };
}
