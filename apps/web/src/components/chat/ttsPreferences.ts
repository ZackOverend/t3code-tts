import * as Schema from "effect/Schema";
import { getLocalStorageItem, useLocalStorage } from "../../hooks/useLocalStorage";

export const TTS_ENGINE = { name: "Kokoro", model: "prince-canuma/Kokoro-82M" } as const;

const TTS_VOICE_KEY = "t3code:tts-voice";
const TTS_SPEED_KEY = "t3code:tts-speed";

export const DEFAULT_TTS_VOICE = "af_heart";
export const DEFAULT_TTS_SPEED = 1.1;
export const MIN_TTS_SPEED = 0.5;
export const MAX_TTS_SPEED = 2;
export const TTS_SPEED_STEP = 0.05;

// The voice packs shipped in the Kokoro-82M snapshot (voices/*.safetensors) whose language the
// daemon can synthesize here. The daemon derives the language from the first letter of the id
// (voice[0]); Japanese (j) and Mandarin (z) packs are omitted because they need misaki[ja] and
// misaki[zh], which the mlx-audio install does not include.
const KOKORO_VOICE_IDS = [
  "af_alloy",
  "af_aoede",
  "af_bella",
  "af_heart",
  "af_jessica",
  "af_kore",
  "af_nicole",
  "af_nova",
  "af_river",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_echo",
  "am_eric",
  "am_fenrir",
  "am_liam",
  "am_michael",
  "am_onyx",
  "am_puck",
  "am_santa",
  "bf_alice",
  "bf_emma",
  "bf_isabella",
  "bf_lily",
  "bm_daniel",
  "bm_fable",
  "bm_george",
  "bm_lewis",
  "ef_dora",
  "em_alex",
  "em_santa",
  "ff_siwis",
  "hf_alpha",
  "hf_beta",
  "hm_omega",
  "hm_psi",
  "if_sara",
  "im_nicola",
  "pf_dora",
  "pm_alex",
  "pm_santa",
] as const;

const KOKORO_LANGUAGES: Readonly<Record<string, string>> = {
  a: "American English",
  b: "British English",
  e: "Spanish",
  f: "French",
  h: "Hindi",
  i: "Italian",
  p: "Brazilian Portuguese",
};

export interface TtsVoice {
  readonly id: string;
  readonly label: string;
}

export interface TtsVoiceGroup {
  readonly language: string;
  readonly voices: ReadonlyArray<TtsVoice>;
}

function describeVoice(id: string): TtsVoice {
  const name = id.slice(3);
  const gender = id[1] === "f" ? "Female" : "Male";
  return { id, label: `${name.charAt(0).toUpperCase()}${name.slice(1)} · ${gender}` };
}

export const TTS_VOICE_GROUPS: ReadonlyArray<TtsVoiceGroup> = Object.entries(KOKORO_LANGUAGES).map(
  ([code, language]) => ({
    language,
    voices: KOKORO_VOICE_IDS.filter((id) => id.startsWith(code)).map(describeVoice),
  }),
);

const VOICES_BY_ID = new Map(
  TTS_VOICE_GROUPS.flatMap((group) => group.voices).map((voice) => [voice.id, voice] as const),
);

export function ttsVoiceLabel(id: string) {
  return VOICES_BY_ID.get(id)?.label ?? id;
}

export function resolveTtsVoice(value: unknown) {
  return typeof value === "string" && VOICES_BY_ID.has(value) ? value : DEFAULT_TTS_VOICE;
}

export function resolveTtsSpeed(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TTS_SPEED;
  const clamped = Math.min(MAX_TTS_SPEED, Math.max(MIN_TTS_SPEED, value));
  // Snap to the slider step so a hand-edited value never shows as 1.0700000000000001.
  return Math.round(clamped / TTS_SPEED_STEP) * TTS_SPEED_STEP;
}

export function formatTtsSpeed(speed: number) {
  return `${speed.toFixed(2).replace(/0$/, "")}×`;
}

export interface TtsVoiceSettings {
  readonly voice: string;
  readonly speed: number;
}

export function useTtsVoiceSettings() {
  const [storedVoice, setStoredVoice] = useLocalStorage(
    TTS_VOICE_KEY,
    DEFAULT_TTS_VOICE,
    Schema.String,
  );
  const [storedSpeed, setStoredSpeed] = useLocalStorage(
    TTS_SPEED_KEY,
    DEFAULT_TTS_SPEED,
    Schema.Number,
  );
  return {
    voice: resolveTtsVoice(storedVoice),
    speed: resolveTtsSpeed(storedSpeed),
    setVoice: (voice: string) => setStoredVoice(resolveTtsVoice(voice)),
    setSpeed: (speed: number) => setStoredSpeed(resolveTtsSpeed(speed)),
    reset: () => {
      setStoredVoice(DEFAULT_TTS_VOICE);
      setStoredSpeed(DEFAULT_TTS_SPEED);
    },
  };
}

function readStored<T, E>(key: string, schema: Schema.Codec<T, E>): T | null {
  try {
    return getLocalStorageItem(key, schema);
  } catch {
    return null;
  }
}

// Read at send time, not render time, so every speak path (Play, autoplay, preview) uses what is
// saved right now, including a change made in another tab.
export function readTtsVoiceSettings(): TtsVoiceSettings {
  return {
    voice: resolveTtsVoice(readStored(TTS_VOICE_KEY, Schema.String)),
    speed: resolveTtsSpeed(readStored(TTS_SPEED_KEY, Schema.Number)),
  };
}
