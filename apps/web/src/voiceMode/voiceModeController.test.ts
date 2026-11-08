import { describe, expect, it, vi } from "vite-plus/test";

import {
  VoiceModeController,
  VoiceModeError,
  type SpeechSource,
  type SpeechSourceHandlers,
  type VoiceModeState,
} from "./voiceModeController";
import { DEFAULT_VOICE_PHRASES, type VoicePhrases } from "./voiceCommands";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Each fake utterance carries an id in its first sample so the fake transcriber can answer for it.
function utterance(id: number): Float32Array {
  return new Float32Array([id, 0, 0]);
}

function createComposer(key: string, draft = "") {
  const composer = {
    key,
    draft,
    sent: [] as string[],
    runningTurnId: null as string | null,
    interrupted: [] as string[],
    draftAtInterrupt: [] as string[],
    get turnRunning(): boolean {
      return (
        composer.runningTurnId !== null && !composer.interrupted.includes(composer.runningTurnId)
      );
    },
    target: {
      key,
      readDraft: () => composer.draft,
      readRunningTurnId: () => composer.runningTurnId,
      interrupt: () => {
        composer.interrupted.push(composer.runningTurnId!);
        composer.draftAtInterrupt.push(composer.draft);
      },
      commitDraft: (text: string) => {
        composer.draft = text;
        return true;
      },
      // Like a typed send: the message goes out and the draft empties.
      submit: (replaceRunningTurn?: boolean) => {
        if (replaceRunningTurn) composer.runningTurnId = null;
        composer.sent.push(composer.draft);
        composer.draft = "";
      },
    },
  };
  return composer;
}

function createHarness(
  options: {
    draft?: string;
    persisted?: boolean;
    withoutComposer?: boolean;
    startMicrophone?: () => Promise<void>;
    stopMicrophone?: () => Promise<void>;
    check?: () => Promise<void>;
    phrases?: VoicePhrases;
    settings?: { sendMode: "keyword" | "pause"; pauseSeconds: number };
  } = {},
) {
  const composer = createComposer("environment:thread", options.draft);
  let stored = options.persisted ?? false;
  let microphoneOpen = false;
  let microphoneStarts = 0;
  let playbackActive = false;
  let playbackText = "";
  let handlers!: SpeechSourceHandlers;
  const transcripts = new Map<number, Promise<string>>();
  let phrases = options.phrases ?? DEFAULT_VOICE_PHRASES;

  const createSource = (): SpeechSource => ({
    start: async () => {
      microphoneStarts += 1;
      await options.startMicrophone?.();
      microphoneOpen = true;
    },
    stop: async () => {
      if (options.stopMicrophone) await options.stopMicrophone();
      microphoneOpen = false;
    },
  });

  const controller = new VoiceModeController({
    createSpeechSource: (next) => {
      handlers = next;
      return createSource();
    },
    transcriber: {
      check: async () => options.check?.(),
      transcribe: async (audio) => transcripts.get(audio[0] ?? -1) ?? "",
    },
    persistence: {
      read: () => stored,
      write: (on) => {
        stored = on;
      },
    },
    phrases: () => phrases,
    settings: () => options.settings ?? { sendMode: "keyword", pauseSeconds: 3 },
    isPlaybackActive: () => playbackActive,
    getPlaybackText: () => (playbackActive ? playbackText : null),
    stopPlayback: () => {
      playbackActive = false;
      controller.syncPlayback();
    },
  });
  if (!options.withoutComposer) controller.registerTarget(composer.target);

  return {
    controller,
    get playbackActive() {
      return playbackActive;
    },
    setPlayback(active: boolean, text = "The reply’s own audio send it") {
      playbackText = text;
      playbackActive = active;
      controller.syncPlayback();
    },
    composer,
    get draft() {
      return composer.draft;
    },
    get sent() {
      return composer.sent;
    },
    get stored() {
      return stored;
    },
    get microphoneStarts() {
      return microphoneStarts;
    },
    get microphoneOpen() {
      return microphoneOpen;
    },
    type: (text: string) => {
      composer.draft = text;
    },
    setPhrases: (next: VoicePhrases) => {
      phrases = next;
    },
    say: (id: number, transcript: string | Promise<string>) => {
      transcripts.set(id, Promise.resolve(transcript));
      handlers.onSegment(utterance(id));
    },
    sayAfter: (id: number, transcript: Promise<string>) => {
      transcripts.set(id, transcript);
      handlers.onSegment(utterance(id));
    },
    startSpeech: () => handlers.onSpeechStart(),
    sourceFails: (error: unknown) => handlers.onError(error),
    listening: () => until(controller, (state) => state.phase === "listening"),
  };
}

describe("VoiceModeController", () => {
  it.each(["speech", "click", "clear", "keyword", "edit", "off", "settings"] as const)(
    "handles %s during a pause countdown",
    async (action) => {
      vi.useFakeTimers();
      try {
        const settings = { sendMode: "pause" as "pause" | "keyword", pauseSeconds: 3 };
        const h = createHarness({ settings });
        await h.controller.turnOn();
        h.say(1, "Hello");
        await h.listening();
        if (action === "speech") h.startSpeech();
        if (action === "click") h.controller.toggle();
        if (action === "edit") h.type("Edited");
        if (action === "off") h.controller.turnOff();
        if (action === "settings") settings.sendMode = "keyword";
        if (action === "clear" || action === "keyword") {
          h.say(2, action === "clear" ? "scratch that" : "send it");
          await h.listening();
        }
        await vi.advanceTimersByTimeAsync(4000);
        expect(h.sent).toEqual(action === "keyword" ? ["Hello"] : []);
        expect(h.controller.state.pauseRemaining).toBeUndefined();
        if (action === "clear") expect(h.draft).toBe("");
        if (action === "click") expect(h.controller.enabled).toBe(true);
        h.controller.turnOff();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reads pause settings again in an active session", async () => {
    vi.useFakeTimers();
    try {
      const settings = { sendMode: "keyword" as "pause" | "keyword", pauseSeconds: 3 };
      const h = createHarness({ settings });
      await h.controller.turnOn();
      h.say(1, "Hello");
      await h.listening();
      await vi.advanceTimersByTimeAsync(4000);
      expect(h.sent).toEqual([]);
      settings.sendMode = "pause";
      settings.pauseSeconds = 2;
      h.say(2, "world");
      await h.listening();
      expect(h.controller.state.pauseRemaining).toBe(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.sent).toEqual(["Hello world"]);
      h.controller.turnOff();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts down then sends a replacement through normal submit", async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness({ settings: { sendMode: "pause", pauseSeconds: 3 } });
      h.composer.runningTurnId = "turn-1";
      await h.controller.turnOn();
      h.say(1, "New plan");
      await h.listening();
      expect(h.controller.state.pauseRemaining).toBe(3);
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.sent).toEqual([]);
      expect(h.controller.state.pauseRemaining).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sent).toEqual(["New plan"]);
      expect(h.composer.runningTurnId).toBeNull();
      h.controller.turnOff();
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts a running turn once before appending, then sends the replacement", async () => {
    const h = createHarness({ draft: "Next:" });
    h.composer.runningTurnId = "turn-1";
    await h.controller.turnOn();
    h.say(1, "Change the plan");
    await h.listening();
    expect(h.composer.interrupted).toEqual(["turn-1"]);
    expect(h.composer.draftAtInterrupt).toEqual(["Next:"]);
    expect(h.composer.turnRunning).toBe(false);
    expect(h.draft).toBe("Next: Change the plan");
    h.say(2, "Use TypeScript send it");
    await h.listening();
    expect(h.composer.interrupted).toEqual(["turn-1"]);
    expect(h.sent).toEqual(["Next: Change the plan Use TypeScript"]);
    expect(h.draft).toBe("");
    expect(h.composer.runningTurnId).toBeNull();
    h.composer.runningTurnId = "turn-2";
    h.say(3, "Actually use Rust send it");
    await h.listening();
    expect(h.composer.interrupted).toEqual(["turn-1", "turn-2"]);
    expect(h.sent).toEqual(["Next: Change the plan Use TypeScript", "Actually use Rust"]);
  });

  it.each([
    { words: "", initial: "keep", running: true, draft: "keep", interrupts: 0, sent: [] },
    { words: "   ", initial: "keep", running: true, draft: "keep", interrupts: 0, sent: [] },
    { words: "...", initial: "keep", running: true, draft: "keep", interrupts: 0, sent: [] },
    { words: "scratch that", initial: "keep", running: true, draft: "", interrupts: 0, sent: [] },
    { words: "send it", initial: "", running: true, draft: "", interrupts: 0, sent: [] },
    { words: "send it", initial: "keep", running: true, draft: "", interrupts: 1, sent: ["keep"] },
    {
      words: "New plan send it",
      initial: "",
      running: true,
      draft: "",
      interrupts: 1,
      sent: ["New plan"],
    },
    { words: "New plan", initial: "", running: false, draft: "New plan", interrupts: 0, sent: [] },
  ])(
    "handles $words with running=$running and draft=$initial",
    async ({ words, initial, running, draft, interrupts, sent }) => {
      const h = createHarness({ draft: initial });
      h.composer.runningTurnId = running ? "turn-1" : null;
      await h.controller.turnOn();
      h.say(1, words);
      await h.listening();
      expect(h.composer.interrupted).toHaveLength(interrupts);
      expect(h.composer.runningTurnId).toBe(running && sent.length === 0 ? "turn-1" : null);
      expect(h.draft).toBe(draft);
      expect(h.sent).toEqual(sent);
    },
  );

  it.each(["send", "edit", "switch", "off"])(
    "waits for Stop before handling the draft: %s",
    async (action) => {
      const h = createHarness();
      const stopped = deferred<void>();
      h.composer.runningTurnId = "turn-1";
      h.controller.registerTarget({ ...h.composer.target, interrupt: () => stopped.promise });
      await h.controller.turnOn();
      h.say(1, "New plan send it");
      await flushMicrotasks();
      expect(h.draft).toBe("");
      expect(h.sent).toEqual([]);
      if (action === "edit") h.type("typed meanwhile");
      const other = createComposer("another-thread");
      if (action === "switch") h.controller.registerTarget(other.target);
      if (action === "off") h.controller.turnOff();
      stopped.resolve();
      await flushMicrotasks();
      expect(h.sent).toEqual(action === "send" ? ["New plan"] : []);
      expect(h.draft).toBe(action === "edit" ? "typed meanwhile" : "");
      expect(other.draft).toBe("");
      expect(other.sent).toEqual([]);
    },
  );

  it("stops playback only after words are transcribed and appends them", async () => {
    const h = createHarness({ draft: "Next:" });
    await h.controller.turnOn();
    h.setPlayback(true);
    const transcript = deferred<string>();
    h.sayAfter(1, transcript.promise);
    expect(h.playbackActive).toBe(true);
    expect(h.draft).toBe("Next:");
    transcript.resolve("Please change the plan");
    await flushMicrotasks();
    expect(h.playbackActive).toBe(false);
    expect(h.draft).toBe("Next: Please change the plan");
    expect(h.controller.state.phase).toBe("listening");
    expect(h.microphoneOpen).toBe(true);
  });

  it.each(["", "   ", "...", "♪", "THE plan is ready!", "plan is ready"])(
    "keeps playback and draft unchanged for noise or echo: %j",
    async (transcript) => {
      const h = createHarness({ draft: "keep" });
      await h.controller.turnOn();
      h.composer.runningTurnId = "turn-1";
      h.setPlayback(true, "The **plan** is ready.");
      h.say(1, transcript);
      await flushMicrotasks();
      expect(h.playbackActive).toBe(true);
      expect(h.draft).toBe("keep");
      expect(h.sent).toEqual([]);
      expect(h.controller.state.phase).toBe("speaking");
      expect(h.composer.interrupted).toEqual([]);
      expect(h.composer.runningTurnId).toBe("turn-1");
    },
  );

  it("rejects echo whose transcription arrives after playback ends", async () => {
    const h = createHarness({ draft: "keep" });
    await h.controller.turnOn();
    h.setPlayback(true, "The plan is ready");
    const transcript = deferred<string>();
    h.sayAfter(1, transcript.promise);
    h.setPlayback(false);
    transcript.resolve("the plan is ready");
    await flushMicrotasks();
    expect(h.playbackActive).toBe(false);
    expect(h.draft).toBe("keep");
  });

  it("rejects an echo segment that ends after the reply finishes", async () => {
    const h = createHarness({ draft: "keep" });
    await h.controller.turnOn();
    h.setPlayback(true, "The plan is ready");
    h.startSpeech();
    h.setPlayback(false);
    h.say(1, "the plan is ready");
    await flushMicrotasks();
    expect(h.draft).toBe("keep");
    expect(h.playbackActive).toBe(false);
    h.startSpeech();
    h.say(2, "the plan is ready");
    await h.listening();
    expect(h.draft).toBe("keep the plan is ready");
  });

  it.each([
    { words: "Change the plan send it", draft: "", sent: ["keep Change the plan"] },
    { words: "scratch that", draft: "", sent: [] },
  ])("handles interrupt command $words", async ({ words, draft, sent }) => {
    const h = createHarness({ draft: "keep" });
    await h.controller.turnOn();
    h.setPlayback(true);
    h.say(1, words);
    await flushMicrotasks();
    expect(h.playbackActive).toBe(false);
    expect(h.draft).toBe(draft);
    expect(h.sent).toEqual(sent);
  });

  it("listens through playback and rejects the reply’s own voice", async () => {
    const h = createHarness();
    await h.controller.turnOn();
    h.say(1, "Hello send it");
    await h.listening();
    expect(h.sent).toEqual(["Hello"]);

    h.setPlayback(true);
    expect(h.controller.state.phase).toBe("speaking");
    expect(h.microphoneOpen).toBe(true);
    h.say(2, "The reply's own audio send it");
    await flushMicrotasks();
    expect(h.draft).toBe("");
    expect(h.sent).toEqual(["Hello"]);
    expect(h.controller.state.phase).toBe("speaking");

    h.setPlayback(false);
    await h.listening();
    expect(h.microphoneOpen).toBe(true);
    h.say(3, "Next question send it");
    await h.listening();
    expect(h.sent).toEqual(["Hello", "Next question"]);
  });

  it("stays off when playback finishes after voice mode is disabled", async () => {
    const h = createHarness();
    await h.controller.turnOn();
    h.setPlayback(true);
    h.controller.turnOff();
    h.setPlayback(false);
    await flushMicrotasks();
    expect(h.controller.state.phase).toBe("off");
    expect(h.microphoneOpen).toBe(false);
    expect(h.stored).toBe(false);
  });

  it("preserves pending user speech across playback", async () => {
    const h = createHarness({ draft: "keep" });
    await h.controller.turnOn();
    const late = deferred<string>();
    h.sayAfter(1, late.promise);
    h.say(2, "queued send it");
    h.setPlayback(true);
    h.setPlayback(false);
    expect(h.controller.state.phase).toBe("transcribing");
    late.resolve("late send it");
    await flushMicrotasks();
    expect(h.draft).toBe("");
    expect(h.sent).toEqual(["keep late", "queued"]);
    h.say(3, "new");
    await h.listening();
    expect(h.draft).toBe("new");
  });

  it("opens the microphone during existing playback", async () => {
    const h = createHarness();
    h.setPlayback(true);
    await h.controller.turnOn();
    expect(h.controller.state.phase).toBe("speaking");
    expect(h.microphoneOpen).toBe(true);
    h.setPlayback(false);
    await h.listening();
    expect(h.microphoneOpen).toBe(true);
  });

  it("appends each phrase to the end of the draft with sensible spacing", async () => {
    const h = createHarness({ draft: "" });
    await h.controller.turnOn();

    h.say(1, "Fix the login bug.");
    await h.listening();
    expect(h.draft).toBe("Fix the login bug.");

    h.say(2, "Then add a test");
    await h.listening();
    expect(h.draft).toBe("Fix the login bug. Then add a test");
  });

  it("does not add a second space after whitespace or a newline", async () => {
    const h = createHarness({ draft: "First line\n" });
    await h.controller.turnOn();

    h.say(1, "second line");
    await h.listening();
    expect(h.draft).toBe("First line\nsecond line");
  });

  it("adds nothing for silence or noise", async () => {
    const h = createHarness({ draft: "keep me" });
    await h.controller.turnOn();

    h.say(1, "");
    await h.listening();
    h.say(2, "   ");
    await h.listening();

    expect(h.draft).toBe("keep me");
    expect(h.controller.state).toEqual({ phase: "listening", error: null, notice: null });
  });

  it("shows transcribing until the phrase has been written", async () => {
    const h = createHarness();
    await h.controller.turnOn();
    const transcript = deferred<string>();

    h.sayAfter(1, transcript.promise);
    expect(h.controller.state.phase).toBe("transcribing");

    transcript.resolve("hello");
    await h.listening();
    expect(h.draft).toBe("hello");
  });

  it("writes phrases spoken during a transcription in order", async () => {
    const h = createHarness();
    await h.controller.turnOn();
    const first = deferred<string>();

    h.sayAfter(1, first.promise);
    h.say(2, "second");
    first.resolve("first");
    await h.listening();

    expect(h.draft).toBe("first second");
  });

  it("appends to what the user typed between phrases", async () => {
    const h = createHarness({ draft: "hello" });
    await h.controller.turnOn();

    h.type("hello there,");
    h.say(1, "and welcome");
    await h.listening();

    expect(h.draft).toBe("hello there, and welcome");
  });

  it("does not overwrite an edit made while the phrase was being transcribed", async () => {
    const h = createHarness({ draft: "original" });
    await h.controller.turnOn();
    const transcript = deferred<string>();

    h.sayAfter(1, transcript.promise);
    h.type("original, edited by hand");
    transcript.resolve("late words");
    await h.listening();

    expect(h.draft).toBe("original, edited by hand");
    expect(h.controller.state.notice).toMatch(/not added/);
  });

  it("keeps listening after a dropped phrase and clears the notice on the next one", async () => {
    const h = createHarness({ draft: "a" });
    await h.controller.turnOn();
    const transcript = deferred<string>();

    h.sayAfter(1, transcript.promise);
    h.type("ab");
    transcript.resolve("dropped");
    await h.listening();
    h.say(2, "kept");
    await h.listening();

    expect(h.draft).toBe("ab kept");
    expect(h.controller.state.notice).toBeNull();
  });

  it("turns off, closes the microphone, and drops a pending phrase", async () => {
    const h = createHarness({ draft: "stay" });
    await h.controller.turnOn();
    const transcript = deferred<string>();

    h.sayAfter(1, transcript.promise);
    h.controller.turnOff();
    transcript.resolve("too late");
    await flushMicrotasks();

    expect(h.controller.state.phase).toBe("off");
    expect(h.microphoneOpen).toBe(false);
    expect(h.draft).toBe("stay");

    await h.controller.turnOn();
    const old = deferred<string>();
    h.sayAfter(2, old.promise);
    h.controller.turnOff();
    await h.controller.turnOn();
    const current = deferred<string>();
    h.sayAfter(3, current.promise);
    old.resolve("stale send it");
    await flushMicrotasks();
    expect(h.controller.state.phase).toBe("transcribing");
    expect(h.draft).toBe("stay");
    expect(h.sent).toEqual([]);
    current.resolve("fresh");
    await h.listening();
    expect(h.draft).toBe("stay fresh");
  });

  it("closes a microphone that finished opening after voice mode was turned off", async () => {
    const opening = deferred<void>();
    const entered = deferred<void>();
    const h = createHarness({
      startMicrophone: () => {
        entered.resolve();
        return opening.promise;
      },
    });
    const started = h.controller.turnOn();
    await entered.promise;

    h.controller.turnOff();
    opening.resolve();
    await started;
    await flushMicrotasks();

    expect(h.controller.state.phase).toBe("off");
    expect(h.microphoneOpen).toBe(false);
  });

  it("waits for microphone teardown before restarting", async () => {
    const stopped = deferred<void>();
    const h = createHarness({ stopMicrophone: () => stopped.promise });
    await h.controller.turnOn();
    h.controller.toggle();
    h.controller.toggle();
    await flushMicrotasks();

    expect(h.controller.state.phase).toBe("starting");
    expect(h.microphoneStarts).toBe(1);
    stopped.resolve();
    await h.listening();
    expect(h.microphoneStarts).toBe(2);
    expect(h.microphoneOpen).toBe(true);
  });

  it("finishes a cancelled microphone start before opening its replacement", async () => {
    const opening = deferred<void>();
    const entered = deferred<void>();
    const h = createHarness({
      startMicrophone: () => {
        entered.resolve();
        return opening.promise;
      },
    });
    const first = h.controller.turnOn();
    await entered.promise;
    await h.controller.turnOn();
    h.setPlayback(true);
    h.setPlayback(false);
    expect(h.controller.state.phase).toBe("starting");
    expect(h.microphoneStarts).toBe(1);
    h.controller.toggle();
    h.controller.toggle();
    await flushMicrotasks();

    expect(h.microphoneStarts).toBe(1);
    opening.resolve();
    await first;
    await h.listening();
    expect(h.microphoneStarts).toBe(2);
    expect(h.microphoneOpen).toBe(true);
  });

  it("reports denied microphone access and can be turned on again", async () => {
    let denied = true;
    const h = createHarness({
      startMicrophone: async () => {
        if (denied) throw new VoiceModeError("microphone-denied");
      },
    });

    await h.controller.turnOn();
    expect(h.controller.state.phase).toBe("error");
    expect(h.controller.state.error).toMatch(/Microphone access was denied/);
    expect(h.microphoneOpen).toBe(false);

    denied = false;
    expect(h.controller.enabled).toBe(false);
    h.controller.toggle();
    expect(h.controller.state.phase).toBe("starting");
    await h.listening();
    expect(h.controller.state).toEqual({ phase: "listening", error: null, notice: null });
  });

  it("reports an unreachable daemon without opening the microphone", async () => {
    const h = createHarness({
      check: async () => {
        throw new VoiceModeError("daemon-unreachable");
      },
    });

    await h.controller.turnOn();

    expect(h.controller.state.phase).toBe("error");
    expect(h.controller.state.error).toMatch(/speech daemon is not running/);
    expect(h.microphoneOpen).toBe(false);
  });

  it("stops listening when the daemon goes away mid-session", async () => {
    const h = createHarness({ draft: "keep" });
    await h.controller.turnOn();

    h.say(1, Promise.reject(new VoiceModeError("daemon-unreachable")));
    await until(h.controller, (state) => state.phase === "error");

    expect(h.controller.state.error).toMatch(/speech daemon is not running/);
    expect(h.microphoneOpen).toBe(false);
    expect(h.draft).toBe("keep");
  });

  it("stops with a message when the microphone stream dies", async () => {
    const h = createHarness();
    await h.controller.turnOn();

    h.sourceFails(new Error("device unplugged"));

    expect(h.controller.state.phase).toBe("error");
    expect(h.controller.state.error).toBe("Voice mode stopped unexpectedly.");
    expect(h.microphoneOpen).toBe(false);
  });

  describe("command phrases", () => {
    it("sends the draft without the phrase when a phrase ends with send it", async () => {
      const h = createHarness({ draft: "Fix the login bug." });
      await h.controller.turnOn();

      h.say(1, "and add a test, send it.");
      await h.listening();

      expect(h.sent).toEqual(["Fix the login bug. and add a test"]);
      expect(h.draft).toBe("");
    });

    it("matches regardless of case and trailing punctuation", async () => {
      const h = createHarness();
      await h.controller.turnOn();

      h.say(1, "First one SEND IT!");
      await h.listening();
      h.say(2, "second one, Send it?  ");
      await h.listening();
      h.say(3, "Third one. Send It...");
      await h.listening();

      expect(h.sent).toEqual(["First one", "second one", "Third one."]);
    });

    it("sends the existing draft when the phrase is only send it", async () => {
      const h = createHarness({ draft: "typed earlier" });
      await h.controller.turnOn();

      h.say(1, "Send it.");
      await h.listening();

      expect(h.sent).toEqual(["typed earlier"]);
    });

    it("sends nothing on an empty draft", async () => {
      const h = createHarness({ draft: "  \n" });
      await h.controller.turnOn();

      h.say(1, "send it");
      await h.listening();

      expect(h.sent).toEqual([]);
    });

    it("clears the draft when a phrase ends with scratch that", async () => {
      const h = createHarness({ draft: "wrong words" });
      await h.controller.turnOn();

      h.say(1, "no I mean, Scratch that.");
      await h.listening();

      expect(h.draft).toBe("");
      expect(h.sent).toEqual([]);
    });

    it("treats the phrases as plain text mid-sentence or inside a word", async () => {
      const h = createHarness();
      await h.controller.turnOn();

      h.say(1, "please send it to the reviewer");
      await h.listening();
      h.say(2, "I will scratch that itch");
      await h.listening();
      h.say(3, "then resend it");
      await h.listening();

      expect(h.sent).toEqual([]);
      expect(h.draft).toBe(
        "please send it to the reviewer I will scratch that itch then resend it",
      );
    });

    it("uses custom phrases instead of the defaults", async () => {
      const h = createHarness({ phrases: { send: ["over and out"], clear: ["never mind"] } });
      await h.controller.turnOn();

      h.say(1, "fix the bug, send it");
      await h.listening();
      h.say(2, "and ship it, Over and out.");
      await h.listening();
      h.say(3, "oops never mind");
      await h.listening();

      expect(h.sent).toEqual(["fix the bug, send it and ship it"]);
      expect(h.draft).toBe("");
    });

    it("matches multi-word phrases across uneven spacing", async () => {
      const h = createHarness({ phrases: { send: ["go ahead"], clear: ["start over"] } });
      await h.controller.turnOn();

      h.say(1, "deploy it Go   ahead");
      await h.listening();

      expect(h.sent).toEqual(["deploy it"]);
    });

    it("matches any phrase on a list, and the longest one wins", async () => {
      const h = createHarness({
        phrases: { send: ["send", "please send"], clear: ["scratch that"] },
      });
      await h.controller.turnOn();

      h.say(1, "hello please send");
      await h.listening();
      h.say(2, "goodbye send");
      await h.listening();

      expect(h.sent).toEqual(["hello", "goodbye"]);
    });

    it("treats regex characters in a phrase as plain text", async () => {
      const h = createHarness({ phrases: { send: ["over|out"], clear: ["scratch.*"] } });
      await h.controller.turnOn();

      h.say(1, "hello out");
      await h.listening();
      h.say(2, "scratch that");
      await h.listening();
      expect(h.sent).toEqual([]);
      expect(h.draft).toBe("hello out scratch that");

      h.say(3, "bye over|out");
      await h.listening();
      expect(h.sent).toEqual(["hello out scratch that bye"]);
    });

    it("does not match a custom phrase inside a longer word", async () => {
      const h = createHarness({ phrases: { send: ["go"], clear: ["scratch that"] } });
      await h.controller.turnOn();

      h.say(1, "let's ago");
      await h.listening();
      h.say(2, "o'go");
      await h.listening();

      expect(h.sent).toEqual([]);
    });

    it("applies phrase changes to the very next phrase mid-session", async () => {
      const h = createHarness({ draft: "ready" });
      await h.controller.turnOn();

      h.say(1, "yes send it");
      await h.listening();
      h.setPhrases({ send: ["fire away"], clear: ["scratch that"] });
      h.say(2, "again send it");
      await h.listening();
      h.say(3, "fire away");
      await h.listening();

      expect(h.sent).toEqual(["ready yes", "again send it"]);
    });

    it("does not send or clear a draft that was edited while the phrase was transcribed", async () => {
      const h = createHarness({ draft: "original" });
      await h.controller.turnOn();
      const transcript = deferred<string>();

      h.sayAfter(1, transcript.promise);
      h.type("original, edited by hand");
      transcript.resolve("more words send it");
      await h.listening();

      expect(h.sent).toEqual([]);
      expect(h.draft).toBe("original, edited by hand");
      expect(h.controller.state.notice).toMatch(/not added/);
    });
  });

  describe("composer targets", () => {
    it("speaks into whichever composer is showing after a switch", async () => {
      const h = createHarness({ draft: "in A" });
      await h.controller.turnOn();
      const b = createComposer("environment:other", "in B");

      h.say(1, "first");
      await h.listening();
      const hideA = h.controller.registerTarget(b.target);
      h.say(2, "second send it");
      await h.listening();

      expect(h.draft).toBe("in A first");
      expect(b.sent).toEqual(["in B second"]);
      hideA();
    });

    it("goes back to the previous composer when the newest one unmounts", async () => {
      const h = createHarness({ draft: "" });
      await h.controller.turnOn();
      const b = createComposer("environment:other");
      const hideB = h.controller.registerTarget(b.target);

      hideB();
      h.say(1, "back to A");
      await h.listening();

      expect(h.draft).toBe("back to A");
      expect(b.draft).toBe("");
    });

    it("drops a phrase captured for one thread when it resolves after a switch", async () => {
      const h = createHarness({ draft: "in A" });
      await h.controller.turnOn();
      const b = createComposer("environment:other", "in B");
      const transcript = deferred<string>();

      h.sayAfter(1, transcript.promise);
      h.controller.registerTarget(b.target);
      transcript.resolve("meant for A send it");
      await h.listening();

      expect(h.draft).toBe("in A");
      expect(b.draft).toBe("in B");
      expect(b.sent).toEqual([]);
      expect(h.sent).toEqual([]);
      expect(h.controller.state.notice).toMatch(/not added/);
    });

    it("keeps listening across the gap between two composers", async () => {
      const h = createHarness({ draft: "" });
      await h.controller.turnOn();
      const b = createComposer("environment:other");

      const hideA = h.controller.registerTarget(h.composer.target);
      hideA();
      h.controller.registerTarget(b.target);
      h.say(1, "hello");
      await h.listening();

      expect(h.controller.state.phase).toBe("listening");
      expect(b.draft).toBe("hello");
    });

    it("drops a phrase with a notice when no composer is showing", async () => {
      const h = createHarness({ withoutComposer: true });
      await h.controller.turnOn();

      h.say(1, "anything send it");
      await h.listening();

      expect(h.sent).toEqual([]);
      expect(h.controller.state.phase).toBe("listening");
      expect(h.controller.state.notice).toMatch(/not added/);
    });

    it("does not warn about noise while no composer is showing", async () => {
      const h = createHarness({ withoutComposer: true });
      await h.controller.turnOn();

      h.say(1, "");
      await h.listening();

      expect(h.controller.state.notice).toBeNull();
    });

    it("drops a phrase when the composer unmounts while it is transcribed", async () => {
      const h = createHarness({ draft: "stay" });
      await h.controller.turnOn();
      const hide = h.controller.registerTarget(h.composer.target);
      const transcript = deferred<string>();

      h.sayAfter(1, transcript.promise);
      h.controller.registerTarget(createComposer("environment:other").target);
      hide();
      transcript.resolve("late");
      await h.listening();

      expect(h.draft).toBe("stay");
    });
  });

  describe("remembering the choice", () => {
    it("starts listening at construction when it was left on", async () => {
      const h = createHarness({ persisted: true, draft: "" });

      await h.listening();
      expect(h.microphoneOpen).toBe(true);
      h.say(1, "hello at launch");
      await h.listening();
      expect(h.draft).toBe("hello at launch");
    });

    it("stays off at construction when it was left off", async () => {
      const h = createHarness({ persisted: false });

      expect(h.controller.state.phase).toBe("off");
    });

    it("remembers on and off from the toggle", async () => {
      const h = createHarness();

      h.controller.toggle();
      await h.listening();
      expect(h.stored).toBe(true);

      h.controller.toggle();
      expect(h.stored).toBe(false);
    });

    it("retries a remembered on after a failed start with one toggle click", async () => {
      let unavailable = true;
      const h = createHarness({
        persisted: true,
        check: async () => {
          if (unavailable) throw new VoiceModeError("daemon-unreachable");
        },
      });
      await until(h.controller, (state) => state.phase === "error");

      expect(h.stored).toBe(true);

      unavailable = false;
      h.controller.toggle();
      expect(h.controller.state.phase).toBe("starting");
      await h.listening();
      expect(h.microphoneOpen).toBe(true);
      expect(h.stored).toBe(true);
    });
  });

  it("toggle turns voice mode on and off", async () => {
    const h = createHarness();

    h.controller.toggle();
    await h.listening();
    expect(h.microphoneOpen).toBe(true);

    h.controller.toggle();
    expect(h.controller.state.phase).toBe("off");
    expect(h.microphoneOpen).toBe(false);
  });
});

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function until(
  controller: VoiceModeController,
  predicate: (state: VoiceModeState) => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    if (predicate(controller.state)) return resolve();
    const unsubscribe = controller.subscribe(() => {
      if (!predicate(controller.state)) return;
      unsubscribe();
      resolve();
    });
  });
}
