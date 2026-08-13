/**
 * Client-side types for dsh-voice: the `voice/note` event shape as the web
 * client sees it, and the `voice-note` chat card payload. Deliberately
 * self-contained (mirrors the host's event vocabulary) so the client bundle
 * stays pure over `node.data` — replay reproduces the card without re-reading
 * audio.
 *
 * @module dsh-voice/client/types
 */

/** The durable `voice/note` event data (client-side mirror of the host type). */
export interface VoiceNoteEventData {
  readonly noteId: string;
  readonly turn: number;
  readonly step: number;
  readonly audioRef: {
    readonly path: string;
    readonly mime: string;
    readonly durationMs?: number;
  };
  readonly transcript: string;
  readonly direction: 'in' | 'out';
  readonly backend: string;
}

/** The host emits this from the same vocabulary; the client merge keeps the event typed in the web bundle. */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One voice note entered the session (see the host's voice/note event).
     * @mode emit
     */
    'voice/note': VoiceNoteEventData;
  }
}

/** The `voice-note` chat card payload (what `node.data` carries). */
export interface VoiceNoteCardData {
  readonly noteId: string;
  readonly direction: 'in' | 'out';
  readonly transcript: string;
  readonly backend: string;
  /** Null when the audio is missing/unplayable — the transcript-only card. */
  readonly audioRef: {
    readonly path: string;
    readonly mime: string;
    readonly durationMs?: number;
  } | null;
  readonly durationMs?: number;
}

/** Derive the web URL of one audio artifact (same-origin route on the host). */
export function audioUrlOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return `/voice/audio/${encodeURIComponent(base)}`;
}
