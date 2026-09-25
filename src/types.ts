/**
 * dsh-voice-call — shared host types: config, audio references, the durable
 * `voice/note` event vocabulary, and the `voice/call` call-domain vocabulary.
 * Everything here is JSON-serializable so the event data can cross the
 * session-log boundary and the wire unchanged.
 *
 * @module dsh-voice-call/types
 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import type { SttBackendId, TtsBackendId } from './backends/types.ts';
import { DEFAULT_PALETTE, DEFAULT_THEME, paletteById, type CardTheme, type PaletteId } from './client/palettes.ts';
import { toneById, type ToneId } from './client/tones.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * One voice-domain message produced by this plugin: a spoken-leg failure
     * notice, or a dictated transcript delivered as the human's own words.
     * 0.1.7 retired the shared `plugin` source kind — `MessageSourceMap` is a
     * merge-extensible sum type and every producer declares its own `kind`,
     * with consumers falling through unknowns (dsh-llm `message.d.ts:94-100`).
     * @mode emit
     */
    'voice-call': {
      readonly kind: 'voice-call';
      /** The producing plugin, kept for log forensics. */
      readonly plugin: 'dsh-voice-call';
    } & ContextFormed;
  }
}

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

/**
 * The CrispASR engine configuration — the local Qwen3-TTS CustomVoice
 * pipeline. `bin` is the crispasr executable, `model` the talker GGUF and
 * `codec` the Qwen3-TTS tokenizer/vocoder GGUF.
 */
export interface CrispasrEngineConfig {
  /** Path to `crispasr.exe` (or `crispasr` on POSIX). */
  readonly bin?: string;
  /** Path to the talker GGUF, e.g. `qwen3-tts-12hz-0.6b-customvoice-q8_0.gguf`. */
  readonly model?: string;
  /** Path to the codec/tokenizer GGUF, e.g. `qwen3-tts-tokenizer-12hz-q8_0.gguf`. */
  readonly codec?: string;
  /**
   * The engine backend to invoke. Absent means `qwen3-tts-customvoice`; the 1.7B
   * port registers under its own backend name, so a model choice carries it.
   * Set it only together with a matching `model` — the pairing is what the
   * engine checks.
   */
  readonly backend?: string;
}

/**
 * Ring/answer behaviour for `offer_call`. `ask` routes the call through the
 * human confirmation channel (the light-weight v0.1 answer: the built-in
 * user-questions prompt). `card` (v0.2) rings the dedicated call-card UI —
 * ring animation, caller identity, 接听/拒接 buttons — falling back to the
 * `ask` prompt when no call-card client is connected. `direct` accepts
 * immediately (no ring) for already-confirmed narration. `off` refuses calls
 * outright.
 */
export type CallMode = 'ask' | 'card' | 'direct' | 'off';

/** The call-card presentation config (v0.2). */
export interface CallCardConfig {
  /** Display name shown on the card as the caller. @default 'DeepSeek' */
  readonly callerName: string;
  /** How long the card rings before the call settles as `missed`. @default 30000 */
  readonly ringTimeoutMs: number;
  /**
   * Which theme half the card renders in. `system` follows the host's own
   * `data-ds-dark-theme` attribute live; `light`/`dark` pin it against the host.
   * @default 'system'
   */
  readonly theme: CardTheme;
  /** The card's accent preset; see `src/palettes.ts`. @default 'azure' */
  readonly palette: PaletteId;
  /**
   * Play the bundled ringtone while a card is unanswered. Off leaves the card
   * visual-only, which is what a shared room wants. @default true
   */
  readonly ringtone: boolean;
  /**
   * Which of the bundled ringtones `ringtone` plays. See `src/client/tones.ts`;
   * an unknown id resolves to `classic`, the sound every install has shipped
   * with, so a typo in a hand-written profile degrades rather than silences.
   * @default 'classic'
   */
  readonly tone: ToneId;
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
    /** Pinned backend; absent auto-selects (say → crispasr → piper). */
    readonly backend?: TtsBackendId;
    /** Default voice passed to the backend (crispasr CustomVoice speaker, say voice, edge-tts voice). */
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
    /** The local CrispASR + Qwen3-TTS CustomVoice engine. */
    readonly crispasr?: CrispasrEngineConfig;
  };
  /** When true, the assistant's reply text is spoken aloud automatically. */
  readonly readReplies: boolean;
  /**
   * When true, `voice/call` and `voice/note` events are appended to the
   * session log (audio cards + call records on replay). Default false:
   * DSH 0.1.0-rc.6 has no plugin-event registration surface, and its session
   * loader REFUSES logs containing event types it does not know — an appended
   * voice event would make the session's history permanently unloadable.
   * Set to true only on a harness build that knows these types (or after a
   * supported registration surface exists).
   */
  readonly durableEvents: boolean;
  /**
   * How `offer_call` rings the human: `ask` (default), `card`, `direct`, or
   * `off`. This is the v0.1 "answer key" — the human always holds it.
   */
  readonly callMode: CallMode;
  /** The call-card presentation (only used when callMode is `card`). */
  readonly callCard: CallCardConfig;
  /** Audio artifact root; defaults to `~/.dsh/voice` (or `$DSH_HOME/voice`). */
  readonly audioDir: string;
  /**
   * FUTURE (v0.3): voicemail behaviour for missed calls. Reserved now so
   * configs written against v0.1 keep loading unchanged.
   */
  readonly voicemail?: {
    readonly enabled?: boolean;
  };
  /**
   * FUTURE (v0.3): read-receipt reporting when the human plays a note.
   * Reserved now; not implemented in v0.1.
   */
  readonly readReceipts?: {
    readonly enabled?: boolean;
  };
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
    readonly crispasr?: CrispasrEngineConfig;
  };
  readonly readReplies?: boolean;
  readonly durableEvents?: boolean;
  readonly callMode?: CallMode;
  readonly callCard?: { readonly callerName?: string; readonly ringTimeoutMs?: number; readonly theme?: CardTheme; readonly palette?: string; readonly ringtone?: boolean; readonly tone?: string };
  readonly audioDir?: string;
  readonly voicemail?: { readonly enabled?: boolean };
  readonly readReceipts?: { readonly enabled?: boolean };
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
      ...(tts.crispasr !== undefined ? { crispasr: tts.crispasr } : {}),
    },
    readReplies: raw?.readReplies ?? false,
    durableEvents: raw?.durableEvents ?? false,
    callMode: raw?.callMode ?? 'ask',
    callCard: {
      callerName: raw?.callCard?.callerName ?? 'DeepSeek',
      ringTimeoutMs: raw?.callCard?.ringTimeoutMs ?? 30_000,
      theme: raw?.callCard?.theme ?? DEFAULT_THEME,
      palette: paletteById(raw?.callCard?.palette).id,
      // Absent means "on": the ringtone is the behaviour every version of this
      // plugin has promised, and a config written before the flag existed
      // should not silently become the quiet one.
      ringtone: raw?.callCard?.ringtone ?? true,
      // Resolved through the table rather than trusted: `assets/ringtone.wav` is
      // the same bytes as the `classic` entry, so an install that never touched
      // this field rings exactly as it did before the picker existed.
      tone: toneById(raw?.callCard?.tone).id,
    },
    audioDir: raw?.audioDir ?? '',
    ...(raw?.voicemail !== undefined ? { voicemail: raw.voicemail } : {}),
    ...(raw?.readReceipts !== undefined ? { readReceipts: raw.readReceipts } : {}),
  };
}

/** One `voice/note` event — the durable event family of dsh-voice-call. */
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
  /** Backend id that produced or played the audio (`crispasr`, `fake`, …). */
  readonly backend: string;
}

/**
 * One `voice/call` event — the call-domain vocabulary.
 *
 * v0.1 emits exactly one event per call (`offered`), carrying the human's
 * decision. The later phases of a call's life are RESERVED types so the
 * session-log vocabulary is stable across upgrades:
 *
 * - `voice/call.read`        (v0.3) the human played a note — read receipt.
 * - `voice/call.voicemail`   (v0.3) a missed call was left as a message.
 *
 * A client that does not know a newer event type renders it inert, and the
 * host never breaks replay: every event is append-only JSON.
 */
export interface VoiceCallData {
  /** Stable call id: `call-<timestamp>-<random>`. */
  readonly callId: string;
  /** Turn/step coordinates where the call entered the session. */
  readonly turn: number;
  readonly step: number;
  /** What the agent wanted to say. */
  readonly transcript: string;
  /** Voice/speaker the call would have used. */
  readonly voice: string;
  /** The human's decision (v0.1: offered carries the decided value). */
  readonly decision: 'accepted' | 'rejected' | 'later' | 'missed';
  /** Present when accepted: the synthesized audio. */
  readonly audioRef?: AudioRef;
  /** Backend id that produced the audio. */
  readonly backend?: string;
  /** Event vocabulary version — clients render by it. */
  readonly version: 1;
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

/** The canonical `offer_call` tool result handle. */
export interface OfferCallOutput {
  /** `accepted` — the human answered; audio was synthesized (job running). */
  readonly status: 'accepted' | 'rejected' | 'later' | 'missed' | 'off' | 'unavailable';
  readonly callId: string;
  readonly jobId?: string;
  readonly audioRef?: AudioRef;
  readonly backend?: string;
  /** Human-readable reason for `unavailable` / `off`. */
  readonly reason?: string;
}

/** The canonical `record` media result produced before transcription. */
export interface RecordedMedia {
  readonly file: string;
  readonly durationMs?: number;
  /**
   * Delete the recording when the caller is done with it. The recorders write
   * raw microphone audio into the OS temp dir, and the artifact store keeps its
   * own copy of whatever was kept — so without this, every transcription of a
   * recording leaves a second, permanent copy of what somebody said out loud.
   */
  readonly discard?: () => Promise<void>;
}
