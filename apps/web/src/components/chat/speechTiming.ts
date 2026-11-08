export type WordTime = { text: string; start: number; end: number };
type Header = { text: string; samples: number; words: WordTime[] };
export class TimedFrames {
  private bytes = new Uint8Array(0);
  push(chunk: Uint8Array) {
    const joined = new Uint8Array(this.bytes.length + chunk.length);
    joined.set(this.bytes);
    joined.set(chunk, this.bytes.length);
    this.bytes = joined;
    const frames: (Header & { pcm: Float32Array<ArrayBuffer> })[] = [];
    while (this.bytes.length >= 4) {
      const n = new DataView(this.bytes.buffer).getUint32(0, true);
      if (n > 1048576) throw new Error("Invalid speech header length");
      if (this.bytes.length < 4 + n) break;
      const header: Header = JSON.parse(new TextDecoder().decode(this.bytes.subarray(4, 4 + n)));
      if (
        !Number.isSafeInteger(header.samples) ||
        header.samples < 0 ||
        header.samples > 24000000 ||
        typeof header.text !== "string" ||
        !Array.isArray(header.words) ||
        header.words.some(
          (w) =>
            typeof w.text !== "string" ||
            !Number.isFinite(w.start) ||
            !Number.isFinite(w.end) ||
            w.start < 0 ||
            w.end < w.start,
        )
      )
        throw new Error("Invalid speech frame");
      const end = 4 + n + header.samples * 4;
      if (this.bytes.length < end) break;
      const view = new DataView(this.bytes.buffer);
      const pcm = new Float32Array(header.samples);
      for (let i = 0; i < pcm.length; i++) pcm[i] = view.getFloat32(4 + n + i * 4, true);
      frames.push({ ...header, pcm });
      this.bytes = this.bytes.slice(end);
    }
    return frames;
  }
  finish() {
    if (this.bytes.length) throw new Error("Truncated speech frame");
  }
}
const small =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const tens = "zero ten twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/\d+/g, (digits) => {
      const n = Number(digits);
      return n < 20
        ? small[n]!
        : n < 100
          ? tens[Math.floor(n / 10)]! + (n % 10 ? small[n % 10] : "")
          : digits;
    })
    .replace(/[^\p{L}\p{N}]/gu, "");
}
const MAX_SKIPPED_TOKENS = 12;
export function alignWords(source: string, words: string[]) {
  const clean = source.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`|\]\([^)]*\)/g, (value) =>
    " ".repeat(value.length),
  );
  const tokens = Array.from(clean.matchAll(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu));
  let cursor = 0;
  return words.map((word) => {
    const key = normalize(word);
    // Bounded so one unmatched word can't jump the rest of the reply far ahead.
    const index = tokens.findIndex(
      (token, i) => i >= cursor && i < cursor + MAX_SKIPPED_TOKENS && normalize(token[0]) === key,
    );
    if (index < 0) return { start: 0, end: 0 };
    cursor = index + 1;
    const token = tokens[index]!;
    return { start: token.index, end: token.index + token[0].length };
  });
}
export function scheduleWords(words: WordTime[], start: number) {
  return words.map((word) => ({ ...word, start: start + word.start, end: start + word.end }));
}
export function sliceFromWord(source: string, offset: number) {
  return source.slice(offset);
}
