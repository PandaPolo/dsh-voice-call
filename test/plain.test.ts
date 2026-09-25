/**
 * Config-read units: `plainConfig` detaching the live references the 0.1.7
 * loader puts on `.volatile()` fields, so a settings change reaches the next
 * read instead of the next remount.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { plainConfig } from '../src/plain.ts';
import { voiceConfigSource } from '../src/settings.ts';

/** The brand cosmokit stamps writable references with (`Symbol.for`, shared). */
const WRITE = Symbol.for('cosmokit.volatile.write');

/** A stand-in for a parsed volatile field: a frozen `{ get, [WRITE] }`. */
function ref(value: unknown) {
  let current = value;
  return Object.freeze({
    get: () => current,
    [WRITE]: (next: unknown) => { current = next; },
  });
}

describe('plainConfig', () => {
  it('replaces a reference with its current snapshot', () => {
    assert.equal(plainConfig(ref('dylan')), 'dylan');
  });

  it('walks nested objects and arrays but leaves plain data alone', () => {
    const shape = { tts: { voice: ref('eric'), rate: 180 }, list: [ref(1), 2], bare: 'x' };
    assert.deepEqual(plainConfig(shape), { tts: { voice: 'eric', rate: 180 }, list: [1, 2], bare: 'x' });
  });

  it('does not mistake a service-shaped object for a reference', () => {
    const notARef = { get: () => 'shadowed', other: 1 };
    assert.deepEqual(plainConfig(notARef), { get: notARef.get, other: 1 });
  });

  it('passes undefined through (an absent config never throws)', () => {
    assert.equal(plainConfig(undefined), undefined);
  });
});

describe('voiceConfigSource', () => {
  it('re-reads volatile fields on every call and applies documented defaults', () => {
    const entry = { tts: { voice: ref('dylan'), rate: ref(160) } };
    const current = voiceConfigSource(entry as never);
    assert.equal(current().tts?.voice, 'dylan');
    // The settings UI writes through the same reference the plugin holds.
    entry.tts.voice[WRITE]('serena');
    assert.equal(current().tts?.voice, 'serena');
    assert.equal(current().readReplies, false, 'unset scalars keep their resolved default');
  });

  it('resolves an empty config to the documented baseline', () => {
    const current = voiceConfigSource(undefined);
    assert.equal(current().callMode, 'ask');
    // An unset `audioDir` stays empty here; `resolveAudioDir` owns the
    // `~/.dsh/voice` fallback so the home directory is resolved once, at mount.
    assert.equal(current().audioDir, '');
  });
});
