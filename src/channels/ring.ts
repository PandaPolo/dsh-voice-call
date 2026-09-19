/**
 * The ring channel: how an offered call reaches the human and comes back with
 * a decision. v0.1 ships ONE channel — the built-in user-questions prompt
 * (`ask_user_question`), which the web UI renders as a modal question with
 * options. The human literally holds the answer key: the call never plays a
 * sound until they pick 接听.
 *
 * FUTURE channels (same contract, plug in behind this interface):
 * - v0.2: a dedicated call-card UI (ring animation, caller identity, 接听/拒接
 *   buttons) driven over the client↔host RPC seam (`voice/answer` endpoint).
 * - v0.3: auto-answer for narration (callMode `direct`) and voicemail.
 *
 * @module dsh-voice-call/channels/ring
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { CallDecision, CallLegStatus, VoiceCall } from '../domain/call.ts';

/** What the ring produced: the human's decision, or a refusal. */
export type RingOutcome =
  | { readonly kind: 'answered'; readonly decision: CallDecision }
  | { readonly kind: 'refused'; readonly reason: string };

/** One ring request — the human-facing payload of a call. */
export interface RingRequest {
  readonly call: VoiceCall;
  /** The live calling agent (needed by the user-questions seam). */
  readonly agent?: Agent;
  /** Abort signal for the owning tool/step. */
  readonly signal?: AbortSignal;
}

/** The ring channel contract. Implementations decide HOW the human answers. */
export interface RingChannel {
  /** Present one call to the human and wait for their answer. */
  ring(request: RingRequest): Promise<RingOutcome>;
  /**
   * Report the follow-up of an ACCEPTED call back into the presentation, so a
   * channel with an on-screen call surface can keep it up while the agent
   * speaks and retire it when the audio is done. Channels without one (the
   * prompt and direct channels) omit this and the caller uses {@link SILENT_LEG}.
   */
  leg?(callId: string): CallLeg;
}

/** The follow-up reporting seam for one accepted call (see {@link RingChannel.leg}). */
export interface CallLeg {
  /** The wav is synthesized and playback started (vs still being synthesized). */
  playing(): void;
  /** The call is over: the agent finished speaking, or the speak job failed. */
  settle(status: CallLegStatus, reason?: string): void;
}

/** The leg of a presentation with nothing to keep on screen. */
export const SILENT_LEG: CallLeg = { playing: () => {}, settle: () => {} };

/**
 * The v0.1 ring: the built-in user-questions prompt. Three options — 接听
 * (accept), 拒接 (reject), 稍后再说 (defer). An absent answerer (headless
 * deployment, no UI) refuses the call with a clear reason instead of hanging.
 */
export class AskUserRingChannel implements RingChannel {
  private readonly ask: (request: {
    readonly questions: AskUserQuestionItem[];
    readonly agent?: Agent;
    readonly signal?: AbortSignal;
  }) => Promise<AskUserQuestionAnswer>;

  constructor(
    ask: (request: {
      readonly questions: AskUserQuestionItem[];
      readonly agent?: Agent;
      readonly signal?: AbortSignal;
    }) => Promise<AskUserQuestionAnswer>,
  ) {
    this.ask = ask;
  }

  async ring(request: RingRequest): Promise<RingOutcome> {
    const { call, agent, signal } = request;
    const answer = await this.ask({
      agent,
      signal,
      questions: [
        {
          id: call.callId,
          header: '📞 voice-call',
          question: `The agent wants to speak: "${call.text}"`,
          detail: `voice: ${call.voice} · answer to hear it, reject to send it back, or defer.`,
          options: [
            { label: '接听', description: 'Play the spoken message now.' },
            { label: '拒接', description: 'The agent learns the call was declined.' },
            { label: '稍后再说', description: 'The agent may call again later.' },
          ],
        },
      ],
    });
    const selected = answer.answers[0]?.selected ?? [];
    const label = selected[0] ?? '';
    switch (label) {
      case '接听':
        return { kind: 'answered', decision: 'accepted' };
      case '拒接':
        return { kind: 'answered', decision: 'rejected' };
      case '稍后再说':
        return { kind: 'answered', decision: 'later' };
      default:
        return { kind: 'answered', decision: 'rejected' };
    }
  }
}

/**
 * The v0.1 `direct` ring: no human in the loop — the call is accepted
 * immediately. Used for narration that was already confirmed (speak / voice
 * speak), never for unannounced calls.
 */
export class DirectRingChannel implements RingChannel {
  async ring(_request: RingRequest): Promise<RingOutcome> {
    return { kind: 'answered', decision: 'accepted' };
  }
}
