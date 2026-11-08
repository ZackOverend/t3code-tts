import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const voiceGhostTextKey = new PluginKey<string>("voiceGhostText");

export function createVoiceGhostTextPlugin() {
  return new Plugin({
    key: voiceGhostTextKey,
    state: {
      init: () => "",
      apply: (transaction, preview) => {
        const next: unknown = transaction.getMeta(voiceGhostTextKey);
        return typeof next === "string" ? next : transaction.docChanged ? "" : preview;
      },
    },
    props: {
      decorations(state) {
        const preview = voiceGhostTextKey.getState(state);
        if (!preview) return DecorationSet.empty;
        let position = state.doc.content.size;
        while (position > 0 && !state.doc.resolve(position).parent.isTextblock) position--;
        return DecorationSet.create(state.doc, [
          Decoration.widget(
            position,
            () => {
              const span = document.createElement("span");
              span.textContent = ` ${preview}`;
              span.className = "text-muted-foreground opacity-60 pointer-events-none select-none";
              span.contentEditable = "false";
              span.setAttribute("aria-hidden", "true");
              return span;
            },
            { side: 1, ignoreSelection: true },
          ),
        ]);
      },
    },
  });
}

export const VoiceGhostText = Extension.create({
  name: "voiceGhostText",
  addProseMirrorPlugins: () => [createVoiceGhostTextPlugin()],
});
