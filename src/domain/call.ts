/**
 * The call domain: one `offer_call` request as a state machine. Pure logic —
 * no cordis, no shell, no UI — so the whole call lifecycle is unit-testable
 * and the human's "answer key" (接听/拒接/稍后) is just one of several
 * decisions a call can take.
 *
 * v0.1 lifecycle (single-step):
 *
 *   offered ──ring──▶ accepted ──▶ (job synthesizes audio)
 *        │
 *        ├──▶ rejected   (human declined; the agent sees the feedback)
 *        ├──▶ later      (human deferred; the agent may call again)
 *        └──▶ missed     (nobody answered — FUTURE: voicemail hook)
 *
 * The state machine is deliberately small now: v0.1 emits ONE decision per
 * call. The future phases (voicemail, read receipts, call-card UI) extend
 * the decision vocabulary and event stream without changing this core.
 *
 * @module dsh-voice-call/domain/call
 */

/** Every decision a call can settle into. */
export type CallDecision = 'accepted' | 'rejected' | 'later' | 'missed';

/** Why the ring never happened (or could not be answered). */
export type CallRefusal = 'off' | 'unavailable';

/** The state of one call, from the agent's perspective. */
export interface VoiceCall {
  /** Stable call id. */
  readonly callId: string;
  /** What the agent wanted to say. */
  readonly text: string;
  /** The speaker the call would have used. */
  readonly voice: string;
  /** The settled decision, once the ring resolves. */
  readonly decision?: CallDecision;
  /** When the ring was refused before it could ring. */
  readonly refusal?: CallRefusal;
  /** Optional human-readable reason for a refusal. */
  readonly reason?: string;
}

/** Input to open a call. */
export interface OpenCallInput {
  readonly text: string;
  readonly voice: string;
}

/** Input to settle a ringing call with the human's answer. */
export interface AnswerCallInput {
  readonly decision: CallDecision;
  readonly reason?: string;
}

/** Mint a stable call id: `call-<timestamp>-<random>`. */
export function mintCallId(now: () => number = Date.now): string {
  return `call-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Open a call in the `offered` (ringing) state. */
export function openCall(input: OpenCallInput, now: () => number = Date.now): VoiceCall {
  return {
    callId: mintCallId(now),
    text: input.text,
    voice: input.voice,
  };
}

/** Settle an offered call with the human's answer. */
export function answerCall(call: VoiceCall, input: AnswerCallInput): VoiceCall {
  if (call.decision !== undefined || call.refusal !== undefined) {
    throw new Error(`call ${call.callId} is already settled (${call.decision ?? call.refusal})`);
  }
  return { ...call, decision: input.decision, ...(input.reason !== undefined ? { reason: input.reason } : {}) };
}

/** Refuse a call before it rings (callMode off / no answerer available). */
export function refuseCall(call: VoiceCall, refusal: CallRefusal, reason?: string): VoiceCall {
  if (call.decision !== undefined || call.refusal !== undefined) {
    throw new Error(`call ${call.callId} is already settled (${call.decision ?? call.refusal})`);
  }
  return { ...call, refusal, ...(reason !== undefined ? { reason } : {}) };
}

/** True once the call is settled (decided or refused). */
export function isSettled(call: VoiceCall): boolean {
  return call.decision !== undefined || call.refusal !== undefined;
}
