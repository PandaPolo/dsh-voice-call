/**
 * The `voice/note` durable session event family. Single-event business:
 * `noteId` is the stable Definition-local id and there are no update events
 * in v0.1. The audio file lives under audioDir; the log carries only the
 * compact ref + transcript, so replay reproduces the audio card without
 * re-reading audio.
 *
 * @module dsh-voice/session-events
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { VoiceNoteData } from './types.ts';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One voice note entered the session: a dictated user message (STT,
     * `direction: 'in'`) or a spoken agent reply (TTS, `direction: 'out'`).
     * Renders as a compact audio card in the chat; the session log holds the
     * ref + transcript only, never raw audio bytes.
     * @mode emit
     * @param data - stable identity, location, audio ref, transcript, direction, backend.
     */
    'voice/note': VoiceNoteData;
  }
}

export type { VoiceNoteData };

/** The current turn/step coordinates of a live session (0/0 when absent). */
export function currentCoords(session: Session | undefined): { readonly turn: number; readonly step: number } {
  if (session === undefined) return { turn: 0, step: 0 };
  let turn = 0;
  let step = 0;
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') turn = event.data.turn;
    else if (event.type === 'step/start') step = event.data.step;
  }
  return { turn, step };
}

/**
 * Append a `voice/note` event; a missing session, a rejected append, or a
 * disabled `durableEvents` flag is logged, never thrown.
 *
 * NOTE (rc.6): the harness's session loader refuses logs containing event
 * types this build does not know, and `Session.append` cannot mark events
 * ignorable — so appending `voice/note` on 0.1.0-rc.6 permanently poisons the
 * session's history. Callers must pass the plugin's `durableEvents` config
 * (default false) and keep it off until a harness with plugin-event support
 * (or an ignorable-capable append) is present.
 */
export function appendVoiceNote(ctx: Context, session: Session | undefined, data: VoiceNoteData, enabled: boolean): void {
  if (session === undefined || !enabled) return;
  try {
    session.append('voice/note', data);
  } catch (error) {
    ctx.logger.warn('dsh-voice: could not append voice/note event', error);
  }
}

/** Mint a stable note id: `voice-<timestamp>-<random>`. */
export function mintNoteId(now: () => number = Date.now): string {
  return `voice-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
