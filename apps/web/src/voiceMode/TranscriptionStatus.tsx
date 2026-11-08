import { useEffect, useState } from "react";
import { readTranscriptionStatus } from "./daemonTranscriber";

export function TranscriptionStatus() {
  const [status, setStatus] = useState({ model: "Transcription model", state: "loading" });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Polls the daemon's read-only model status while settings are mounted.
  useEffect(() => {
    const abort = new AbortController();
    const refresh = async () => {
      const next = await readTranscriptionStatus(abort.signal);
      if (!abort.signal.aborted) setStatus(next);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, []);
  return (
    <span>
      {status.model} · {status.state}
    </span>
  );
}
