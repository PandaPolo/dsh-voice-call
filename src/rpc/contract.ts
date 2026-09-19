/**
 * RPC contracts for the dedicated call-card UI. RESERVED in v0.1, SHIPPED in
 * v0.2 over the webserver seam: the DSH 0.1.2-rc.1 baseline has no
 * client-connection RPC surface yet, so the card transport rides the same
 * `webServer.register` gap as the audio route, and the reserved payload
 * shapes here cross the wire verbatim.
 *
 * v0.2 wire map (see `src/callcard/web.ts`):
 * - `RPC_VOICE_ANSWER` (`voice/answer`) → `POST /voice/call/answer`, body
 *   `VoiceAnswerPayload`, response `VoiceAnswerResult`.
 * - The host→card direction (the ring itself) streams as SSE on
 *   `GET /voice/call/events` (`ringing` / `active` / `settled` events carrying
 *   `CallCardRingState` / `CallCardSettledState`; `active` marks an accepted
 *   call whose spoken leg is still running), with `GET /voice/call/state`
 *   as the polling equivalent.
 *
 * When a harness build gains a real connection-RPC surface, these endpoints
 * migrate onto it with the SAME payload types — the call domain and the card
 * UI keep their shapes; only the transport moves.
 *
 * @module dsh-voice-call/rpc/contract
 */

/** Endpoint: the human answered a ringing call from the call-card UI (v0.2: `POST /voice/call/answer`). */
export const RPC_VOICE_ANSWER = 'voice/answer' as const;
export interface VoiceAnswerPayload {
  readonly callId: string;
  readonly decision: 'accepted' | 'rejected' | 'later';
}
export interface VoiceAnswerResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/** Endpoint: the human finished playing a note (read receipt, v0.3). */
export const RPC_VOICE_READ = 'voice/read' as const;
export interface VoiceReadPayload {
  readonly noteId: string;
  /** Playback fraction 0..1 when the client can report it. */
  readonly progress?: number;
}
export interface VoiceReadResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/** Endpoint: list voicemail entries (v0.3). */
export const RPC_VOICEMAIL_LIST = 'voice/voicemail/list' as const;
export interface VoiceVoicemailListResult {
  readonly entries: readonly {
    readonly callId: string;
    readonly text: string;
    readonly voice: string;
    readonly audioRef: { readonly path: string; readonly mime: string };
    readonly savedAt: number;
    readonly readAt?: number;
  }[];
}

/** Endpoint: mark a voicemail entry as read (v0.3). */
export const RPC_VOICEMAIL_READ = 'voice/voicemail/read' as const;
export interface VoiceVoicemailReadPayload {
  readonly callId: string;
}
export interface VoiceVoicemailReadResult {
  readonly ok: boolean;
  readonly reason?: string;
}
