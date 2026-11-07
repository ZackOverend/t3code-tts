import { readTtsVoiceSettings, type TtsVoiceSettings } from "./ttsPreferences";

export const TTS_DAEMON_URL = "http://127.0.0.1:7788";
export const TTS_PREVIEW_ID = "tts-preview";
const TTS_PREVIEW_TEXT = "This is how your assistant's responses will sound.";

type PlaybackState = "idle" | "playing" | "paused";
export type Playback = { id: string | null; state: PlaybackState };

// The daemon synthesizes and streams float32 PCM; the client schedules it through Web Audio so
// the browser's echo cancellation can account for it. One module store keeps a single playback
// shared by every mounted button and by a future voice-mode controller.
type Session = {
  context: AudioContext | null;
  abort: AbortController;
  sources: Set<AudioBufferSourceNode>;
  nextStart: number;
  streamDone: boolean;
};

const IDLE: Playback = { id: null, state: "idle" };
let playback: Playback = IDLE;
// null until the first daemon response or failure, so the UI never claims a state it has not seen.
let daemonReachable: boolean | null = null;
// A response, timer or `ended` event only acts while its session is still the current one.
let session: Session | null = null;
const listeners = new Set<() => void>();

export function getPlayback() {
  return playback;
}

export function getDaemonReachable() {
  return daemonReachable;
}

export function isSpeechActive() {
  return playback.state !== "idle";
}

function setDaemonReachable(next: boolean) {
  if (next === daemonReachable) return;
  daemonReachable = next;
  for (const listener of listeners) listener();
}

function setPlayback(next: Playback) {
  if (next.id === playback.id && next.state === playback.state) return;
  playback = next;
  for (const listener of listeners) listener();
}

async function probeDaemon() {
  try {
    setDaemonReachable((await fetch(`${TTS_DAEMON_URL}/status`)).ok);
  } catch {
    setDaemonReachable(false);
  }
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) void probeDaemon();
  return () => void listeners.delete(listener);
}

// FNV-1a: a stable per-message id without needing one from the timeline.
export function hashText(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function buildSynthesizeBody(text: string, { voice, speed }: TtsVoiceSettings, md: boolean) {
  return { text, ...(md ? { md: true } : {}), voice, speed };
}

function endSession(ended: Session) {
  if (session === ended) session = null;
  ended.abort.abort();
  for (const source of ended.sources) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
    source.disconnect();
  }
  ended.sources.clear();
  void ended.context?.close().catch(() => {});
}

function finish(ended: Session) {
  if (session !== ended) return;
  endSession(ended);
  setPlayback(IDLE);
}

function scheduleChunk(current: Session, samples: Float32Array<ArrayBuffer>, sampleRate: number) {
  const context = current.context!;
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  const startAt = Math.max(context.currentTime, current.nextStart);
  source.start(startAt);
  current.nextStart = startAt + buffer.duration;
  current.sources.add(source);
  source.onended = () => {
    current.sources.delete(source);
    if (current.streamDone && current.sources.size === 0) finish(current);
  };
}

async function play(current: Session, body: object, onError?: () => void) {
  let reachedDaemon = false;
  try {
    current.context = new AudioContext();
    void current.context.resume().catch(() => {});
    const response = await fetch(`${TTS_DAEMON_URL}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: current.abort.signal,
    });
    if (session !== current) return;
    reachedDaemon = true;
    setDaemonReachable(true);
    if (!response.ok) throw new Error(`TTS daemon responded ${response.status}`);
    const sampleRate = Number(response.headers.get("X-Sample-Rate"));
    if (response.status === 204 || !response.body) return finish(current);
    if (!(sampleRate > 0)) throw new Error("TTS daemon sent no sample rate");

    const reader = response.body.getReader();
    let carry = new Uint8Array(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (session !== current) return void reader.cancel().catch(() => {});
      if (done) break;
      const bytes = new Uint8Array(carry.length + value.length);
      bytes.set(carry);
      bytes.set(value, carry.length);
      const usable = bytes.length - (bytes.length % 4);
      carry = bytes.slice(usable);
      if (usable > 0) {
        scheduleChunk(current, new Float32Array(bytes.slice(0, usable).buffer), sampleRate);
      }
    }
    current.streamDone = true;
    if (current.sources.size === 0) finish(current);
  } catch {
    if (session !== current) return;
    if (!reachedDaemon) setDaemonReachable(false);
    // A stream that dies midway still lets the audio already queued play out.
    if (reachedDaemon && current.sources.size > 0) {
      current.streamDone = true;
      return;
    }
    finish(current);
    onError?.();
  }
}

function speak(text: string, id: string, md: boolean, onError?: () => void) {
  stopSpeech();
  const current: Session = {
    context: null,
    abort: new AbortController(),
    sources: new Set(),
    nextStart: 0,
    streamDone: false,
  };
  session = current;
  setPlayback({ id, state: "playing" });
  return play(current, buildSynthesizeBody(text, readTtsVoiceSettings(), md), onError);
}

export function speakMessage(text: string, onError?: () => void) {
  return speak(text, hashText(text), true, onError);
}

export function previewVoice(onError?: () => void) {
  return speak(TTS_PREVIEW_TEXT, TTS_PREVIEW_ID, false, onError);
}

export function stopSpeech() {
  if (session) endSession(session);
  setPlayback(IDLE);
}

export function pauseSpeech() {
  if (!session || playback.state !== "playing") return;
  void session.context?.suspend().catch(() => {});
  setPlayback({ id: playback.id, state: "paused" });
}

export function resumeSpeech() {
  if (!session || playback.state !== "paused") return;
  void session.context?.resume().catch(() => {});
  setPlayback({ id: playback.id, state: "playing" });
}
