import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useSyncExternalStore } from "react";

import { isElectron } from "../env";
import { getVoiceModeController } from "./voiceModeSession";
import { voiceGhostTextKey } from "./voiceGhostText";

const noopSubscribe = () => () => {};

export function useVoiceGhostText(editor: Editor | null, ownerKey: string | undefined) {
  // Voice mode is desktop-only; the web build must not create its controller.
  const preview = useSyncExternalStore(
    isElectron ? getVoiceModeController().subscribe : noopSubscribe,
    () => {
      if (!isElectron || ownerKey === undefined) return "";
      const { state } = getVoiceModeController();
      return state.previewOwner === ownerKey ? (state.preview ?? "") : "";
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronizes the external voice preview with ProseMirror decorations before paint.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed || voiceGhostTextKey.getState(editor.state) === preview)
      return;
    editor.view.dispatch(
      editor.state.tr.setMeta(voiceGhostTextKey, preview).setMeta("addToHistory", false),
    );
  }, [editor, preview]);
}
