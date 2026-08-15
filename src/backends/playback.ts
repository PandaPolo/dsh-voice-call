/**
 * Local wav playback shared by the wav-producing TTS backends (crispasr,
 * piper). Windows uses the built-in PowerShell `System.Media.SoundPlayer`
 * (WAV only, zero dependencies); POSIX uses `afplay` (macOS) or `aplay`
 * (Linux) best-effort. A nonzero exit throws, so a "completed but silent"
 * job is never reported as success.
 *
 * @module dsh-voice-call/backends/playback
 */
import { quoteForShell } from './quote.ts';
import type { ShellRun } from './runner.ts';

/** Build the local playback command for one wav file (platform-aware). */
export function playWavCommand(file: string): string {
  if (process.platform === 'win32') {
    return `(New-Object Media.SoundPlayer ${quoteForShell(file)}).PlaySync()`;
  }
  const player = process.platform === 'darwin' ? 'afplay' : 'aplay';
  return `${quoteForShell(player)} ${quoteForShell(file)}`;
}

/** Play one wav through the shared runner; throws on a nonzero exit. */
export async function runWavPlayback(run: ShellRun, file: string, signal?: AbortSignal): Promise<void> {
  const outcome = await run(playWavCommand(file), { signal });
  if (outcome.exitCode !== 0) {
    const detail = outcome.stderr.trim() || outcome.stdout.trim();
    throw new Error(`playback failed (exit ${outcome.exitCode})${detail !== '' ? `: ${detail}` : ''}`);
  }
}
