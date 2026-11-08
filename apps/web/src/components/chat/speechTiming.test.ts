import { expect, it } from "vite-plus/test";
import { TimedFrames, alignWords, scheduleWords, sliceFromWord } from "./speechTiming";
it("decodes frames split at every byte", () => {
  const header = new TextEncoder().encode(
    JSON.stringify({ text: "Hi", samples: 2, words: [{ text: "Hi", start: 0, end: 0.2 }] }),
  );
  const bytes = new Uint8Array(4 + header.length + 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, header.length, true);
  bytes.set(header, 4);
  view.setFloat32(4 + header.length, 0.5, true);
  view.setFloat32(8 + header.length, -0.5, true);
  const parser = new TimedFrames();
  const frames = Array.from(bytes).flatMap((byte) => parser.push(Uint8Array.of(byte)));
  parser.finish();
  expect(frames).toHaveLength(1);
  expect(Array.from(frames[0]!.pcm)).toEqual([0.5, -0.5]);
});
it("aligns markdown, skipped code, punctuation and spoken numbers", () => {
  const source = "**Hello**, `ignore` world!\n```js\nhidden\n```\n42 cats.";
  const ranges = alignWords(source, ["Hello", "world", "forty-two", "cats"]);
  expect(ranges.map((r) => source.slice(r.start, r.end))).toEqual(["Hello", "world", "42", "cats"]);
  expect(sliceFromWord(source, ranges[2]!.start)).toBe("42 cats.");
});
it("places words relative to sentence audio start", () => {
  expect(scheduleWords([{ text: "hi", start: 0.2, end: 0.5 }], 12)).toEqual([
    { text: "hi", start: 12.2, end: 12.5 },
  ]);
});
it("rejects truncated frames and oversized headers", () => {
  const truncated = new TimedFrames();
  truncated.push(Uint8Array.of(1, 0));
  expect(() => truncated.finish()).toThrow("Truncated");
  expect(() => new TimedFrames().push(Uint8Array.of(255, 255, 255, 255))).toThrow("length");
});
it("keeps repeated words in source order and skips link destinations", () => {
  const source = "[go](https://go.example) go, go!";
  expect(alignWords(source, ["go", "go", "go"])).toEqual([
    { start: 1, end: 3 },
    { start: 25, end: 27 },
    { start: 29, end: 31 },
  ]);
});
it("a word missing nearby does not jump alignment to a far match", () => {
  const source = `alpha beta ${"filler ".repeat(20)}the end`;
  const ranges = alignWords(source, ["alpha", "beta", "the", "filler"]);
  expect(ranges.map((r) => source.slice(r.start, r.end))).toEqual(["alpha", "beta", "", "filler"]);
});
