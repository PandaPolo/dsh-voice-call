/**
 * FUTURE RPC contracts (v0.2+): the client↔host endpoints a dedicated
 * call-card UI will use to answer calls and report playback. RESERVED in v0.1
 * — nothing here is registered or served yet. Keeping the endpoint names and
 * payload shapes fixed now means a v0.2 card UI can ship without touching the
 * host plugin's call domain.
 *
 * Transport: `@deepseek-ai/dsh-client-connection` — the browser calls
 * `createWebConnectionRpc().call('/api', endpoint, payload)` and the host
 * registers handlers via `ctx.connection.rpc.intercept('/api', matcher,
 * handler, { authority: 'loopback' })`.
 *
 * @module dsh-voice-call/rpc/contract
 */

/** Endpoint: the human answered a ringing call from the call-card UI. */
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
