/**
 * The provisioning runner: the state machine behind "点几个按钮", plus the
 * store the settings card subscribes to.
 *
 * Lifecycle of one run:
 *
 *   prepare(request) ──▶ phase `preparing`; every step the root still needs is
 *     │                  `queued` (what is already on disk shows as `ready`)
 *     ├── per pending step, serially:
 *     │     `downloading` ── progress ticks, origin rotation, `.part` resume
 *     │       ├─ verified ──▶ `installing` (engine only: unpack + locate binary)
 *     │       │                 ──▶ `ready`, record persisted
 *     │       ├─ cancelled ─▶ `cancelled`, run stops, `.part` kept for next time
 *     │       └─ failed ────▶ `failed` + the reason's advice, run stops
 *     └── all steps ready ──▶ phase `ready`
 *
 * Serial on purpose: two stalled GitHub proxies fetching in parallel teach
 * nothing and halve the bandwidth the one origin that *does* answer needs.
 *
 * The view is JSON-shaped because it crosses the SSE seam to the card — which
 * is why an unknown ETA is omitted rather than sent as `Infinity`, and why no
 * field here is a function or a Date.
 *
 * @module dsh-voice-call/provision/state
 */
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DownloadError, downloadAsset, matchesAsset, orderByThroughput, sizeOf } from './download.ts';
import { DEFAULT_CONNECTIONS, downloadSegmented, shouldSegment } from './segmented.ts';
import type { FetchLike } from './download.ts';
import { buildPlan, candidatesFor, DEFAULT_SOURCE, ENGINE_TAG, estimateSeconds, formatBytes } from './manifest.ts';
import type { Candidate, EngineVariant, EngineVariantId, ModelAsset, PlanStep, SourceSettings } from './manifest.ts';
import { engineBinaryFor, installedMap, readRecord, writeRecord } from './layout.ts';
import type { InstalledAsset, ProvisionLayout, ProvisionRecord } from './layout.ts';

/** Where one step is in its own lifecycle. */
export type StepStatus = 'ready' | 'queued' | 'downloading' | 'installing' | 'failed' | 'cancelled';

/** The whole run's phase, as the card's headline. */
export type ProvisionPhase = 'unknown' | 'unprepared' | 'preparing' | 'ready' | 'failed' | 'cancelled';

/** One step as the UI sees it. */
export interface StepView {
  readonly id: PlanStep['id'];
  readonly label: string;
  readonly status: StepStatus;
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly bytesPerSecond: number;
  readonly origin: string;
  /** Present only when a throughput sample exists (JSON-safe by construction). */
  readonly remainingSeconds?: number;
  readonly manualRecommended: boolean;
  readonly message?: string;
  readonly advice?: string;
}

/** What the card renders. */
export interface ProvisionView {
  readonly phase: ProvisionPhase;
  readonly variantId: string;
  readonly steps: readonly StepView[];
  /** Still to fetch at the moment this view was produced. */
  readonly remainingBytes: number;
  readonly receivedBytes: number;
  readonly updatedAt: number;
  /** One line that answers "还要多久 / 还要下多少" before the user commits. */
  readonly summary: string;
}

/** One prepare request: which build, which model pair, from where. */
export interface PrepareRequest {
  readonly variant: EngineVariant;
  /**
   * Whether the plugin can already speak through paths the user wrote into its
   * config. When it can, the engine row shows as ready and is left out of the
   * work list: someone with a working CUDA build must not be handed a 693 MB
   * download as the default action, which is what a capability-first default
   * alone would do.
   */
  readonly engineFromConfig?: boolean;
  readonly talker: ModelAsset;
  readonly codec: ModelAsset;
  readonly source?: SourceSettings;
  /**
   * Restrict the run to these steps — "只补模型", or a talker swapped for
   * another quant. Undefined means every step the root is missing.
   */
  readonly only?: readonly PlanStep['id'][];
}

/** Unpack input, handed to the platform-specific archive worker. */
export interface UnpackRequest {
  readonly archivePath: string;
  readonly destDir: string;
  readonly binary: string;
  readonly format: 'zip' | 'tar.gz';
  readonly signal?: AbortSignal;
}

/** Everything injectable, so the runner is testable without a network or a zip. */
export interface ProvisionDeps {
  readonly layout: ProvisionLayout;
  /**
   * Unpack an engine archive into `destDir` and return the path of the
   * executable that ended up there, or `undefined` when the archive held no
   * runnable engine.
   */
  readonly unpack: (request: UnpackRequest) => Promise<string | undefined>;
  readonly fetchImpl?: FetchLike;
  readonly candidates?: (url: string, source: SourceSettings) => readonly Candidate[];
  /**
   * Concurrent range lanes for large assets. Eight is the measured knee on both
   * a GitHub accelerator and the model mirror; more lanes than that just queue
   * behind the same per-connection throttle.
   */
  readonly connections?: number;
  readonly now?: () => number;
}

/** A subscriber of {@link ProvisionRunner} views. */
export type ProvisionListener = (view: ProvisionView) => void;

/**
 * Advice per failure reason — the part that makes a failed download actionable
 * instead of a red word. Written for the measured link: a GitHub stall from
 * China is normal, so every branch names a way out (换源 / 手动放置).
 */
export function adviceFor(reason: string, manualRecommended: boolean): string {
  switch (reason) {
    case 'first-byte':
    case 'stalled':
    case 'server':
      return manualRecommended
        ? '这个来源连不上。这么大的包在国内基本只能手动下载：把文件放到 models 目录后点「校验已放置的文件」。'
        : '连不上或中途断了。已下完的分段都留着：先取消，过一会儿再点，会从断点继续；也可以换下载源。';
    case 'not-found':
      return '来源上没有这个文件——通常是清单钉的上游版本已经变了，升级插件后重试。';
    case 'checksum':
      return '校验和不符：这个来源给的不是上游那份文件（镜像缓存了错的或被改过的内容），坏文件已丢弃，换下载源重试。';
    case 'size':
      return '收到的字节和清单对不上（多半是传到一半断了）：已保留断点，换来源或再点一次从这儿继续。';
    case 'slow':
      return '这个来源连上了但跑得太慢（镜像可能正在按流量收口），已经让给下一个。已下完的分段不会白下：可以先取消，稍后再点继续。';
    case 'aborted':
      return '已取消。已下载的字节留在 .part 里，再点一次从断点继续。';
    case 'unsupported':
      return '这台机器缺解压器（zip / tar）。手动解压到 engine 目录后点「校验已放置的文件」。';
    default:
      return '下载失败。看下面的来源与原因，换一个来源再试。';
  }
}

/**
 * The runner and its store: one per plugin mount, read by both the web route
 * and the settings card.
 */
export class ProvisionRunner {
  private readonly deps: ProvisionDeps;
  private readonly subscribers = new Set<ProvisionListener>();
  private view: ProvisionView = emptyView();
  private record: ProvisionRecord = { version: 1, assets: [] };
  private controller: AbortController | undefined;
  private running = false;

  constructor(deps: ProvisionDeps) {
    this.deps = deps;
  }

  /** What the root's `provision.json` said at the last read. */
  get persisted(): ProvisionRecord {
    return this.record;
  }

  /** The current view, safe to serialize. */
  snapshot(): ProvisionView {
    return this.view;
  }

  /** Whether a run holds the runner. */
  get busy(): boolean {
    return this.running;
  }

  /** Subscribe to view changes; the disposer is what an SSE close handler calls. */
  subscribe(listener: ProvisionListener): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** Stop the current run, keeping every `.part` for the next one. */
  cancel(): void {
    this.controller?.abort();
  }

  /**
   * Read the root and report what it holds and what it would take. Downloads
   * nothing; called on mount, after each run, and whenever the card opens.
   */
  async inspect(request: PrepareRequest): Promise<ProvisionView> {
    this.record = await readRecord(this.deps.layout.stateFile);
    const installed = await installedMap(this.deps.layout, request);
    const full = selected(buildPlan({ ...request, installed: {} }), request.only);
    const pending = selected(buildPlan({ ...request, installed }), request.only);
    const pendingIds = new Set(pending.map((step) => step.id));
    // A working engine named in the config is not work to pay for: the row stays
    // visible (hiding it would read as "broken") but leaves the work list, so the
    // default button is 1.2 GB of models rather than 1.9 GB including an archive
    // the user already has.
    if (request.engineFromConfig === true) pendingIds.delete('engine');
    const steps = full.map((step) => toView(step, pendingIds.has(step.id) ? 'queued' : 'ready'));
    const remainingBytes = full.filter((step) => pendingIds.has(step.id))
      .reduce((sum, step) => sum + step.bytes, 0);
    return this.publish({
      phase: pendingIds.size === 0 ? 'ready' : 'unprepared',
      variantId: request.variant.id,
      steps,
      remainingBytes,
      receivedBytes: steps.reduce((sum, step) => sum + step.receivedBytes, 0),
      updatedAt: this.now(),
      summary: remainingBytes === 0 ? '运行环境已就绪' : `还需下载 ${formatBytes(remainingBytes)}`,
    });
  }

  /**
   * Fetch, verify and install whatever the root is missing. Resolves with the
   * final view and does not throw for a download problem: the view carries the
   * reason and the advice, which is what the card has to render.
   */
  async prepare(request: PrepareRequest): Promise<ProvisionView> {
    if (this.running) return this.view;
    this.running = true;
    this.controller = new AbortController();
    const source = request.source ?? DEFAULT_SOURCE;
    try {
      const base = await this.inspect(request);
      const pendingIds = new Set(base.steps.filter((step) => step.status === 'queued').map((step) => step.id));
      if (pendingIds.size === 0) return base;
      return await this.run(request, source, base, pendingIds);
    } finally {
      this.running = false;
      this.controller = undefined;
    }
  }

  /**
   * Adopt a file the user placed by hand: verify it against the manifest, move
   * it into the root, record it. This is the escape hatch that turns a bad
   * network into a detour instead of a dead end.
   *
   * It holds the runner for exactly as long as {@link prepare} does, because both
   * of them read `this.record`, add one entry to it, and write the file back.
   * Two of those interleaving is how a 1.2 GB install gets recorded as an empty
   * root — and the card then offers to download the whole thing again. Verifying
   * a model is a full sha256 pass over ~2 GB, so the window is tens of seconds,
   * not a tick.
   */
  async adopt(request: PrepareRequest, role: PlanStep['id'], path: string): Promise<{ readonly ok: boolean; readonly message: string }> {
    if (this.running) return { ok: false, message: '正在装配别的文件，等它结束或先取消，再接管这一个' };
    this.running = true;
    try {
      return await this.adoptNow(request, role, path);
    } finally {
      this.running = false;
    }
  }

  private async adoptNow(request: PrepareRequest, role: PlanStep['id'], path: string): Promise<{ readonly ok: boolean; readonly message: string }> {
    const want = assetFor(request, role);
    if (want === undefined) return { ok: false, message: '不知道要校验哪个文件' };
    if ((await sizeOf(path)) === 0) return { ok: false, message: '文件不存在或读不到' };
    if (role === 'engine') {
      const dir = this.deps.layout.engineDir(request.variant.id);
      let binary: string | undefined;
      try {
        binary = await this.deps.unpack({ archivePath: path, destDir: dir, binary: request.variant.binary, format: request.variant.archive });
      } catch (error) {
        return { ok: false, message: `解压失败：${messageOf(error)}` };
      }
      if (binary === undefined) return { ok: false, message: '解压出来的目录里找不到引擎可执行文件' };
      this.record = withEngine(this.record, {
        variant: request.variant.id, binary, bytes: await sizeOf(path), sha256: want.sha256, origin: '手动放置', at: this.now(),
      });
    } else {
      if (!(await matchesAsset(path, want.bytes, want.sha256))) {
        return { ok: false, message: `体积或校验和对不上：这个文件不是清单里的那一份（${want.file}）` };
      }
      const dest = this.deps.layout.modelPath(want.asset as ModelAsset);
      await mkdir(dirname(dest), { recursive: true });
      await rename(path, dest);
      this.record = withAsset(this.record, {
        role, file: want.file, bytes: want.bytes, sha256: want.sha256, path: dest, origin: '手动放置', installedAt: this.now(),
      });
    }
    await writeRecord(this.deps.layout, this.record);
    await this.inspect(request);
    return { ok: true, message: `已接管${role === 'engine' ? '引擎' : role === 'talker' ? ' talker 模型' : ' codec 模型'}` };
  }

  /** The serial fetch loop. */
  private async run(request: PrepareRequest, source: SourceSettings, base: ProvisionView, pendingIds: ReadonlySet<PlanStep['id']>): Promise<ProvisionView> {
    const steps = new Map(base.steps.map((step) => [step.id, step]));
    let outcome: 'done' | 'cancelled' | 'failed' = 'done';
    for (const planned of selected(buildPlan({ ...request, installed: {} }), request.only)) {
      if (!pendingIds.has(planned.id)) continue;
      let current: StepView = toView(planned, 'downloading');
      steps.set(planned.id, current);
      this.emit(base, steps, 'preparing');
      try {
        const result = await this.fetch(planned, source, request, steps, base);
        if (planned.id === 'engine') {
          current = { ...current, status: 'installing', origin: result.origin };
          steps.set(planned.id, current);
          this.emit(base, steps, 'preparing');
          const dir = this.deps.layout.engineDir(request.variant.id);
          const binary = await this.deps.unpack({
            archivePath: result.path, destDir: dir, binary: request.variant.binary, format: request.variant.archive,
            ...(this.controller !== undefined ? { signal: this.controller.signal } : {}),
          });
          if (binary === undefined) throw new DownloadError('unsupported', '解压后找不到引擎可执行文件');
          this.record = withEngine(this.record, {
            variant: request.variant.id, binary, bytes: planned.bytes, sha256: planned.sha256, origin: result.origin, at: this.now(),
          });
          // The archive is scaffolding: a provisioned 693 MB CUDA zip would
          // otherwise sit next to the 693 MB of files it just produced.
          await this.discard(result.path);
        } else {
          this.record = withAsset(this.record, {
            role: planned.id, file: planned.file, bytes: planned.bytes, sha256: planned.sha256,
            path: result.path, origin: result.origin, installedAt: this.now(),
          });
        }
        current = { ...current, status: 'ready', receivedBytes: planned.bytes, origin: result.origin, bytesPerSecond: result.bytesPerSecond };
        steps.set(planned.id, current);
        await writeRecord(this.deps.layout, this.record);
        this.emit(base, steps, 'preparing');
      } catch (error) {
        const reason = error instanceof DownloadError ? error.reason : 'server';
        outcome = reason === 'aborted' ? 'cancelled' : 'failed';
        steps.set(planned.id, {
          ...current,
          status: outcome === 'cancelled' ? 'cancelled' : 'failed',
          message: messageOf(error),
          advice: adviceFor(reason, planned.manualRecommended),
        });
        break;
      }
    }
    const ready = [...steps.values()].every((step) => step.status === 'ready');
    return this.emit(base, steps, ready ? 'ready' : outcome === 'cancelled' ? 'cancelled' : 'failed');
  }

  /**
   * One step's download, with progress folded into the shared view.
   *
   * Two engines, one contract: files under {@link MIN_SEGMENTED_BYTES} go through
   * the single-stream fetcher (handshaking six lanes costs more than it saves on
   * an 8 MB archive), and everything above it is fetched in parallel ranges —
   * which on the measured link is the difference between 7 minutes and 70 seconds
   * for a 1.95 GB model.
   */
  private async fetch(planned: PlanStep, source: SourceSettings, request: PrepareRequest, steps: Map<PlanStep['id'], StepView>, base: ProvisionView) {
    const listed = (this.deps.candidates ?? candidatesFor)(planned.url, source);
    // `auto` is the only policy that measures: the rest are the user saying
    // "use exactly this", and honoring that is the point of offering it.
    const candidates = source.policy === 'auto'
      ? await orderByThroughput(listed, {
        ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
        ...(this.controller !== undefined ? { signal: this.controller.signal } : {}),
        ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
      })
      : [...listed];
    const dest = destinationFor(this.deps.layout, request, planned);
    const shared = {
      candidates,
      dest,
      expectedBytes: planned.bytes,
      expectedSha256: planned.sha256,
      ...(this.controller !== undefined ? { signal: this.controller.signal } : {}),
      ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.now !== undefined ? { now: this.deps.now } : {}),
    };
    const fold = (receivedBytes: number, bytesPerSecond: number, origin: string): void => {
      const remaining = estimateSeconds(planned.bytes - receivedBytes, bytesPerSecond);
      steps.set(planned.id, {
        id: planned.id, label: planned.label, status: 'downloading',
        totalBytes: planned.bytes, receivedBytes,
        bytesPerSecond, origin,
        manualRecommended: planned.manualRecommended,
        ...(Number.isFinite(remaining) && remaining > 0 ? { remainingSeconds: Math.ceil(remaining) } : {}),
      });
      this.emit(base, steps, 'preparing');
    };

    if (!shouldSegment(planned.bytes)) {
      const single = await downloadAsset({
        ...shared,
        onProgress: (progress) => fold(progress.receivedBytes, progress.bytesPerSecond, progress.origin),
      });
      return { path: single.path, origin: single.origin, bytesPerSecond: single.bytesPerSecond };
    }
    const segmented = await downloadSegmented({
      ...shared,
      connections: this.deps.connections ?? DEFAULT_CONNECTIONS,
      onProgress: (progress) => fold(progress.receivedBytes, progress.bytesPerSecond, progress.origins.join(' + ')),
    });
    return { path: segmented.path, origin: segmented.origins.join(' + '), bytesPerSecond: segmented.bytesPerSecond };
  }

  /** Best-effort: a leftover archive is a disk nuisance, not a failed install. */
  private async discard(path: string): Promise<void> {
    await rm(path, { force: true }).catch(() => undefined);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Rebuild the aggregate view from the step map and push it to subscribers. */
  private emit(base: ProvisionView, steps: Map<PlanStep['id'], StepView>, phase: ProvisionPhase): ProvisionView {
    const list = [...steps.values()];
    const remainingBytes = list.reduce((sum, step) => (step.status === 'ready' ? sum : sum + step.totalBytes - step.receivedBytes), 0);
    const receivedBytes = list.reduce((sum, step) => sum + step.receivedBytes, 0);
    const sample = list.find((step) => step.remainingSeconds !== undefined);
    return this.publish({
      phase,
      variantId: base.variantId,
      steps: list,
      remainingBytes,
      receivedBytes,
      updatedAt: this.now(),
      summary: phase === 'ready'
        ? '运行环境已就绪'
        : phase === 'preparing'
          ? `已收到 ${formatBytes(receivedBytes)}，剩 ${formatBytes(remainingBytes)}${sample !== undefined ? ` · 约 ${formatSeconds(sample.remainingSeconds ?? 0)}` : ''}`
          : `${phase === 'cancelled' ? '已取消' : '装配失败'}，剩 ${formatBytes(remainingBytes)}`,
    });
  }

  private publish(view: ProvisionView): ProvisionView {
    this.view = view;
    for (const listener of this.subscribers) {
      try {
        listener(view);
      } catch {
        // A broken subscriber must never take down a provisioning run.
      }
    }
    return view;
  }
}

/** The executable a ready root offers, or undefined when it is not provisioned. */
export async function provisionedEngine(layout: ProvisionLayout, variant: EngineVariant): Promise<{ readonly bin: string } | undefined> {
  const record = await readRecord(layout.stateFile);
  const bin = await engineBinaryFor(layout, record, variant);
  return bin === undefined ? undefined : { bin };
}

/** The plan restricted to the requested steps. */
function selected(steps: PlanStep[], only: readonly PlanStep['id'][] | undefined): PlanStep[] {
  return only === undefined ? steps : steps.filter((step) => only.includes(step.id));
}

function emptyView(): ProvisionView {
  return { phase: 'unknown', variantId: '', steps: [], remainingBytes: 0, receivedBytes: 0, updatedAt: 0, summary: '尚未检测' };
}

function toView(step: PlanStep, status: StepStatus): StepView {
  return {
    id: step.id, label: step.label, status,
    totalBytes: step.bytes, receivedBytes: status === 'ready' ? step.bytes : 0,
    bytesPerSecond: 0, origin: '', manualRecommended: step.manualRecommended,
  };
}

function destinationFor(layout: ProvisionLayout, request: PrepareRequest, step: PlanStep): string {
  if (step.id === 'engine') return layout.archivePath(request.variant);
  return layout.modelPath(step.id === 'talker' ? request.talker : request.codec);
}

/** The manifest entry behind one step, plus the model asset when there is one. */
function assetFor(request: PrepareRequest, role: PlanStep['id']): {
  readonly file: string; readonly bytes: number; readonly sha256: string; readonly asset?: ModelAsset;
} | undefined {
  if (role === 'engine') return { file: request.variant.file, bytes: request.variant.bytes, sha256: request.variant.sha256 };
  if (role === 'talker') return { ...request.talker, asset: request.talker };
  if (role === 'codec') return { ...request.codec, asset: request.codec };
  return undefined;
}

function withEngine(record: ProvisionRecord, input: {
  readonly variant: EngineVariantId; readonly binary: string; readonly bytes: number; readonly sha256: string; readonly origin: string; readonly at: number;
}): ProvisionRecord {
  return {
    ...record,
    version: record.version,
    engineVariant: input.variant,
    engineTag: ENGINE_TAG,
    engineBinary: input.binary,
    assets: [
      ...record.assets.filter((asset) => asset.role !== 'engine'),
      {
        role: 'engine', file: input.variant, bytes: input.bytes, sha256: input.sha256,
        path: dirname(input.binary), origin: input.origin, installedAt: input.at,
      },
    ],
  };
}

function withAsset(record: ProvisionRecord, asset: InstalledAsset): ProvisionRecord {
  return { ...record, assets: [...record.assets.filter((entry) => entry.role !== asset.role), asset] };
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '未知时间';
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded} 秒`;
  const minutes = Math.round(rounded / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${(minutes / 60).toFixed(1)} 小时`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
