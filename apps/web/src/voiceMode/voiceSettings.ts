import * as Schema from "effect/Schema";
import { readLocalStorageValue, useLocalStorage } from "../hooks/useLocalStorage";

const KEY = "t3code:voice-send-settings";
const SettingsSchema = Schema.Struct({
  sendMode: Schema.Literals(["keyword", "pause"]),
  pauseSeconds: Schema.Number,
  livePreview: Schema.optional(Schema.Boolean),
});
const DEFAULTS: {
  sendMode: "keyword" | "pause";
  pauseSeconds: number;
  livePreview?: boolean | undefined;
} = {
  sendMode: "keyword",
  pauseSeconds: 3,
  livePreview: true,
};

function normalize(value: typeof DEFAULTS) {
  return {
    ...value,
    livePreview: value.livePreview ?? true,
    pauseSeconds: Number.isFinite(value.pauseSeconds)
      ? Math.max(1, Math.min(30, Math.round(value.pauseSeconds)))
      : 3,
  };
}

export function readVoiceSettings() {
  return normalize(readLocalStorageValue(KEY, DEFAULTS, SettingsSchema));
}

export function useVoiceSettings() {
  const [value, setValue] = useLocalStorage(KEY, DEFAULTS, SettingsSchema);
  return {
    settings: normalize(value),
    setSettings: (next: typeof DEFAULTS) => setValue(normalize(next)),
  };
}
