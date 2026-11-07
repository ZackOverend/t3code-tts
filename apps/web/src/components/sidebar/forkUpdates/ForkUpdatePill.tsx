import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useDesktopUpdateState } from "../../../state/desktopUpdate";
import { SidebarMenuItem } from "../../ui/sidebar";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export function ForkUpdatePill({ fallback }: { readonly fallback: ReactNode }) {
  const state = useDesktopUpdateState();
  const [pending, setPending] = useState(false);
  if (!state?.message?.startsWith("Fork update: ") || state.status === "up-to-date")
    return fallback;
  const ready = state.downloadedVersion !== null;
  const label = pending ? "Restarting…" : ready ? "Restart to update" : "Update needs fixing";
  const detail = state.message.replace(/^Fork update: /, "");
  const install = async () => {
    if (!ready || pending || !window.desktopBridge) return;
    setPending(true);
    const failure = await window.desktopBridge.installUpdate().then(
      (result) => (result.completed ? null : (result.state.message ?? "Try again.")),
      () => "Your installed app is unchanged. Try again.",
    );
    setPending(false);
    if (failure) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not install update",
          description: failure,
        }),
      );
    }
  };
  return (
    <SidebarMenuItem className="ml-auto shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`${label}. ${detail}`}
              aria-disabled={!ready || pending}
              onClick={() => void install()}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-sidebar-control-surface px-3 text-xs text-sidebar-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset aria-disabled:cursor-default"
            >
              {ready ? (
                <RotateCwIcon className="size-3.5" />
              ) : (
                <TriangleAlertIcon className="size-3.5 text-warning" />
              )}
              {label}
            </button>
          }
        />
        <TooltipPopup side="top">{detail}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
