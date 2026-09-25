/**
 * The 运行环境 section's presentation model: everything the card shows that can
 * be derived without a DOM — row labels, status words, progress percentages, the
 * byte counts and the one-line summary.
 *
 * It lives in a `.ts` module rather than inside the component for one reason:
 * the JSX file cannot be imported by the test runner (no JSX transform there),
 * and a card whose copy and percentages are only checked by eye is a card where
 * "8.3 MB" can silently become "8 MB" or a bar can fill past its own row. The
 * component below is layout; this file is content.
 *
 * @module dsh-voice-call/client/runtime-model
 */
import type { DiskUsage, ProvisionView, StepView } from './provision-api.ts';

/** One rendered row. */
export interface RuntimeRow {
  readonly id: StepView['id'];
  readonly name: string;
  readonly statusText: string;
  /** 0–100, clamped: a partial read must never overflow the bar. */
  readonly percent: number;
  readonly receivedLabel: string;
  readonly totalLabel: string;
  readonly rateLabel: string;
  readonly etaLabel: string;
  readonly originLabel: string;
  readonly showBar: boolean;
  readonly showAdvice: boolean;
  readonly advice: string;
}

/** What the section's action button should say and whether it can be pressed. */
export interface RuntimeAction {
  readonly label: string;
  readonly disabled: boolean;
  readonly cancelling: boolean;
}

const NAMES: Record<StepView['id'], string> = {
  engine: '引擎',
  talker: 'Talker 模型',
  codec: 'Codec 模型',
};

const STATUS_TEXT: Record<StepView['status'], string> = {
  ready: '已就绪',
  queued: '未安装',
  downloading: '下载中',
  installing: '解压中',
  failed: '失败',
  cancelled: '已取消',
};

/** `1.2 GB` / `8.3 MB` — the unit a user reasons in, one decimal under 100. */
export function formatBytes(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(count) / Math.log(1024)), units.length - 1);
  const value = count / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/** `剩约 3 分钟`; nothing when there is no sample to promise from. */
export function formatEta(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `剩约 ${Math.max(1, Math.round(seconds))} 秒`;
  const minutes = seconds / 60;
  if (minutes < 60) return `剩约 ${Math.round(minutes)} 分钟`;
  return `剩约 ${(minutes / 60).toFixed(1)} 小时`;
}

/** The rows, in the server's order, with every label already resolved. */
export function runtimeRows(view: ProvisionView): RuntimeRow[] {
  return view.steps.map((step) => {
    const active = step.status === 'downloading' || step.status === 'installing';
    return {
      id: step.id,
      name: NAMES[step.id],
      statusText: STATUS_TEXT[step.status],
      percent: Math.max(0, Math.min(100, Math.round((step.receivedBytes / Math.max(1, step.totalBytes)) * 100))),
      receivedLabel: formatBytes(step.receivedBytes),
      totalLabel: formatBytes(step.totalBytes),
      rateLabel: step.bytesPerSecond > 0 ? `${formatBytes(Math.round(step.bytesPerSecond))}/s` : '',
      etaLabel: formatEta(step.remainingSeconds),
      originLabel: step.origin === '' ? '' : `来自 ${step.origin}`,
      showBar: active,
      showAdvice: step.status === 'failed' || step.status === 'cancelled',
      advice: step.advice ?? step.message ?? '装配未完成',
    };
  });
}

/** The pending count, so the button can say what it is about to do. */
export function pendingSteps(view: ProvisionView): StepView[] {
  return view.steps.filter((step) => step.status !== 'ready');
}

/**
 * The primary button. A ready root still gets a pressable control — "重新检查"
 * — because the user may have moved files around by hand, and the cheapest way
 * to make that legible is to let them ask.
 *
 * `auto` names the press after what it actually is. Nothing in the selection has
 * been touched, so the button will fetch the build this machine was measured
 * against — that is 一键部署, and calling it "安装缺的 3 项" makes the user think
 * they have to understand the three items first. Once a dropdown has been moved,
 * the same press is a deliberate choice and says so.
 *
 * `usableFromConfig` only adds the destination: someone whose engine already
 * works from paths in their config must not be told their runtime is missing,
 * but the words still have to name a button they can press with one click.
 *
 * The byte total rides in the label either way — a 693 MB download must never be
 * one unlabelled click.
 */
export function runtimeAction(
  view: ProvisionView,
  busy: boolean,
  usableFromConfig = false,
  auto = true,
): RuntimeAction {
  const preparing = view.phase === 'preparing';
  const pending = pendingSteps(view);
  if (preparing) return { label: '取消', disabled: busy, cancelling: true };
  if (pending.length === 0) return { label: '重新检查', disabled: busy, cancelling: false };
  const size = formatBytes(view.remainingBytes);
  const what = auto ? `一键部署${usableFromConfig ? '到 voice 目录' : ''}` : `安装选定的 ${pending.length} 项`;
  return { label: `${what} · ${size}`, disabled: busy, cancelling: false };
}

/**
 * Whether the selection is still whatever the server proposed. Structural on
 * purpose: the card can ask without importing the catalogue's full shape into
 * the presentation model.
 *
 * The baseline is the server's own selection, not a rule repeated here. Comparing
 * against a second copy of "what the default is" is how the two stop agreeing —
 * and the label below is the only thing that depends on it.
 */
export function isDefaultSelection(
  selection: { variantId?: string; talkerFile?: string; codecQuant?: string; policy?: string },
  base: { variantId: string; talkerFile: string; codecQuant: string; policy: string },
): boolean {
  return (selection.variantId ?? base.variantId) === base.variantId
    && (selection.talkerFile ?? base.talkerFile) === base.talkerFile
    && (selection.codecQuant ?? base.codecQuant) === base.codecQuant
    && (selection.policy ?? base.policy) === base.policy;
}

/** The line explaining why the button says 另装一份. */
export function runtimeNotice(view: ProvisionView, usableFromConfig: boolean): string {
  if (!usableFromConfig) return '';
  return pendingSteps(view).length === 0
    ? 'voice 目录里已经装好一份，可直接使用。'
    : '当前引擎来自配置里指定的路径，已经能用；下面这份是装进 voice 目录的独立副本。';
}

/**
 * The cleanup control. It is invisible while there is nothing to reclaim, because
 * a "delete 0 B" affordance on a card that is already trying not to alarm anyone
 * is pure noise — and it is disabled, not hidden, during a download, because the
 * reason it will not act is the thing the user needs to read.
 *
 * The size lives in {@link usageLine} rather than in the label: a control that
 * has to be found before it can be read should not be the thing carrying the
 * number that makes it worth finding.
 */
export function cleanupAction(usage: DiskUsage | undefined, busy: boolean): { visible: boolean; disabled: boolean; label: string } {
  if (usage === undefined || usage.totalBytes === 0) return { visible: false, disabled: true, label: '清理本地文件' };
  if (busy || usage.busy) return { visible: true, disabled: true, label: '清理本地文件（下载中）' };
  return { visible: true, disabled: false, label: '清理本地文件' };
}

/** `voice 目录当前占用 3.1 GB` — what the root costs, next to the way back. */
export function usageLine(usage: DiskUsage | undefined): string {
  if (usage === undefined || usage.totalBytes === 0) return '';
  return `voice 目录当前占用 ${formatBytes(usage.totalBytes)}`;
}

/** The confirmation line: what goes, how much each part costs, and the total. */
export function cleanupSummary(usage: DiskUsage, selected: readonly string[]): string {
  const chosen = usage.groups.filter((group) => selected.includes(group.id) && group.present);
  if (chosen.length === 0) return '没有选中任何一项';
  const parts = chosen.map((group) => `${group.label} ${formatBytes(group.bytes)}`).join(' · ');
  const total = chosen.reduce((sum, group) => sum + group.bytes, 0);
  return `将删除 ${parts}，共 ${formatBytes(total)}。删除后需要重新下载才能用语音来电。`;
}

/**
 * Which groups a first-time panel should have ticked.
 *
 * All of them, except that a root still in use gets its cache pre-ticked only —
 * someone pressing 清理 while the runtime works is far more likely to mean "clear
 * the junk" than "break my voice", and the box is right there to tick.
 */
export function defaultSelection(usage: DiskUsage, usableFromConfig: boolean): string[] {
  if (usableFromConfig) return usage.groups.filter((group) => group.id === 'cache' && group.present).map((group) => group.id);
  return usage.groups.filter((group) => group.present).map((group) => group.id);
}
