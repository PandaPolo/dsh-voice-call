/**
 * The cloud edge-tts backend (Microsoft Edge neural voices) — the only TTS
 * path that sends text off-machine. Never auto-selected; reachable only when
 * the user explicitly sets `tts.backend: edge-tts`.
 *
 * @module dsh-voice/backends/edge-tts
 */
import { shqFlags } from './quote.ts';
import type { ShellRun } from './runner.ts';
import type { SynthesizeResult, TtsBackend } from './types.ts';

/** The edge-tts CLI text-to-speech backend. */
export class EdgeTtsBackend implements TtsBackend {
  readonly id = 'edge-tts' as const;

  private readonly run: ShellRun;
  private readonly options: { readonly bin: string; readonly voice: string };

  constructor(run: ShellRun, options: { readonly bin: string; readonly voice: string }) {
    this.run = run;
    this.options = options;
  }

  async synthesize(input: { readonly text: string; readonly voice?: string }, dest: string, signal?: AbortSignal): Promise<SynthesizeResult> {
    const voice = input.voice ?? this.options.voice;
    const command = shqFlags(this.options.bin, '--voice', voice, '--write-media', dest, '--text', input.text);
    const outcome = await this.run(command, { signal });
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new Error(`edge-tts: synthesis failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
    }
    return { mime: 'audio/mpeg' };
  }

  async play(_file: string): Promise<void> {
    // edge-tts writes a file only; playback is left to the caller's player.
  }
}
