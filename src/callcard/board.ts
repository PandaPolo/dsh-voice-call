/**
 * The call-card board: the host-side registry of live calls — ringing and
 * active — plus the subscriber fan-out the web call-card UI listens to. Pure
 * logic — no cordis, no HTTP — so the ring/answer race is unit-testable.
 *
 * Lifecycle of one call on the board:
 *
 *   open(call, caller) ──▶ RINGING (broadcast `ringing`, waiters pending)
 *     ├── answer(callId, 'accepted') ──▶ ACTIVE (broadcast `active`, card stays)
 *     │     ├── playing(callId)          ──▶ broadcast `active` again, synthesizing → playing
 *     │     └── settle(callId, status)   ──▶ broadcast `settled` (the agent finished speaking,
 *     │                                     or the speak job failed — the card may go away)
 *     ├── answer(callId, rejected|later) ──▶ settled at once (broadcast `settled`)
 *     ├── expire(callId)                 ──▶ settled as `missed` (nobody answered)
 *     └── abort(callId)                  ──▶ settled as `missed` (tool/step cancelled)
 *
 * The accepted call keeps its entry on the board because the human's side of
 * the call is not over when they press 接听 — the audio has not even been
 * synthesized yet. Dismissing the card at that moment made the answer key look
 * like a no-op, so the ACTIVE leg lives until the speak job settles it.
 *
 * Subscribers (the SSE route) receive the full live table on connect —
 * a page opened mid-ring still shows the card, and a page opened mid-call
 * shows it in its active leg — and per-call events after. Every payload is
 * JSON-serializable: the board is the wire vocabulary.
 *
 * @module dsh-voice-call/callcard/board
 */
import type { CallDecision, CallLegStatus } from '../domain/call.ts';

/** The caller identity the card shows under the agent's message. */
export interface CallCaller {
  /** Display name of the caller (config `callCard.callerName`). */
  readonly name: string;
  /** Tail of the calling agent's session id, when known. */
  readonly sessionId?: string;
}

/** Which leg a live call is on: waiting for an answer, or speaking. */
export type CallPhase = 'ringing' | 'active';

/** The live-call entry the card renders — the `ringing` and `active` payloads. */
export interface CallCardRingState {
  readonly callId: string;
  /** What the agent wants to say (the card's preview text). */
  readonly text: string;
  /** The speaker the call would use (the card's voice badge). */
  readonly voice: string;
  readonly caller: CallCaller;
  /** Epoch ms when the ring started (the card's elapsed timer). */
  readonly ringAt: number;
  readonly phase: CallPhase;
  /** Epoch ms the human pressed 接听 (the call-duration timer). */
  readonly answeredAt?: number;
  /** True once the wav exists and playback started (vs still synthesizing). */
  readonly playing?: boolean;
}

/** The `settled` broadcast payload — the call is off the board. */
export interface CallCardSettledState {
  readonly callId: string;
  readonly decision: CallDecision;
  /** Human-readable reason for a missed/expired ring or a failed speak job. */
  readonly reason?: string;
  /** Set when an ACCEPTED call settled: how its active leg ended. */
  readonly status?: CallLegStatus;
}

/** Every event a call-card subscriber can receive. */
export type CallCardEvent =
  | { readonly kind: 'ringing'; readonly call: CallCardRingState }
  | { readonly kind: 'active'; readonly call: CallCardRingState }
  | { readonly kind: 'settled'; readonly call: CallCardSettledState };

/** One entry on the board while its call is live (ringing or active). */
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
  private readonly live = new Map<string, BoardEntry>();
  private readonly subscribers = new Set<(event: CallCardEvent) => void>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** True when at least one call-card client is listening (SSE connected). */
  get hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  /** The current live calls, newest first (the card's initial render). */
  list(): CallCardRingState[] {
    return [...this.live.values()].map((entry) => entry.call).reverse();
  }

  /**
   * Put a call on the board: broadcast `ringing` and park a waiter the
   * {@link answer} / {@link expire} paths resolve.
   */
  open(call: Omit<CallCardRingState, 'phase'>, onDecision: (decision: CallDecision, reason?: string) => void): void {
    if (this.live.has(call.callId)) return;
    const entry: CallCardRingState = { ...call, phase: 'ringing' };
    this.live.set(call.callId, { call: entry, waiter: onDecision });
    this.publish({ kind: 'ringing', call: entry });
  }

  /**
   * The human answered from the card. The first answer wins; answers for a
   * call that is unknown, already answered, or past its ringing leg report
   * `ok: false` so the client can dismiss its card without a retry loop.
   *
   * 拒接/稍后再说 end the call here. 接听 does NOT: it moves the entry to its
   * active leg and broadcasts `active`, because the spoken message has not been
   * synthesized yet — {@link settle} ends it when the audio is really done.
   */
  answer(callId: string, decision: AnswerDecision): { ok: boolean; reason?: string } {
    const entry = this.ringingEntry(callId);
    if (entry === undefined) return { ok: false, reason: 'unknown or already settled call' };
    if (decision !== 'accepted') {
      this.live.delete(callId);
      this.publish({ kind: 'settled', call: { callId, decision } });
      entry.waiter(decision);
      return { ok: true };
    }
    const active: CallCardRingState = { ...entry.call, phase: 'active', answeredAt: this.now() };
    this.live.set(callId, { call: active, waiter: () => {} });
    this.publish({ kind: 'active', call: active });
    entry.waiter(decision);
    return { ok: true };
  }

  /** The accepted call's audio is synthesized and started playing. */
  playing(callId: string): void {
    const entry = this.live.get(callId);
    if (entry === undefined || entry.call.phase !== 'active' || entry.call.playing === true) return;
    const call: CallCardRingState = { ...entry.call, playing: true };
    this.live.set(callId, { call, waiter: entry.waiter });
    this.publish({ kind: 'active', call });
  }

  /**
   * End an accepted call's active leg: the agent finished speaking, or the
   * speak job failed and the card should say so. Broadcasts the same `settled`
   * event the rejected/missed paths use, so a client that knows nothing about
   * the active leg still dismisses on it.
   */
  settle(callId: string, status: CallLegStatus, reason?: string): void {
    const entry = this.live.get(callId);
    if (entry === undefined || entry.call.phase !== 'active') return;
    this.live.delete(callId);
    this.publish({
      kind: 'settled',
      call: { callId, decision: 'accepted', status, ...(reason !== undefined ? { reason } : {}) },
    });
  }

  /** The ring expired (timeout) or was aborted — settle it as `missed`. */
  expire(callId: string, reason: string): void {
    const entry = this.ringingEntry(callId);
    if (entry === undefined) return;
    this.live.delete(callId);
    this.publish({ kind: 'settled', call: { callId, decision: 'missed', reason } });
    entry.waiter('missed', reason);
  }

  /**
   * Subscribe a call-card client. The subscriber immediately receives the
   * current live table (so a mid-ring page load renders the card), then
   * live events.
   * @returns the unsubscribe disposer.
   */
  subscribe(send: (event: CallCardEvent) => void): () => void {
    this.subscribers.add(send);
    for (const call of this.list()) {
      send(call.phase === 'active' ? { kind: 'active', call } : { kind: 'ringing', call });
    }
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

  /** The entry only while its call is still waiting for an answer. */
  private ringingEntry(callId: string): BoardEntry | undefined {
    const entry = this.live.get(callId);
    return entry !== undefined && entry.call.phase === 'ringing' ? entry : undefined;
  }
}
