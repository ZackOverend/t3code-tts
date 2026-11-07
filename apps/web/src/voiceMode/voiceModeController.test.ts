import { describe, expect, it } from "vite-plus/test";

import {
  VoiceModeController,
  VoiceModeError,
  type SpeechSource,
  type SpeechSourceHandlers,
  type VoiceModeState,
} from "./voiceModeController";

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

function createHarness(
  options: {
    draft?: string;
    startMicrophone?: () => Promise<void>;
    check?: () => Promise<void>;
  } = {},
) {
  let draft = options.draft ?? "";
  const ownerKey = "environment:thread";
  let microphoneOpen = false;
  let handlers!: SpeechSourceHandlers;
  const transcripts = new Map<number, Promise<string>>();

  const source: SpeechSource = {
    start: async () => {
      await options.startMicrophone?.();
      microphoneOpen = true;
    },
    stop: async () => {
      microphoneOpen = false;
    },
  };

  const controller = new VoiceModeController({
    createSpeechSource: (next) => {
      handlers = next;
      return source;
    },
    transcriber: {
      check: async () => options.check?.(),
      transcribe: async (audio) => transcripts.get(audio[0] ?? -1) ?? "",
    },
    readDraft: () => ({ ownerKey, text: draft }),
    commitDraft: (text) => {
      draft = text;
    },
  });

  return {
    controller,
    get draft() {
      return draft;
    },
    get microphoneOpen() {
      return microphoneOpen;
    },
    type: (text: string) => {
      draft = text;
    },
    say: (id: number, transcript: string | Promise<string>) => {
      transcripts.set(id, Promise.resolve(transcript));
      handlers.onSegment(utterance(id));
    },
    sayAfter: (id: number, transcript: Promise<string>) => {
      transcripts.set(id, transcript);
      handlers.onSegment(utterance(id));
    },
    sourceFails: (error: unknown) => handlers.onError(error),
    listening: () => until(controller, (state) => state.phase === "listening"),
  };
}

describe("VoiceModeController", () => {
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
  });

  it("closes a microphone that finished opening after voice mode was turned off", async () => {
    const opening = deferred<void>();
    const h = createHarness({ startMicrophone: () => opening.promise });
    const started = h.controller.turnOn();

    h.controller.turnOff();
    opening.resolve();
    await started;

    expect(h.controller.state.phase).toBe("off");
    expect(h.microphoneOpen).toBe(false);
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
    await h.controller.turnOn();
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
