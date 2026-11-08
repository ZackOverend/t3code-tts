export type VoiceCommand = "send" | "clear";

export interface VoicePhrases {
  readonly send: ReadonlyArray<string>;
  readonly clear: ReadonlyArray<string>;
}

export const DEFAULT_VOICE_PHRASES: VoicePhrases = {
  send: ["send it"],
  clear: ["scratch that"],
};

export interface ParsedVoicePhrase {
  readonly text: string;
  readonly command: VoiceCommand | null;
}

const TRAILING_PUNCTUATION = /[\s.,!?;:…"'’”)\]]+$/u;
const SEPARATOR_BEFORE_COMMAND = /[\s,;:]+$/u;

/** The canonical form of a spoken phrase: lowercase, single spaces, no trailing punctuation. */
export function normalizeVoicePhrase(raw: string): string {
  return raw.trim().replace(TRAILING_PUNCTUATION, "").split(/\s+/u).join(" ").toLocaleLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Finds a command phrase at the very end of a transcribed phrase and strips it. */
export function parseVoicePhrase(transcript: string, phrases: VoicePhrases): ParsedVoicePhrase {
  const commandByPhrase = new Map<string, VoiceCommand>();
  for (const command of ["clear", "send"] as const) {
    for (const phrase of phrases[command]) {
      const normalized = normalizeVoicePhrase(phrase);
      if (normalized !== "") commandByPhrase.set(normalized, command);
    }
  }
  if (commandByPhrase.size === 0) return { text: transcript, command: null };

  const alternatives = [...commandByPhrase.keys()]
    .toSorted((a, b) => b.length - a.length)
    .map((phrase) => phrase.split(" ").map(escapeRegExp).join("\\s+"));
  const commandAtEnd = new RegExp(`(^|[^\\p{L}\\p{N}'’])(${alternatives.join("|")})$`, "iu");

  const body = transcript.trim().replace(TRAILING_PUNCTUATION, "");
  const match = commandAtEnd.exec(body);
  if (!match) return { text: transcript, command: null };
  const spoken = normalizeVoicePhrase(match[2] ?? "");
  return {
    text: body
      .slice(0, match.index + (match[1] ?? "").length)
      .replace(SEPARATOR_BEFORE_COMMAND, ""),
    command: commandByPhrase.get(spoken) ?? null,
  };
}
