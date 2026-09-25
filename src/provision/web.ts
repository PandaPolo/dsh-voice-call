/**
 * The provisioning web routes: the transport between the settings card and the
 * runner, registered on `ctx.webServer` under `/voice/provision` exactly like
 * the call-card and audio routes (same-origin, loopback-bound by default).
 *
 * - `GET  /voice/provision/state`   — the view + the catalogue the card renders
 * - `POST /voice/provision/preview` — the view for a *hypothetical* selection
 * - `GET  /voice/provision/events`  — the same view, streamed as it changes
 * - `POST /voice/provision/prepare` — start a run; body selects, manifest decides
 * - `POST /voice/provision/cancel`  — stop it, keeping the `.part` files
 * - `POST /voice/provision/adopt`   — take in a file the user dropped to download/
 *
 * Two rules the handlers exist to enforce:
 *
 * 1. **The client names, the manifest pins.** A request carries a variant id and
 *    a quant; the URL, size and digest always come from `manifest.ts`. A page
 *    cannot provision an arbitrary URL through this plugin, and a stale tab
 *    cannot install a file the plugin has not verified.
 * 2. **No paths from the wire.** 手动放置 resolves by *file name* inside the two
 *    directories this plugin owns. Accepting a path would hand any page that can
 *    reach the loopback port a read-and-move primitive over the user's disk.
 *
 * @module dsh-voice-call/provision/web
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { guardWrite } from '../web-guard.ts';
import { cleanRoot, cleanableRoot, diskUsage, requestedGroups } from './cleanup.ts';
import { findDropped } from './layout.ts';
import type { ProvisionLayout } from './layout.ts';
import {
  ENGINE_VARIANTS, GH_PROXY_PRESETS, MODEL_ASSETS, engineVariantById, formatBytes,
  suggestVariants,
} from './manifest.ts';
import type { PlanStep, SourcePolicy } from './manifest.ts';
import type { DeviceReport } from './detect.ts';
import type { GpuRequirement } from './manifest.ts';
import { describeDevice } from './detect.ts';
import type { PrepareRequest, ProvisionRunner, ProvisionView } from './state.ts';

/** The route prefix serving the provisioning endpoints. */
export const PROVISION_ROUTE = '/voice/provision';

/** Heartbeat interval for the SSE stream (ms). */
const HEARTBEAT_MS = 15_000;
/** POST body cap — a selection is a dozen bytes. */
const MAX_BODY_BYTES = 4096;

/** The steps a client may ask for. */
const ROLES: readonly PlanStep['id'][] = ['engine', 'talker', 'codec'];
const POLICIES: readonly SourcePolicy[] = ['auto', 'cn', 'official', 'custom'];

/** The identifiers the card may echo back — the same shape `applySelection` reads. */
export interface ProvisionSelectionDto {
  readonly variantId: string;
  readonly talkerFile: string;
  readonly codecQuant: string;
  readonly policy: string;
}

/** Everything the card needs that is not the view. */
export interface ProvisionCatalogue {
  /** One line: what the engine said about this machine, or why it could not say. */
  readonly device: string;
  /**
   * The selection the server would act on right now — the build and the model
   * pair it actually found on disk, falling back to what this machine should get.
   *
   * The card seeds its dropdowns from here rather than from a rule of its own,
   * because the two would drift the moment the root stopped matching the
   * manifest's default: a machine holding the 1.7B talker was shown the 0.6B one
   * selected, and the row next to it said `未安装 · 还需下载 923 MB` forever.
   */
  readonly selection: ProvisionSelectionDto;
  readonly variants: readonly { id: string; label: string; bytes: number; gpu: string; note: string; offered: boolean; whyNot: string }[];
  readonly models: readonly { role: string; file: string; quant: string; bytes: string; label: string; note: string; backend: string; isDefault: boolean }[];
  readonly sources: readonly { policy: SourcePolicy; label: string; proxies: readonly string[] }[];
  readonly dropDir: string;
  /**
   * Whether the plugin can already speak, by way of paths the user wrote into
   * the config. Without this the card reads "未安装 · 下载 1.2 GB" to someone
   * whose engine works perfectly from `D:\crispasr` — the same root would then
   * hold a second, unused copy of the models.
   */
  readonly usableFromConfig: boolean;
}

/**
 * Register the provisioning routes when a webserver is present; returns the
 * disposer. Headless (no webserver) leaves the runner reachable only through
 * the `/voice` command.
 */
export function installProvisionRoutes(
  ctx: Context,
  runner: ProvisionRunner,
  layout: ProvisionLayout,
  currentRequest: () => PrepareRequest,
  device: () => DeviceReport,
  usableFromConfig: () => boolean,
): () => void {
  const webServer = ctx.get('webServer') as
    | { register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void }
    | undefined;
  if (webServer === undefined) return () => {};
  return webServer.register({
    kind: 'prefix',
    path: PROVISION_ROUTE,
    handler: (req, res) => serveProvisionRoute(runner, layout, currentRequest, device, usableFromConfig, req, res),
  });
}

/** Dispatch one `/voice/provision/*` request by its path suffix. */
export function serveProvisionRoute(
  runner: ProvisionRunner,
  layout: ProvisionLayout,
  currentRequest: () => PrepareRequest,
  device: () => DeviceReport,
  usableFromConfig: () => boolean,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  let path: string;
  try {
    path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const suffix = path.slice(PROVISION_ROUTE.length);
  // One gate for every write on this prefix, applied before the suffix is read so
  // a POST added here later cannot forget it. `/cleanup` deletes 1.2 GB and
  // `/prepare` spends 1.9 GB of someone's bandwidth; neither is a thing a page
  // from another origin should be able to ask for.
  if (req.method === 'POST' && guardWrite(req, res)) return;
  if (suffix === '/events') {
    if (req.method !== 'GET') return rejectMethod(res, 'GET');
    serveEventStream(runner, res);
    return;
  }
  if (suffix === '/state') {
    if (req.method !== 'GET') return rejectMethod(res, 'GET');
    // Reading the state also refreshes it, so a folder the user edited by hand
    // is reflected the next time the card opens — but never in the middle of a
    // run. `inspect` rebuilds the whole view from the plan, so answering a card
    // refresh with it reset a live download's progress bar to zero and relabelled
    // the run `unprepared`; the phase change then made the plugin re-detect the
    // engine while it was still being fetched. `/preview` already refused to do
    // this, which is how the hole here stayed visible for so long.
    const send = (): void => sendJson(res, 200, {
      view: runner.snapshot(),
      catalogue: catalogueFor(layout, device(), currentRequest(), usableFromConfig()),
    });
    if (runner.busy) {
      send();
      return;
    }
    // Both branches answer: a refresh that cannot read the root still has to
    // tell the card what the last read said, not hang a socket open.
    void runner.inspect(currentRequest()).then(send, send);
    return;
  }
  // "What would it take, if I chose this?" — the same walk `/state` does, over a
  // selection instead of the plugin's own. Without it the rows keep describing the
  // server's pair while the dropdown shows another one, which is how a card ends
  // up offering `安装选定的 1 项` with a byte total from a different build.
  if (suffix === '/preview') {
    if (req.method !== 'POST') return rejectMethod(res, 'POST');
    readJsonBody(req, res, (selection) => {
      const request = applySelection(currentRequest(), selection);
      if (request === undefined) {
        sendJson(res, 400, { ok: false, message: '选择的版本或下载源不在清单里' });
        return;
      }
      if (runner.busy) {
        // A run owns the view while it is going: answering with the live one keeps
        // a stray preview from wiping a progress bar someone is watching.
        sendJson(res, 200, { view: runner.snapshot() });
        return;
      }
      void runner.inspect(request).then(
        (view) => sendJson(res, 200, { view }),
        () => sendJson(res, 200, { view: runner.snapshot() }),
      );
    });
    return;
  }
  if (suffix === '/prepare' || suffix === '/adopt') {
    if (req.method !== 'POST') return rejectMethod(res, 'POST');
    serveMutation(runner, layout, currentRequest, suffix === '/adopt', req, res);
    return;
  }
  if (suffix === '/cancel') {
    if (req.method !== 'POST') return rejectMethod(res, 'POST');
    runner.cancel();
    sendJson(res, 200, { view: runner.snapshot() });
    return;
  }
  // Disk usage is a GET and a walk of the root, so it is never folded into
  // `/state`: that one answers every SSE tick and the card opens this only when
  // someone asks what is taking the space.
  if (suffix === '/disk') {
    if (req.method !== 'GET') return rejectMethod(res, 'GET');
    void diskUsage(layout, runner.busy).then(
      (usage) => sendJson(res, 200, usage),
      () => sendJson(res, 500, { ok: false, message: '读不出这个目录的占用' }),
    );
    return;
  }
  if (suffix === '/cleanup') {
    if (req.method !== 'POST') return rejectMethod(res, 'POST');
    serveCleanup(layout, runner, currentRequest, req, res);
    return;
  }
  res.writeHead(404);
  res.end();
}

/**
 * Delete what the plugin put under the voice root.
 *
 * `confirm: true` is required, not decorative: the endpoint is reachable by
 * anything that can post to loopback, and "the card sent a body" is not the same
 * as "a person pressed the second button". A request without it gets the usage
 * report instead, which is the safe reply to a misunderstanding.
 */
function serveCleanup(
  layout: ProvisionLayout,
  runner: ProvisionRunner,
  currentRequest: () => PrepareRequest,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  readJsonBody(req, res, async (body) => {
    // Before anything else: is this root one the plugin may empty at all? Said
    // here rather than folded into the group list because the card has to show
    // the person the reason, and "没有指定要清理哪一类文件" would be a lie.
    const verdict = cleanableRoot(layout.root);
    if (!verdict.ok) {
      sendJson(res, 400, { ok: false, message: verdict.reason });
      return;
    }
    const groups = requestedGroups(body.groups, layout);
    if (groups.length === 0) {
      sendJson(res, 400, { ok: false, message: '没有指定要清理哪一类文件' });
      return;
    }
    if (runner.busy) {
      // Deleting a `.part` the downloader is writing would corrupt the resume, and
      // the run would then re-fetch the whole file.
      sendJson(res, 409, { ok: false, message: '正在下载，先取消再清理' });
      return;
    }
    if (body.confirm !== true) {
      sendJson(res, 400, {
        ok: false,
        needConfirm: true,
        usage: await diskUsage(layout, false),
        message: '清理需要明确确认',
      });
      return;
    }
    const result = await cleanRoot(layout, groups);
    // The root is empty now: refresh so the card stops showing a runtime that is
    // no longer on disk, and the SSE subscribers see it too.
    void runner.inspect(currentRequest()).catch(() => undefined);
    sendJson(res, 200, { ok: result.failed.length === 0, ...result });
  });
}

/** Why the machine cannot run this build, in the words the dropdown shows. */
function notOfferedReason(gpu: GpuRequirement, device: DeviceReport): string {
  if (device.gpu === 'unknown') return '未探测到设备';
  if (gpu === 'cuda12') return '没有 CUDA 后端';
  if (gpu === 'vulkan') return '没有 Vulkan 后端';
  return '不是这个平台的包';
}

/** What the card may offer, derived from the manifest and this machine. */
export function catalogueFor(layout: ProvisionLayout, device: DeviceReport, request: PrepareRequest, usableFromConfig: boolean): ProvisionCatalogue {
  const offeredList = suggestVariants(device);
  const offered = new Set(offeredList.map((variant) => variant.id));
  return {
    device: describeDevice(device),
    selection: {
      variantId: request.variant.id,
      talkerFile: request.talker.file,
      codecQuant: request.codec.quant,
      policy: request.source?.policy ?? 'auto',
    },
    variants: ENGINE_VARIANTS.map((variant) => ({
      id: variant.id, label: variant.label, bytes: variant.bytes, gpu: variant.gpu, note: variant.note,
      offered: offered.has(variant.id),
      whyNot: offered.has(variant.id) ? '' : notOfferedReason(variant.gpu, device),
    })),
    models: MODEL_ASSETS.map((asset) => ({
      role: asset.role, file: asset.file, quant: asset.quant, bytes: formatBytes(asset.bytes),
      label: asset.label, note: asset.note, backend: asset.backend,
      isDefault: asset.file === request.talker.file || asset.file === request.codec.file,
    })),
    sources: POLICIES.map((policy) => ({
      policy,
      label: policy === 'auto' ? '自动（测速择优）' : policy === 'cn' ? '国内镜像优先' : policy === 'official' ? '只用官方源' : '自定义加速前缀',
      proxies: GH_PROXY_PRESETS.map((preset) => preset.id),
    })),
    dropDir: layout.downloadDir(),
    usableFromConfig,
  };
}

/** Read a small JSON body, answer 4xx on anything else, then run the mutation. */
function serveMutation(
  runner: ProvisionRunner,
  layout: ProvisionLayout,
  currentRequest: () => PrepareRequest,
  isAdopt: boolean,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  readJsonBody(req, res, (selection) => {
    const request = applySelection(currentRequest(), selection);
    if (request === undefined) {
      sendJson(res, 400, { ok: false, message: '选择的版本或下载源不在清单里' });
      return;
    }
    if (isAdopt) {
      void adoptSelected(runner, layout, request, selection, res);
      return;
    }
    // The run continues after the response: the card follows it over SSE.
    void runner.prepare(request).catch(() => undefined);
    sendJson(res, 202, { view: runner.snapshot() });
  });
}

/**
 * Read one capped JSON object and hand it to a handler. Shared because every
 * mutation on this prefix has the same shape, and a body limit written twice is a
 * body limit that one day differs.
 */
function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  then: (body: Record<string, unknown>) => void | Promise<void>,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, { ok: false, message: '请求过大' });
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', () => {
    aborted = true;
  });
  req.on('end', () => {
    if (aborted) return;
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      sendJson(res, 400, { ok: false, message: '不是有效的 JSON' });
      return;
    }
    // This is where every write on the prefix lands, so it is also where a
    // handler that throws gets an answer: left floating, a rejection here would
    // both hang the socket and surface as an unhandled rejection in the host.
    void Promise.resolve()
      .then(() => then((body ?? {}) as Record<string, unknown>))
      .catch(() => sendJson(res, 500, { ok: false, message: '这个请求没能完成' }));
  });
}

/** Adopt by role, resolving the dropped file by name inside the plugin's own dirs. */
async function adoptSelected(
  runner: ProvisionRunner,
  layout: ProvisionLayout,
  request: PrepareRequest,
  selection: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const role = selection.role;
  if (typeof role !== 'string' || !ROLES.includes(role as PlanStep['id'])) {
    sendJson(res, 400, { ok: false, message: 'role 必须是 engine / talker / codec' });
    return;
  }
  const file = role === 'engine' ? request.variant.file : role === 'talker' ? request.talker.file : request.codec.file;
  const dropped = await findDropped(layout, file);
  if (dropped === undefined) {
    sendJson(res, 409, { ok: false, message: `投放目录里没有找到 ${file}：先把它放进 ${layout.downloadDir()}` });
    return;
  }
  const result = await runner.adopt(request, role as PlanStep['id'], dropped);
  sendJson(res, result.ok ? 200 : 422, { ok: result.ok, message: result.message, view: runner.snapshot() });
}

/**
 * Fold a client selection onto the plugin's current request. Returns undefined
 * when the selection names something the manifest does not know — the pinned
 * digests never come from the wire, so an unknown id is a rejection, not a URL.
 */
export function applySelection(base: PrepareRequest, selection: Record<string, unknown>): PrepareRequest | undefined {
  const variantId = selection.variantId;
  const talkerFile = selection.talkerFile;
  const codecQuant = selection.codecQuant;
  const policy = selection.policy;
  const proxyPrefix = selection.proxyPrefix;
  const only = selection.only;
  const variant = variantId === undefined || variantId === null || variantId === base.variant.id
    ? base.variant
    : engineVariantById(typeof variantId === 'string' ? variantId : undefined);
  if (variant === undefined) return undefined;
  const codec = codecQuant === undefined || codecQuant === null
    ? base.codec
    : MODEL_ASSETS.find((asset) => asset.role === 'codec' && asset.quant === codecQuant);
  if (codec === undefined) return undefined;
  const talker = talkerFile === undefined || talkerFile === null
    ? base.talker
    : MODEL_ASSETS.find((asset) => asset.role === 'talker' && asset.file === talkerFile);
  if (talker === undefined) return undefined;
  const source = {
    policy: POLICIES.includes(policy as SourcePolicy) ? (policy as SourcePolicy) : (base.source?.policy ?? 'auto'),
    ...(typeof proxyPrefix === 'string' ? { proxyPrefix } : base.source?.proxyPrefix !== undefined ? { proxyPrefix: base.source.proxyPrefix } : {}),
  };
  const steps = Array.isArray(only) && only.length > 0 && only.every((step) => ROLES.includes(step as PlanStep['id']))
    ? (only as PlanStep['id'][])
    : base.only;
  return { ...base, variant, talker, codec, source, ...(steps !== undefined ? { only: steps } : {}) };
}

/** Hold one SSE response open and mirror the runner onto it. */
function serveEventStream(runner: ProvisionRunner, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const send = (view: ProvisionView): void => {
    try {
      res.write(`data: ${JSON.stringify(view)}\n\n`);
    } catch {
      // A write against a dead socket must not break the run.
    }
  };
  send(runner.snapshot());
  const unsubscribe = runner.subscribe(send);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // The close handler cleans this up.
    }
  }, HEARTBEAT_MS);
  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  res.on('error', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function rejectMethod(res: ServerResponse, allowed: string): void {
  res.writeHead(405, { allow: allowed });
  res.end();
}
