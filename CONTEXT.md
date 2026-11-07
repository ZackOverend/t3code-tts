# T3 Code TTS fork

Fork-only language; upstream terms remain in `docs/internals/glossary.md`.

## Language

**Speech daemon**:
The local process on `127.0.0.1:7788` that speaks replies (Kokoro) and transcribes speech (Canary). It lives outside this repo.

**Voice mode**:
A desktop toggle that listens to the microphone and appends what is said to the draft of whichever thread composer is showing. One per window, stays on across thread switches and pages, and is remembered across restarts (on at launch means the microphone opens at launch). A phrase that ends with no composer showing is dropped. Ending a phrase with "send it" sends the draft; "scratch that" clears it.
_Avoid_: voice input (upstream's mobile dictation, which never runs continuously).

**Speech segment**:
One utterance cut from the microphone stream by the voice activity detector after a pause. The unit that is transcribed and appended.

**Fork update**: A build of this fork following a stable upstream release.

**Staged build**: A completed fork update waiting to replace the installed app.

**Needs fixing**: A fork update whose rebase conflicted and needs an agent to resolve it. The installed app remains usable.
