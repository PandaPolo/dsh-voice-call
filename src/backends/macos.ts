/**
 * The macOS STT backend — built-in `SFSpeechRecognizer` via a tiny bundled
 * swift shim through `ctx.shell`. No install, no network, and a fallback that
 * works on any Mac. Also owns mic recording (`ffmpeg` avfoundation first, the
 * bundled swift recorder shim second), which gates `transcribe({record})`.
 *
 * @module dsh-voice/backends/macos
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildCommandLine } from './quote.ts';
import type { ShellRun } from './runner.ts';
import type { SttBackend, SttOutcome } from './types.ts';

/** Absolute path of the bundled `macos-stt.swift` shim. */
export function macosSttShimPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shims', 'macos-stt.swift');
}

/** Absolute path of the bundled `macos-record.swift` shim. */
export function macosRecordShimPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shims', 'macos-record.swift');
}

/** The macOS SFSpeechRecognizer speech-to-text backend. */
export class MacosSttBackend implements SttBackend {
  readonly id = 'macos' as const;

  private readonly run: ShellRun;
  private readonly options: { readonly shim?: string };

  constructor(run: ShellRun, options: { readonly shim?: string } = {}) {
    this.run = run;
    this.options = options;
  }

  async transcribe(file: string, signal?: AbortSignal): Promise<SttOutcome> {
    const shim = this.options.shim ?? macosSttShimPath();
    // First run compiles the shim; give it room but still bound the call.
    const outcome = await this.run(buildCommandLine(['swift', shim, file]), { signal });
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim() || outcome.stdout.trim();
      throw new Error(`macos: speech recognition failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
    }
    const transcript = outcome.stdout.trim();
    if (transcript === '') {
      throw new Error('macos: speech recognition returned an empty transcript');
    }
    return { transcript, backend: this.id, detail: 'SFSpeechRecognizer' };
  }
}

/**
 * Record microphone audio to `outFile` for `seconds` (default 5). Prefers
 * `ffmpeg` avfoundation when present, then the bundled swift recorder shim.
 * Throws with a clear message when no recording path exists.
 */
export async function recordWithMacos(run: ShellRun, outFile: string, seconds: number | undefined, signal?: AbortSignal): Promise<void> {
  const duration = seconds !== undefined && seconds > 0 ? seconds : 5;
  const ffmpeg = await tryRun(run, 'command -v ffmpeg', signal);
  if (ffmpeg) {
    const outcome = await run(
      buildCommandLine(['ffmpeg', '-y', '-f', 'avfoundation', '-i', ':0', '-t', String(duration), '-c:a', 'aac', outFile]),
      { signal },
    );
    if (outcome.exitCode === 0) return;
    // ffmpeg may have failed because no input device is named ":0" — fall
    // through to the swift shim rather than failing the whole call.
  }
  const swift = await tryRun(run, 'command -v swift', signal);
  if (!swift) {
    throw new Error('dsh-voice: mic recording is unavailable — no ffmpeg or swift on PATH');
  }
  const outcome = await run(buildCommandLine(['swift', macosRecordShimPath(), outFile, String(duration)]), { signal });
  if (outcome.exitCode !== 0) {
    const detail = outcome.stderr.trim() || outcome.stdout.trim();
    throw new Error(`dsh-voice: mic recording failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
  }
}

async function tryRun(run: ShellRun, command: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const outcome = await run(command, { signal });
    return outcome.exitCode === 0 && outcome.stdout.trim() !== '';
  } catch {
    return false;
  }
}
