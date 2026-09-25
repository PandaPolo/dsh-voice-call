/**
 * The tone table against the package on disk.
 *
 * `src/client/tones.ts` is the only thing standing between a user-chosen id and
 * `readFile`, so the two directions of agreement are both checked: an entry whose
 * file is missing would make the route 404 and the card silently stop ringing, and
 * a WAV on disk that no entry names is dead weight in every tarball. The size
 * ceiling is here for the same reason the picker exists — eleven ringtones are
 * 1.7 MB, which is fine, and a future sixth "just add one more" habit is how an
 * install ends up shipping 20 MB of sound nobody chose.
 */
import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DEFAULT_TONE, TONES, TONE_IDS, toneById } from '../src/client/tones.ts';

/** The total the `assets/` ringtones may weigh together, in bytes. */
const PACKAGE_BUDGET = 2_500_000;

const asset = (file: string): URL => new URL(`../assets/${file}`, import.meta.url);

describe('the tone table', () => {
  it('names a real WAV for every entry', async () => {
    for (const tone of TONES) {
      const info = await stat(asset(tone.file)).catch(() => undefined);
      assert.ok(info !== undefined && info.isFile(), `${tone.id} points at ${tone.file}, which is not in the package`);
      assert.ok(info.size > 44, `${tone.id} is not an empty file`);
      assert.ok(info.size < 300_000, `${tone.id} is ${info.size} bytes; a ringtone is a few seconds, not a song`);
    }
  });

  it('leaves no ringtone on disk that the UI cannot reach', async () => {
    const onDisk = (await readdir(asset('ringtones'))).filter((name) => name.endsWith('.wav'));
    const named = TONES.filter((tone) => tone.file.startsWith('ringtones/')).map((tone) => tone.file.slice('ringtones/'.length));
    assert.equal(named.length, TONES.length - 1, 'every entry but the default lives under ringtones/');
    assert.deepEqual(onDisk.sort(), [...named].sort(), 'the folder and the dropdown must hold the same files');
  });

  it('stays inside the package budget', async () => {
    const sizes = await Promise.all(TONES.map(async (tone) => (await stat(asset(tone.file))).size));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    assert.ok(total < PACKAGE_BUDGET, `the ringtones weigh ${total} bytes`);
  });

  it('is a table of distinct, sayable choices', () => {
    assert.equal(new Set(TONE_IDS).size, TONE_IDS.length, 'ids are unique');
    assert.equal(TONE_IDS[0], DEFAULT_TONE, 'the first entry is the one an untouched install gets');
    for (const tone of TONES) {
      assert.ok(tone.label.length > 0 && tone.label.length <= 8, `${tone.id}: a dropdown label is a few characters`);
      assert.ok(tone.hint.length > 10, `${tone.id} needs a hint that says why to pick it`);
    }
  });

  it('resolves anything it does not know to the shipped default', () => {
    assert.equal(toneById(undefined).id, DEFAULT_TONE);
    assert.equal(toneById('../../package.json').id, DEFAULT_TONE);
    assert.equal(toneById('Kalimba').id, DEFAULT_TONE, 'ids are case-sensitive, and a near-miss still rings');
    assert.equal(toneById('kalimba').file, 'ringtones/kalimba.wav');
  });
});
