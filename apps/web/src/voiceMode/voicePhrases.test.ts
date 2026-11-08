import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_VOICE_PHRASES } from "./voiceCommands";
import {
  addVoicePhrase,
  removeVoicePhrase,
  replaceVoicePhrase,
  resolveVoicePhrases,
} from "./voicePhrases";

const phrases = { send: ["send it", "go ahead"], clear: ["scratch that"] };

function accepted(result: ReturnType<typeof addVoicePhrase>) {
  if (!result.ok) throw new Error(result.error);
  return result.phrases;
}

describe("editing voice phrases", () => {
  it("adds a normalized phrase to the end of its list", () => {
    expect(accepted(addVoicePhrase(phrases, "clear", "  Never   Mind! "))).toEqual({
      send: ["send it", "go ahead"],
      clear: ["scratch that", "never mind"],
    });
  });

  it("rejects blank phrases and punctuation-only phrases", () => {
    expect(addVoicePhrase(phrases, "send", "   ").ok).toBe(false);
    expect(addVoicePhrase(phrases, "send", "?!").ok).toBe(false);
  });

  it("rejects a phrase already on the same list, ignoring case and spacing", () => {
    expect(addVoicePhrase(phrases, "send", "GO   ahead").ok).toBe(false);
  });

  it("rejects a phrase that is already on the other list", () => {
    const result = addVoicePhrase(phrases, "send", "Scratch that.");
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/clear/) });
  });

  it("replaces a phrase in place, and allows keeping its own text", () => {
    expect(accepted(replaceVoicePhrase(phrases, "send", 1, "ship it")).send).toEqual([
      "send it",
      "ship it",
    ]);
    expect(accepted(replaceVoicePhrase(phrases, "send", 0, "SEND IT")).send).toEqual([
      "send it",
      "go ahead",
    ]);
    expect(replaceVoicePhrase(phrases, "send", 1, "send it").ok).toBe(false);
    expect(replaceVoicePhrase(phrases, "send", 1, "scratch that").ok).toBe(false);
    expect(replaceVoicePhrase(phrases, "send", 1, " ").ok).toBe(false);
  });

  it("removes a phrase but never the last one for a command", () => {
    expect(accepted(removeVoicePhrase(phrases, "send", 0)).send).toEqual(["go ahead"]);
    expect(removeVoicePhrase(phrases, "clear", 0).ok).toBe(false);
  });
});

describe("resolving stored phrases", () => {
  it("falls back to the defaults for missing or malformed storage", () => {
    expect(resolveVoicePhrases(null)).toEqual(DEFAULT_VOICE_PHRASES);
    expect(resolveVoicePhrases({ send: "send it" })).toEqual(DEFAULT_VOICE_PHRASES);
    expect(resolveVoicePhrases({ send: [], clear: ["scratch that"] })).toEqual(
      DEFAULT_VOICE_PHRASES,
    );
  });

  it("cleans hand-edited storage: blanks, duplicates and cross-list repeats", () => {
    expect(
      resolveVoicePhrases({
        send: [" Go Ahead ", "go ahead", "", "send it"],
        clear: ["send it", "wipe it"],
      }),
    ).toEqual({ send: ["go ahead", "send it"], clear: ["wipe it"] });
  });
});
