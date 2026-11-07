import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { toastManager } from "../ui/toast";
import { speakMessage } from "./messageSpeech";
import {
  resolveAssistantMessageCopyState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

const TTS_AUTOPLAY_KEY = "t3code:tts-autoplay";

export function useTtsAutoplaySetting() {
  return useLocalStorage(TTS_AUTOPLAY_KEY, false, Schema.Boolean);
}

export type AutoplayCandidate = {
  id: string;
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
};

// A response is only spoken if it was seen in progress first. Rows that first
// appear already complete are history (mount, navigation, lazy hydration), and
// the Play button's visibility rules keep partial text from ever qualifying.
export function createAutoplayTracker() {
  const inProgress = new Set<string>();
  const handled = new Set<string>();
  return {
    observe(candidate: AutoplayCandidate): string | null {
      if (handled.has(candidate.id)) return null;
      if (candidate.streaming) {
        inProgress.add(candidate.id);
        return null;
      }
      if (!inProgress.has(candidate.id)) return null;
      const copyState = resolveAssistantMessageCopyState({
        text: candidate.text,
        showCopyButton: candidate.showCopyButton,
        streaming: false,
      });
      if (!copyState.visible) return null;
      // Consumed even when autoplay is off, so enabling it later never reads old responses.
      handled.add(candidate.id);
      inProgress.delete(candidate.id);
      return copyState.text;
    },
  };
}

export function notifyDaemonUnavailable() {
  toastManager.add({ type: "error", title: "TTS daemon not running" });
}

export function useTtsAutoplay(rows: ReadonlyArray<MessagesTimelineRow>, threadKey: string) {
  const [enabled] = useTtsAutoplaySetting();
  const trackerRef = useRef<{
    threadKey: string;
    tracker: ReturnType<typeof createAutoplayTracker>;
  }>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- speaks in response to timeline rows streaming in, which only the effect sees
  useEffect(() => {
    if (trackerRef.current?.threadKey !== threadKey) {
      trackerRef.current = { threadKey, tracker: createAutoplayTracker() };
    }
    const { tracker } = trackerRef.current;
    for (const row of rows) {
      if (row.kind === "message" && row.message.role !== "assistant") continue;
      if (row.kind !== "message" && row.kind !== "assistant-meta") continue;
      const text = tracker.observe({
        id: row.message.id,
        text: row.message.text ?? null,
        showCopyButton: row.showAssistantCopyButton,
        streaming: row.assistantCopyStreaming,
      });
      if (text !== null && enabled) void speakMessage(text, notifyDaemonUnavailable);
    }
  }, [rows, threadKey, enabled]);
}
