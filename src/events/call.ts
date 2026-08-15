/**
 * The `voice/call` durable session event family. v0.1 emits exactly one event
 * per call (`voice/call`), carrying the settled decision. FUTURE event types
 * are declared here so the vocabulary is stable across upgrades:
 *
 * - `voice/call.read`      (v0.3) — the human played the accepted audio.
 * - `voice/call.voicemail` (v0.3) — a missed call was saved as a message.
 *
 * @module dsh-voice-call/events/call
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { VoiceCallData } from '../types.ts';

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One call was settled: the agent offered speech and the human answered
     * (接听/拒接/稍后), or the ring was refused (callMode off / no answerer).
     * The audio card for an accepted call is a separate `voice/note` event —
     * the call event is the decision record, the note is the artifact.
     * @mode emit
     * @param data - stable call identity, transcript, voice, decision, optional audio ref.
     */
    'voice/call': VoiceCallData;
    /**
     * FUTURE (v0.3): the human played a note to completion — the read receipt
     * the agent can see on later turns. Reserved; not emitted in v0.1.
     * @mode emit
     */
    'voice/call.read': {
      readonly callId: string;
      readonly noteId: string;
      readonly readAt: number;
    };
    /**
     * FUTURE (v0.3): a missed call was saved as a voicemail message.
     * Reserved; not emitted in v0.1.
     * @mode emit
     */
    'voice/call.voicemail': {
      readonly callId: string;
      readonly savedAt: number;
    };
  }
}

export type { VoiceCallData };

/**
 * Append a `voice/call` event; a missing session, a rejected append, or a
 * disabled `durableEvents` flag is logged, never thrown.
 *
 * NOTE (rc.6): the harness's session loader refuses logs containing event
 * types this build does not know, and `Session.append` cannot mark events
 * ignorable — so appending `voice/call` on 0.1.0-rc.6 permanently poisons the
 * session's history. Callers must pass the plugin's `durableEvents` config
 * (default false) and keep it off until a harness with plugin-event support
 * (or an ignorable-capable append) is present.
 */
export function appendVoiceCall(ctx: Context, session: Session | undefined, data: VoiceCallData, enabled: boolean): void {
  if (session === undefined || !enabled) return;
  try {
    session.append('voice/call', data);
  } catch (error) {
    ctx.logger.warn('dsh-voice-call: could not append voice/call event', error);
  }
}
