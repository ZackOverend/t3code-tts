import { LoaderCircleIcon, MicIcon, MicOffIcon } from "lucide-react";
import { memo, useEffect, useState, useSyncExternalStore } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { toastManager } from "../components/ui/toast";
import { Toggle } from "../components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { daemonTranscriber } from "./daemonTranscriber";
import { createVadSpeechSource } from "./speechSource";
import { VoiceModeController, type VoiceModeState } from "./voiceModeController";

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
    case "error":
      return "Voice mode stopped. Click to try again";
  }
}

export const VoiceModeToggle = memo(function VoiceModeToggle(props: {
  ownerKey: string;
  readPrompt: () => string;
  commitPrompt: (text: string) => void;
}) {
  const readDraft = useStableCallback(() => ({
    ownerKey: props.ownerKey,
    text: props.readPrompt(),
  }));
  const commitDraft = useStableCallback((text: string) => props.commitPrompt(text));
  const [controller] = useState(
    () =>
      new VoiceModeController({
        createSpeechSource: createVadSpeechSource,
        transcriber: daemonTranscriber,
        readDraft,
        commitDraft,
      }),
  );
  const state = useSyncExternalStore(controller.subscribe, () => controller.state);

  // oxlint-disable-next-line t3code/react-effect-budget -- Nothing in render can close a live microphone. The composer keys this component by thread, so unmounting is how voice mode ends when the thread changes.
  useEffect(() => () => controller.turnOff(), [controller]);

  const message = state.error ?? state.notice;
  const isError = state.error !== null;
  // oxlint-disable-next-line t3code/react-effect-budget -- Surfaces a controller-initiated failure or dropped phrase as a toast; it has no other trigger to hang off.
  useEffect(() => {
    if (!message) return;
    toastManager.add({
      type: isError ? "error" : "warning",
      title: "Voice mode",
      description: message,
    });
  }, [message, isError]);

  const Icon =
    state.phase === "transcribing" || state.phase === "starting"
      ? LoaderCircleIcon
      : state.phase === "error"
        ? MicOffIcon
        : MicIcon;
  const label = describe(state);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label="Voice mode"
            pressed={state.phase === "listening" || state.phase === "transcribing"}
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
