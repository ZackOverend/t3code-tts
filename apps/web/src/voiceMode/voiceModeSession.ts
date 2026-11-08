import * as Schema from "effect/Schema";

import {
  getSpeechText,
  stopSpeech,
  isSpeechActive,
  subscribe as subscribePlayback,
} from "../components/chat/messageSpeech";
import { isElectron } from "../env";
import { toastManager } from "../components/ui/toast";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { daemonTranscriber } from "./daemonTranscriber";
import { createVadSpeechSource } from "./speechSource";
import { readVoiceSettings } from "./voiceSettings";
import { readVoicePhrases } from "./voicePhrases";
import { VoiceModeController, type VoiceModePersistence } from "./voiceModeController";

const VOICE_MODE_KEY = "t3code:voice-mode";

const localStorageVoiceModePersistence: VoiceModePersistence = {
  read() {
    try {
      return getLocalStorageItem(VOICE_MODE_KEY, Schema.Boolean) ?? false;
    } catch {
      return false;
    }
  },
  write(on) {
    try {
      setLocalStorageItem(VOICE_MODE_KEY, on, Schema.Boolean);
    } catch {
      // Not remembering the choice must not stop voice mode.
    }
  },
};

let controller: VoiceModeController | null = null;

/** The window's single voice mode; created on first use and, when remembered as on, listening at once. */
export function getVoiceModeController(): VoiceModeController {
  if (controller) return controller;
  const created = new VoiceModeController({
    createSpeechSource: createVadSpeechSource,
    transcriber: daemonTranscriber,
    persistence: localStorageVoiceModePersistence,
    phrases: readVoicePhrases,
    settings: readVoiceSettings,
    isPlaybackActive: isSpeechActive,
    getPlaybackText: getSpeechText,
    stopPlayback: stopSpeech,
  });
  let lastMessage: string | null = null;
  // Toasts live here, not in the toggle: an error at launch happens before any composer mounts.
  created.subscribe(() => {
    const { error, notice } = created.state;
    const message = error ?? notice;
    if (message && message !== lastMessage) {
      toastManager.add({
        type: error !== null ? "error" : "warning",
        title: "Voice mode",
        description: message,
      });
    }
    lastMessage = message;
  });
  subscribePlayback(created.syncPlayback);
  controller = created;
  return created;
}

export function startVoiceMode(): void {
  if (isElectron) getVoiceModeController();
}
