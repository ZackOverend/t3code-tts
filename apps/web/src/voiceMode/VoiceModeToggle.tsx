import { LoaderCircleIcon, MicIcon, MicOffIcon, Volume2Icon } from "lucide-react";
import { memo, useEffect, useSyncExternalStore } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { Toggle } from "../components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { VoiceModeState } from "./voiceModeController";
import { getVoiceModeController } from "./voiceModeSession";

function describe(state: VoiceModeState): string {
  switch (state.phase) {
    case "off":
      return "Start voice mode";
    case "starting":
      return "Starting voice mode…";
    case "listening":
      return "Listening. Click to stop voice mode";
    case "transcribing":
      return "Transcribing. Click to stop voice mode";
    case "speaking":
      return "Speaking. Click to stop voice mode";
    case "error":
      return "Voice mode stopped. Click to retry";
  }
}

export const VoiceModeToggle = memo(function VoiceModeToggle(props: {
  ownerKey: string;
  readPrompt: () => string;
  commitPrompt: (text: string) => boolean;
  submit: (replaceRunningTurn?: boolean) => void;
  runningTurnId: string | null;
  interrupt: () => void | Promise<void>;
}) {
  const controller = getVoiceModeController();
  const readDraft = useStableCallback(() => props.readPrompt());
  const commitDraft = useStableCallback((text: string) => props.commitPrompt(text));
  const submit = useStableCallback((replaceRunningTurn?: boolean) =>
    props.submit(replaceRunningTurn),
  );
  const readRunningTurnId = useStableCallback(() => props.runningTurnId);
  const interrupt = useStableCallback(() => props.interrupt());
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Registers this composer as the place speech goes while it is showing; the controller outlives it, so unmounting must unregister.
  useEffect(
    () =>
      controller.registerTarget({
        key: props.ownerKey,
        readDraft,
        commitDraft,
        submit,
        readRunningTurnId,
        interrupt,
      }),
    [controller, props.ownerKey, readDraft, commitDraft, submit, readRunningTurnId, interrupt],
  );

  const Icon =
    state.phase === "transcribing" || state.phase === "starting"
      ? LoaderCircleIcon
      : state.phase === "error"
        ? MicOffIcon
        : state.phase === "speaking"
          ? Volume2Icon
          : MicIcon;
  const label =
    state.pauseRemaining === undefined
      ? describe(state)
      : `Sending in ${state.pauseRemaining}s. Click to cancel`;

  return (
    <>
      {state.preview && state.previewOwner === props.ownerKey ? (
        <span className="max-w-64 whitespace-pre-wrap break-words text-xs italic text-muted-foreground">
          {state.preview}
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label="Voice mode"
              pressed={state.phase !== "off" && state.phase !== "error"}
              onPressedChange={() => controller.toggle()}
              onPointerDown={(event) => event.preventDefault()}
              size="sm"
              variant="ghost"
            />
          }
        >
          {state.pauseRemaining !== undefined ? <span>{state.pauseRemaining}s</span> : null}
          <Icon
            aria-hidden
            className={
              state.phase === "transcribing" || state.phase === "starting"
                ? "animate-spin"
                : undefined
            }
          />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    </>
  );
});
