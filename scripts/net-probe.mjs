#!/usr/bin/env node
/**
 * Measure which provisioning origin this machine can actually use, against the
 * real candidate lists from `src/provision/manifest.ts`.
 *
 *   node scripts/net-probe.mjs                 # one 1 MB range probe per origin
 *   node scripts/net-probe.mjs --bytes 8388608 # a bigger sample (sustained rate)
 *   node scripts/net-probe.mjs --policy official
 *
 * It downloads a slice of each asset and writes nothing to disk. The point is
 * reproducibility: the ordering baked into the manifest came from a run of this
 * script, and a future run can say whether it still holds.
 */
import { parseArgs } from 'node:util';
import {
  ENGINE_VARIANTS, DEFAULT_SOURCE, candidatesFor, defaultModels, engineUrl, modelUrl,
} from '../src/provision/manifest.ts';

const { values: flags } = parseArgs({
  options: {
    bytes: { type: 'string', default: '1048576' },
    policy: { type: 'string', default: DEFAULT_SOURCE.policy },
    'max-time': { type: 'string', default: '15' },
  },
});

const SAMPLE = Number(flags.bytes);
const POLICY = flags.policy;
const MAX_MS = Number(flags['max-time']) * 1000;

/** Fetch a leading slice and report what it cost. */
async function probe(url) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_MS);
  let bytes = 0;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { range: `bytes=0-${SAMPLE - 1}` },
    });
    if (response.body === null) return { url, status: response.status, ms: Date.now() - started, bytes: 0 };
    for await (const chunk of response.body) bytes += chunk.byteLength ?? chunk.length;
    return { url, status: response.status, ms: Date.now() - started, bytes };
  } catch (error) {
    return { url, status: 0, ms: Date.now() - started, bytes, error: error instanceof Error ? error.name : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function line(label, result) {
  const seconds = result.ms / 1000;
  const rate = seconds > 0 ? result.bytes / 1048576 / seconds : 0;
  const verdict = result.bytes === 0 ? `✗ ${result.error ?? `HTTP ${result.status}`}` : `✓ ${rate.toFixed(2)} MB/s`;
  console.log(`  ${verdict.padEnd(18)} ${seconds.toFixed(1).padStart(5)}s ${(result.bytes / 1048576).toFixed(1).padStart(6)} MB  ${label}`);
  return result.bytes > 0 ? rate : 0;
}

const source = { ...DEFAULT_SOURCE, policy: POLICY };
const pair = defaultModels();
const groups = [
  ['引擎 · CPU（国内链路唯一的 GitHub 依赖）', engineUrl(ENGINE_VARIANTS.find((v) => v.id === 'win-cpu'))],
  ['引擎 · Vulkan', engineUrl(ENGINE_VARIANTS.find((v) => v.id === 'win-vulkan'))],
  ['Talker 模型', modelUrl(pair.talker)],
  ['Codec 模型', modelUrl(pair.codec)],
];

console.log(`policy=${POLICY} sample=${(SAMPLE / 1048576).toFixed(1)} MB cap=${MAX_MS / 1000}s node=${process.version}\n`);
for (const [label, url] of groups) {
  console.log(`${label}`);
  for (const candidate of candidatesFor(url, source)) {
    await line(`${candidate.origin} [${candidate.kind}]`, await probe(candidate.url));
  }
  console.log('');
}
console.log('manifest 的排序就是这张表的读法：第一个 ✓ 会用上，最后一个永远是官方地址。');
