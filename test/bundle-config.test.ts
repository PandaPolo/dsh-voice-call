/**
 * The shipped bundle layer against the plugin's own defaults.
 *
 * `cordis.patch.yml` at the package root is not a sample: `package.json` lists it
 * under `files` and declares it as `dsh.bundle.patch`, so it is the config a
 * fresh install *receives* — and a value written there outranks the schema's
 * `.default()`, because the loader hands it to `apply()` instead of a gap.
 *
 * That is how "the default is the call card" could be true in `src/index.ts` and
 * false on a real machine at the same time. The patch pinned `callMode: ask`, the
 * first install anyone outside the author's own box ran rang the modal prompt, and
 * the suite stayed green the whole time (289 cases at that release) — no test had
 * ever read the two against each other. The same drift is one baseline flip, or one
 * more field added to the patch, away from happening again, which is why this file
 * checks *every* scalar the patch pins, not just `callMode`.
 *
 * The parse is line-based rather than through a YAML library on purpose: `yaml`
 * is only present as a transitive host dependency, and naming one the host does
 * not guarantee is the rule `src/plain.ts:12-17` states for the same reason.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Config } from '../src/index.ts';
import { plainConfig } from '../src/plain.ts';
import { resolveConfig } from '../src/types.ts';
import { defaultAudioDir, resolveAudioDir } from '../src/audio.ts';

/** The shipped bundle layer, read from the package root next to this test. */
const PATCH_FILE = new URL('../cordis.patch.yml', import.meta.url);

/** The fields a fresh install must be told about explicitly (delete one = fail). */
const PINNED = ['stt', 'tts', 'readReplies', 'durableEvents', 'callMode', 'audioDir'] as const;

/**
 * The `config:` block of the plugin row, as plain JSON values.
 *
 * Only one level deep, and only the keys the row pins: this file needs the patch
 * to be legible enough to compare, not a YAML implementation. Inline `{}` is a
 * real value here (an empty engine block means "auto-select"), numbers and
 * booleans are typed, everything else stays the string the profile holds.
 */
function pinnedConfig(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*config:\s*$/.test(line));
  assert.ok(start >= 0, 'the shipped patch has no `config:` block to compare');
  const indent = lines[start]!.match(/^\s*/)![0].length;
  const found: Record<string, unknown> = {};
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const lead = line.match(/^\s*/)![0].length;
    // The first line that is not deeper than `config:` ends the block.
    if (lead <= indent) break;
    const entry = line.match(/^\s*([A-Za-z][\w]*):\s*(\S.*)?$/);
    if (entry === null) break;
    found[entry[1]!] = scalar(entry[2]?.trim() ?? '');
  }
  return found;
}

/** Type one YAML scalar the way the loader would hand it to the plugin. */
function scalar(raw: string): unknown {
  if (raw === '{}') return {};
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** Every patch value the plugin would not have chosen anyway, as `key: want/got`. */
function drifts(patch: Record<string, unknown>): string[] {
  // What the plugin resolves when the profile mentions nothing.
  const resolved = resolveConfig(undefined) as unknown as Record<string, unknown>;
  const bad: string[] = [];
  for (const [key, pinned] of Object.entries(patch)) {
    // `audioDir` is the one field whose absence means something else: the schema
    // leaves it empty and `resolveAudioDir` owns the `~/.dsh/voice` fallback, so
    // the patch's literal is compared against where that actually lands.
    if (key === 'audioDir') {
      const want = defaultAudioDir();
      const got = resolveAudioDir(String(pinned));
      if (got !== want) bad.push(`audioDir: patch expands to ${got}, the code defaults to ${want}`);
      continue;
    }
    try {
      assert.deepEqual(pinned, resolved[key]);
    } catch {
      bad.push(`${key}: patch pins ${JSON.stringify(pinned)}, the plugin defaults to ${JSON.stringify(resolved[key])}`);
    }
  }
  return bad;
}

/**
 * The host's own view of the schema defaults (`~standard.validate` fills them).
 *
 * Detached through `plainConfig` because it does not return plain values for a
 * `.volatile()` field: `callMode` comes back as the cosmokit reference the loader
 * hands `apply()`. Comparing that against the patch would be a test that passes
 * for the wrong reason — the same trap `src/plain.ts` exists for.
 */
function schemaDefaults(): Record<string, unknown> {
  const result = (Config['~standard'].validate({}) as { value?: unknown }).value;
  assert.ok(result !== undefined && typeof result === 'object', 'the host cannot resolve an empty config');
  return plainConfig(result) as Record<string, unknown>;
}

const patch = pinnedConfig(readFileSync(PATCH_FILE, 'utf8'));

describe('the shipped bundle layer', () => {
  it('pins every field a fresh install needs', () => {
    for (const key of PINNED) {
      assert.ok(key in patch, `cordis.patch.yml no longer pins ${key}, so this file stopped comparing it`);
    }
  });

  it('agrees with the plugin defaults on every field it pins', () => {
    assert.deepEqual(drifts(patch), [], 'a value in cordis.patch.yml outranks the schema default — keep them equal');
  });

  it('rings the call card on a first install', () => {
    // The three places a fresh install could get its ring from, checked as one
    // chain: the patch (what ships), the schema (what an absent field becomes),
    // and `resolveConfig` (what the tools actually read).
    assert.equal(patch.callMode, 'card');
    assert.equal(schemaDefaults().callMode, 'card');
    assert.equal(resolveConfig(undefined).callMode, 'card');
  });

  it('lets the card degrade instead of refusing when no client is connected', () => {
    // `card` is only a safe default because the channel falls back to the prompt.
    // A config that says `card` must still resolve to `card` — the degradation
    // lives in `src/channels/callcard.ts`, not in the config layer, and this
    // pins that division of labour.
    assert.equal(resolveConfig({ callMode: 'card' }).callMode, 'card');
    assert.equal(resolveConfig({}).callMode, 'card', 'an empty profile block keeps the shipped default');
  });

  it('would have caught the drift this file exists for', () => {
    // The guard bites: this is the patch as it shipped, with `callMode` left at
    // the old value while the schema moved. No assertion below can pass unless a
    // mismatch is really reported.
    const drifted = drifts({ ...patch, callMode: 'ask' });
    assert.ok(drifted.some((line) => line.startsWith('callMode:')), `mutating callMode did not register: ${drifted}`);
    const movedRoot = drifts({ ...patch, audioDir: 'D:\\somewhere\\else' });
    assert.ok(movedRoot.some((line) => line.startsWith('audioDir:')), 'a hand-pinned audio root must also register');
    const flipped = drifts({ ...patch, readReplies: true });
    assert.ok(flipped.some((line) => line.startsWith('readReplies:')), 'a pinned true against a false default registers');
    assert.ok(!flipped.some((line) => line.startsWith('callMode:')), 'and it reports only what actually moved');
  });
});
