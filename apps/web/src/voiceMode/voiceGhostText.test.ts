import { DecorationSet } from "@tiptap/pm/view";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { history, undoDepth } from "@tiptap/pm/history";
import { describe, expect, it } from "vite-plus/test";

import { createVoiceGhostTextPlugin, voiceGhostTextKey } from "./voiceGhostText";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", group: "block" },
    text: { group: "inline" },
  },
});

describe("voice ghost text", () => {
  it("updates and clears decorations without changing the document, selection, or history", () => {
    const plugin = createVoiceGhostTextPlugin();
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [schema.node("paragraph", null, schema.text("Draft"))]),
      plugins: [history(), plugin],
    });
    state = state.apply(state.tr.insertText("!"));
    const original = state.doc.toJSON();
    const selection = state.selection.toJSON();
    const depth = undoDepth(state);
    for (const preview of ["hello", "hello world", ""]) {
      const tr = state.tr.setMeta(voiceGhostTextKey, preview).setMeta("addToHistory", false);
      expect(tr.docChanged).toBe(false);
      state = state.apply(tr);
      expect(voiceGhostTextKey.getState(state)).toBe(preview);
      const decorations = plugin.props.decorations?.call(plugin, state);
      expect(
        (decorations instanceof DecorationSet ? decorations.find() : []).map(
          (decoration) => decoration.from,
        ),
      ).toEqual(preview ? [state.doc.content.size - 1] : []);
      expect(state.doc.toJSON()).toEqual(original);
      expect(state.doc.textContent).toBe("!Draft");
      expect(state.selection.toJSON()).toEqual(selection);
      expect(undoDepth(state)).toBe(depth);
    }
  });

  it("clears ghost text in the same transaction as a draft edit or final transcript", () => {
    const plugin = createVoiceGhostTextPlugin();
    let state = EditorState.create({ schema, plugins: [plugin] });
    state = state.apply(state.tr.setMeta(voiceGhostTextKey, "spoken"));
    state = state.apply(state.tr.insertText("spoken"));
    expect(voiceGhostTextKey.getState(state)).toBe("");
    expect(plugin.props.decorations?.call(plugin, state)).toBe(DecorationSet.empty);
    expect(state.doc.textContent).toBe("spoken");
  });
});
