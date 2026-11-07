import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { setLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  getDaemonReachable,
  getPlayback,
  isSpeechActive,
  pauseSpeech,
  previewVoice,
  resumeSpeech,
  speakMessage,
  stopSpeech,
  subscribe,
  TTS_PREVIEW_ID,
} from "./messageSpeech";
import { readTtsVoiceSettings } from "./ttsPreferences";

class FakeSource {
  buffer: FakeBuffer | null = null;
  startedAt: number | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  connect() {}
  disconnect() {}
  start(at: number) {
    this.startedAt = at;
  }
  stop() {
    this.stopped = true;
  }
  finishPlaying() {
    this.onended?.();
  }
}

class FakeBuffer {
  samples: Float32Array = new Float32Array(0);
  constructor(
    readonly length: number,
    readonly sampleRate: number,
  ) {}
  get duration() {
    return this.length / this.sampleRate;
  }
  copyToChannel(samples: Float32Array) {
    this.samples = samples;
  }
}

class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  currentTime = 0;
  destination = {};
  suspended = false;
  closed = false;
  sources: FakeSource[] = [];
  constructor() {
    FakeAudioContext.created.push(this);
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return new FakeBuffer(length, sampleRate);
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  suspend() {
    this.suspended = true;
    return Promise.resolve();
  }
  resume() {
    this.suspended = false;
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

// A daemon response whose reads the test releases one at a time, so assertions never need a timer.
function daemonStream(status = 200) {
  const pendingReads: Array<(result: { done: boolean; value?: Uint8Array }) => void> = [];
  let readRequested: (() => void) | null = null;
  const reader = {
    cancelled: false,
    read: () =>
      new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
        pendingReads.push(resolve);
        readRequested?.();
        readRequested = null;
      }),
    cancel: () => {
      reader.cancelled = true;
      return Promise.resolve();
    },
  };
  const nextRead = () =>
    pendingReads.length > 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          readRequested = resolve;
        });
  return {
    reader,
    response: {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ "X-Sample-Rate": "24000" }),
      body: { getReader: () => reader },
    } as unknown as Response,
    async push(bytes: Uint8Array) {
      await nextRead();
      pendingReads.shift()!({ done: false, value: bytes });
      await nextRead();
    },
    async release(bytes: Uint8Array) {
      await nextRead();
      pendingReads.shift()!({ done: false, value: bytes });
    },
    async end() {
      await nextRead();
      pendingReads.shift()!({ done: true });
    },
    async fail() {
      await nextRead();
      pendingReads.shift()!(Promise.reject(new Error("stream broke")) as never);
    },
  };
}

function pcm(...samples: number[]) {
  return new Uint8Array(new Float32Array(samples).buffer);
}

function stubWebAudio() {
  FakeAudioContext.created = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>, call = 0) {
  return JSON.parse(fetchMock.mock.calls[call]![1]!.body as string);
}

afterEach(() => {
  stopSpeech();
  vi.unstubAllGlobals();
});

describe("saved voice settings reach the daemon", () => {
  it("sends the saved voice and speed for a message and for the preview", async () => {
    setLocalStorageItem("t3code:tts-voice", "bf_emma", Schema.String);
    setLocalStorageItem("t3code:tts-speed", 1.3, Schema.Number);
    stubWebAudio();

    const message = stubFetch(async () => new Response(null, { status: 204 }));
    await speakMessage("Hello **there**");
    expect(message.mock.calls[0]![0]).toBe("http://127.0.0.1:7788/synthesize");
    expect(sentBody(message)).toEqual({
      text: "Hello **there**",
      md: true,
      voice: "bf_emma",
      speed: 1.3,
    });

    const preview = stubFetch(async () => new Response(null, { status: 204 }));
    await previewVoice();
    expect(sentBody(preview)).toEqual({
      text: expect.any(String),
      voice: "bf_emma",
      speed: 1.3,
    });
  });

  it("falls back to defaults when the stored values are invalid", () => {
    setLocalStorageItem("t3code:tts-voice", "not-a-voice", Schema.String);
    setLocalStorageItem("t3code:tts-speed", 99, Schema.Number);
    expect(readTtsVoiceSettings()).toEqual({ voice: "af_heart", speed: 2 });
  });
});

describe("client playback of the daemon's audio stream", () => {
  it("plays streamed chunks back to back and returns to idle once they finish", async () => {
    stubWebAudio();
    const stream = daemonStream();
    stubFetch(async () => stream.response);

    const request = speakMessage("Hello");
    expect(getPlayback()).toEqual({ id: expect.any(String), state: "playing" });
    const id = getPlayback().id;

    await stream.push(pcm(0.25, 0.5, -0.5, -0.25));
    await stream.push(pcm(0.125, 0.0625));
    await stream.end();
    await request;

    const context = FakeAudioContext.created[0]!;
    expect(context.sources.map((source) => [...source.buffer!.samples])).toEqual([
      [0.25, 0.5, -0.5, -0.25],
      [0.125, 0.0625],
    ]);
    const [first, second] = context.sources;
    expect(second!.startedAt).toBeCloseTo(first!.startedAt! + 4 / 24000, 10);
    expect(getDaemonReachable()).toBe(true);
    expect(getPlayback()).toEqual({ id, state: "playing" });

    first!.finishPlaying();
    expect(getPlayback().state).toBe("playing");
    second!.finishPlaying();
    expect(getPlayback()).toEqual({ id: null, state: "idle" });
    expect(context.closed).toBe(true);
  });

  it("reassembles samples split across network chunks", async () => {
    stubWebAudio();
    const stream = daemonStream();
    stubFetch(async () => stream.response);

    const request = speakMessage("Hello");
    const bytes = pcm(0.5, -0.5, 0.25);
    await stream.push(bytes.slice(0, 6));
    await stream.push(bytes.slice(6));
    await stream.end();
    await request;

    const heard = FakeAudioContext.created[0]!.sources.flatMap((source) => [
      ...source.buffer!.samples,
    ]);
    expect(heard).toEqual([0.5, -0.5, 0.25]);
  });

  it("pauses and resumes the same playback and ignores them when idle", async () => {
    stubWebAudio();
    const stream = daemonStream();
    stubFetch(async () => stream.response);

    pauseSpeech();
    resumeSpeech();
    expect(getPlayback().state).toBe("idle");

    void speakMessage("Hello");
    const id = getPlayback().id;
    await stream.push(pcm(0.1, 0.2));
    const context = FakeAudioContext.created[0]!;

    pauseSpeech();
    expect(getPlayback()).toEqual({ id, state: "paused" });
    expect(context.suspended).toBe(true);
    expect(isSpeechActive()).toBe(true);

    resumeSpeech();
    expect(getPlayback()).toEqual({ id, state: "playing" });
    expect(context.suspended).toBe(false);
  });

  it("stops mid-stream: silences queued audio, closes the output, drops late chunks", async () => {
    stubWebAudio();
    const stream = daemonStream();
    const fetchMock = stubFetch(async () => stream.response);

    const request = speakMessage("Hello");
    await stream.push(pcm(0.1, 0.2));
    const context = FakeAudioContext.created[0]!;

    stopSpeech();
    expect(getPlayback()).toEqual({ id: null, state: "idle" });
    expect(isSpeechActive()).toBe(false);
    expect(context.sources.every((source) => source.stopped)).toBe(true);
    expect(context.closed).toBe(true);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true);

    await stream.release(pcm(0.3));
    await request;
    expect(context.sources).toHaveLength(1);
    expect(stream.reader.cancelled).toBe(true);
  });

  it("drops a response that arrives after stop", async () => {
    stubWebAudio();
    const late = deferred<Response>();
    stubFetch(() => late.promise);
    const onError = vi.fn();

    const request = speakMessage("Hello", onError);
    stopSpeech();
    const stream = daemonStream();
    late.resolve(stream.response);
    await request;

    expect(getPlayback()).toEqual({ id: null, state: "idle" });
    expect(FakeAudioContext.created[0]!.sources).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("lets a new reply replace the current one and ignores the old one's late audio", async () => {
    stubWebAudio();
    const first = daemonStream();
    const second = daemonStream();
    const responses = [first.response, second.response];
    stubFetch(async () => responses.shift()!);

    const firstRequest = speakMessage("First reply");
    await first.push(pcm(0.1));
    const secondRequest = speakMessage("Second reply");
    const secondId = getPlayback().id;
    const [firstContext, secondContext] = FakeAudioContext.created;

    expect(firstContext!.sources[0]!.stopped).toBe(true);
    expect(firstContext!.closed).toBe(true);

    await first.release(pcm(0.9));
    await firstRequest;
    await second.push(pcm(0.2));
    await second.end();
    await secondRequest;

    expect(firstContext!.sources).toHaveLength(1);
    expect(secondContext!.sources).toHaveLength(1);
    expect(getPlayback()).toEqual({ id: secondId, state: "playing" });
  });

  it("returns to idle when the reply has nothing to say", async () => {
    stubWebAudio();
    stubFetch(async () => new Response(null, { status: 204 }));
    const onError = vi.fn();
    await speakMessage("```code```", onError);
    expect(getPlayback().state).toBe("idle");
    expect(onError).not.toHaveBeenCalled();
    expect(FakeAudioContext.created[0]!.closed).toBe(true);
  });

  it("lets queued audio finish when the stream dies midway", async () => {
    stubWebAudio();
    const stream = daemonStream();
    stubFetch(async () => stream.response);
    const onError = vi.fn();

    const request = speakMessage("Hello", onError);
    await stream.push(pcm(0.1, 0.2));
    await stream.fail();
    await request;

    expect(onError).not.toHaveBeenCalled();
    expect(getPlayback().state).toBe("playing");
    FakeAudioContext.created[0]!.sources[0]!.finishPlaying();
    expect(getPlayback().state).toBe("idle");
  });
});

describe("daemon outcomes", () => {
  it("reports unreachable and clears playback when the daemon is offline", async () => {
    stubWebAudio();
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const onError = vi.fn();
    const request = speakMessage("Hello", onError);
    expect(getPlayback().state).toBe("playing");
    await request;
    expect(onError).toHaveBeenCalledOnce();
    expect(getPlayback()).toEqual({ id: null, state: "idle" });
    expect(getDaemonReachable()).toBe(false);
    expect(FakeAudioContext.created[0]!.closed).toBe(true);
  });

  it("fails the playback on an error status but knows the daemon is up", async () => {
    stubWebAudio();
    stubFetch(async () => new Response("bad voice", { status: 500 }));
    const onError = vi.fn();
    await previewVoice(onError);
    expect(onError).toHaveBeenCalledOnce();
    expect(getPlayback().state).toBe("idle");
    expect(getDaemonReachable()).toBe(true);
  });

  it("marks the preview with its own id while it plays", async () => {
    stubWebAudio();
    const stream = daemonStream();
    stubFetch(async () => stream.response);
    void previewVoice();
    expect(getPlayback()).toEqual({ id: TTS_PREVIEW_ID, state: "playing" });
    await stream.push(pcm(0.1));
    expect(getPlayback().id).toBe(TTS_PREVIEW_ID);
  });

  it("probes the daemon once when the first listener subscribes", async () => {
    const status = deferred<Response>();
    const fetchMock = stubFetch(() => status.promise);
    const unsubscribeFirst = subscribe(() => {});
    const unsubscribeSecond = subscribe(() => {});
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:7788/status");

    status.reject(new TypeError("Failed to fetch"));
    unsubscribeFirst();
    unsubscribeSecond();
  });
});
