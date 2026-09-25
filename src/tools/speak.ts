/**
 * The `speak` tool: text-to-speech that never blocks the turn. Synthesis +
 * playback run on a background job via `ctx.jobs.start({ kind: 'voice-speak'
 * })`; the tool returns `{ jobId, audioRef }` immediately. Every backend
 * writes a durable audio file under audioDir (the unit-testable seam), then
 * plays it as a separate best-effort step. A job failure surfaces as an
 * injected note, never a thrown turn. `speak` doubles as progress narration
 * for long/headless runs — narration *is* speak called from a job context.
 *
 * @module dsh-voice/tools/speak
 */
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JobId, JobOutcome, JobSpec } from '@deepseek-ai/dsh-jobs';
import { MessageId } from '@deepseek-ai/dsh-llm';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools';
import { mimeForPath } from '../audio.ts';
import type { AudioRef, SpeakOutput, VoiceNoteData } from '../types.ts';
import type { TtsBackend } from '../backends/types.ts';
import { appendVoiceNote, currentCoords, mintNoteId } from '../session-events.ts';

/** Everything the speak pipeline needs; injected so tests run with fakes. */
export interface SpeakDeps {
  readonly tts: TtsBackend;
  readonly startJob: (spec: JobSpec) => JobId;
  /**
   * The owning agent, stamped onto the job spec. rc.6's Web composition
   * disables `tool-jobs` on the host plane (the controller lives in the
   * agent-preset scope), so an UNOWNED job is refused with "no job
   * controller serves this agent" — `servesOwner(undefined)` only consults
   * the global layer. An owned job resolves the preset scope chain, exactly
   * like the harness's own `tool-bash`/`tool-pwsh` background tasks.
   */
  readonly owner?: Agent;
  /** A fresh artifact path under audioDir for one synthesis. */
  readonly audioPath: () => string;
  readonly appendNote: (data: VoiceNoteData) => void;
  /** Surface a failed narration as an injected note (never a thrown turn). */
  readonly injectFailure: (message: string) => void;
  readonly coords: () => { readonly turn: number; readonly step: number };
  readonly now?: () => number;
}

/** Tool args as inferred by the schema. */
export interface SpeakArgs {
  readonly text: string;
  readonly voice?: string;
  readonly rate?: number;
}

/** Start one speak job; returns the handle plus the settled outcome for tests. */
export function startSpeakJob(
  deps: SpeakDeps,
  input: {
    readonly text: string;
    readonly voice?: string;
    readonly rate?: number;
    /** Fires once the wav exists and audible playback begins (the call card's 播放中). */
    readonly onPlay?: () => void;
  },
): { readonly jobId: string; readonly audioRef: AudioRef; readonly settled: Promise<JobOutcome> } {
  const file = deps.audioPath();
  const controller = new AbortController();
  const work = (async (): Promise<JobOutcome> => {
    try {
      // The audio root is created lazily on first write: synthesis targets the
      // artifact path directly, so the parent dir must exist before the
      // backend opens the file (a missing ~/.dsh/voice made crispasr fail
      // with "cannot write ..." even though synthesis itself succeeded).
      await mkdir(dirname(file), { recursive: true });
      const result = await deps.tts.synthesize({ text: input.text, ...(input.voice !== undefined ? { voice: input.voice } : {}), ...(input.rate !== undefined ? { rate: input.rate } : {}) }, file, controller.signal);
      const audioRef: AudioRef = { path: file, mime: result.mime, ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}) };
      const coords = deps.coords();
      deps.appendNote({
        noteId: mintNoteId(deps.now ?? Date.now),
        turn: coords.turn,
        step: coords.step,
        audioRef,
        transcript: input.text,
        direction: 'out',
        backend: deps.tts.id,
      });
      // Playback is best-effort per platform, but a failure is SURFACED — a
      // swallowed error left users with "job completed but silent".
      input.onPlay?.();
      await deps.tts.play(file, controller.signal);
      return { status: 'completed', detail: `${input.text.length} chars` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.injectFailure(message);
      return { status: 'failed', detail: message };
    }
  })();
  const spec: JobSpec = {
    kind: 'voice-speak',
    label: `speak: ${truncateLabel(input.text)}`,
    // Unowned jobs are refused in the web composition (host-plane tool-jobs is
    // disabled); the owner's *live* agent — the one currently registered under
    // this session id — is what lets the preset's controller serve the job
    // (JobSpec.owner is a SessionId since 0.1.7). Absent in headless runs,
    // where the host owns tool-jobs.
    ...(deps.owner !== undefined ? { owner: deps.owner.session.id } : {}),
    run: () => ({
      cancel: (reason) => controller.abort(reason ?? 'cancelled'),
      done: work,
    }),
  };
  const jobId = deps.startJob(spec);
  return { jobId: String(jobId), audioRef: { path: file, mime: mimeForPath(file) }, settled: work };
}

/** Truncate a long line for the job label. */
export function truncateLabel(text: string, max = 60): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The `speak` parameter spec (exported for schema unit tests). */
export const speakParameters = {
  text: { type: 'string', required: true, description: 'The text to speak.' },
  voice: { type: 'string', description: 'Voice name (say/edge-tts voice); defaults to the configured voice.' },
  rate: { type: 'number', description: 'Speaking rate (say words per minute); defaults to the configured rate.' },
} as const;

/** Register the `speak` tool on `ctx.tools`. */
export function applySpeakTool(
  ctx: Context,
  deps: {
    readonly makeDeps: (exec: { readonly agent?: Agent }) => SpeakDeps;
  },
): void {
  ctx.tools.register(defineTool({
    name: 'speak',
    description: 'Speak text aloud and save the audio under ~/.dsh/voice/. Runs on a background job — the tool returns immediately with a handle and playback happens asynchronously. Use for short spoken answers and for walk-away narration on long builds or headless runs ("build finished, 0 failures"). Optional voice and rate (say words per minute).',
    parameters: speakParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', required: true },
          audioRef: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              path: { type: 'string', required: true },
              mime: { type: 'string', required: true },
              durationMs: { type: 'number' },
            },
          },
          backend: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as SpeakOutput;
        return [{ type: 'text', text: `Started speaking on background job ${v.jobId} (${v.backend}); audio will be at ${v.audioRef.path}.` }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<SpeakOutput> {
      const typed = args as unknown as SpeakArgs;
      if (typed.text.trim() === '') throw new Error('speak: text must not be empty');
      const pipeline = deps.makeDeps(exec);
      const handle = startSpeakJob(pipeline, typed);
      return { jobId: handle.jobId, audioRef: handle.audioRef, backend: pipeline.tts.id };
    },
    presentCall(args): GenericCallView {
      const typed = args as unknown as SpeakArgs;
      return { card: 'generic', title: `Speak: ${truncateLabel(typed.text, 40)}`, kind: 'other' };
    },
  }));
}

/** Build the pipeline deps from a live context + exec (used by the plugin). */
export function buildSpeakDeps(
  ctx: Context,
  deps: {
    readonly tts: TtsBackend;
    readonly audioPath: () => string;
    readonly durableEvents: () => boolean;
  },
  exec: { readonly agent?: Agent },
): SpeakDeps {
  const session = exec.agent?.session;
  return {
    tts: deps.tts,
    audioPath: deps.audioPath,
    owner: exec.agent,
    startJob: (spec) => ctx.jobs.start(spec),
    appendNote: (data) => appendVoiceNote(ctx, session, data, deps.durableEvents()),
    injectFailure: (message) => {
      if (exec.agent === undefined) return;
      const note: UserMessage = {
        id: MessageId(`voice-fail-${mintNoteId()}`),
        role: 'user',
        content: [{ type: 'text', text: `dsh-voice-call: speak failed — ${message}` }],
        source: { kind: 'voice-call', plugin: 'dsh-voice-call', form: 'notice', summary: 'speak failed' },
      };
      try {
        exec.agent.inject(note);
      } catch {
        // agent disposed mid-job — the failure is already recorded in the job
      }
    },
    coords: () => currentCoords(session),
  };
}
