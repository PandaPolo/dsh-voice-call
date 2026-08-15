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
import { shq } from './quote.ts';
import type { ShellRun } from './runner.ts';
import type { SynthesizeResult, TtsBackend } from './types.ts';

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
    /** Extra flags appended verbatim (e.g. `--gpu-backend cuda`). */
    readonly extraFlags?: readonly string[];
  };

  constructor(
    run: ShellRun,
    options: { readonly bin: string; readonly model: string; readonly codec: string; readonly extraFlags?: readonly string[] },
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
    const command = playbackCommand(file);
    const outcome = await this.run(command, { signal });
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new Error(`crispasr: playback failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
    }
  }
}

/**
 * Build the local playback command for a synthesized wav. Windows uses the
 * built-in PowerShell `System.Media.SoundPlayer` (WAV only, zero dependencies);
 * POSIX uses `afplay` (macOS) or `aplay` (Linux) best-effort.
 */
export function playbackCommand(file: string): string {
  if (process.platform === 'win32') {
    return `(New-Object Media.SoundPlayer ${quoteForShell(file)}).PlaySync()`;
  }
  const player = process.platform === 'darwin' ? 'afplay' : 'aplay';
  return invokeForShell(player, quoteForShell(file));
}

/** Build the full crispasr command line for one synthesis. */
export function crispasrCommand(
  options: { readonly bin: string; readonly model: string; readonly codec: string; readonly extraFlags?: readonly string[] },
  input: { readonly text: string; readonly voice: string },
  dest: string,
): string {
  const tokens: string[] = [
    options.bin,
    '--backend', 'qwen3-tts-customvoice',
    '-m', options.model,
    '--codec-model', options.codec,
    '--voice', input.voice,
    '--tts', input.text,
    '--tts-output', dest,
    ...(options.extraFlags ?? []),
  ];
  return buildCommandLine(tokens);
}

/** Join argv tokens into one shell command line (platform-aware quoting). */
export function buildCommandLine(tokens: readonly string[]): string {
  if (tokens.length === 0) return '';
  const [program, ...args] = tokens;
  const quoted = args.map((token) => quoteForShell(token)).join(' ');
  return invokeForShell(program ?? '', quoted);
}

/** Quote one argument for the current platform's shell (POSIX or PowerShell). */
export function quoteForShell(token: string | undefined): string {
  const value = token ?? '';
  // win32: the dsh shell layer runs PowerShell; `''` is the escape for `'`.
  if (process.platform === 'win32') {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return shq(value);
}

/** Invoke a program path with pre-quoted arguments on the current shell. */
export function invokeForShell(program: string, quotedArgs: string): string {
  if (process.platform === 'win32') {
    // PowerShell: `& 'path'` is the call operator for a quoted program path.
    return `& ${quoteForShell(program)} ${quotedArgs}`.trimEnd();
  }
  return `${shq(program)} ${quotedArgs}`.trimEnd();
}
