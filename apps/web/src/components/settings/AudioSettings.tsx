import { PlayIcon, SquareIcon } from "lucide-react";
import { useSyncExternalStore, type CSSProperties } from "react";

import {
  getDaemonReachable,
  getPlayback,
  previewVoice,
  stopSpeech,
  subscribe,
  TTS_DAEMON_URL,
} from "../chat/messageSpeech";
import {
  DEFAULT_TTS_SPEED,
  DEFAULT_TTS_VOICE,
  formatTtsSpeed,
  MAX_TTS_SPEED,
  MIN_TTS_SPEED,
  TTS_ENGINE,
  TTS_SPEED_STEP,
  TTS_VOICE_GROUPS,
  ttsVoiceLabel,
  useTtsVoiceSettings,
} from "../chat/ttsPreferences";
import { notifyDaemonUnavailable, useTtsAutoplaySetting } from "../chat/ttsAutoplay";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function EngineStatusBadge({ reachable }: { reachable: boolean | null }) {
  if (reachable === null) return <Badge variant="outline">Checking…</Badge>;
  return reachable ? (
    <Badge variant="success">Daemon running</Badge>
  ) : (
    <Badge variant="warning">Daemon not running</Badge>
  );
}

export function AudioSettings() {
  const [autoplay, setAutoplay] = useTtsAutoplaySetting();
  const { voice, speed, setVoice, setSpeed } = useTtsVoiceSettings();
  const reachable = useSyncExternalStore(subscribe, getDaemonReachable);
  const playback = useSyncExternalStore(subscribe, getPlayback);

  const speedRatio = (speed - MIN_TTS_SPEED) / (MAX_TTS_SPEED - MIN_TTS_SPEED);
  const speedSliderStyle = {
    "--settings-slider-progress": `${speedRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - speedRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      <SettingsSection id="tts" title="Text to speech">
        <SettingsRow
          {...searchableSetting("tts-engine")}
          description={`${TTS_ENGINE.name} (${TTS_ENGINE.model}) runs locally on this device through the speech daemon and plays in this app on your current output device. The model is fixed.`}
          status={
            reachable === false
              ? `Can't reach the daemon at ${TTS_DAEMON_URL}. Start it, then try again.`
              : undefined
          }
          control={<EngineStatusBadge reachable={reachable} />}
        />

        <SettingsRow
          {...searchableSetting("tts-autoplay")}
          description="Speak each assistant response when it finishes. You can also read any message aloud from its actions."
          control={
            <Switch
              checked={autoplay}
              aria-label="Read responses aloud automatically"
              onCheckedChange={setAutoplay}
            />
          }
        />

        <SettingsRow
          {...searchableSetting("tts-voice")}
          description="Voices installed with the Kokoro model. The voice's language sets how text is pronounced."
          resetAction={
            voice !== DEFAULT_TTS_VOICE ? (
              <SettingResetButton label="voice" onClick={() => setVoice(DEFAULT_TTS_VOICE)} />
            ) : null
          }
          control={
            <Select value={voice} onValueChange={(value) => value && setVoice(value)}>
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Voice">
                <SelectValue>{ttsVoiceLabel(voice)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {TTS_VOICE_GROUPS.map((group) => (
                  <SelectGroup key={group.language}>
                    <SelectGroupLabel>{group.language}</SelectGroupLabel>
                    {group.voices.map((option) => (
                      <SelectItem key={option.id} hideIndicator value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          {...searchableSetting("tts-speed")}
          description="How fast responses are read."
          resetAction={
            speed !== DEFAULT_TTS_SPEED ? (
              <SettingResetButton
                label="speech speed"
                onClick={() => setSpeed(DEFAULT_TTS_SPEED)}
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="tts-speed"
              >
                {formatTtsSpeed(speed)}
              </output>
              <input
                aria-label="Speech speed"
                className="settings-slider min-w-0 flex-1"
                id="tts-speed"
                max={MAX_TTS_SPEED}
                min={MIN_TTS_SPEED}
                onChange={(event) => setSpeed(event.currentTarget.valueAsNumber)}
                step={TTS_SPEED_STEP}
                style={speedSliderStyle}
                type="range"
                value={speed}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("tts-preview")}
          description="Play a sample with your saved voice and speed, or stop whatever is playing."
          control={
            <>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void previewVoice(notifyDaemonUnavailable)}
              >
                <PlayIcon className="size-3" />
                Preview voice
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={playback.state === "idle"}
                onClick={stopSpeech}
              >
                <SquareIcon className="size-3" />
                Stop playback
              </Button>
            </>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
