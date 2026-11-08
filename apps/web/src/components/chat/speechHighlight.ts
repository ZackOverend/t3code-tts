import { alignWords, scheduleWords, type WordTime } from "./speechTiming";
function textRanges(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: { node: Node; start: number; end: number }[] = [];
  let text = "";
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest("pre,code,button,input,textarea")) continue;
    const start = text.length;
    text += node.textContent;
    nodes.push({ node, start, end: text.length });
  }
  return {
    text,
    range(start: number, end: number) {
      const a = nodes.find((n) => n.end > start);
      const b = nodes.find((n) => n.end >= end);
      if (!a || !b || end <= start) return null;
      const range = new Range();
      range.setStart(a.node, start - a.start);
      range.setEnd(b.node, end - b.start);
      return range;
    },
    nodes,
  };
}
export function clickedSpeechOffset(
  root: HTMLElement,
  source: string,
  event: { clientX: number; clientY: number; target: EventTarget | null },
) {
  if (
    !(event.target instanceof Element) ||
    event.target.closest("a,pre,code,button,input,textarea,[contenteditable=true]") ||
    !window.getSelection()?.isCollapsed
  )
    return null;
  const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
  if (!caret || !root.contains(caret.startContainer)) return null;
  const mapped = textRanges(root);
  const node = mapped.nodes.find((n) => n.node === caret.startContainer);
  if (!node) return null;
  const position = node.start + caret.startOffset;
  const tokens = Array.from(mapped.text.matchAll(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu));
  const index = tokens.findIndex((t) => t.index <= position && t.index + t[0].length > position);
  if (index < 0) return null;
  const aligned = alignWords(
    source,
    tokens.map((t) => t[0]),
  );
  const match = aligned[index];
  return match && match.end > match.start ? match.start : null;
}
export function speechHighlight(id: string, context: AudioContext, prefix = "") {
  const root = document.querySelector<HTMLElement>(`[data-speech-id="${id}"]`);
  const supported =
    typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
  const mapped = root ? textRanges(root) : null;
  const prefixWords =
    prefix
      .replace(/```[\s\S]*?```|`[^`]*`/g, " ")
      .match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu) ?? [];
  let offset = mapped
    ? (alignWords(mapped.text, prefixWords)
        .filter((r) => r.end > r.start)
        .at(-1)?.end ?? 0)
    : 0;
  let follow = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const events: { start: number; end: number; word: Range | null; sentence: Range | null }[] = [];
  const abort = new AbortController();
  const unfollow = () => {
    follow = false;
  };
  window.addEventListener("wheel", unfollow, { passive: true, signal: abort.signal });
  window.addEventListener("touchmove", unfollow, { passive: true, signal: abort.signal });
  window.addEventListener(
    "keydown",
    (event) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        unfollow();
    },
    { signal: abort.signal },
  );
  const clear = () => {
    if (supported) {
      CSS.highlights.delete("tts-word");
      CSS.highlights.delete("tts-sentence");
    }
  };
  function update() {
    clearTimeout(timer);
    clear();
    if (context.state !== "running") return;
    const now = context.currentTime;
    const active = events.find((e) => e.start <= now && now < e.end);
    if (active && supported && root?.isConnected) {
      if (active.word) CSS.highlights.set("tts-word", new Highlight(active.word));
      if (active.sentence) CSS.highlights.set("tts-sentence", new Highlight(active.sentence));
      const range = active.word ?? active.sentence;
      const rect = range?.getBoundingClientRect();
      if (follow && rect && (rect.top < 0 || rect.bottom > window.innerHeight))
        range?.startContainer.parentElement?.scrollIntoView({ block: "center" });
    }
    const next = events
      .flatMap((e) => [e.start, e.end])
      .filter((t) => t > now)
      .sort((a, b) => a - b)[0];
    if (next !== undefined) timer = setTimeout(update, Math.max(1, (next - now) * 1000));
  }
  context.addEventListener("statechange", update, { signal: abort.signal });
  return {
    add(text: string, words: WordTime[], start: number, duration: number) {
      if (!mapped) return;
      const spoken = words.length
        ? words.map((w) => w.text)
        : (text.match(/[\p{L}\p{N}]+/gu) ?? []);
      const aligned = alignWords(mapped.text.slice(offset), spoken).map((r) => ({
        start: r.start + offset,
        end: r.end + offset,
      }));
      const valid = aligned.filter((r) => r.end > r.start);
      if (!valid.length) return;
      const sentence = mapped.range(valid[0]!.start, valid.at(-1)!.end);
      if (words.length)
        scheduleWords(words, start).forEach((w, i) => {
          const r = aligned[i]!;
          events.push({ start: w.start, end: w.end, word: mapped.range(r.start, r.end), sentence });
        });
      else events.push({ start, end: start + duration, word: null, sentence });
      offset = valid.at(-1)!.end;
      update();
    },
    stop() {
      clearTimeout(timer);
      abort.abort();
      clear();
    },
  };
}
