/**
 * Backend contracts for dsh-voice. STT turns one audio file into a
 * transcript; TTS turns text into an audio file (synthesis is the
 * unit-testable seam — playback is a separate best-effort step).
 *
 * @module dsh-voice/backends/types
 */

/** Speech-to-text backend ids. `fake` is the CI/test default. */
export type SttBackendId = 'whisper-local' | 'openai' | 'macos' | 'fake';

/** Text-to-speech backend ids. */
export type TtsBackendId = 'say' | 'piper' | 'edge-tts' | 'fake' | 'crispasr';

/** One transcription outcome. */
export interface SttOutcome {
  /** The recognized text. */
  readonly transcript: string;
  /** Source audio duration in ms, when the backend could report it. */
  readonly durationMs?: number;
  /** Backend id that produced the transcript. */
  readonly backend: SttBackendId;
  /** Optional backend detail (e.g. the model used). */
  readonly detail?: string;
}

/** A speech-to-text backend. */
export interface SttBackend {
  readonly id: SttBackendId;
  /**
   * Transcribe one audio file.
   * @param file - absolute path of an existing audio file.
   * @param signal - cancellation for shell/network work.
   */
  transcribe(file: string, signal?: AbortSignal): Promise<SttOutcome>;
}

/** Synthesis metadata for one written audio file. */
export interface SynthesizeResult {
  /** MIME type of the written file (aiff/m4a/wav/mp3/…). */
  readonly mime: string;
  /** Playback duration in ms, when the backend reported one. */
  readonly durationMs?: number;
}

/** A text-to-speech backend. */
export interface TtsBackend {
  readonly id: TtsBackendId;
  /**
   * Synthesize `text` into the audio file at `dest`. The destination is
   * chosen by the caller (under audioDir) — synthesis to a known path is the
   * seam tests and the web audio route rely on.
   */
  synthesize(input: { readonly text: string; readonly voice?: string; readonly rate?: number }, dest: string, signal?: AbortSignal): Promise<SynthesizeResult>;
  /**
   * Best-effort playback of a synthesized file. Never throws: a missing
   * player or a failed play is logged by the caller, not thrown into the job.
   */
  play(file: string, signal?: AbortSignal): Promise<void>;
}
