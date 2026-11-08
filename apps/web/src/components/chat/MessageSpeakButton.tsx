import { memo, useRef, useState, useSyncExternalStore } from "react";
import { PauseIcon, PlayIcon, Volume2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { ANCHORED_COPY_TOAST_TIMEOUT_MS } from "../ui/anchoredCopyToast";
import { anchoredToastManager } from "../ui/toast";
import { Label } from "../ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import {
  getPlayback,
  hashText,
  pauseSpeech,
  resumeSpeech,
  speakMessage,
  subscribe,
} from "./messageSpeech";
import { isVoiceModeEnabled, subscribeVoiceMode } from "../../voiceMode/voiceModeSession";
import { useTtsAutoplaySetting } from "./ttsAutoplay";

export const MessageSpeakButton = memo(function MessageSpeakButton({ text }: { text: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
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

  const label = state === "playing" ? "Pause" : state === "paused" ? "Resume" : "Read aloud";
  const onClick = () => {
    if (state === "playing") pauseSpeech();
    else if (state === "paused") resumeSpeech();
    else void speakMessage(text, onError);
  };
  const Icon = state === "playing" ? PauseIcon : state === "paused" ? PlayIcon : Volume2Icon;

  return (
    <Popover open={menuOpen} onOpenChange={setMenuOpen}>
      <PopoverTrigger
        openOnHover
        render={
          <Button
            aria-label={label}
            onClick={onClick}
            onFocus={(event) => {
              if (event.currentTarget.matches(":focus-visible")) setMenuOpen(true);
            }}
            ref={ref}
            type="button"
            size="xs"
            variant="ghost-muted"
          />
        }
      >
        <Icon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup align="start" initialFocus={false} padding="compact" side="top">
        <AutoplayMenu />
      </PopoverPopup>
    </Popover>
  );
});

function AutoplayMenu() {
  const [autoplay, setAutoplay] = useTtsAutoplaySetting();
  const voiceMode = useSyncExternalStore(subscribeVoiceMode, isVoiceModeEnabled);
  return (
    <div className="flex w-48 flex-col gap-1.5">
      <Label className="justify-between">
        Autoplay
        <Switch checked={autoplay} onCheckedChange={setAutoplay} size="sm" />
      </Label>
      {voiceMode ? (
        <p className="text-muted-foreground text-xs">Voice mode reads replies aloud anyway.</p>
      ) : null}
    </div>
  );
}
