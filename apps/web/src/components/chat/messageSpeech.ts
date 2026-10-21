import { readTtsVoiceSettings, type TtsVoiceSettings } from "./ttsPreferences";

export const TTS_DAEMON_URL = "http://127.0.0.1:7788";
const POLL_INTERVAL_MS = 750;
export const TTS_PREVIEW_ID = "tts-preview";
const TTS_PREVIEW_TEXT = "This is how your assistant's responses will sound.";

type PlaybackState = "idle" | "playing" | "paused";
export type Playback = { id: string | null; state: PlaybackState };

// One store and one poller shared by every mounted button, so only the message being read shows pause/resume.
let playback: Playback = { id: null, state: "idle" };
// null until the first daemon response or failure, so the UI never claims a state it has not seen.
let daemonReachable: boolean | null = null;
// Bumped on every write so a /status response that raced an optimistic update is dropped.
let version = 0;
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | undefined;

export function getPlayback() {
  return playback;
}

export function getDaemonReachable() {
  return daemonReachable;
}

function setDaemonReachable(next: boolean) {
  if (next === daemonReachable) return;
  daemonReachable = next;
  for (const listener of listeners) listener();
}

function setPlayback(next: Playback) {
  version += 1;
  if (next.id === playback.id && next.state === playback.state) return;
  playback = next;
  for (const listener of listeners) listener();
}

async function poll() {
  const seen = version;
  let next: Playback = { id: null, state: "idle" };
  let reachable = false;
  try {
    const response = await fetch(`${TTS_DAEMON_URL}/status`);
    reachable = response.ok;
    if (response.ok) next = await response.json();
  } catch {
    // Daemon unreachable: treat as idle so no button is stuck on pause.
  }
  setDaemonReachable(reachable);
  if (version === seen) setPlayback(next);
}

function syncPolling() {
  const shouldPoll = listeners.size > 0 && document.visibilityState === "visible";
  if (shouldPoll && pollTimer === undefined) {
    void poll();
    pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  } else if (!shouldPoll && pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

export function subscribe(listener: () => void) {
  if (listeners.size === 0) document.addEventListener("visibilitychange", syncPolling);
  listeners.add(listener);
  syncPolling();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.removeEventListener("visibilitychange", syncPolling);
    syncPolling();
  };
}

// FNV-1a: a stable per-message id without needing one from the timeline.
export function hashText(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function buildSpeakBody(
  text: string,
  id: string,
  { voice, speed }: TtsVoiceSettings,
  md: boolean,
) {
  return { text, ...(md ? { md: true } : {}), id, voice, speed };
}

// The daemon answers 204 even when synthesis later fails (for example an unknown voice), so a
// resolved request only means "accepted"; /status is what shows whether audio is actually playing.
export function sendToDaemon(path: string, body: object, next: Playback, onError?: () => void) {
  setPlayback(next);
  return fetch(`${TTS_DAEMON_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((response) => {
      if (!response.ok) throw new Error(`TTS daemon responded ${response.status}`);
      setDaemonReachable(true);
    })
    .catch(() => {
      setDaemonReachable(false);
      setPlayback({ id: null, state: "idle" });
      onError?.();
    });
}

function speak(text: string, id: string, md: boolean, onError?: () => void) {
  const body = buildSpeakBody(text, id, readTtsVoiceSettings(), md);
  return sendToDaemon("/speak", body, { id, state: "playing" }, onError);
}

export function speakMessage(text: string, onError?: () => void) {
  return speak(text, hashText(text), true, onError);
}

export function previewVoice(onError?: () => void) {
  return speak(TTS_PREVIEW_TEXT, TTS_PREVIEW_ID, false, onError);
}

export function stopSpeech(onError?: () => void) {
  return sendToDaemon("/stop", {}, { id: null, state: "idle" }, onError);
}
