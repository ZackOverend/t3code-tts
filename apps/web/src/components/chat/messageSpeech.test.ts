import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { setLocalStorageItem } from "../../hooks/useLocalStorage";
import * as Schema from "effect/Schema";
import {
  buildSpeakBody,
  getDaemonReachable,
  getPlayback,
  previewVoice,
  speakMessage,
  stopSpeech,
  TTS_PREVIEW_ID,
} from "./messageSpeech";
import { readTtsVoiceSettings } from "./ttsPreferences";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof stubFetch>) {
  return JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
}

describe("buildSpeakBody", () => {
  it("only marks markdown for messages", () => {
    const settings = { voice: "af_heart", speed: 1.1 };
    expect(buildSpeakBody("hi", "m1", settings, true)).toEqual({
      text: "hi",
      md: true,
      id: "m1",
      voice: "af_heart",
      speed: 1.1,
    });
    expect(buildSpeakBody("hi", "m1", settings, false)).not.toHaveProperty("md");
  });
});

describe("saved voice settings reach the daemon", () => {
  it("sends the saved voice and speed for a message and for the preview", async () => {
    setLocalStorageItem("t3code:tts-voice", "bf_emma", Schema.String);
    setLocalStorageItem("t3code:tts-speed", 1.3, Schema.Number);

    const message = stubFetch(new Response(null, { status: 204 }));
    await speakMessage("Hello **there**");
    expect(message.mock.calls[0]![0]).toBe("http://127.0.0.1:7788/speak");
    expect(sentBody(message)).toMatchObject({
      text: "Hello **there**",
      md: true,
      voice: "bf_emma",
      speed: 1.3,
    });

    const preview = stubFetch(new Response(null, { status: 204 }));
    await previewVoice();
    expect(sentBody(preview)).toMatchObject({ id: TTS_PREVIEW_ID, voice: "bf_emma", speed: 1.3 });
    expect(sentBody(preview)).not.toHaveProperty("md");
  });

  it("falls back to defaults when the stored values are invalid", async () => {
    setLocalStorageItem("t3code:tts-voice", "not-a-voice", Schema.String);
    setLocalStorageItem("t3code:tts-speed", 99, Schema.Number);
    expect(readTtsVoiceSettings()).toEqual({ voice: "af_heart", speed: 2 });
  });
});

describe("daemon outcomes", () => {
  it("reports unreachable and clears optimistic playback when the daemon is offline", async () => {
    stubFetch(new TypeError("Failed to fetch"));
    const onError = vi.fn();
    const request = speakMessage("Hello", onError);
    expect(getPlayback().state).toBe("playing");
    await request;
    expect(onError).toHaveBeenCalledOnce();
    expect(getPlayback()).toEqual({ id: null, state: "idle" });
    expect(getDaemonReachable()).toBe(false);
  });

  it("treats an error status as a failure", async () => {
    stubFetch(new Response(null, { status: 500 }));
    const onError = vi.fn();
    await previewVoice(onError);
    expect(onError).toHaveBeenCalledOnce();
    expect(getPlayback().state).toBe("idle");
  });

  it("marks the daemon reachable after an accepted request and stops to idle", async () => {
    stubFetch(new Response(null, { status: 204 }));
    const onError = vi.fn();
    await speakMessage("Hello", onError);
    expect(getDaemonReachable()).toBe(true);
    expect(getPlayback().state).toBe("playing");

    const stop = stubFetch(new Response(null, { status: 204 }));
    await stopSpeech(onError);
    expect(stop.mock.calls[0]![0]).toBe("http://127.0.0.1:7788/stop");
    expect(getPlayback()).toEqual({ id: null, state: "idle" });
    expect(onError).not.toHaveBeenCalled();
  });
});
