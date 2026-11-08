import { describe, expect, it } from "vite-plus/test";
import { createAutoplayTracker, type AutoplayCandidate } from "./ttsAutoplay";

const message = (overrides: Partial<AutoplayCandidate> = {}): AutoplayCandidate => ({
  id: "m1",
  text: "Hello there",
  showCopyButton: true,
  streaming: false,
  ...overrides,
});

describe("createAutoplayTracker", () => {
  it.each([
    { autoplay: false, expected: null },
    { autoplay: true, expected: "Hello there" },
  ])("reads once with autoplay=$autoplay", (settings) => {
    const tracker = createAutoplayTracker();
    tracker.observe(message({ streaming: true }), settings);
    expect(tracker.observe(message(), settings)).toBe(settings.expected);
    expect(tracker.observe(message(), { autoplay: true })).toBeNull();
    tracker.observe(message({ id: "next", streaming: true }), settings);
    expect(tracker.observe(message({ id: "next" }), settings)).toBe(
      settings.autoplay ? "Hello there" : null,
    );
  });

  it("speaks a response once after it finishes streaming", () => {
    const tracker = createAutoplayTracker();
    expect(
      tracker.observe(message({ streaming: true, showCopyButton: false, text: "Hel" }), {
        autoplay: true,
      }),
    ).toBe(null);
    expect(
      tracker.observe(message({ streaming: true, showCopyButton: false }), { autoplay: true }),
    ).toBe(null);
    expect(tracker.observe(message(), { autoplay: true })).toBe("Hello there");
    expect(tracker.observe(message(), { autoplay: true })).toBe(null);
  });

  it("never speaks responses that first appear complete", () => {
    const tracker = createAutoplayTracker();
    expect(tracker.observe(message({ id: "old1" }), { autoplay: true })).toBe(null);
    expect(tracker.observe(message({ id: "old2" }), { autoplay: true })).toBe(null);
  });

  it("does not speak a response that is not the terminal message", () => {
    const tracker = createAutoplayTracker();
    tracker.observe(message({ streaming: true, showCopyButton: false }), { autoplay: true });
    expect(tracker.observe(message({ showCopyButton: false }), { autoplay: true })).toBe(null);
    expect(tracker.observe(message(), { autoplay: true })).toBe("Hello there");
  });

  it("does not speak an empty finished response", () => {
    const tracker = createAutoplayTracker();
    tracker.observe(message({ streaming: true, showCopyButton: false, text: "" }), {
      autoplay: true,
    });
    expect(tracker.observe(message({ text: "  " }), { autoplay: true })).toBe(null);
  });

  it("consumes a completion so it is not replayed after autoplay is toggled on", () => {
    const tracker = createAutoplayTracker();
    tracker.observe(message({ streaming: true, showCopyButton: false }), { autoplay: true });
    expect(tracker.observe(message(), { autoplay: false })).toBeNull();
    expect(tracker.observe(message(), { autoplay: true })).toBe(null);
  });

  it("speaks each new response separately", () => {
    const tracker = createAutoplayTracker();
    tracker.observe(message({ id: "a", streaming: true, showCopyButton: false }), {
      autoplay: true,
    });
    expect(tracker.observe(message({ id: "a", text: "First" }), { autoplay: true })).toBe("First");
    tracker.observe(message({ id: "b", streaming: true, showCopyButton: false }), {
      autoplay: true,
    });
    expect(tracker.observe(message({ id: "b", text: "Second" }), { autoplay: true })).toBe(
      "Second",
    );
    expect(tracker.observe(message({ id: "a", text: "First" }), { autoplay: true })).toBe(null);
  });
});
