/**
 * The `offer_call` tool: the agent's voice, offered. The agent decides WHEN
 * to speak and WHAT to say (its dialling right); the human holds the ANSWER
 * KEY — nothing plays until 接听. Rejected or deferred calls return the
 * human's decision to the agent, so it learns to write instead, or to call
 * again later.
 *
 * Pipeline per call:
 *
 *   open call (callId) → ring (channel by callMode) → settle
 *     accepted → speak job (synthesize + note + play)
 *     rejected / later → return the decision to the agent
 *     off / unavailable → refuse with a reason
 *
 * The ring is synchronous (the human answers while the tool call is pending);
 * the synthesis runs on a background job exactly like `speak`, so an accepted
 * call never blocks the turn.
 *
 * @module dsh-voice-call/tools/offer-call
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JobStart } from '@deepseek-ai/dsh-jobs';
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { CallMode } from '../types.ts';
import type { OfferCallOutput, VoiceCallData } from '../types.ts';
import type { RingChannel } from '../channels/ring.ts';
import { answerCall, openCall, refuseCall, type VoiceCall } from '../domain/call.ts';
import { appendVoiceCall } from '../events/call.ts';
import { startSpeakJob, type SpeakDeps } from './speak.ts';

/** Everything the offer-call pipeline needs; injected so tests run with fakes. */
export interface OfferCallDeps {
  /** The ring channel (ask-user by default, direct when callMode is direct). */
  readonly ring: RingChannel;
  /** The live calling agent (the web user-questions provider requires it). */
  readonly agent?: Agent;
  /** Resolve the current call mode (default `ask`). */
  readonly callMode: () => CallMode;
  /** The speak pipeline used for an accepted call. */
  readonly speak: SpeakDeps;
  readonly appendCall: (data: VoiceCallData) => void;
  readonly now?: () => number;
}

/** Tool args as inferred by the schema. */
export interface OfferCallArgs {
  readonly text: string;
  readonly voice?: string;
}

/** The user-questions ask function shape the default ring needs. */
export type AskUserFn = (request: {
  readonly questions: AskUserQuestionItem[];
  readonly agent?: Agent;
  readonly signal?: AbortSignal;
}) => Promise<AskUserQuestionAnswer>;

/** Run one offer-call pipeline; returns the settled handle. */
export async function runOfferCall(deps: OfferCallDeps, input: OfferCallArgs): Promise<OfferCallOutput> {
  const call: VoiceCall = openCall(
    { text: input.text, voice: input.voice ?? 'default' },
    deps.now ?? Date.now,
  );
  const mode = deps.callMode();

  if (mode === 'off') {
    const settled = refuseCall(call, 'off', 'callMode is "off" — calls are refused');
    deps.appendCall(callEventOf(settled));
    return { status: 'off', callId: settled.callId, reason: 'calls are disabled (callMode: off)' };
  }

  const outcome = await deps.ring.ring({ call, agent: deps.agent });
  if (outcome.kind === 'refused') {
    const settled = refuseCall(call, 'unavailable', outcome.reason);
    deps.appendCall(callEventOf(settled));
    return { status: 'unavailable', callId: settled.callId, reason: outcome.reason };
  }

  const settled = answerCall(call, { decision: outcome.decision });
  deps.appendCall(callEventOf(settled));

  switch (outcome.decision) {
    case 'accepted': {
      const started = startSpeakJob(deps.speak, { text: call.text, voice: call.voice === 'default' ? undefined : call.voice });
      return { status: 'accepted', callId: settled.callId, jobId: started.jobId, audioRef: started.audioRef, backend: deps.speak.tts.id };
    }
    case 'rejected':
      return { status: 'rejected', callId: settled.callId };
    case 'later':
      return { status: 'later', callId: settled.callId };
    case 'missed':
      return { status: 'missed', callId: settled.callId };
  }
}

/** Project a settled call into the durable `voice/call` event payload. */
function callEventOf(call: VoiceCall): VoiceCallData {
  if (call.decision !== undefined) {
    return {
      callId: call.callId,
      turn: 0,
      step: 0,
      transcript: call.text,
      voice: call.voice,
      decision: call.decision,
      version: 1,
    };
  }
  return {
    callId: call.callId,
    turn: 0,
    step: 0,
    transcript: call.text,
    voice: call.voice,
    decision: call.refusal === 'off' ? 'missed' : 'missed',
    version: 1,
  };
}

/** The `offer_call` parameter spec (exported for schema unit tests). */
export const offerCallParameters = {
  text: { type: 'string', required: true, description: 'The text the agent wants to speak. The human must answer (接听/拒接/稍后) before anything plays.' },
  voice: { type: 'string', description: 'CustomVoice speaker (aiden, dylan, eric, ono_anna, ryan, serena, sohee, uncle_fu, vivian); defaults to the configured voice.' },
} as const;

/** Register the `offer_call` tool on `ctx.tools`. */
export function applyOfferCallTool(
  ctx: Context,
  deps: {
    readonly makeDeps: (exec: { readonly agent?: Agent }) => OfferCallDeps;
  },
): void {
  ctx.tools.register(defineTool({
    name: 'offer_call',
    description: 'Offer to speak aloud: ring the human with the text; nothing plays until they answer 接听 (accept), 拒接 (reject), or 稍后再说 (defer). Use when you genuinely want to say something out loud — a finishing thought, a milestone, a feeling — not for routine narration (use speak for that). The human holds the answer key; a rejected call comes back to you so you can write it down instead.',
    parameters: offerCallParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          callId: { type: 'string', required: true },
          jobId: { type: 'string' },
          audioRef: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              mime: { type: 'string', required: true },
              durationMs: { type: 'number' },
            },
          },
          backend: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as OfferCallOutput;
        const lines = [`Call ${v.callId}: ${v.status}.`];
        if (v.jobId !== undefined) lines.push(`Speaking on background job ${v.jobId}.`);
        if (v.reason !== undefined) lines.push(v.reason);
        return [{ type: 'text', text: lines.join(' ') }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<OfferCallOutput> {
      const typed = args as unknown as OfferCallArgs;
      if (typed.text.trim() === '') throw new Error('offer_call: text must not be empty');
      return runOfferCall(deps.makeDeps(exec), typed);
    },
    presentCall(args): GenericCallView {
      const typed = args as unknown as OfferCallArgs;
      return { card: 'generic', title: `Offer call: ${truncate(typed.text, 40)}`, kind: 'other' };
    },
  }));
}

/** Truncate a long line for display. */
function truncate(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Build the offer-call deps from a live context + exec (used by the plugin). */
export function buildOfferCallDeps(
  ctx: Context,
  deps: {
    readonly ring: RingChannel;
    readonly callMode: () => CallMode;
    readonly speak: SpeakDeps;
    readonly durableEvents: () => boolean;
  },
  exec: { readonly agent?: Agent },
): OfferCallDeps {
  const session = exec.agent?.session;
  return {
    ring: deps.ring,
    agent: exec.agent,
    callMode: deps.callMode,
    speak: deps.speak,
    appendCall: (data) => appendVoiceCall(ctx, session, data, deps.durableEvents()),
  };
}
