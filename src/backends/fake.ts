/**
 * The fake STT/TTS backends — text-to-text stand-ins that run the whole tool
 * path with no mic and no network. The default in CI and unit tests.
 *
 * Mapping (deterministic, both directions):
 * - STT reads the "audio" file. If its content is a JSON object with a
 *   `transcript` string field, that text is returned. Otherwise the basename
 *   (extension stripped, `-`/`_` → space) is returned — so a hand-made
 *   fixture like `fixture-build-finished.m4a` transcribes to
 *   `build finished`.
 * - TTS writes `{"transcript": "<text>"}` into the destination file, so
 *   `speak` output round-trips exactly through the fake STT.
 *
 * @module dsh-voice/backends/fake
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { SttBackend, SttOutcome, SynthesizeResult, TtsBackend } from './types.ts';

/** Extract the fixture transcript from one fake "audio" file. */
export async function fakeTranscriptFrom(file: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    raw = '';
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { transcript?: unknown };
      if (typeof parsed.transcript === 'string' && parsed.transcript !== '') return parsed.transcript;
    } catch {
      // not JSON — fall through to the basename rule
    }
  }
  return basename(file, extname(file)).replaceAll(/[-_]+/g, ' ').trim();
}

/** The fake speech-to-text backend. */
export class FakeSttBackend implements SttBackend {
  readonly id = 'fake' as const;

  async transcribe(file: string): Promise<SttOutcome> {
    const transcript = await fakeTranscriptFrom(file);
    return { transcript, backend: this.id, detail: 'fake: text-to-text fixture mapping' };
  }
}

/** The fake text-to-speech backend. */
export class FakeTtsBackend implements TtsBackend {
  readonly id = 'fake' as const;

  async synthesize(input: { readonly text: string }, dest: string): Promise<SynthesizeResult> {
    await writeFile(dest, JSON.stringify({ transcript: input.text }, null, 2), 'utf8');
    return { mime: 'application/json; fake-audio' };
  }

  async play(): Promise<void> {
    // Fake playback is a no-op — nothing audible, nothing to fail.
  }
}
