import * as Schema from "effect/Schema";

import { readLocalStorageValue, useLocalStorage } from "../hooks/useLocalStorage";
import {
  DEFAULT_VOICE_PHRASES,
  normalizeVoicePhrase,
  type VoiceCommand,
  type VoicePhrases,
} from "./voiceCommands";

const VOICE_PHRASES_KEY = "t3code:voice-phrases";

const VoicePhrasesSchema = Schema.Struct({
  send: Schema.Array(Schema.String),
  clear: Schema.Array(Schema.String),
});

const OTHER_COMMAND: Record<VoiceCommand, VoiceCommand> = { send: "clear", clear: "send" };

export type VoicePhraseEdit =
  | { readonly ok: true; readonly phrases: VoicePhrases }
  | { readonly ok: false; readonly error: string };

function check(
  phrases: VoicePhrases,
  command: VoiceCommand,
  raw: string,
  ignoreIndex: number | null,
): { readonly phrase: string } | { readonly error: string } {
  const phrase = normalizeVoicePhrase(raw);
  if (phrase === "") return { error: "Enter a phrase." };
  if (phrases[OTHER_COMMAND[command]].includes(phrase)) {
    return { error: `"${phrase}" is already a ${OTHER_COMMAND[command]} phrase.` };
  }
  if (phrases[command].some((existing, index) => index !== ignoreIndex && existing === phrase)) {
    return { error: `"${phrase}" is already in the list.` };
  }
  return { phrase };
}

function withList(
  phrases: VoicePhrases,
  command: VoiceCommand,
  list: ReadonlyArray<string>,
): VoicePhrases {
  return { ...phrases, [command]: list };
}

export function addVoicePhrase(
  phrases: VoicePhrases,
  command: VoiceCommand,
  raw: string,
): VoicePhraseEdit {
  const checked = check(phrases, command, raw, null);
  if ("error" in checked) return { ok: false, error: checked.error };
  return { ok: true, phrases: withList(phrases, command, [...phrases[command], checked.phrase]) };
}

export function replaceVoicePhrase(
  phrases: VoicePhrases,
  command: VoiceCommand,
  index: number,
  raw: string,
): VoicePhraseEdit {
  const checked = check(phrases, command, raw, index);
  if ("error" in checked) return { ok: false, error: checked.error };
  return {
    ok: true,
    phrases: withList(
      phrases,
      command,
      phrases[command].map((existing, at) => (at === index ? checked.phrase : existing)),
    ),
  };
}

export function removeVoicePhrase(
  phrases: VoicePhrases,
  command: VoiceCommand,
  index: number,
): VoicePhraseEdit {
  if (phrases[command].length <= 1) {
    return { ok: false, error: `Keep at least one ${command} phrase.` };
  }
  return {
    ok: true,
    phrases: withList(
      phrases,
      command,
      phrases[command].filter((_, at) => at !== index),
    ),
  };
}

/** Turns whatever storage held into usable phrase lists; anything unusable means the defaults. */
export function resolveVoicePhrases(value: unknown): VoicePhrases {
  if (typeof value !== "object" || value === null) return DEFAULT_VOICE_PHRASES;
  const lists = value as Partial<Record<VoiceCommand, unknown>>;
  const send = cleanList(lists.send, []);
  const clear = cleanList(lists.clear, send);
  return send.length === 0 || clear.length === 0 ? DEFAULT_VOICE_PHRASES : { send, clear };
}

function cleanList(raw: unknown, taken: ReadonlyArray<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const list: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const phrase = normalizeVoicePhrase(item);
    if (phrase !== "" && !list.includes(phrase) && !taken.includes(phrase)) list.push(phrase);
  }
  return list;
}

/** Read fresh on every spoken phrase so settings changes apply mid-session. */
export function readVoicePhrases(): VoicePhrases {
  return resolveVoicePhrases(
    readLocalStorageValue(VOICE_PHRASES_KEY, DEFAULT_VOICE_PHRASES, VoicePhrasesSchema),
  );
}

export function useVoicePhrases() {
  const [stored, setStored] = useLocalStorage(
    VOICE_PHRASES_KEY,
    DEFAULT_VOICE_PHRASES,
    VoicePhrasesSchema,
  );
  return {
    phrases: resolveVoicePhrases(stored),
    setPhrases: (phrases: VoicePhrases) => setStored(phrases),
    reset: () => setStored(DEFAULT_VOICE_PHRASES),
  };
}
