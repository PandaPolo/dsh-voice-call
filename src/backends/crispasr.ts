/**
 * The local CrispASR + Qwen3-TTS CustomVoice backend — offline neural TTS
 * with 9 baked speaker tokens (aiden, dylan, eric, ono_anna, ryan, serena,
 * sohee, uncle_fu, vivian). Two of the speakers carry Chinese-dialect
 * overrides: `dylan` (Beijing) and `eric` (Sichuan).
 *
 * Command shape (CrispASR ≥ 0.8.28):
 *
 *   crispasr --backend qwen3-tts-customvoice \
 *     -m <talker.gguf> --codec-model <codec.gguf> \
 *     --voice <speaker> --tts "<text>" --tts-output <dest.wav>
 *
 * The shell runner used by DSH is platform-dependent: POSIX shells on
 * darwin/linux, PowerShell on win32. Command strings are therefore built by
 * {@link quoteForShell} / {@link invokeForShell} so both families get a
 * correct, injection-safe command line (PowerShell: `& 'path'` + `''` escape;
 * POSIX: `shq` + `'\''` escape).
 *
 * @module dsh-voice-call/backends/crispasr
 */
import { buildCommandLine, invokeForShell, quoteForShell } from './quote.ts';
import { runWavPlayback } from './playback.ts';
import type { ShellRun } from './runner.ts';
import type { SynthesizeResult, TtsBackend } from './types.ts';

// Re-exported for API compatibility (the platform-aware quoting helpers live
// in `quote.ts`; the wav playback helpers live in `playback.ts`).
export { buildCommandLine, invokeForShell, quoteForShell } from './quote.ts';
export { playWavCommand, runWavPlayback } from './playback.ts';

/** The 9 CustomVoice speakers (lowercase, as the engine expects them). */
export const CUSTOMVOICE_SPEAKERS = [
  'aiden', 'dylan', 'eric', 'ono_anna', 'ryan',
  'serena', 'sohee', 'uncle_fu', 'vivian',
] as const;

/** A known CustomVoice speaker name, or `undefined` when unknown. */
export type CustomVoiceSpeaker = (typeof CUSTOMVOICE_SPEAKERS)[number];

/** True when `voice` names a built-in CustomVoice speaker. */
export function isCustomVoiceSpeaker(voice: string | undefined): voice is CustomVoiceSpeaker {
  return voice !== undefined && (CUSTOMVOICE_SPEAKERS as readonly string[]).includes(voice);
}

/** The local CrispASR Qwen3-TTS backend. */
export class CrispasrTtsBackend implements TtsBackend {
  readonly id = 'crispasr' as const;

  private readonly run: ShellRun;
  private readonly options: {
    readonly bin: string;
    readonly model: string;
    readonly codec: string;
    /** The engine backend this talker needs; defaults to the 0.6B CustomVoice one. */
    readonly backend?: string;
    /** Extra flags appended verbatim (e.g. `--gpu-backend cuda`). */
    readonly extraFlags?: readonly string[];
  };

  constructor(
    run: ShellRun,
    options: { readonly bin: string; readonly model: string; readonly codec: string; readonly backend?: string; readonly extraFlags?: readonly string[] },
  ) {
    this.run = run;
    this.options = options;
  }

  async synthesize(
    input: { readonly text: string; readonly voice?: string },
    dest: string,
    signal?: AbortSignal,
  ): Promise<SynthesizeResult> {
    const voice = input.voice !== undefined && input.voice !== '' ? input.voice : 'aiden';
    if (!isCustomVoiceSpeaker(voice)) {
      throw new Error(`crispasr: unknown speaker "${voice}" — available: ${CUSTOMVOICE_SPEAKERS.join(', ')}`);
    }
    if (input.text.trim() === '') {
      throw new Error('crispasr: text must not be empty');
    }
    const command = crispasrCommand(this.options, { text: input.text, voice }, dest);
    const outcome = await this.run(command, { signal });
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new Error(`crispasr: synthesis failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
    }
    return { mime: 'audio/wav' };
  }

  async play(file: string, signal?: AbortSignal): Promise<void> {
    // Local playback keeps the "answer to hear it" promise independent of the
    // web client's audio card (the card is driven by session events that rc.6
    // cannot persist safely — durableEvents stays off, so no card appears).
    try {
      await runWavPlayback(this.run, file, signal);
    } catch (error) {
      throw new Error(`crispasr: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Build the full crispasr command line for one synthesis (the string `ctx.shell` runs). */
export function crispasrCommand(
  options: CrispasrInvocation,
  input: { readonly text: string; readonly voice: string },
  dest: string,
): string {
  return buildCommandLine(crispasrArgv(options, input, dest));
}

/** Everything one synthesis needs to name the engine, its model pair and backend. */
export interface CrispasrInvocation {
  readonly bin: string;
  readonly model: string;
  readonly codec: string;
  /**
   * The engine backend. The 1.7B CustomVoice port is registered under its own
   * name, so a model choice carries it; omitting it keeps the 0.6B default that
   * every hand-written config today relies on.
   */
  readonly backend?: string;
  readonly extraFlags?: readonly string[];
}

/**
 * The same invocation as an argv list: `[bin, ...flags]`. The command string is
 * for `ctx.shell`; the list is for a direct spawn and for the device probe —
 * one definition of the engine's flags, two consumers.
 */
export function crispasrArgv(
  options: CrispasrInvocation,
  input: { readonly text: string; readonly voice: string },
  dest: string,
): string[] {
  return [
    options.bin,
    '--backend', options.backend ?? 'qwen3-tts-customvoice',
    '-m', options.model,
    '--codec-model', options.codec,
    '--voice', input.voice,
    '--tts', input.text,
    '--tts-output', dest,
    ...(options.extraFlags ?? []),
  ];
}
