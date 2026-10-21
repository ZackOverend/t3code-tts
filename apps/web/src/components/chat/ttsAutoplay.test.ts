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
  it("speaks a response once after it finishes streaming", () => {
    const tracker = createAutoplayTracker();
    expect(tracker.observe(message({ streaming: true, showCopyButton: false, text: "Hel" }))).toBe(
      null,
    );
    expect(tracker.observe(message({ streaming: true, showCopyButton: false }))).toBe(null);
    expect(tracker.observe(message())).toBe("Hello there");
    expect(tracker.observe(message())).toBe(null);
  });

  it("never speaks responses that first appear complete", () => {
    const tracker = createAutoplayTracker();
    expect(tracker.observe(message({ id: "old1" }))).toBe(null);
    expect(tracker.observe(message({ id: "old2" }))).toBe(null);
  });

  it("does not speak a response that is not the terminal message", () => {
    const tracker = createAutoplayTracker();
    tracker.observe(message({ streaming: true, showCopyButton: false }));
    expect(tracker.observe(message({ showCopyButton: false }))).toBe(null);
    expect(tracker.observe(message())).toBe("Hello there");
  });

  it("does not speak an empty finished response", () => {
    const tracker = createAutoplayTracker();
    tracker.observe(message({ streaming: true, showCopyButton: false, text: "" }));
    expect(tracker.observe(message({ text: "  " }))).toBe(null);
  });

  it("consumes a completion so it is not replayed after autoplay is toggled on", () => {
    const tracker = createAutoplayTracker();
    tracker.observe(message({ streaming: true, showCopyButton: false }));
    // The caller observes every completion but only speaks while autoplay is enabled.
    expect(tracker.observe(message())).toBe("Hello there");
    expect(tracker.observe(message())).toBe(null);
  });

  it("speaks each new response separately", () => {
    const tracker = createAutoplayTracker();
    tracker.observe(message({ id: "a", streaming: true, showCopyButton: false }));
    expect(tracker.observe(message({ id: "a", text: "First" }))).toBe("First");
    tracker.observe(message({ id: "b", streaming: true, showCopyButton: false }));
    expect(tracker.observe(message({ id: "b", text: "Second" }))).toBe("Second");
    expect(tracker.observe(message({ id: "a", text: "First" }))).toBe(null);
  });
});
