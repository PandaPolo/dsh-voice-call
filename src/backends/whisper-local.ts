/**
 * The local whisper.cpp STT backend — fully offline speech recognition.
 * Invokes a whisper.cpp binary via `ctx.shell` with `-oj` (JSON output) and
 * parses the transcript defensively across the two JSON shapes whisper.cpp
 * has emitted over the years.
 *
 * @module dsh-voice/backends/whisper-local
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { shqFlags } from './quote.ts';
import type { ShellRun } from './runner.ts';
import type { SttBackend, SttOutcome } from './types.ts';

/** Extract the transcript from whisper.cpp JSON output (either shape). */
export function parseWhisperJson(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.text === 'string' && record.text.trim() !== '') return record.text.trim();
  const transcription = record.transcription;
  if (Array.isArray(transcription) && transcription.length > 0) {
    const first = transcription[0];
    if (typeof first === 'object' && first !== null && typeof (first as Record<string, unknown>).text === 'string') {
      return ((first as Record<string, unknown>).text as string).trim();
    }
  }
  const segments = record.segments;
  if (Array.isArray(segments) && segments.length > 0) {
    const first = segments[0];
    if (typeof first === 'object' && first !== null && typeof (first as Record<string, unknown>).text === 'string') {
      return ((first as Record<string, unknown>).text as string).trim();
    }
  }
  return undefined;
}

/** The local whisper.cpp speech-to-text backend. */
export class WhisperLocalSttBackend implements SttBackend {
  readonly id = 'whisper-local' as const;

  private readonly run: ShellRun;
  private readonly options: { readonly bin: string; readonly model?: string };

  constructor(run: ShellRun, options: { readonly bin: string; readonly model?: string }) {
    this.run = run;
    this.options = options;
  }

  async transcribe(file: string, signal?: AbortSignal): Promise<SttOutcome> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-whisper-'));
    try {
      const prefix = join(dir, 'out');
      const tokens = [this.options.bin, '-f', file, '-oj', '-of', prefix];
      if (this.options.model !== undefined && this.options.model !== '') tokens.push('-m', this.options.model);
      const outcome = await this.run(shqFlags(...tokens), { signal });
      if (outcome.exitCode !== 0) {
        const detail = outcome.stderr.trim() || outcome.stdout.trim();
        throw new Error(`whisper-local: recognition failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
      }
      const jsonPath = `${prefix}.json`;
      const raw = await readFile(jsonPath, 'utf8');
      const transcript = parseWhisperJson(raw);
      if (transcript === undefined || transcript === '') {
        throw new Error('whisper-local: no transcript in whisper.cpp JSON output');
      }
      return { transcript, backend: this.id, detail: this.options.model ?? 'whisper.cpp' };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** The artifact basename this backend consumes (any audio whisper.cpp reads). */
  static artifactName(): string {
    return basename('voice.wav');
  }
}
