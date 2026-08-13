/**
 * dsh-voice — shared host types: config, audio references, and the durable
 * `voice/note` event vocabulary. Everything here is JSON-serializable so the
 * event data can cross the session-log boundary and the wire unchanged.
 *
 * @module dsh-voice/types
 */
import type { SttBackendId, TtsBackendId } from './backends/types.ts';

/**
 * A durable reference to one audio artifact under {@link AudioStore} root.
 * The session log carries only refs, never raw audio bytes.
 */
export interface AudioRef {
  /** Absolute path of the audio file under `audioDir` (`~/.dsh/voice`). */
  readonly path: string;
  /** MIME type of the file (aiff/m4a/wav/mp3/…). */
  readonly mime: string;
  /** Playback duration in milliseconds, when the backend reported one. */
  readonly durationMs?: number;
}

/** Plugin config as resolved by {@link resolveConfig} (defaults applied). */
export interface VoiceConfig {
  readonly stt: {
    /** Pinned backend; absent selects automatically (whisper-local → macos). */
    readonly backend?: SttBackendId;
    /** STT model (whisper-1 for the openai backend, a whisper.cpp model otherwise). */
    readonly model?: string;
    readonly whisperLocal?: {
      /** whisper.cpp binary path; defaults to `whisper-cli` on PATH. */
      readonly bin?: string;
      /** whisper.cpp model path/name passed to `-m`. */
      readonly model?: string;
    };
    readonly openai?: {
      /** OpenAI-compatible base URL; defaults to `https://api.openai.com/v1`. */
      readonly baseUrl?: string;
      /** Credential reference resolved through `ctx.credentials` (or env). */
      readonly apiKeyEnv?: string;
    };
  };
  readonly tts: {
    /** Pinned backend; absent auto-selects (say → piper). */
    readonly backend?: TtsBackendId;
    /** Default voice passed to the backend (say voice, edge-tts voice). */
    readonly voice?: string;
    /** Default speaking rate (say words-per-minute). */
    readonly rate?: number;
    readonly piper?: {
      readonly bin?: string;
      /** Piper ONNX model path (`-m`). */
      readonly model?: string;
    };
    readonly edgeTts?: {
      readonly voice?: string;
    };
  };
  /** When true, the assistant's reply text is spoken aloud automatically. */
  readonly readReplies: boolean;
  /** Audio artifact root; defaults to `~/.dsh/voice` (or `$DSH_HOME/voice`). */
  readonly audioDir: string;
}

/** Raw plugin config input — every field optional, defaults applied on resolve. */
export interface VoiceConfigInput {
  readonly stt?: {
    readonly backend?: SttBackendId;
    readonly model?: string;
    readonly whisperLocal?: { readonly bin?: string; readonly model?: string };
    readonly openai?: { readonly baseUrl?: string; readonly apiKeyEnv?: string };
  };
  readonly tts?: {
    readonly backend?: TtsBackendId;
    readonly voice?: string;
    readonly rate?: number;
    readonly piper?: { readonly bin?: string; readonly model?: string };
    readonly edgeTts?: { readonly voice?: string };
  };
  readonly readReplies?: boolean;
  readonly audioDir?: string;
}

/** Resolve raw config to the fully-defaulted shape the plugin consumes. */
export function resolveConfig(raw: VoiceConfigInput | undefined): VoiceConfig {
  const stt = raw?.stt ?? {};
  const tts = raw?.tts ?? {};
  return {
    stt: {
      ...(stt.backend !== undefined ? { backend: stt.backend } : {}),
      ...(stt.model !== undefined ? { model: stt.model } : {}),
      ...(stt.whisperLocal !== undefined ? { whisperLocal: stt.whisperLocal } : {}),
      ...(stt.openai !== undefined ? { openai: stt.openai } : {}),
    },
    tts: {
      ...(tts.backend !== undefined ? { backend: tts.backend } : {}),
      ...(tts.voice !== undefined ? { voice: tts.voice } : {}),
      ...(tts.rate !== undefined ? { rate: tts.rate } : {}),
      ...(tts.piper !== undefined ? { piper: tts.piper } : {}),
      ...(tts.edgeTts !== undefined ? { edgeTts: tts.edgeTts } : {}),
    },
    readReplies: raw?.readReplies ?? false,
    audioDir: raw?.audioDir ?? '',
  };
}

/** One `voice/note` event — the single durable event family of dsh-voice. */
export interface VoiceNoteData {
  /** Stable Definition-local business id; one start event per note. */
  readonly noteId: string;
  /** Turn/step coordinates where the note entered the session. */
  readonly turn: number;
  readonly step: number;
  /** Durable audio reference (path + mime + duration). */
  readonly audioRef: AudioRef;
  /** The spoken transcript (inbound) or the text spoken (outbound). */
  readonly transcript: string;
  /** `in` = user spoke (STT); `out` = agent spoke (TTS). */
  readonly direction: 'in' | 'out';
  /** Backend id that produced or played the audio (`say`, `fake`, …). */
  readonly backend: string;
}

/** The canonical `transcribe` tool result handle. */
export interface TranscribeOutput {
  readonly transcript: string;
  readonly audioRef: AudioRef;
  readonly backend: string;
  readonly durationMs?: number;
  /** Present when the note was delivered to a crosstalk peer instead. */
  readonly deliveredTo?: { readonly messageId: string; readonly peer: string };
}

/** The canonical `speak` tool result handle. */
export interface SpeakOutput {
  readonly jobId: string;
  readonly audioRef: AudioRef;
  readonly backend: string;
}

/** The canonical `record` media result produced before transcription. */
export interface RecordedMedia {
  readonly file: string;
  readonly durationMs?: number;
}
