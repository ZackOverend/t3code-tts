import { createFileRoute } from "@tanstack/react-router";

import { AudioSettings } from "../components/settings/AudioSettings";

function SettingsAudioRoute() {
  return <AudioSettings />;
}

export const Route = createFileRoute("/_chat/settings/audio")({
  component: SettingsAudioRoute,
});
