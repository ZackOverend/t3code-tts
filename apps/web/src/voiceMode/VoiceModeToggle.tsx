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
  submit: () => void;
}) {
  const controller = getVoiceModeController();
  const readDraft = useStableCallback(() => props.readPrompt());
  const commitDraft = useStableCallback((text: string) => props.commitPrompt(text));
  const submit = useStableCallback(() => props.submit());
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Registers this composer as the place speech goes while it is showing; the controller outlives it, so unmounting must unregister.
  useEffect(
    () => controller.registerTarget({ key: props.ownerKey, readDraft, commitDraft, submit }),
    [controller, props.ownerKey, readDraft, commitDraft, submit],
  );

  const Icon =
    state.phase === "transcribing" || state.phase === "starting"
      ? LoaderCircleIcon
      : state.phase === "error"
        ? MicOffIcon
        : state.phase === "speaking"
          ? Volume2Icon
          : MicIcon;
  const label = describe(state);

  return (
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
  );
});
