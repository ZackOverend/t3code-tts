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

function createComposer(key: string, draft = "") {
  const composer = {
    key,
    draft,
    sent: [] as string[],
    target: {
      key,
      readDraft: () => composer.draft,
      commitDraft: (text: string) => {
        composer.draft = text;
        return true;
      },
      // Like a typed send: the message goes out and the draft empties.
      submit: () => {
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
    check?: () => Promise<void>;
  } = {},
) {
  const composer = createComposer("environment:thread", options.draft);
  let stored = options.persisted ?? false;
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
    persistence: {
      read: () => stored,
      write: (on) => {
        stored = on;
      },
    },
  });
  if (!options.withoutComposer) controller.registerTarget(composer.target);

  return {
    controller,
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
    get microphoneOpen() {
      return microphoneOpen;
    },
    type: (text: string) => {
      composer.draft = text;
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

    it("keeps a remembered on after a failed start, and the toggle then turns it off", async () => {
      const h = createHarness({
        persisted: true,
        check: async () => {
          throw new VoiceModeError("daemon-unreachable");
        },
      });
      await until(h.controller, (state) => state.phase === "error");

      expect(h.stored).toBe(true);

      h.controller.toggle();
      expect(h.controller.state.phase).toBe("off");
      expect(h.stored).toBe(false);
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
