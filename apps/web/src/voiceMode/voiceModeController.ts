import {
  resolveTranscriptCommit,
  type VoiceDraftSnapshot,
} from "@t3tools/client-runtime/voice-input";

import { isInterruptTranscript } from "./interruptTranscript";
import { parseVoicePhrase, type VoicePhrases } from "./voiceCommands";

export type VoiceModePhase =
  | "off"
  | "starting"
  | "listening"
  | "transcribing"
  | "speaking"
  | "error";

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
const NO_COMPOSER_NOTICE = "No message box was showing, so that phrase was not added.";
const DRAFT_LOCALE = "en-US";

function describeError(error: unknown): string {
  return error instanceof VoiceModeError ? ERROR_MESSAGES[error.code] : UNEXPECTED_ERROR_MESSAGE;
}

export interface SpeechSourceHandlers {
  readonly onSpeechStart: () => void;
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

/** The composer currently showing; speech goes to whichever one is registered last. */
export interface ComposerTarget {
  /** Identifies the draft; a transcript captured for one key is never written under another. */
  readonly key: string;
  readonly readDraft: () => string;
  /** Replaces the whole draft. Returns false when the composer refused the edit. */
  readonly commitDraft: (text: string) => boolean;
  /** The composer's own send, as if the Send button was pressed. */
  readonly submit: (replaceRunningTurn?: boolean) => void;
  readonly readRunningTurnId: () => string | null;
  readonly interrupt: () => void | Promise<void>;
}

export interface VoiceModePersistence {
  read(): boolean;
  write(on: boolean): void;
}

export interface VoiceModeDependencies {
  readonly createSpeechSource: (handlers: SpeechSourceHandlers) => SpeechSource;
  readonly transcriber: VoiceModeTranscriber;
  readonly persistence: VoiceModePersistence;
  readonly isPlaybackActive: () => boolean;
  readonly getPlaybackText: () => string | null;
  readonly stopPlayback: () => void;
  /** Read for every phrase, so settings changes apply mid-session. */
  readonly phrases: () => VoicePhrases;
}

const OFF: VoiceModeState = { phase: "off", error: null, notice: null };

export class VoiceModeController {
  private current: VoiceModeState = OFF;
  private readonly listeners = new Set<() => void>();
  // Bumped on every turn on/off so work started by an earlier run is dropped when it settles.
  private runId = 0;
  private drainingRun: number | null = null;
  private source: SpeechSource | null = null;
  private sourceStart: Promise<void> | null = null;
  private sourceCleanup: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  private queue: { audio: Float32Array; playbackText: string | null }[] = [];
  private targets: ComposerTarget[] = [];
  private readonly interruptedTurns = new Map<string, string>();
  private segmentPlaybackText: string | null = null;

  constructor(private readonly dependencies: VoiceModeDependencies) {
    if (dependencies.persistence.read()) void this.turnOn();
  }

  registerTarget(target: ComposerTarget): () => void {
    this.targets.push(target);
    return () => {
      this.targets = this.targets.filter((candidate) => candidate !== target);
    };
  }

  private get target(): ComposerTarget | null {
    return this.targets.at(-1) ?? null;
  }

  get state(): VoiceModeState {
    return this.current;
  }

  get enabled(): boolean {
    return this.current.phase !== "off" && this.current.phase !== "error";
  }

  syncPlayback = (): void => {
    if (!this.enabled || this.current.phase === "starting" || this.drainingRun === this.runId)
      return;
    this.setState({
      ...this.current,
      phase: this.dependencies.isPlaybackActive() ? "speaking" : "listening",
    });
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  toggle(): void {
    if (this.enabled) this.turnOff();
    else void this.turnOn();
  }

  async turnOn(): Promise<void> {
    if (this.enabled) return;
    this.dependencies.persistence.write(true);
    const run = ++this.runId;
    const abort = new AbortController();
    this.abort = abort;
    this.setState({ phase: "starting", error: null, notice: null });
    try {
      await this.sourceCleanup;
      if (run !== this.runId) return;
      await this.dependencies.transcriber.check(abort.signal);
      if (run !== this.runId) return;
      const source = this.dependencies.createSpeechSource({
        onSpeechStart: () => {
          if (run === this.runId) this.segmentPlaybackText = this.dependencies.getPlaybackText();
        },
        onSegment: (audio) => this.enqueue(run, audio),
        onError: (error) => this.fail(run, error),
      });
      this.source = source;
      this.sourceStart = source.start();
      await this.sourceStart;
    } catch (error) {
      this.fail(run, error);
      return;
    }
    if (run !== this.runId) return;
    this.sourceStart = null;
    this.setState({
      phase: this.dependencies.isPlaybackActive() ? "speaking" : "listening",
      error: null,
      notice: null,
    });
  }

  turnOff(): void {
    if (this.current.phase === "off") return;
    this.dependencies.persistence.write(false);
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
    this.segmentPlaybackText = null;
    this.abort?.abort();
    this.abort = null;
    const source = this.source;
    this.source = null;
    const starting = this.sourceStart;
    this.sourceStart = null;
    if (source) {
      const stopped = source.stop().catch(() => undefined);
      this.sourceCleanup = Promise.all([
        this.sourceCleanup,
        stopped,
        starting?.catch(() => undefined),
      ]).then(async () => {
        // A cancelled start can still open the microphone after the first stop.
        if (starting) await source.stop().catch(() => undefined);
      });
    }
  }

  private enqueue(run: number, audio: Float32Array): void {
    if (run !== this.runId || this.current.phase === "starting") return;
    // Keep the reply reference through VAD hangover, transcription and queue delays.
    this.queue.push({
      audio,
      playbackText: this.segmentPlaybackText ?? this.dependencies.getPlaybackText(),
    });
    this.segmentPlaybackText = null;
    void this.drain(run);
  }

  // One segment at a time, so each is committed before the next one captures the draft it appends to.
  private async drain(run: number): Promise<void> {
    if (this.drainingRun === run) return;
    this.drainingRun = run;
    try {
      for (let segment = this.queue.shift(); segment; segment = this.queue.shift()) {
        if (run !== this.runId) return;
        this.setState({ ...this.current, phase: "transcribing" });
        await this.transcribeAndAppend(run, segment.audio, segment.playbackText);
        if (run !== this.runId) return;
      }
      this.setState({
        ...this.current,
        phase: this.dependencies.isPlaybackActive() ? "speaking" : "listening",
      });
    } catch (error) {
      this.fail(run, error);
    } finally {
      if (this.drainingRun === run) this.drainingRun = null;
    }
  }

  private async transcribeAndAppend(
    run: number,
    audio: Float32Array,
    playbackText: string | null,
  ): Promise<void> {
    const before = this.target;
    const abort = this.abort;
    if (!abort) return;
    const capturedText = before?.readDraft() ?? "";
    const captured: VoiceDraftSnapshot | null = before && {
      ownerKey: before.key,
      text: capturedText,
      selection: { start: capturedText.length, end: capturedText.length },
      // The composer draft has no revision counter; the stale guard compares its text.
      revision: 0,
    };
    const transcript = await this.dependencies.transcriber.transcribe(audio, abort.signal);
    if (run !== this.runId || !isInterruptTranscript(transcript, playbackText)) return;
    if (this.dependencies.isPlaybackActive()) this.dependencies.stopPlayback();
    const target = this.target;
    if (!captured || !target) {
      this.setState({ ...this.current, notice: NO_COMPOSER_NOTICE });
      return;
    }
    const phrase = parseVoicePhrase(transcript, this.dependencies.phrases());
    const draft = target.readDraft();
    const result = resolveTranscriptCommit(
      captured,
      { ...captured, ownerKey: target.key, text: draft },
      phrase.text,
      DRAFT_LOCALE,
    );
    if (result.kind === "stale") {
      this.setState({ ...this.current, notice: STALE_DRAFT_NOTICE });
      return;
    }
    const turnId = target.readRunningTurnId();
    const hasMessage =
      phrase.text.trim() !== "" || (phrase.command === "send" && draft.trim() !== "");
    if (hasMessage && turnId !== null && this.interruptedTurns.get(target.key) !== turnId) {
      this.interruptedTurns.set(target.key, turnId);
      await target.interrupt();
      if (run !== this.runId) return;
      if (this.target !== target || target.readDraft() !== draft) {
        this.setState({ ...this.current, notice: STALE_DRAFT_NOTICE });
        return;
      }
    }
    let finalText = draft;
    if (result.kind === "commit") {
      if (!target.commitDraft(result.text)) {
        this.setState({ ...this.current, notice: STALE_DRAFT_NOTICE });
        return;
      }
      finalText = result.text;
    }
    this.setState({ ...this.current, notice: null });
    if (phrase.command === "send" && finalText.trim() !== "")
      target.submit(turnId !== null && this.interruptedTurns.get(target.key) === turnId);
    else if (phrase.command === "clear") target.commitDraft("");
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
