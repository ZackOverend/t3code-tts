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
  readonly preview?: string | undefined;
  readonly previewOwner?: string | undefined;
  readonly pauseRemaining?: number | undefined;
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
  readonly onFrame: (audio: Float32Array) => void;
  readonly onSpeechCancel: () => void;
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
  readonly settings: () => {
    sendMode: "keyword" | "pause";
    pauseSeconds: number;
    livePreview?: boolean;
  };
}

const OFF: VoiceModeState = { phase: "off", error: null, notice: null };

export class VoiceModeController {
  private previewTimer: ReturnType<typeof setInterval> | null = null;
  private previewAbort: AbortController | null = null;
  private previewBusy = false;
  private previewGeneration = 0;
  private previewFrames: Float32Array[] = [];
  private current: VoiceModeState = OFF;

  private clearPreview(): void {
    this.previewGeneration += 1;
    if (this.previewTimer !== null) clearInterval(this.previewTimer);
    this.previewTimer = null;
    this.previewFrames = [];
    this.previewAbort?.abort();
    this.setState({ ...this.current, preview: undefined, previewOwner: undefined });
  }

  private async updatePreview(): Promise<void> {
    if (
      this.dependencies.settings().livePreview === false ||
      this.dependencies.isPlaybackActive()
    ) {
      this.previewGeneration += 1;
      this.previewAbort?.abort();
      this.setState({ ...this.current, preview: undefined, previewOwner: undefined });
      return;
    }
    const target = this.target;
    if (this.previewBusy || !target || !this.previewFrames.length || this.drainingRun !== null)
      return;
    const generation = this.previewGeneration;
    const draft = target.readDraft();
    const audio = new Float32Array(
      this.previewFrames.reduce((size, frame) => size + frame.length, 0),
    );
    let offset = 0;
    for (const frame of this.previewFrames) {
      audio.set(frame, offset);
      offset += frame.length;
    }
    const abort = new AbortController();
    this.previewAbort = abort;
    this.previewBusy = true;
    try {
      const preview = await this.dependencies.transcriber.transcribe(audio, abort.signal);
      if (
        generation === this.previewGeneration &&
        !abort.signal.aborted &&
        this.target === target &&
        target.readDraft() === draft &&
        this.dependencies.settings().livePreview !== false &&
        !this.dependencies.isPlaybackActive()
      )
        this.setState({ ...this.current, preview, previewOwner: target.key });
    } catch {
      // Preview failures must not prevent final transcription.
    } finally {
      this.previewBusy = false;
      if (this.previewAbort === abort) this.previewAbort = null;
    }
  }

  private pauseTimer: ReturnType<typeof setInterval> | null = null;
  private speechGeneration = 0;
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
    this.cancelCountdown();
    this.clearPreview();
    this.targets.push(target);
    return () => {
      this.cancelCountdown();
      this.clearPreview();
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
    if (this.dependencies.isPlaybackActive()) this.clearPreview();
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

  cancelCountdown(): void {
    this.speechGeneration += 1;
    if (this.pauseTimer !== null) clearInterval(this.pauseTimer);
    this.pauseTimer = null;
    this.setState({ ...this.current, pauseRemaining: undefined });
  }

  private startCountdown(target: ComposerTarget, text: string, replace: boolean): void {
    const settings = this.dependencies.settings();
    if (settings.sendMode !== "pause") return;
    let elapsed = 0;
    this.setState({ ...this.current, pauseRemaining: settings.pauseSeconds });
    this.pauseTimer = setInterval(() => {
      const current = this.dependencies.settings();
      if (current.sendMode !== "pause" || this.target !== target || target.readDraft() !== text) {
        this.cancelCountdown();
        return;
      }
      elapsed += 1;
      const remaining = Math.max(0, current.pauseSeconds - elapsed);
      if (remaining === 0) {
        this.cancelCountdown();
        target.submit(replace);
      } else this.setState({ ...this.current, pauseRemaining: remaining });
    }, 1000);
  }

  toggle(): void {
    if (this.current.pauseRemaining !== undefined) {
      this.cancelCountdown();
      return;
    }
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
          if (run === this.runId) {
            this.cancelCountdown();
            this.clearPreview();
            this.previewTimer = setInterval(() => void this.updatePreview(), 1000);
            this.segmentPlaybackText = this.dependencies.getPlaybackText();
          }
        },
        onFrame: (audio) => {
          if (
            run === this.runId &&
            this.previewTimer !== null &&
            this.dependencies.settings().livePreview !== false &&
            !this.dependencies.isPlaybackActive()
          )
            this.previewFrames.push(audio.slice());
        },
        onSpeechCancel: () => {
          if (run === this.runId) this.clearPreview();
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
    this.clearPreview();
    this.cancelCountdown();
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
    this.cancelCountdown();
    this.clearPreview();
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
    const generation = this.speechGeneration;
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
    else if (result.kind === "commit" && finalText.trim() && generation === this.speechGeneration)
      this.startCountdown(
        target,
        finalText,
        turnId !== null && this.interruptedTurns.get(target.key) === turnId,
      );
  }

  private setState(next: VoiceModeState): void {
    const previous = this.current;
    if (
      previous.pauseRemaining === next.pauseRemaining &&
      previous.phase === next.phase &&
      previous.preview === next.preview &&
      previous.previewOwner === next.previewOwner &&
      previous.error === next.error &&
      previous.notice === next.notice
    ) {
      return;
    }
    this.current = next;
    for (const listener of this.listeners) listener();
  }
}
