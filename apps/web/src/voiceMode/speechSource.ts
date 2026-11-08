import vadPackage from "@ricky0123/vad-web/package.json";

import {
  VoiceModeError,
  type SpeechSource,
  type SpeechSourceHandlers,
} from "./voiceModeController";

// Served by vite/voiceVadAssets.ts; the version in the path keeps cached assets in step with the package.
const VAD_ASSET_BASE = `${import.meta.env.BASE_URL}vad/${vadPackage.version}/`;

// Tuned in spike #2: Silero v5 at 16 kHz.
const VAD_OPTIONS = {
  model: "v5",
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  minSpeechMs: 400,
  redemptionMs: 700,
  preSpeechPadMs: 300,
} as const;

function microphoneError(error: unknown): VoiceModeError {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new VoiceModeError("microphone-denied", { cause: error });
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new VoiceModeError("microphone-unavailable", { cause: error });
  }
  return new VoiceModeError("speech-engine-failed", { cause: error });
}

export function createVadSpeechSource(handlers: SpeechSourceHandlers): SpeechSource {
  let vad: { destroy(): Promise<void> } | null = null;
  let stopped = false;

  const release = async () => {
    const current = vad;
    vad = null;
    await current?.destroy();
  };

  return {
    async start() {
      // The VAD and ONNX runtime are fetched here, so nothing loads until voice mode is turned on.
      const { MicVAD } = await import("@ricky0123/vad-web").catch((error: unknown) => {
        throw new VoiceModeError("speech-engine-failed", { cause: error });
      });
      const microphone: { failure?: VoiceModeError } = {};
      try {
        const created = await MicVAD.new({
          ...VAD_OPTIONS,
          baseAssetPath: VAD_ASSET_BASE,
          onnxWASMBasePath: VAD_ASSET_BASE,
          // One WASM thread without a proxy worker works without cross-origin isolation.
          ortConfig: (ort) => {
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.proxy = false;
            ort.env.logLevel = "error";
          },
          getStream: async () => {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                  channelCount: 1,
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                },
              });
              for (const track of stream.getAudioTracks()) {
                track.addEventListener("ended", () => handlers.onError(new Error("track ended")));
              }
              return stream;
            } catch (error) {
              microphone.failure = microphoneError(error);
              throw microphone.failure;
            }
          },
          onSpeechStart: handlers.onSpeechStart,
          onFrameProcessed: (_probabilities, frame) => handlers.onFrame(frame),
          onVADMisfire: handlers.onSpeechCancel,
          onSpeechEnd: (audio) => handlers.onSegment(audio),
        });
        vad = created;
      } catch (error) {
        throw microphone.failure ?? new VoiceModeError("speech-engine-failed", { cause: error });
      }
      if (stopped) await release();
    },

    async stop() {
      stopped = true;
      await release();
    },
  };
}
