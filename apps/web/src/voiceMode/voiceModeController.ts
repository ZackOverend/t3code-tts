import {
  resolveTranscriptCommit,
  type VoiceDraftSnapshot,
} from "@t3tools/client-runtime/voice-input";

export type VoiceModePhase = "off" | "starting" | "listening" | "transcribing" | "error";

export interface VoiceModeState {
  readonly phase: VoiceModePhase;
  /** Why voice mode turned itself off; set only in the "error" phase. */
  readonly error: string | null;
  /** A phrase that was dropped while voice mode kept running. */
  readonly notice: string | null;
}

export type VoiceModeErrorCode =
  | "microphone-denied"
  | "microphone-unavailable"
  | "speech-engine-failed"
  | "daemon-unreachable"
  | "daemon-outdated"
  | "transcription-failed";

export class VoiceModeError extends Error {
  readonly code: VoiceModeErrorCode;

  constructor(code: VoiceModeErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "VoiceModeError";
    this.code = code;
  }
}

const ERROR_MESSAGES: Record<VoiceModeErrorCode, string> = {
  "microphone-denied":
    "Microphone access was denied. Allow T3 Code in System Settings → Privacy & Security → Microphone.",
  "microphone-unavailable": "No microphone was found.",
  "speech-engine-failed": "Could not start speech detection.",
  "daemon-unreachable": "The speech daemon is not running.",
  "daemon-outdated": "The speech daemon is running but does not support transcription yet.",
  "transcription-failed": "Could not transcribe speech.",
};

const UNEXPECTED_ERROR_MESSAGE = "Voice mode stopped unexpectedly.";
const STALE_DRAFT_NOTICE = "The draft changed while transcribing, so that phrase was not added.";
const DRAFT_LOCALE = "en-US";

function describeError(error: unknown): string {
  return error instanceof VoiceModeError ? ERROR_MESSAGES[error.code] : UNEXPECTED_ERROR_MESSAGE;
}

export interface SpeechSourceHandlers {
  /** One finished utterance: 16 kHz mono samples. */
  readonly onSegment: (audio: Float32Array) => void;
  /** The source died after it started (device unplugged, stream ended). */
  readonly onError: (error: unknown) => void;
}

export interface SpeechSource {
  /** Opens the microphone. Rejects with a VoiceModeError. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface VoiceModeTranscriber {
  /** Rejects with a VoiceModeError("daemon-unreachable") if transcription cannot work right now. */
  check(signal: AbortSignal): Promise<void>;
  /** Resolves "" for audio with no speech in it. */
  transcribe(audio: Float32Array, signal: AbortSignal): Promise<string>;
}

export interface VoiceModeDependencies {
  readonly createSpeechSource: (handlers: SpeechSourceHandlers) => SpeechSource;
  readonly transcriber: VoiceModeTranscriber;
  readonly readDraft: () => { readonly ownerKey: string; readonly text: string } | null;
  readonly commitDraft: (text: string) => void;
}

const OFF: VoiceModeState = { phase: "off", error: null, notice: null };

export class VoiceModeController {
  private current: VoiceModeState = OFF;
  private readonly listeners = new Set<() => void>();
  // Bumped on every turn on/off so work started by an earlier run is dropped when it settles.
  private runId = 0;
  private drainingRun: number | null = null;
  private source: SpeechSource | null = null;
  private abort: AbortController | null = null;
  private queue: Float32Array[] = [];

  constructor(private readonly dependencies: VoiceModeDependencies) {}

  get state(): VoiceModeState {
    return this.current;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  toggle(): void {
    if (this.current.phase === "off" || this.current.phase === "error") void this.turnOn();
    else this.turnOff();
  }

  async turnOn(): Promise<void> {
    if (this.current.phase !== "off" && this.current.phase !== "error") return;
    const run = ++this.runId;
    const abort = new AbortController();
    this.abort = abort;
    this.setState({ phase: "starting", error: null, notice: null });
    const source = this.dependencies.createSpeechSource({
      onSegment: (audio) => this.enqueue(run, audio),
      onError: (error) => this.fail(run, error),
    });
    this.source = source;
    try {
      await this.dependencies.transcriber.check(abort.signal);
      if (run !== this.runId) return;
      await source.start();
    } catch (error) {
      this.fail(run, error);
      return;
    }
    if (run !== this.runId) {
      // Turned off while the microphone was opening.
      void source.stop().catch(() => undefined);
      return;
    }
    this.setState({ phase: "listening", error: null, notice: null });
  }

  turnOff(): void {
    if (this.current.phase === "off") return;
    this.halt();
    this.setState(OFF);
  }

  private fail(run: number, error: unknown): void {
    if (run !== this.runId) return;
    this.halt();
    this.setState({ phase: "error", error: describeError(error), notice: null });
  }

  private halt(): void {
    this.runId += 1;
    this.queue = [];
    this.abort?.abort();
    this.abort = null;
    const source = this.source;
    this.source = null;
    void source?.stop().catch(() => undefined);
  }

  private enqueue(run: number, audio: Float32Array): void {
    if (run !== this.runId || this.current.phase === "starting") return;
    this.queue.push(audio);
    void this.drain(run);
  }

  // One segment at a time, so each is committed before the next one captures the draft it appends to.
  private async drain(run: number): Promise<void> {
    if (this.drainingRun === run) return;
    this.drainingRun = run;
    try {
      for (let audio = this.queue.shift(); audio; audio = this.queue.shift()) {
        if (run !== this.runId) return;
        this.setState({ ...this.current, phase: "transcribing" });
        await this.transcribeAndAppend(run, audio);
        if (run !== this.runId) return;
      }
      this.setState({ ...this.current, phase: "listening" });
    } catch (error) {
      this.fail(run, error);
    } finally {
      if (this.drainingRun === run) this.drainingRun = null;
    }
  }

  private async transcribeAndAppend(run: number, audio: Float32Array): Promise<void> {
    const before = this.dependencies.readDraft();
    const abort = this.abort;
    if (!before || !abort) return;
    const captured: VoiceDraftSnapshot = {
      ownerKey: before.ownerKey,
      text: before.text,
      selection: { start: before.text.length, end: before.text.length },
      // The composer draft has no revision counter; the stale guard compares its text.
      revision: 0,
    };
    const text = await this.dependencies.transcriber.transcribe(audio, abort.signal);
    if (run !== this.runId) return;
    const now = this.dependencies.readDraft();
    const result = resolveTranscriptCommit(
      captured,
      now && { ...captured, ownerKey: now.ownerKey, text: now.text },
      text,
      DRAFT_LOCALE,
    );
    if (result.kind === "commit") {
      this.dependencies.commitDraft(result.text);
      this.setState({ ...this.current, notice: null });
    } else if (result.kind === "stale") {
      this.setState({ ...this.current, notice: STALE_DRAFT_NOTICE });
    }
  }

  private setState(next: VoiceModeState): void {
    const previous = this.current;
    if (
      previous.phase === next.phase &&
      previous.error === next.error &&
      previous.notice === next.notice
    ) {
      return;
    }
    this.current = next;
    for (const listener of this.listeners) listener();
  }
}
