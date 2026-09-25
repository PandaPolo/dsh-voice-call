/**
 * The 运行环境 card's content, checked without a browser: the byte strings, the
 * clamped percentages, and the words on the button the user is about to press.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanupAction, cleanupSummary, defaultSelection, formatBytes, formatEta, isDefaultSelection,
  pendingSteps, runtimeAction, runtimeNotice, runtimeRows, usageLine,
} from '../src/client/runtime-model.ts';
import type { DiskUsage, ProvisionView, StepView } from '../src/client/provision-api.ts';

function step(over: Partial<StepView> & { id: StepView['id']; status: StepView['status'] }): StepView {
  return {
    label: over.id, totalBytes: 1000, receivedBytes: 0, bytesPerSecond: 0, origin: '',
    manualRecommended: false, ...over,
  } as StepView;
}

function view(steps: StepView[], over: Partial<ProvisionView> = {}): ProvisionView {
  return {
    phase: 'unprepared', variantId: 'win-cpu', steps,
    remainingBytes: steps.reduce((sum, entry) => (entry.status === 'ready' ? sum : sum + entry.totalBytes - entry.receivedBytes), 0),
    receivedBytes: 0, updatedAt: 0, summary: '', ...over,
  };
}

describe('runtime card model', () => {
  it('formats sizes the way the card promises', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(-5), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(8_659_961), '8.3 MB');
    assert.equal(formatBytes(967_980_192), '923 MB');
    assert.equal(formatBytes(1_295_855_597), '1.2 GB');
    assert.equal(formatBytes(Number.NaN), '0 B');
  });

  it('only promises an ETA it can back with a sample', () => {
    assert.equal(formatEta(undefined), '');
    assert.equal(formatEta(0), '');
    assert.equal(formatEta(38), '剩约 38 秒');
    assert.equal(formatEta(202), '剩约 3 分钟');
    assert.equal(formatEta(7200), '剩约 2.0 小时');
  });

  it('names each row and clamps its bar into 0–100', () => {
    const rows = runtimeRows(view([
      step({ id: 'engine', status: 'ready', totalBytes: 8_659_961, receivedBytes: 8_659_961 }),
      step({ id: 'talker', status: 'downloading', totalBytes: 1000, receivedBytes: 412, bytesPerSecond: 2_750_000, origin: 'hf-mirror.com', remainingSeconds: 202 }),
      step({ id: 'codec', status: 'queued', totalBytes: 290_623_616 }),
    ]));
    assert.deepEqual(rows.map((row) => row.name), ['引擎', 'Talker 模型', 'Codec 模型']);
    assert.deepEqual(rows.map((row) => row.statusText), ['已就绪', '下载中', '未安装']);
    assert.equal(rows[1]?.percent, 41);
    assert.equal(rows[1]?.showBar, true);
    assert.equal(rows[0]?.showBar, false, 'a finished row does not draw a bar');
    assert.equal(rows[1]?.etaLabel, '剩约 3 分钟');
    assert.equal(rows[1]?.originLabel, '来自 hf-mirror.com');
    assert.equal(rows[2]?.originLabel, '', 'no origin yet, no claim about one');
    // A server that overshoots must not fill the bar past its own row.
    assert.equal(runtimeRows(view([step({ id: 'codec', status: 'downloading', totalBytes: 100, receivedBytes: 140 })]))[0]?.percent, 100);
    assert.equal(runtimeRows(view([step({ id: 'codec', status: 'queued', totalBytes: 0, receivedBytes: 0 })]))[0]?.percent, 0);
  });

  it('shows advice only where something went wrong, and always shows some', () => {
    // Precedence: the actionable advice wins, the raw reason is better than
    // nothing, and a row with neither still says the step did not finish.
    const raw = runtimeRows(view([step({ id: 'engine', status: 'failed', message: 'ghproxy.net 只有 41 KB/s' })]))[0];
    assert.equal(raw?.showAdvice, true);
    assert.equal(raw?.advice, 'ghproxy.net 只有 41 KB/s');
    const bare = runtimeRows(view([step({ id: 'engine', status: 'failed' })]))[0];
    assert.equal(bare?.advice, '装配未完成');
    const withAdvice = runtimeRows(view([step({ id: 'engine', status: 'cancelled', advice: '已取消，可续传', message: 'aborted' })]))[0];
    assert.equal(withAdvice?.advice, '已取消，可续传', 'advice outranks the raw message');
    assert.equal(runtimeRows(view([step({ id: 'engine', status: 'ready' })]))[0]?.showAdvice, false);
    assert.equal(runtimeRows(view([step({ id: 'engine', status: 'downloading', advice: '不该出现' })]))[0]?.showAdvice, false);
  });

  it('tells the user what the button will do, in bytes', () => {
    const fresh = view([
      step({ id: 'engine', status: 'queued', totalBytes: 8_659_961 }),
      step({ id: 'talker', status: 'queued', totalBytes: 967_980_192 }),
      step({ id: 'codec', status: 'queued', totalBytes: 290_623_616 }),
    ]);
    // The untouched selection is the probe's own answer, so the press is a
    // one-click deploy; the bytes still have to be in the label.
    assert.equal(runtimeAction(fresh, false).label, '一键部署 · 1.2 GB');
    assert.equal(runtimeAction(fresh, false, false, false).label, '安装选定的 3 项 · 1.2 GB');
    assert.equal(runtimeAction(fresh, true).disabled, true, 'no double-submit while a write is in flight');
    assert.equal(runtimeAction(view([step({ id: 'engine', status: 'ready' })]), false).label, '重新检查');
    const running = runtimeAction(view([step({ id: 'engine', status: 'downloading' })], { phase: 'preparing' }), false);
    assert.equal(running.label, '取消');
    assert.equal(running.cancelling, true);
  });

  it('does not tell a working hand-configured engine that it is missing', () => {
    const missing = view([
      step({ id: 'engine', status: 'queued', totalBytes: 8_659_961 }),
      step({ id: 'talker', status: 'queued', totalBytes: 967_980_192 }),
    ]);
    assert.equal(runtimeAction(missing, false, false, false).label, '安装选定的 2 项 · 931 MB');
    // Same root state, but the plugin can already speak from configured paths.
    assert.equal(runtimeAction(missing, false, true).label, '一键部署到 voice 目录 · 931 MB',
      'a working install is never called missing, and the press is still one click');
    assert.equal(runtimeAction(missing, false, true, false).label, '安装选定的 2 项 · 931 MB',
      'once a dropdown has been moved, the press is a choice, not a default');
    assert.match(runtimeNotice(missing, true), /已经能用/);
    assert.equal(runtimeNotice(missing, false), '', 'no notice when the root is the only source');
    assert.match(runtimeNotice(view([step({ id: 'engine', status: 'ready' })]), true), /已经装好/);
  });

  it('knows an untouched selection from a steered one', () => {
    const base = { variantId: 'win-vulkan', talkerFile: 'small.gguf', codecQuant: 'q8_0', policy: 'auto' };
    // Nothing picked yet — the card seeds these from the server, and an empty
    // selection means the same thing as the seed.
    assert.equal(isDefaultSelection({}, base), true);
    assert.equal(isDefaultSelection({ variantId: 'win-vulkan', codecQuant: 'q8_0', policy: 'auto' }, base), true);
    assert.equal(isDefaultSelection({ talkerFile: 'big.gguf' }, base), false);
    assert.equal(isDefaultSelection({ variantId: 'win-cuda' }, base), false);
    assert.equal(isDefaultSelection({ codecQuant: 'f16' }, base), false);
    // A different download source is a different decision, even if the files are
    // the same ones — 一键部署 promises "I chose for you", and this person did.
    assert.equal(isDefaultSelection({ policy: 'cn' }, base), false);
    // The baseline is the server's, not a rule copied here: a machine whose root
    // holds the 1.7B talker is untouched at *that* file.
    assert.equal(isDefaultSelection({ talkerFile: 'big.gguf' }, { ...base, talkerFile: 'big.gguf' }), true);
  });


  it('shows the clean affordance only when there is something to reclaim', () => {
    const usage = (bytes: Record<string, number>, busy = false): DiskUsage => ({
      root: 'C:\\Users\\j\\.dsh\\voice',
      busy,
      totalBytes: Object.values(bytes).reduce((sum, value) => sum + value, 0),
      groups: (['engine', 'models', 'cache'] as const).map((id) => ({
        id, label: id === 'engine' ? '引擎' : id === 'models' ? '模型' : '下载缓存',
        path: `root/${id}`, bytes: bytes[id] ?? 0, entries: (bytes[id] ?? 0) > 0 ? 1 : 0, present: (bytes[id] ?? 0) > 0,
      })),
    });
    assert.equal(cleanupAction(undefined, false).visible, false, 'no report, no button');
    assert.equal(cleanupAction(usage({}), false).visible, false, 'an empty root must not offer to delete 0 B');
    assert.equal(cleanupAction(usage({ engine: 37_251_389, models: 967_980_192 }), false).label,
      '清理本地文件', 'the size belongs to the line beside it, not inside the label');
    assert.equal(usageLine(usage({ engine: 37_251_389, models: 967_980_192 })),
      'voice 目录当前占用 959 MB', 'the same binary units the rows use, not decimal MB');
    assert.equal(usageLine(usage({})), '', 'an empty root says nothing about its footprint');
    const busy = cleanupAction(usage({ engine: 1024 }), true);
    assert.equal(busy.disabled, true, 'a download in flight is refused, not hidden — the reason must be readable');
    assert.match(busy.label, /下载中/);
  });

  it('says what a clean will cost before it is confirmed', () => {
    const usage: DiskUsage = {
      root: 'R', busy: false, totalBytes: 3 * 1024 + 2 * 1024,
      groups: [
        { id: 'engine', label: '引擎', path: 'R/engine', bytes: 3 * 1024, entries: 1, present: true },
        { id: 'models', label: '模型', path: 'R/models', bytes: 2 * 1024, entries: 1, present: true },
        { id: 'cache', label: '下载缓存', path: 'R/downloads', bytes: 0, entries: 0, present: false },
      ],
    };
    assert.equal(cleanupSummary(usage, []), '没有选中任何一项');
    const line = cleanupSummary(usage, ['engine', 'models', 'cache']);
    assert.match(line, /引擎 3\.0 KB · 模型 2\.0 KB/);
    assert.equal(line.includes('下载缓存'), false, 'an absent group is not something being deleted');
    assert.match(line, /共 5\.0 KB/);
    assert.match(line, /重新下载/, 'the consequence belongs in the confirmation, not after it');
  });

  it('pre-ticks a clean for the situation, not for every situation', () => {
    const usage: DiskUsage = {
      root: 'R', busy: false, totalBytes: 4 * 1024,
      groups: [
        { id: 'engine', label: '引擎', path: 'R/engine', bytes: 3 * 1024, entries: 1, present: true },
        { id: 'models', label: '模型', path: 'R/models', bytes: 0, entries: 0, present: false },
        { id: 'cache', label: '下载缓存', path: 'R/downloads', bytes: 1 * 1024, entries: 1, present: true },
      ],
    };
    assert.deepEqual(defaultSelection(usage, false), ['engine', 'cache']);
    // A runtime that works from paths the user wrote elsewhere: ticking the
    // engine box would let one click break the voice they are listening to.
    assert.deepEqual(defaultSelection(usage, true), ['cache']);
  });

  it('counts what is left without counting what is already on disk', () => {
    const mixed = view([
      step({ id: 'engine', status: 'ready', totalBytes: 8_659_961, receivedBytes: 8_659_961 }),
      step({ id: 'talker', status: 'failed', totalBytes: 967_980_192, receivedBytes: 1000 }),
      step({ id: 'codec', status: 'cancelled', totalBytes: 290_623_616, receivedBytes: 500 }),
    ]);
    assert.deepEqual(pendingSteps(mixed).map((step2) => step2.id), ['talker', 'codec']);
    assert.equal(pendingSteps(view([step({ id: 'engine', status: 'ready' })])).length, 0);
  });
});
