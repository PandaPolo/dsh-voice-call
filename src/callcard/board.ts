/**
 * The call-card board: the host-side registry of live (ringing) calls plus
 * the subscriber fan-out the web call-card UI listens to. Pure logic — no
 * cordis, no HTTP — so the ring/answer race is unit-testable.
 *
 * Lifecycle of one ringing call:
 *
 *   open(call, caller) ──▶ RINGING (broadcast `ringing`, waiters pending)
 *     ├── answer(callId, decision) ──▶ settled (broadcast `settled`, waiter resolves)
 *     ├── expire(callId)            ──▶ settled as `missed` (nobody answered)
 *     └── abort(callId)             ──▶ settled as `missed` (tool/step cancelled)
 *
 * Subscribers (the SSE route) receive the full ringing table on connect —
 * a page opened mid-ring still shows the card — and per-call events after.
 * Every payload is JSON-serializable: the board is the wire vocabulary.
 *
 * @module dsh-voice-call/callcard/board
 */
import type { CallDecision } from '../domain/call.ts';

/** The caller identity the card shows while ringing. */
export interface CallCaller {
  /** Display name of the caller (config `callCard.callerName`). */
  readonly name: string;
  /** Tail of the calling agent's session id, when known. */
  readonly sessionId?: string;
}

/** The `ringing` broadcast payload — one offered call waiting for the human. */
export interface CallCardRingState {
  readonly callId: string;
  /** What the agent wants to say (the card's preview text). */
  readonly text: string;
  /** The speaker the call would use (the card's voice badge). */
  readonly voice: string;
  readonly caller: CallCaller;
  /** Epoch ms when the ring started (the card's elapsed timer). */
  readonly ringAt: number;
}

/** The `settled` broadcast payload — the call no longer rings. */
export interface CallCardSettledState {
  readonly callId: string;
  readonly decision: CallDecision;
  /** Human-readable reason for a missed/expired ring. */
  readonly reason?: string;
}

/** Every event a call-card subscriber can receive. */
export type CallCardEvent =
  | { readonly kind: 'ringing'; readonly call: CallCardRingState }
  | { readonly kind: 'settled'; readonly call: CallCardSettledState };

/** One entry on the board while its call is ringing. */
interface BoardEntry {
  readonly call: CallCardRingState;
  /** Resolved with the human's decision (or a timeout miss). */
  readonly waiter: (decision: CallDecision, reason?: string) => void;
}

export type AnswerDecision = 'accepted' | 'rejected' | 'later';

/**
 * The live-call registry behind the call-card UI. One instance per plugin
 * mount; the ring channel opens calls on it, the web routes answer/observe
 * it, and nothing else touches it.
 */
export class CallBoard {
  private readonly ringing = new Map<string, BoardEntry>();
  private readonly subscribers = new Set<(event: CallCardEvent) => void>();

  /** True when at least one call-card client is listening (SSE connected). */
  get hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  /** The current ringing calls, newest first (the card's initial render). */
  list(): CallCardRingState[] {
    return [...this.ringing.values()].map((entry) => entry.call).reverse();
  }

  /**
   * Put a call on the board: broadcast `ringing` and park a waiter the
   * {@link answer} / {@link expire} / {@link abort} paths resolve.
   * @returns unsubscribe for the channel's timeout/abort cleanup.
   */
  open(call: CallCardRingState, onDecision: (decision: CallDecision, reason?: string) => void): void {
    if (this.ringing.has(call.callId)) return;
    this.ringing.set(call.callId, { call, waiter: onDecision });
    this.publish({ kind: 'ringing', call });
  }

  /**
   * The human answered from the card. The first answer wins; answers for
   * unknown (already settled or never opened) calls report `ok: false` so
   * the client can dismiss its card without a retry loop.
   */
  answer(callId: string, decision: AnswerDecision): { ok: boolean; reason?: string } {
    const entry = this.ringing.get(callId);
    if (entry === undefined) return { ok: false, reason: 'unknown or already settled call' };
    this.ringing.delete(callId);
    this.publish({ kind: 'settled', call: { callId, decision } });
    entry.waiter(decision);
    return { ok: true };
  }

  /** The ring expired (timeout) or was aborted — settle it as `missed`. */
  expire(callId: string, reason: string): void {
    const entry = this.ringing.get(callId);
    if (entry === undefined) return;
    this.ringing.delete(callId);
    this.publish({ kind: 'settled', call: { callId, decision: 'missed', reason } });
    entry.waiter('missed', reason);
  }

  /**
   * Subscribe a call-card client. The subscriber immediately receives the
   * current ringing table (so a mid-ring page load renders the card), then
   * live events.
   * @returns the unsubscribe disposer.
   */
  subscribe(send: (event: CallCardEvent) => void): () => void {
    this.subscribers.add(send);
    for (const call of this.list()) send({ kind: 'ringing', call });
    return () => {
      this.subscribers.delete(send);
    };
  }

  private publish(event: CallCardEvent): void {
    for (const send of this.subscribers) {
      try {
        send(event);
      } catch {
        // A broken subscriber never takes down the board.
      }
    }
  }
}
