const TTS_DAEMON_URL = "http://127.0.0.1:7788";
const POLL_INTERVAL_MS = 750;

type PlaybackState = "idle" | "playing" | "paused";
export type Playback = { id: string | null; state: PlaybackState };

// One store and one poller shared by every mounted button, so only the message being read shows pause/resume.
let playback: Playback = { id: null, state: "idle" };
// Bumped on every write so a /status response that raced an optimistic update is dropped.
let version = 0;
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | undefined;

export function getPlayback() {
  return playback;
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
  try {
    const response = await fetch(`${TTS_DAEMON_URL}/status`);
    if (response.ok) next = await response.json();
  } catch {
    // Daemon unreachable: treat as idle so no button is stuck on pause.
  }
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

export function sendToDaemon(path: string, body: object, next: Playback, onError: () => void) {
  setPlayback(next);
  fetch(`${TTS_DAEMON_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((response) => {
      if (!response.ok) throw new Error(`TTS daemon responded ${response.status}`);
    })
    .catch(() => {
      setPlayback({ id: null, state: "idle" });
      onError();
    });
}

export function speakMessage(text: string, onError: () => void) {
  const id = hashText(text);
  sendToDaemon("/speak", { text, md: true, id }, { id, state: "playing" }, onError);
}
