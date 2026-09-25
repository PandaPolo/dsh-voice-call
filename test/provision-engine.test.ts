/**
 * The merge rule: a hand-written config outranks the provisioned root, and the
 * root only fills the holes. This is the guarantee that upgrading the plugin
 * cannot silently move a working install onto different files — and, since the
 * 1.7B port arrived, that the engine backend travels with the model needing it
 * rather than being a second thing to keep in step by hand.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { engineReady, readInstalledModels, readProvisionedEngine, withProvisionedEngine } from '../src/provision/engine.ts';
import type { ProvisionedEngine } from '../src/provision/engine.ts';
import { resolveConfig } from '../src/types.ts';
import type { VoiceConfig } from '../src/types.ts';
import { ENGINE_TAG, MODEL_ASSETS, engineVariantById } from '../src/provision/manifest.ts';
import { STATE_VERSION, provisionLayout, writeRecord } from '../src/provision/layout.ts';
import { crispasrArgv } from '../src/backends/crispasr.ts';

const installed: ProvisionedEngine = {
  bin: '/opt/voice/engine/win-cpu/crispasr.exe',
  model: '/opt/voice/models/talker.gguf',
  codec: '/opt/voice/models/codec.gguf',
  backend: 'qwen3-tts-customvoice',
  variant: engineVariantById('win-cpu')!,
};

function configured(over?: { bin?: string; model?: string; codec?: string; backend?: string }): VoiceConfig {
  return resolveConfig(over === undefined ? undefined : { tts: { crispasr: over } });
}

describe('provisioned engine resolution', () => {
  it('leaves an untouched config alone when nothing is provisioned', () => {
    const config = configured();
    assert.equal(withProvisionedEngine(config, undefined), config);
  });

  it('fills every hole from the root when the config names no paths', () => {
    const merged = withProvisionedEngine(configured(), installed);
    assert.equal(merged.tts.crispasr?.bin, installed.bin);
    assert.equal(merged.tts.crispasr?.model, installed.model);
    assert.equal(merged.tts.crispasr?.codec, installed.codec);
    assert.equal(engineReady(merged), true);
  });

  it('keeps a hand-written path in front of the provisioned one, field by field', () => {
    const own = configured({ bin: 'D:\\crispasr\\crispasr.exe' });
    const merged = withProvisionedEngine(own, installed);
    assert.equal(merged.tts.crispasr?.bin, 'D:\\crispasr\\crispasr.exe', 'a working install must not be moved');
    // The models it never named still come from the root, so the triple is usable.
    assert.equal(merged.tts.crispasr?.model, installed.model);
    assert.equal(merged.tts.crispasr?.codec, installed.codec);
  });

  it('prefers a fully hand-configured install and changes nothing', () => {
    const own = configured({ bin: 'D:\\crispasr\\crispasr.exe', model: 'D:\\tts\\a.gguf', codec: 'D:\\tts\\b.gguf' });
    const merged = withProvisionedEngine(own, installed);
    assert.equal(merged.tts.crispasr?.bin, 'D:\\crispasr\\crispasr.exe');
    assert.equal(merged.tts.crispasr?.model, 'D:\\tts\\a.gguf');
    assert.equal(merged.tts.crispasr?.codec, 'D:\\tts\\b.gguf');
    assert.equal(merged, own, 'a config that needed no merge is returned by identity, not copied');
  });

  it('moves the engine backend together with the model that needs it', () => {
    const big: ProvisionedEngine = { ...installed, model: '/opt/voice/models/1.7b.gguf', backend: 'qwen3-tts-1.7b-customvoice' };
    // Model from the root ⇒ its backend comes along; they are one decision.
    const merged = withProvisionedEngine(configured(), big);
    assert.equal(merged.tts.crispasr?.model, big.model);
    assert.equal(merged.tts.crispasr?.backend, 'qwen3-tts-1.7b-customvoice');
    // A hand-written model with no backend keeps the 0.6B default, because every
    // config written before this field existed names exactly that pipeline.
    const own = configured({ model: 'D:\\tts\\0.6b.gguf' });
    assert.equal(withProvisionedEngine(own, big).tts.crispasr?.backend, undefined);
    // An explicit backend always wins, whichever model it is paired with.
    const explicit = configured({ model: 'D:\\tts\\1.7b.gguf', backend: 'qwen3-tts-1.7b-customvoice' });
    assert.equal(withProvisionedEngine(explicit, installed).tts.crispasr?.backend, 'qwen3-tts-1.7b-customvoice');
    assert.equal(withProvisionedEngine(explicit, installed).tts.crispasr?.model, 'D:\\tts\\1.7b.gguf');
  });

  it('resolves a root holding a non-default talker, with that talker backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsvc-pair-'));
    try {
      const layout = provisionLayout(root);
      const big = MODEL_ASSETS.find((asset) => asset.role === 'talker' && asset.file.includes('1.7b-customvoice-q8_0'));
      const codec = MODEL_ASSETS.find((asset) => asset.role === 'codec' && asset.default);
      const variant = engineVariantById('win-cpu');
      assert.ok(big !== undefined && codec !== undefined && variant !== undefined);
      await writeRecord(layout, {
        version: STATE_VERSION,
        engineVariant: variant.id,
        engineTag: ENGINE_TAG,
        engineBinary: layout.engineBinaryPath(variant),
        assets: [
          { role: 'engine', file: variant.id, bytes: variant.bytes, sha256: variant.sha256, path: 'engine/win-cpu', origin: 'test', installedAt: 0 },
          { role: 'talker', file: big.file, bytes: big.bytes, sha256: big.sha256, path: join('models', big.file), origin: 'test', installedAt: 0 },
          { role: 'codec', file: codec.file, bytes: codec.bytes, sha256: codec.sha256, path: join('models', codec.file), origin: 'test', installedAt: 0 },
        ],
      });
      // Sizes are pretended: the real weights are 2 GB and 277 MB and a unit test
      // must not write either. The record, the lookup and the backend choice all
      // run the production way.
      const sizes = new Map<string, number>([
        [layout.engineBinaryPath(variant), 1_000],
        [layout.modelPath(big), big.bytes],
        [layout.modelPath(codec), codec.bytes],
      ]);
      const engine = await readProvisionedEngine(layout, async (path) => sizes.get(path) ?? 0);
      assert.ok(engine !== undefined, 'a root holding the 1.7B weights must be recognised, not only the default one');
      assert.equal(engine.model, layout.modelPath(big));
      assert.equal(engine.backend, 'qwen3-tts-1.7b-customvoice');

      // The pairing has to survive into the argv the engine is actually run with.
      const merged = withProvisionedEngine(resolveConfig(undefined), engine);
      assert.equal(merged.tts.crispasr?.backend, 'qwen3-tts-1.7b-customvoice');
      const argv = crispasrArgv({
        bin: merged.tts.crispasr?.bin ?? '', model: merged.tts.crispasr?.model ?? '', codec: merged.tts.crispasr?.codec ?? '',
        backend: merged.tts.crispasr?.backend,
      }, { text: 'x', voice: 'aiden' }, 'o.wav');
      assert.deepEqual(argv.slice(1, 3), ['--backend', 'qwen3-tts-1.7b-customvoice']);
      assert.equal(argv[4], layout.modelPath(big));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the models a half-built root holds, even when it is not an engine', async () => {
    // `readProvisionedEngine` answers undefined here — no binary, so nothing to
    // run. The *plan* still has to know the weights are sitting in the folder, or
    // it offers to re-download a 1.9 GB talker that is already installed.
    const root = await mkdtemp(join(tmpdir(), 'dsvc-models-'));
    try {
      const layout = provisionLayout(root);
      const big = MODEL_ASSETS.find((asset) => asset.role === 'talker' && asset.file.includes('1.7b-customvoice-q8_0'));
      assert.ok(big !== undefined);
      await writeRecord(layout, {
        version: STATE_VERSION,
        assets: [{
          role: 'talker', file: big.file, bytes: big.bytes, sha256: big.sha256,
          path: join('models', big.file), origin: 'test', installedAt: 0,
        }],
      });
      const sizes = new Map<string, number>([[layout.modelPath(big), big.bytes]]);
      const models = await readInstalledModels(layout, async (path) => sizes.get(path) ?? 0);
      assert.equal(models.talker?.file, big.file);
      assert.equal(models.codec, undefined, 'an unfilled role stays unfilled rather than falling back');
      sizes.set(layout.modelPath(big), big.bytes - 1);
      assert.equal((await readInstalledModels(layout, async (path) => sizes.get(path) ?? 0)).talker, undefined,
        'a truncated file is not an installed model');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not call an engine binary without its models a usable engine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsvc-pair2-'));
    try {
      const layout = provisionLayout(root);
      const variant = engineVariantById('win-cpu');
      assert.ok(variant !== undefined);
      await writeRecord(layout, {
        version: STATE_VERSION,
        engineVariant: variant.id,
        engineTag: ENGINE_TAG,
        engineBinary: layout.engineBinaryPath(variant),
        assets: [],
      });
      const sizes = new Map<string, number>([[layout.engineBinaryPath(variant), 1_000]]);
      assert.equal(await readProvisionedEngine(layout, async (path) => sizes.get(path) ?? 0), undefined,
        'selecting a backend then failing on the first call is worse than staying unavailable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not mutate the config it was handed', () => {
    const own = configured();
    const before = JSON.stringify(own.tts.crispasr);
    withProvisionedEngine(own, installed);
    assert.equal(JSON.stringify(own.tts.crispasr), before);
  });

  it('reports an incomplete triple as not ready', () => {
    assert.equal(engineReady(configured({ bin: 'x' })), false);
    assert.equal(engineReady(configured({ bin: 'x', model: 'y' })), false);
    assert.equal(engineReady(configured({ bin: 'x', model: 'y', codec: 'z' })), true);
  });
});
