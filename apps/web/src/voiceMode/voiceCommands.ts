export type VoiceCommand = "send" | "clear";

export interface ParsedVoicePhrase {
  readonly text: string;
  readonly command: VoiceCommand | null;
}

const TRAILING_PUNCTUATION = /[\s.,!?;:…"'’”)\]]+$/u;
const COMMAND_AT_END = /(^|[^\p{L}\p{N}'’])(send\s+it|scratch\s+that)$/iu;
const SEPARATOR_BEFORE_COMMAND = /[\s,;:]+$/u;

/** Finds "send it" or "scratch that" at the very end of a transcribed phrase and strips it. */
export function parseVoicePhrase(transcript: string): ParsedVoicePhrase {
  const body = transcript.trim().replace(TRAILING_PUNCTUATION, "");
  const match = COMMAND_AT_END.exec(body);
  if (!match) return { text: transcript, command: null };
  const spoken = match[2] ?? "";
  return {
    text: body
      .slice(0, match.index + (match[1] ?? "").length)
      .replace(SEPARATOR_BEFORE_COMMAND, ""),
    command: spoken.toLowerCase().startsWith("send") ? "send" : "clear",
  };
}
