import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { DraftInput } from "../components/ui/draft-input";
import { Input } from "../components/ui/input";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { DEFAULT_VOICE_PHRASES, type VoiceCommand, type VoicePhrases } from "./voiceCommands";
import {
  addVoicePhrase,
  removeVoicePhrase,
  replaceVoicePhrase,
  type VoicePhraseEdit,
  useVoicePhrases,
} from "./voicePhrases";

function isDefault(phrases: VoicePhrases) {
  return (["send", "clear"] as const).every(
    (command) =>
      phrases[command].length === DEFAULT_VOICE_PHRASES[command].length &&
      phrases[command].every((phrase, index) => phrase === DEFAULT_VOICE_PHRASES[command][index]),
  );
}

function PhraseListEditor(props: {
  command: VoiceCommand;
  phrases: VoicePhrases;
  onEdit: (edit: VoicePhraseEdit) => boolean;
}) {
  const { command, phrases, onEdit } = props;
  const [error, setError] = useState<string | null>(null);
  const [newPhrase, setNewPhrase] = useState("");

  const apply = (edit: VoicePhraseEdit) => {
    const accepted = onEdit(edit);
    setError(edit.ok ? null : edit.error);
    return accepted;
  };
  const submitNew = () => {
    if (newPhrase.trim() === "") return;
    if (apply(addVoicePhrase(phrases, command, newPhrase))) setNewPhrase("");
  };

  return (
    <div className="space-y-1.5 pb-2 pt-3">
      {phrases[command].map((phrase, index) => (
        <div key={phrase} className="flex items-center gap-1.5">
          <DraftInput
            size="sm"
            aria-label={`${command} phrase ${index + 1}`}
            value={phrase}
            onCommit={(next) => apply(replaceVoicePhrase(phrases, command, index, next))}
          />
          <Button
            size="icon-micro"
            variant="ghost-destructive"
            aria-label={`Remove phrase "${phrase}"`}
            disabled={phrases[command].length <= 1}
            onClick={() => apply(removeVoicePhrase(phrases, command, index))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <Input
          size="sm"
          aria-label={`Add ${command} phrase`}
          placeholder="Add a phrase"
          value={newPhrase}
          onChange={(event) => setNewPhrase(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              submitNew();
            }
          }}
        />
        <Button size="xs" variant="outline" disabled={newPhrase.trim() === ""} onClick={submitNew}>
          <PlusIcon className="size-3" />
          Add
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

export function VoiceModeSettingsSection() {
  const { phrases, setPhrases, reset } = useVoicePhrases();
  const onEdit = (edit: VoicePhraseEdit) => {
    if (edit.ok) setPhrases(edit.phrases);
    return edit.ok;
  };
  const resetAction = isDefault(phrases) ? null : (
    <SettingResetButton
      label="voice mode phrases"
      tooltip="Reset send and clear phrases to default"
      onClick={reset}
    />
  );

  return (
    <SettingsSection id="voice-mode" title="Voice mode">
      <SettingsRow
        {...searchableSetting("voice-mode-send")}
        description="Say one of these at the end of a phrase to send the message. Ignores case and trailing punctuation."
        resetAction={resetAction}
      >
        <PhraseListEditor command="send" phrases={phrases} onEdit={onEdit} />
      </SettingsRow>
      <SettingsRow
        {...searchableSetting("voice-mode-clear")}
        description="Say one of these at the end of a phrase to clear the message box."
        resetAction={resetAction}
      >
        <PhraseListEditor command="clear" phrases={phrases} onEdit={onEdit} />
      </SettingsRow>
    </SettingsSection>
  );
}
