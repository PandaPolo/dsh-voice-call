/**
 * Generates the plugin's ringtone: `assets/ringtone.wav`.
 *
 * Written from scratch rather than sourced, on purpose — a real messenger's
 * ringtone is someone's trademarked sound, and a plugin that fetches a ringtone
 * from the internet to play at your face is a dependency nobody asked for.
 * These are a few sine waves and an envelope.
 *
 * The shape of it, and why:
 *
 * - **A descending minor figure on a plucked string**, not a struck triad. The
 *   first version here was A·C#·E as a block, with inharmonic partials — and it
 *   was rejected out of hand, because that is the sound of a train pulling in.
 *   Public-announcement chimes are *ascending major triads with metallic
 *   shimmer*; this avoids all three halves of that recipe: it descends, it is
 *   minor pentatonic, and every partial is a whole-number multiple of the
 *   fundamental, which is what makes an instrument sound wooden rather than
 *   institutional.
 * - **Per-partial decay** — the upper harmonics die faster than the fundamental.
 *   That ratio is the whole difference between a plucked string and an organ
 *   tone, and it is why this reads as an object in a room instead of a speaker
 *   in a ceiling.
 * - **Overlapping tails and a diminuendo**: each note is a little quieter than
 *   the one before, so the figure leans away from you instead of announcing.
 * - **One breath per loop.** 1.4 s of sound, 1.8 s of rest. A ringtone that
 *   fills its own loop is the one that gets turned off.
 * - **Faded at both ends of the buffer**, because the file loops and a 3 %
 *   amplitude step at the seam is a click.
 * - **Mixed to a known peak (−3.3 dBFS), and every tone in `assets/ringtones/`
 *   is mixed to that same peak**: the settings card's 铃声 dropdown puts eleven
 *   files next to each other, and they need the same headroom so that a person
 *   picking one is not picking the one that happened to be loudest. It is *not*
 *   loudness-matched beyond that — see TARGET_LOUD in `ringtone-kit.mjs` for the
 *   equal-loudness trim that made seven of eleven inaudible. The player decides
 *   how loud any of them lands, in one visible number
 *   (`RINGTONE_VOLUME` in `src/client/ringtone.ts`).
 * - **22.05 kHz mono, 16-bit**: below the range where anything finer matters for
 *   a tone this simple, at half the bytes of 44.1 kHz.
 *
 *   node scripts/gen-ringtone.mjs
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbfs, encode, hz, loudWindow, render, SAMPLE_RATE, TARGET_LOUD, TARGET_PEAK } from './ringtone-kit.mjs';

const SECONDS = 3.2;
/** C5 · A4 · G4 · E4 — A minor pentatonic, falling, ending below where it started. */
const PITCH = [72, 69, 67, 64].map(hz);
/** Each note a little softer than the last. */
const VELOCITY = [1, 0.86, 0.74, 0.66];
/**
 * The string: fundamental plus three harmonic partials, each dying faster than
 * the one below it. No 2.01×, no 2.98× — inharmonicity is what made the previous
 * version sound like a bell in a station.
 */
const PARTIALS = [
  { multiple: 1, gain: 1, decay: 1.7 },
  { multiple: 2, gain: 0.3, decay: 3.1 },
  { multiple: 3, gain: 0.11, decay: 4.6 },
  { multiple: 4, gain: 0.04, decay: 6.2 },
];

/** The four-note figure, then silence — the motif the loop repeats. */
function recipe() {
  const ONSET = [0.10, 0.42, 0.74, 1.12];
  return {
    seconds: SECONDS,
    partials: PARTIALS,
    attack: 0.012,
    notes: ONSET.map((at, index) => ({ at, freq: PITCH[index], vel: VELOCITY[index] })),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'assets', 'ringtone.wav');
const samples = render(recipe());
const { buffer, peak } = encode(samples);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, buffer);
const info = await stat(target);
console.log(`assets/ringtone.wav  ${info.size} bytes  ${SECONDS}s @ ${SAMPLE_RATE} Hz mono 16-bit`);
console.log(`peak ${peak.toFixed(4)} = ${dbfs(peak).toFixed(1)} dBFS  ${peak >= 1 ? 'CLIPPING' : '(headroom ok)'}`);
console.log(`loud ${dbfs(loudWindow(samples)).toFixed(1)} dBFS (loudest 300 ms window)`
  + (TARGET_LOUD > 0 ? `, capped at ${dbfs(TARGET_LOUD).toFixed(1)}` : ', uncapped'));
