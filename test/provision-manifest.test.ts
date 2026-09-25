/**
 * The manifest's invariants — including the ones that encode the measured
 * network reality, so a future edit that quietly reintroduces "just use GitHub"
 * fails here rather than on a user's first run.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ENGINE_TAG, ENGINE_VARIANTS, GH_PROXY_PRESETS, MODEL_ASSETS, DEFAULT_SOURCE,
  buildPlan, candidatesFor, defaultModels, engineUrl, estimateSeconds, formatBytes, formatDuration,
  manualRecommended, modelUrl, planBytes, recommendedVariant, rewriteHost, suggestVariants, talkerOptions,
} from '../src/provision/manifest.ts';
import type { DeviceHint, EngineVariant, ModelAsset } from '../src/provision/manifest.ts';

const HEX64 = /^[0-9a-f]{64}$/;

/** One pinned asset, checked the way an installer has to trust it. */
function assertPinned(entry: { readonly bytes: number; readonly sha256: string }, name: string): void {
  assert.match(entry.sha256, HEX64, `${name}: sha256 must be 64 lowercase hex`);
  assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0, `${name}: bytes must be a positive integer`);
}

describe('provision manifest', () => {
  it('pins every engine build with a real digest and a unique identity', () => {
    assert.ok(ENGINE_VARIANTS.length >= 6);
    const files = new Set<string>();
    for (const variant of ENGINE_VARIANTS) {
      assertPinned(variant, variant.id);
      assert.equal(variant.file.includes('/'), false);
      assert.equal(variant.file.includes('..'), false);
      assert.ok(variant.binary.length > 0);
      assert.ok(variant.note.length > 0, `${variant.id} needs a note: size is a decision, not a footnote`);
      assert.ok(!files.has(variant.file), `duplicate archive ${variant.file}`);
      files.add(variant.file);
    }
    assert.equal(new Set(ENGINE_VARIANTS.map((variant) => variant.id)).size, ENGINE_VARIANTS.length);
    for (const os of ['win32', 'darwin', 'linux'] as const) {
      const options = ENGINE_VARIANTS.filter((variant) => variant.os === os);
      assert.ok(options.length > 0, `${os} must have at least one build`);
      assert.ok(options.some((variant) => variant.gpu === 'none'), `${os} must offer a build that needs no accelerator`);
      const ranks = options.map((variant) => variant.rank);
      assert.equal(new Set(ranks).size, ranks.length, `ranks must be unique within ${os}`);
    }
  });

  it('pins exactly one default talker and one default codec', () => {
    for (const asset of MODEL_ASSETS) {
      assertPinned(asset, asset.file);
      assert.equal(asset.file.endsWith('.gguf'), true);
      assert.ok(asset.repo.startsWith('cstr/'), 'models come from the GGUF port author, not a re-uploader');
    }
    const pair = defaultPair();
    assert.equal(pair.talker.role, 'talker');
    assert.equal(pair.codec.role, 'codec');
    assert.match(pair.talker.file, /customvoice/, 'the backend this plugin drives is CustomVoice');
    assert.equal(MODEL_ASSETS.filter((asset) => asset.role === 'talker' && asset.default).length, 1);
    assert.equal(MODEL_ASSETS.filter((asset) => asset.role === 'codec' && asset.default).length, 1);
  });

  it('offers three talkers, each carrying the backend it needs', () => {
    const talkers = talkerOptions();
    assert.equal(talkers.length, 3, '0.6B q8_0, 1.7B q8_0, 1.7B f16');
    for (const asset of talkers) {
      assertPinned(asset, asset.file);
      assert.match(asset.backend, /^qwen3-tts/);
      assert.ok(asset.note.length > 8, 'a model choice without a size/quality note is a guess');
      assert.ok(asset.file.includes(asset.quant === 'q8_0' ? 'q8_0' : 'f16'), 'the label and the file agree');
    }
    // The pairing is the point of the field: a 1.7B file must never be driven by
    // the 0.6B backend, and the two 1.7B quants share one backend name.
    assert.equal(talkers.find((asset) => asset.file.includes('0.6b'))?.backend, 'qwen3-tts-customvoice');
    for (const asset of talkers.filter((entry) => entry.file.includes('1.7b'))) {
      assert.equal(asset.backend, 'qwen3-tts-1.7b-customvoice', asset.file);
      assert.equal(asset.repo, 'cstr/qwen3-tts-1.7b-customvoice-GGUF');
    }
    assert.equal(defaultModels().talker.default, true, 'the default stays the pair verified end to end');
    assert.equal(defaultModels().talker.bytes, 967_980_192);
  });

  it('closes every candidate list with the official URL, whatever the policy', () => {
    const github = engineUrl(ENGINE_VARIANTS[0] as EngineVariant);
    const huggingFace = modelUrl(MODEL_ASSETS[0] as ModelAsset);
    for (const url of [github, huggingFace]) {
      for (const policy of ['auto', 'cn', 'official', 'custom'] as const) {
        const list = candidatesFor(url, { ...DEFAULT_SOURCE, policy });
        assert.ok(list.length >= 1, `${policy} produced nothing`);
        assert.equal(new Set(list.map((entry) => entry.url)).size, list.length, `${policy} repeated a URL`);
        assert.equal(list[list.length - 1]?.url, url, `${policy} must end at the canonical URL`);
        assert.equal(list[list.length - 1]?.kind, 'official');
      }
    }
    // `official` is the no-detours setting, so it must name exactly one origin.
    assert.equal(candidatesFor(github, { policy: 'official' }).length, 1);
  });

  it('keeps Hugging Face traffic off the GitHub proxies and the other way round', () => {
    const github = engineUrl(ENGINE_VARIANTS[0] as EngineVariant);
    const huggingFace = modelUrl(MODEL_ASSETS[1] as ModelAsset);
    for (const entry of candidatesFor(github, { policy: 'cn' })) {
      assert.equal(entry.url.includes('hf-mirror.com'), false);
    }
    for (const entry of candidatesFor(huggingFace, { policy: 'cn' })) {
      assert.equal(/gh-proxy|ghproxy/.test(entry.url), false);
    }
    const first = candidatesFor(huggingFace, { policy: 'cn' })[0];
    assert.equal(first?.url.startsWith('https://hf-mirror.com/'), true, 'the mirror that measured 2.7 MB/s goes first');
  });

  it('prefers a working accelerator over a dead one, and never dead-ends on it', () => {
    const github = engineUrl(ENGINE_VARIANTS[0] as EngineVariant);
    const list = candidatesFor(github, { policy: 'cn' });
    const presets = GH_PROXY_PRESETS.map((preset) => preset.id);
    const accelerated = list.filter((entry) => entry.kind === 'proxy');
    assert.deepEqual(accelerated.map((entry) => entry.origin), presets);
    for (const preset of GH_PROXY_PRESETS) {
      const entry = accelerated.find((candidate) => candidate.origin === preset.id);
      assert.ok(entry !== undefined);
      // A prefix proxy is addressed by wrapping the canonical URL; a host-swap
      // proxy keeps only the path, which is what makes sibling assets reachable.
      assert.equal(entry.url.endsWith(github), preset.mode === 'prefix', `${preset.id} mode`);
    }
    // A prefix proxy cannot reach sibling assets, so the replace-host family must
    // not embed the canonical URL at all.
    const wrapped = candidatesFor(github, { policy: 'cn' }, 'replace-host').find((entry) => entry.origin === 'ghproxy.link');
    assert.ok(wrapped !== undefined);
    assert.equal(wrapped.url.includes(github), false);
    assert.equal(wrapped.url.startsWith('https://ghproxy.link/CrispStrobe/'), true);
  });

  it('ignores a malformed custom prefix instead of fetching nonsense', () => {
    const github = engineUrl(ENGINE_VARIANTS[0] as EngineVariant);
    for (const junk of ['ftp://nope', 'not a url', '', '   ']) {
      const list = candidatesFor(github, { policy: 'custom', proxyPrefix: junk });
      assert.equal(list.some((entry) => entry.origin === 'custom'), false, `junk prefix "${junk}" must contribute no candidate`);
      assert.equal(list[list.length - 1]?.url, github, 'a rejected prefix must still leave the official URL');
    }
    const custom = candidatesFor(github, { policy: 'custom', proxyPrefix: 'https://mirror.example.com/' });
    assert.equal(custom[0]?.url, `https://mirror.example.com/${github}`, 'the user mirror leads its own policy');
    assert.equal(custom[custom.length - 1]?.url, github, 'a stale prefix must degrade to upstream, not to nothing');
  });

  it('rewrites only the host, and only for a matching URL', () => {
    assert.equal(
      rewriteHost('https://huggingface.co/cstr/x/resolve/main/a.gguf', 'https://huggingface.co', 'https://hf-mirror.com'),
      'https://hf-mirror.com/cstr/x/resolve/main/a.gguf',
    );
    assert.equal(rewriteHost('https://example.com/a', 'https://huggingface.co', 'https://hf-mirror.com'), null);
    assert.equal(
      rewriteHost('https://huggingface.co/a', 'https://huggingface.co', 'https://mirror.example.com/'),
      'https://mirror.example.com/a', 'a trailing slash must not double up',
    );
  });

  it('never offers a build the machine cannot run', () => {
    const win: DeviceHint = { os: 'win32', arch: 'x64', gpu: 'cuda12' };
    const cudaOrder = suggestVariants(win).map((variant) => variant.id);
    assert.equal(cudaOrder[0], 'win-cuda', 'the self-contained CUDA build leads on a CUDA box');
    assert.ok(cudaOrder.indexOf('win-cuda') < cudaOrder.indexOf('win-cuda-non-cuda'), 'the needs-cuBLAS build is an opt-in, not the default');
    for (const hint of [{ os: 'win32', arch: 'x64', gpu: 'unknown' }, { os: 'win32', arch: 'x64', gpu: 'none' }, { os: 'win32', arch: 'x64', gpu: 'vulkan' }] as const) {
      const ids = suggestVariants(hint).map((variant) => variant.id);
      assert.equal(ids.includes('win-cuda'), false, `${hint.gpu} must not be offered a 693 MB CUDA bet`);
      assert.equal(ids[0], hint.gpu === 'vulkan' ? 'win-vulkan' : 'win-cpu');
    }
    assert.deepEqual(suggestVariants({ os: 'linux', arch: 'x64', gpu: 'vulkan' }).map((v) => v.id), ['linux-vulkan', 'linux-cpu']);
    assert.deepEqual(suggestVariants({ os: 'darwin', arch: 'arm64', gpu: 'cuda12' }).map((v) => v.id), ['mac-cpu']);
  });

  it('recommends what the machine can run, and lets a caller ask for what fits', () => {
    const cudaBox: DeviceHint = { os: 'win32', arch: 'x64', gpu: 'cuda12' };
    // Capability first: a 4090 owner is offered the CUDA build, with its size
    // and note shown — not a quieter engine chosen on their behalf.
    // The default never picks a build we would tell someone to download by
    // hand; CUDA stays first in the list, one deliberate click away.
    assert.equal(recommendedVariant(cudaBox)?.id, 'win-vulkan');
    assert.equal(suggestVariants(cudaBox)[0]?.id, 'win-cuda', 'the dropdown still leads with what the machine runs best');
    assert.equal(recommendedVariant(cudaBox, 800_000_000)?.id, 'win-cuda', 'a caller with a real ceiling gets CUDA back');
    assert.equal(recommendedVariant(cudaBox, 1)?.id, 'win-cuda', 'nothing fits: name the best, not nothing');
    assert.equal(recommendedVariant({ os: 'win32', arch: 'x64', gpu: 'none' })?.id, 'win-cpu');
    assert.equal(recommendedVariant({ os: 'win32', arch: 'x64', gpu: 'unknown' })?.id, 'win-cpu');
  });

  it('flags the downloads that should be handed to a browser, not a proxy', () => {
    assert.equal(manualRecommended(8_659_961), false);
    assert.equal(manualRecommended(37_251_389), false);
    assert.equal(manualRecommended(726_216_766), true);
    const cuda = ENGINE_VARIANTS.find((variant) => variant.id === 'win-cuda');
    assert.ok(cuda !== undefined && manualRecommended(cuda.bytes));
    assert.equal(new URL(engineUrl(cuda)).protocol, 'https:');
    assert.ok(engineUrl(cuda).includes(ENGINE_TAG));
  });

  it('plans exactly what the root is missing, and nothing else', () => {
    const { variant, talker, codec } = fixtures();
    const all = buildPlan({ variant, talker, codec, installed: {} });
    assert.deepEqual(all.map((step) => step.id), ['engine', 'talker', 'codec']);
    assert.equal(planBytes(all), variant.bytes + talker.bytes + codec.bytes);
    assert.equal(buildPlan({ variant, talker, codec, installed: { talker: { bytes: talker.bytes, sha256: talker.sha256 } } }).length, 2);
    assert.equal(buildPlan({ variant, talker, codec, installed: { talker: { bytes: talker.bytes - 1 } } }).length, 3, 'a wrong size is not installed');
    assert.equal(buildPlan({ variant, talker, codec, installed: { talker: { bytes: talker.bytes, sha256: 'f'.repeat(64) } } }).length, 3, 'a wrong digest is not installed');
    assert.equal(buildPlan({ variant, talker, codec, installed: { engine: { bytes: variant.bytes }, talker: { bytes: talker.bytes }, codec: { bytes: codec.bytes } } }).length, 0);
  });

  it('formats sizes and waits the way the card shows them', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(8_659_961), '8.3 MB');
    assert.equal(formatBytes(967_980_192), '923 MB');
    assert.equal(formatDuration(30), '约 30 秒');
    assert.equal(formatDuration(180), '约 3 分钟');
    assert.equal(formatDuration(7200), '约 2.0 小时');
    assert.equal(estimateSeconds(1000, 0), Number.POSITIVE_INFINITY, 'no sample, no promise');
    assert.equal(estimateSeconds(1000, 100), 10);
  });
});

function defaultPair(): { readonly talker: ModelAsset; readonly codec: ModelAsset } {
  const talker = MODEL_ASSETS.find((asset) => asset.role === 'talker' && asset.default);
  const codec = MODEL_ASSETS.find((asset) => asset.role === 'codec' && asset.default);
  assert.ok(talker !== undefined && codec !== undefined);
  return { talker, codec };
}

/** Tiny synthetic assets so a plan test does not depend on the pinned upstream sizes. */
function fixtures(): { readonly variant: EngineVariant; readonly talker: ModelAsset; readonly codec: ModelAsset } {
  const variant = ENGINE_VARIANTS[0] as EngineVariant;
  return {
    variant,
    talker: { ...(MODEL_ASSETS.find((asset) => asset.role === 'talker') as ModelAsset), bytes: 100, sha256: 'a'.repeat(64) },
    codec: { ...(MODEL_ASSETS.find((asset) => asset.role === 'codec') as ModelAsset), bytes: 50, sha256: 'b'.repeat(64) },
  };
}
