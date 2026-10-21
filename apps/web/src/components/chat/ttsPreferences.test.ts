import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_TTS_SPEED,
  DEFAULT_TTS_VOICE,
  formatTtsSpeed,
  MAX_TTS_SPEED,
  MIN_TTS_SPEED,
  resolveTtsSpeed,
  resolveTtsVoice,
  TTS_VOICE_GROUPS,
  ttsVoiceLabel,
} from "./ttsPreferences";

describe("resolveTtsVoice", () => {
  it("keeps an installed voice", () => {
    expect(resolveTtsVoice("bm_george")).toBe("bm_george");
  });

  it("falls back for unknown, uninstalled-language, and non-string values", () => {
    expect(resolveTtsVoice("af_nope")).toBe(DEFAULT_TTS_VOICE);
    // Japanese and Mandarin packs exist in the model but the install cannot synthesize them.
    expect(resolveTtsVoice("jf_alpha")).toBe(DEFAULT_TTS_VOICE);
    expect(resolveTtsVoice("zm_yunxi")).toBe(DEFAULT_TTS_VOICE);
    expect(resolveTtsVoice(42)).toBe(DEFAULT_TTS_VOICE);
    expect(resolveTtsVoice(null)).toBe(DEFAULT_TTS_VOICE);
  });
});

describe("resolveTtsSpeed", () => {
  it("keeps in-range values on the slider step", () => {
    expect(resolveTtsSpeed(1.25)).toBe(1.25);
    expect(resolveTtsSpeed(DEFAULT_TTS_SPEED)).toBe(DEFAULT_TTS_SPEED);
  });

  it("clamps out-of-range values", () => {
    expect(resolveTtsSpeed(0)).toBe(MIN_TTS_SPEED);
    expect(resolveTtsSpeed(-3)).toBe(MIN_TTS_SPEED);
    expect(resolveTtsSpeed(10)).toBe(MAX_TTS_SPEED);
  });

  it("snaps to the step without float noise", () => {
    expect(resolveTtsSpeed(1.07)).toBeCloseTo(1.05, 10);
    expect(formatTtsSpeed(resolveTtsSpeed(1.1500000000000001))).toBe("1.15×");
  });

  it("falls back for values that are not finite numbers", () => {
    expect(resolveTtsSpeed(Number.NaN)).toBe(DEFAULT_TTS_SPEED);
    expect(resolveTtsSpeed(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TTS_SPEED);
    expect(resolveTtsSpeed("1.5")).toBe(DEFAULT_TTS_SPEED);
    expect(resolveTtsSpeed(null)).toBe(DEFAULT_TTS_SPEED);
  });
});

describe("voice list", () => {
  it("includes the default voice, no duplicates, and each id in its language group", () => {
    const ids = TTS_VOICE_GROUPS.flatMap((group) => group.voices.map((voice) => voice.id));
    expect(ids).toContain(DEFAULT_TTS_VOICE);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TTS_VOICE_GROUPS.every((group) => group.voices.length > 0)).toBe(true);
  });

  it("labels voices by name and gender", () => {
    expect(ttsVoiceLabel("af_heart")).toBe("Heart · Female");
    expect(ttsVoiceLabel("bm_george")).toBe("George · Male");
  });
});
