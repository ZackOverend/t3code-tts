import { memo, useRef, useSyncExternalStore } from "react";
import { AudioLinesIcon, PauseIcon, PlayIcon, Volume2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { ANCHORED_COPY_TOAST_TIMEOUT_MS } from "../ui/anchoredCopyToast";
import { anchoredToastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getPlayback,
  hashText,
  sendToDaemon,
  speakMessage,
  subscribe,
  type Playback,
} from "./messageSpeech";
import { useTtsAutoplaySetting } from "./ttsAutoplay";

export const MessageSpeakButton = memo(function MessageSpeakButton({ text }: { text: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const id = hashText(text);
  const state = useSyncExternalStore(subscribe, () =>
    getPlayback().id === id ? getPlayback().state : "idle",
  );

  const onError = () => {
    if (!ref.current) return;
    anchoredToastManager.add({
      data: { tooltipStyle: true },
      positionerProps: { anchor: ref.current },
      timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
      title: "TTS daemon not running",
    });
  };
  const send = (path: string, body: object, next: Playback) =>
    void sendToDaemon(path, body, next, onError);

  const label = state === "playing" ? "Pause" : state === "paused" ? "Resume" : "Read aloud";
  const onClick = () => {
    if (state === "playing") send("/pause", {}, { id, state: "paused" });
    else if (state === "paused") send("/resume", {}, { id, state: "playing" });
    else void speakMessage(text, onError);
  };
  const Icon = state === "playing" ? PauseIcon : state === "paused" ? PlayIcon : Volume2Icon;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={label}
              onClick={onClick}
              ref={ref}
              type="button"
              size="xs"
              variant="ghost-muted"
            />
          }
        >
          <Icon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>
          <p>{label}</p>
        </TooltipPopup>
      </Tooltip>
      <AutoplayToggle />
    </>
  );
});

function AutoplayToggle() {
  const [autoplay, setAutoplay] = useTtsAutoplaySetting();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label="Automatically read new responses aloud"
            pressed={autoplay}
            onPressedChange={setAutoplay}
            size="xs"
            variant="ghost"
          />
        }
      >
        <AudioLinesIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup>
        <p>{autoplay ? "Autoplay on" : "Autoplay off"}</p>
      </TooltipPopup>
    </Tooltip>
  );
}
