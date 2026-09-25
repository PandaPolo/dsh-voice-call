/**
 * The local Piper TTS backend — offline neural TTS. Feeds the text to
 * `piper -m <model> --output_file <dest>` through the shell runner's stdin
 * channel. Only reachable when the user configures `tts.backend: piper`
 * (or auto-selection finds a piper binary); never a cloud path.
 *
 * @module dsh-voice/backends/piper
 */
import { buildCommandLine } from './quote.ts';
import { runWavPlayback } from './playback.ts';
import type { ShellRun } from './runner.ts';
import type { SynthesizeResult, TtsBackend } from './types.ts';

/** The local Piper text-to-speech backend. */
export class PiperTtsBackend implements TtsBackend {
  readonly id = 'piper' as const;

  private readonly run: ShellRun;
  private readonly options: { readonly bin: string; readonly model: string };

  constructor(run: ShellRun, options: { readonly bin: string; readonly model: string }) {
    this.run = run;
    this.options = options;
  }

  async synthesize(input: { readonly text: string }, dest: string, signal?: AbortSignal): Promise<SynthesizeResult> {
    const command = buildCommandLine([this.options.bin, '-m', this.options.model, '--output_file', dest]);
    const outcome = await this.run(command, { signal, stdin: input.text });
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new Error(`piper: synthesis failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
    }
    return { mime: 'audio/wav' };
  }

  async play(file: string, signal?: AbortSignal): Promise<void> {
    // Piper writes wav; play it locally through the shared wav player so a
    // "completed but silent" job is never reported as success.
    try {
      await runWavPlayback(this.run, file, signal);
    } catch (error) {
      throw new Error(`piper: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
