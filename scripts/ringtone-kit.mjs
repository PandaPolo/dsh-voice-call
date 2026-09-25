/**
 * The synthesis kit behind the ringtone candidates. Deterministic on purpose:
 * the same recipe must produce the same bytes on any machine, so a chosen
 * ringtone can be regenerated and reviewed as a diff.
 *
 * Everything here is mono 22.05 kHz 16-bit normalised to a stated peak, which
 * is what `src/client/ringtone.ts` expects: the asset keeps its headroom and
 * the player alone decides loudness.
 */

export const SAMPLE_RATE = 22_050;
/** −3.3 dBFS, same as the shipped ringtone. */
export const TARGET_PEAK = 0.68;
/**
 * Loudness matching, OFF, and it is off because switching it on was the bug: a
 * first version trimmed every candidate down to the loudest-window loudness of
 * the quietest one, "so nobody is picked for being louder". It put 7 of the 11
 * files at peak 0.35–0.54 instead of 0.68 — 3 to 6 dB down — and with the card's
 * 0.45 player gain on top, those seven were inaudible on laptop speakers while
 * the four that kept their peak played. A ringtone nobody can hear is not a fair
 * comparison, it is a missing feature.
 *
 * So every file gets the same headroom (peak = TARGET_PEAK), and `loudWindow`
 * stays a *reported* number: a swell and a struck bar genuinely differ in
 * brightness, and that difference belongs in the recipe — a velocity or a decay —
 * not in a gain stage bolted onto the end.
 *
 * 0 disables the trim; anything above it caps the loudest 300 ms window.
 */
export const TARGET_LOUD = 0;

const TAU = Math.PI * 2;

/** MIDI note number → Hz. */
export const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** Amplitude → dBFS, silent input staying finite so a report can print it. */
export const dbfs = (value) => (value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY);

export function buffer(seconds) {
  return new Float64Array(Math.floor(seconds * SAMPLE_RATE));
}

/**
 * Additive voice. `partials` are `{ multiple, gain, decay }` triples whose
 * decay is what separates an object in a room from a tone generator: upper
 * partials must die faster than the fundamental.
 *
 * - `beat`: relative detune (0.005 ≈ 5 cents) added as a second copy of every
 *   partial → slow amplitude throb. This is a kalimba / bell "living" quality.
 * - `vibratoHz` + `vibratoDepth`: phase modulation, i.e. a human or bowed tone.
 * - `attack` / `release`: ramps in seconds; a slow attack is a swell, not a hit.
 */
export function tone(dst, at, dur, freq, vel, partials, opts = {}) {
  const length = Math.floor(dur * SAMPLE_RATE);
  const attack = Math.max(1, Math.floor((opts.attack ?? 0.012) * SAMPLE_RATE));
  const release = Math.max(1, Math.floor((opts.release ?? 0.02) * SAMPLE_RATE));
  const beat = opts.beat ?? 0;
  const vibHz = opts.vibratoHz ?? 0;
  const vibDepth = opts.vibratoDepth ?? 0;
  const mix = beat ? 0.5 : 1;
  for (let index = 0; index < length; index += 1) {
    const slot = at + index;
    if (slot >= dst.length) return;
    const t = index / SAMPLE_RATE;
    let env = Math.min(1, index / attack);
    if (index > length - release) env *= Math.max(0, (length - index) / release);
    const wobble = vibHz === 0 ? 0 : (vibDepth / vibHz) * Math.sin(TAU * vibHz * t);
    let wave = 0;
    for (const p of partials) {
      const amplitude = p.gain * Math.exp(-p.decay * t);
      const f = freq * p.multiple;
      wave += amplitude * Math.sin(TAU * f * (t + wobble));
      if (beat) wave += amplitude * Math.sin(TAU * f * (1 + beat) * (t + wobble));
    }
    dst[slot] += vel * mix * env * wave;
  }
}

/**
 * Karplus-Strong: a plucked string, built from a delay line instead of
 * harmonics, so it loses brightness as it decays the way a real string does.
 * `decay` is seconds to −60 dB, `brightness` (0–1) opens the loop lowpass.
 */
export function string(dst, at, dur, freq, vel, opts = {}) {
  const taps = Math.max(2, Math.round(SAMPLE_RATE / freq));
  const loss = Math.exp(Math.log(0.001) / (SAMPLE_RATE * (opts.decay ?? 1.2)));
  const bright = opts.brightness ?? 0.5;
  const width = Math.max(1, Math.round((opts.pick ?? 0.004) * SAMPLE_RATE));
  const excite = noise(taps + width);
  const line = new Float64Array(taps);
  // Comb-filtered noise burst: picking a string away from the nut.
  for (let i = 0; i < taps; i += 1) {
    let sum = 0;
    for (let k = 0; k < width; k += 1) sum += excite[(i + k) % excite.length] * (1 - k / width);
    line[i] = sum;
  }
  const length = Math.floor(dur * SAMPLE_RATE);
  let previous = 0;
  let cursor = 0;
  for (let index = 0; index < length; index += 1) {
    const slot = at + index;
    if (slot >= dst.length) return;
    const next = line[cursor];
    const filtered = (1 - bright) * 0.5 * (next + previous) + bright * next;
    line[cursor] = loss * filtered;
    previous = next;
    cursor = cursor + 1 >= taps ? 0 : cursor + 1;
    const ramp = Math.min(1, index / Math.max(1, Math.round(0.004 * SAMPLE_RATE)));
    dst[slot] += vel * ramp * next;
  }
}

/** Small deterministic PRNG — a rebuilt ringtone must not differ by noise. */
function noise(length, seed = 1) {
  const out = new Float64Array(length);
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (state / 0x3fffffff) - 1;
  }
  return out;
}

/** Render a recipe: notes → samples → loudness match → loop-safe edges. */
export function render(recipe, loudTarget = TARGET_LOUD) {
  const dst = buffer(recipe.seconds);
  const voices = { tone, string };
  // Recipe-level voicing (attack, beat, vibrato) applies to every note; a note
  // may override it, which is how a guitar gets one damping setting per string.
  const defaults = { attack: recipe.attack, release: recipe.release, beat: recipe.beat, vibratoHz: recipe.vibratoHz, vibratoDepth: recipe.vibratoDepth };
  for (const note of recipe.notes) {
    const start = Math.floor(note.at * SAMPLE_RATE);
    const voice = voices[note.voice ?? 'tone'];
    if (voice === undefined) throw new Error(`unknown voice ${note.voice}`);
    voice(dst, start, recipe.seconds - note.at, note.freq, note.vel ?? 1, note.partials ?? recipe.partials ?? [], { ...defaults, ...note });
  }
  let peak = 0;
  for (const value of dst) peak = Math.max(peak, Math.abs(value));
  if (peak > 0) for (let i = 0; i < dst.length; i += 1) dst[i] *= TARGET_PEAK / peak;
  // Peak alone is not loudness: a swell and a struck bar can share a peak and
  // differ by 9 dB over the ear. Match the loudest 300 ms window, and only ever
  // turn candidates *down* — a file that is quieter than the target is a mix
  // problem to fix in the recipe, not something to gain-stage into clipping.
  const loud = loudWindow(dst);
  const gain = loud > 0 && loudTarget > 0 ? Math.min(1, loudTarget / loud) : 1;
  if (gain !== 1) for (let i = 0; i < dst.length; i += 1) dst[i] *= gain;
  return edgeFades(dst);
}

/** RMS of the loudest sliding window, which is what "sounds louder" tracks. */
export function loudWindow(samples, seconds = 0.3) {
  const span = Math.max(1, Math.round(seconds * SAMPLE_RATE));
  if (samples.length < span) return 0;
  const prefix = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; i += 1) prefix[i + 1] = prefix[i] + samples[i] * samples[i];
  const step = Math.max(1, Math.round(span / 8));
  let best = 0;
  for (let end = span; end <= samples.length; end += step) {
    best = Math.max(best, (prefix[end] - prefix[end - span]) / span);
  }
  return Math.sqrt(best);
}

/** 5 ms in, 40 ms out: the card loops the file, and a step is a click. */
export function edgeFades(samples) {
  const inLen = Math.floor(0.005 * SAMPLE_RATE);
  const outLen = Math.floor(0.04 * SAMPLE_RATE);
  for (let i = 0; i < inLen; i += 1) samples[i] *= i / inLen;
  for (let i = 0; i < outLen; i += 1) samples[samples.length - 1 - i] *= i / outLen;
  return samples;
}

/** Canonical 16-bit mono PCM header plus the frames, and the peak actually seen. */
export function encode(samples) {
  const bytes = samples.length * 2;
  const out = Buffer.alloc(44 + bytes);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + bytes, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(bytes, 40);
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    peak = Math.max(peak, Math.abs(value));
    out.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(value * 32_767))), 44 + i * 2);
  }
  return { buffer: out, peak };
}
