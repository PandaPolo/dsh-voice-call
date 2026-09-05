/**
 * The v0.2 ring channel: the dedicated call-card UI. The call lands on the
 * {@link CallBoard}, every connected web client receives it over the
 * `/voice/call/events` stream, and the human answers with the card's
 * 接听/拒接/稍后再说 buttons — the answer travels back as a
 * `POST /voice/call/answer` whose payload is the reserved
 * `VoiceAnswerPayload` contract.
 *
 * Fallback semantics (the card is a web-UI feature):
 * - subscribers connected  → ring the card, bounded by `ringTimeoutMs`
 *   (default 30s; an unanswered ring settles as `missed` instead of hanging
 *   the agent turn forever);
 * - no subscribers, fallback channel present → the human is not watching a
 *   call-card UI, so the call degrades to the v0.1 user-questions prompt;
 * - no subscribers, no fallback (headless) → refuse with `unavailable`.
 *
 * @module dsh-voice-call/channels/callcard
 */
import type { CallDecision } from '../domain/call.ts';
import { CallBoard } from '../callcard/board.ts';
import type { RingChannel, RingOutcome, RingRequest } from './ring.ts';

/** Everything the card channel needs; injected so tests run with fakes. */
export interface CallCardChannelDeps {
  readonly board: CallBoard;
  /** Resolve the caller display name (config `callCard.callerName`). */
  readonly callerName: () => string;
  /** Resolve the ring timeout in ms (config `callCard.ringTimeoutMs`). */
  readonly ringTimeoutMs: () => number;
  /** Used when no call-card client is connected (v0.1 prompt channel). */
  readonly fallback?: RingChannel;
}

/**
 * Ring through the call-card UI. Implements the same {@link RingChannel}
 * contract as the v0.1 channels — the offer-call pipeline does not know or
 * care which presentation carried the ring.
 */
export class CallCardRingChannel implements RingChannel {
  private readonly deps: CallCardChannelDeps;

  constructor(deps: CallCardChannelDeps) {
    this.deps = deps;
  }

  async ring(request: RingRequest): Promise<RingOutcome> {
    const { board, fallback } = this.deps;
    if (!board.hasSubscribers) {
      if (fallback !== undefined) return fallback.ring(request);
      return { kind: 'refused', reason: 'no call-card client is connected' };
    }
    return await new Promise<RingOutcome>((resolve) => {
      const settled = (outcome: RingOutcome): void => {
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        board.expire(request.call.callId, `the ring timed out after ${this.deps.ringTimeoutMs()}ms`);
      }, Math.max(1, this.deps.ringTimeoutMs()));
      board.open(
        {
          callId: request.call.callId,
          text: request.call.text,
          voice: request.call.voice,
          caller: {
            name: this.deps.callerName(),
            ...(request.agent !== undefined ? { sessionId: sessionTail(request.agent.id) } : {}),
          },
          ringAt: Date.now(),
        },
        // A timed-out ring settles as the domain's `missed` decision — the
        // truthful status for the agent (nobody answered), distinct from
        // `refused`/`unavailable` (nobody could answer).
        (decision: CallDecision) => {
          settled({ kind: 'answered', decision });
        },
      );
    });
  }
}

/** The short session tag the card shows under the caller name. */
function sessionTail(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(-8);
}
