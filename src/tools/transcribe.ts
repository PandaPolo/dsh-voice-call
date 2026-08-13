/**
 * The `transcribe` tool: speech-to-text. `source` is exactly one of
 * `{ file }` (transcribe an existing audio file) or `{ record }` (record from
 * the mic first — gated on a recording path being available). The transcript
 * is inserted as a user message (the model's next step sees it as user
 * input, never as tool output) and a durable `voice/note` event renders the
 * audio card as a user-authored turn. The canonical return is a compact
 * handle so Code Mode callers get structured data.
 *
 * @module dsh-voice/tools/transcribe
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { MessageId } from '@deepseek-ai/dsh-llm';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool, type GenericCallView } from '@deepseek-ai/dsh-tools';
import type { AudioRef, RecordedMedia, TranscribeOutput, VoiceNoteData } from '../types.ts';
import type { SttBackend } from '../backends/types.ts';
import { deliverToPeer } from '../crosstalk.ts';
import { appendVoiceNote, currentCoords, mintNoteId } from '../session-events.ts';

/** Everything the transcribe pipeline needs; injected so tests run with fakes. */
export interface TranscribeDeps {
  readonly stt: SttBackend;
  readonly record: (seconds: number | undefined, signal?: AbortSignal) => Promise<RecordedMedia>;
  readonly commit: (file: string, name: string, extra?: { readonly durationMs?: number }) => Promise<AudioRef>;
  readonly appendNote: (data: VoiceNoteData) => void;
  readonly deliverToPeer: (to: string, transcript: string, audioRef: AudioRef) => Promise<{ readonly messageId: string; readonly peer: string } | undefined>;
  readonly deliverUserMessage: (transcript: string, noteId: string) => void;
  readonly coords: () => { readonly turn: number; readonly step: number };
  readonly now?: () => number;
}

/** The exact-one `{file | record}` union as inferred from the tool schema. */
export type TranscribeSource =
  | { readonly file: string }
  | { readonly record: { readonly seconds?: number } };

/** Tool args as inferred by the schema. */
export interface TranscribeArgs {
  readonly source: TranscribeSource;
  /** Crosstalk peer name/ref to deliver the note to (soft dependency). */
  readonly to?: string;
}

/** Run one transcription against injected deps (unit-testable end to end). */
export async function runTranscribe(
  deps: TranscribeDeps,
  args: TranscribeArgs,
  signal?: AbortSignal,
): Promise<TranscribeOutput> {
  const source = args.source;
  let file: string;
  let mediaDurationMs: number | undefined;
  if ('file' in source) {
    file = source.file;
  } else {
    const recorded = await deps.record(source.record?.seconds, signal);
    file = recorded.file;
    mediaDurationMs = recorded.durationMs;
  }
  const outcome = await deps.stt.transcribe(file, signal);
  const noteId = mintNoteId(deps.now ?? Date.now);
  const coords = deps.coords();
  const audioRef = await deps.commit(file, `voice-in-${noteId}${extOf(file)}`);
  const note: VoiceNoteData = {
    noteId,
    turn: coords.turn,
    step: coords.step,
    audioRef,
    transcript: outcome.transcript,
    direction: 'in',
    backend: outcome.backend,
  };
  deps.appendNote(note);

  let deliveredTo: { readonly messageId: string; readonly peer: string } | undefined;
  if (args.to !== undefined && args.to !== '') {
    deliveredTo = await deps.deliverToPeer(args.to, outcome.transcript, audioRef);
  } else {
    deps.deliverUserMessage(outcome.transcript, noteId);
  }
  return {
    transcript: outcome.transcript,
    audioRef,
    backend: outcome.backend,
    ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : mediaDurationMs !== undefined ? { durationMs: mediaDurationMs } : {}),
    ...(deliveredTo !== undefined ? { deliveredTo } : {}),
  };
}

function extOf(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot >= 0 ? file.slice(dot) : '.m4a';
}

/** The tool schema's `source` parameter — an exact-one union. */
export const sourceSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', required: true, description: 'Absolute path of an audio file to transcribe.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        record: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            seconds: { type: 'number', description: 'How long to record (default 5).' },
          },
        },
      },
    },
  ],
} as const;

/** The `transcribe` parameter spec (exported for schema unit tests). */
export const transcribeParameters = {
  source: { ...sourceSchema, required: true as const, description: 'Exactly one of file or record.' },
  to: { type: 'string', description: 'Crosstalk peer name/ref to deliver the voice note to (requires dsh-crosstalk).' },
} as const;

/** Register the `transcribe` tool on `ctx.tools`. */
export function applyTranscribeTool(
  ctx: Context,
  deps: {
    readonly makeDeps: (exec: { readonly agent?: Agent }) => TranscribeDeps;
  },
): void {
  ctx.tools.register(defineTool({
    name: 'transcribe',
    description: 'Transcribe spoken audio into a user message. Pass exactly one of source.file (an existing audio file path) or source.record (record from the microphone for source.record.seconds, default 5). The transcript becomes a user message the agent responds to; the audio is saved under ~/.dsh/voice/. Optional `to` delivers the note to another local DSH session by crosstalk peer name/ref.',
    parameters: transcribeParameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          transcript: { type: 'string', required: true },
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
          durationMs: { type: 'number' },
          deliveredTo: {
            type: 'object',
            additionalProperties: false,
            properties: {
              messageId: { type: 'string', required: true },
              peer: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as TranscribeOutput;
        const delivery = v.deliveredTo !== undefined ? `\n(delivered to peer ${v.deliveredTo.peer})` : '';
        return [{ type: 'text', text: `Transcribed via ${v.backend}: "${v.transcript}"${delivery}\nThe transcript has been added as a user message for the agent. Audio: ${v.audioRef.path}` }];
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<TranscribeOutput> {
      const typed = args as unknown as TranscribeArgs;
      const pipeline = deps.makeDeps(exec);
      return runTranscribe(pipeline, typed, exec.signal);
    },
    presentCall(args): GenericCallView {
      const typed = args as unknown as TranscribeArgs;
      const label = 'file' in typed.source ? `Transcribe ${typed.source.file}` : `Record ${typed.source.record?.seconds ?? 5}s and transcribe`;
      return { card: 'generic', title: label, kind: 'search' };
    },
  }));
}

/** Build the pipeline deps from a live context + exec (used by the plugin). */
export function buildTranscribeDeps(
  ctx: Context,
  deps: {
    readonly stt: SttBackend;
    readonly record: (seconds: number | undefined, signal?: AbortSignal) => Promise<RecordedMedia>;
    readonly commit: (file: string, name: string, extra?: { readonly durationMs?: number }) => Promise<AudioRef>;
  },
  exec: { readonly agent?: Agent },
): TranscribeDeps {
  const session = exec.agent?.session;
  return {
    stt: deps.stt,
    record: deps.record,
    commit: deps.commit,
    appendNote: (data) => appendVoiceNote(ctx, session, data),
    deliverToPeer: (to, transcript, audioRef) => deliverToPeer(ctx, to, transcript, audioRef),
    deliverUserMessage: (transcript, noteId) => {
      if (exec.agent === undefined) return;
      const message: UserMessage = {
        id: MessageId(`voice-${noteId}`),
        role: 'user',
        content: [{ type: 'text', text: transcript }],
        source: { kind: 'plugin', plugin: 'dsh-voice', form: 'notice', summary: 'voice note transcribed' },
      };
      exec.agent.send(message, 'next-step', true);
    },
    coords: () => currentCoords(session),
  };
}
