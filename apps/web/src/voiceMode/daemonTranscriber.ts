import { TTS_DAEMON_URL } from "../components/chat/messageSpeech";
import { VoiceModeError, type VoiceModeTranscriber } from "./voiceModeController";

async function daemonFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${TTS_DAEMON_URL}${path}`, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new VoiceModeError("daemon-unreachable", { cause: error });
  }
}

export const daemonTranscriber: VoiceModeTranscriber = {
  async check(signal) {
    const response = await daemonFetch("/stt/status", { signal });
    if (response.status === 404) throw new VoiceModeError("daemon-outdated");
    if (!response.ok) throw new VoiceModeError("transcription-failed");
  },

  // The daemon takes raw little-endian float32 PCM at 16 kHz, which is what the VAD produces.
  async transcribe(audio, signal) {
    const response = await daemonFetch("/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([audio as Float32Array<ArrayBuffer>]),
      signal,
    });
    if (!response.ok) throw new VoiceModeError("transcription-failed");
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("text" in body)) {
      throw new VoiceModeError("transcription-failed");
    }
    return typeof body.text === "string" ? body.text : "";
  },
};
