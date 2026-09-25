/**
 * The macOS `say` TTS backend — zero install, present on every Mac. Synthesizes
 * AAC-LC into an `.m4a` under audioDir (Chrome/Safari-playable), then plays it
 * with `afplay` as a separate best-effort step.
 *
 * @module dsh-voice/backends/say
 */
import { buildCommandLine } from './quote.ts';
import type { ShellRun } from './runner.ts';
import type { SynthesizeResult, TtsBackend } from './types.ts';

/** The macOS `say` text-to-speech backend. */
export class SayTtsBackend implements TtsBackend {
  readonly id = 'say' as const;

  private readonly run: ShellRun;

  constructor(run: ShellRun) {
    this.run = run;
  }

  async synthesize(input: { readonly text: string; readonly voice?: string; readonly rate?: number }, dest: string, signal?: AbortSignal): Promise<SynthesizeResult> {
    const tokens = ['say', '-o', dest, '--file-format=m4af', '--data-format=aac'];
    if (input.voice !== undefined && input.voice !== '') tokens.push('--voice', input.voice);
    if (input.rate !== undefined && input.rate > 0) tokens.push('-r', String(Math.round(input.rate)));
    tokens.push(input.text);
    const outcome = await this.run(buildCommandLine(tokens), { signal });
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new Error(`say: synthesis failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
    }
    return { mime: 'audio/mp4' };
  }

  async play(file: string, signal?: AbortSignal): Promise<void> {
    const outcome = await this.run(buildCommandLine(['afplay', file]), { signal });
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new Error(`afplay: playback failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
    }
  }
}
