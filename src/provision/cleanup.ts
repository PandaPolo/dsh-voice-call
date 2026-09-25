/**
 * Cleaning the managed root out.
 *
 * A plugin that quietly lays down 1.2 GB owes the person who installed it a way
 * to take it back. This module is the whole of that promise: it measures what is
 * under the voice root, and it deletes what it measured — nothing else.
 *
 * Three rules hold it together:
 *
 * 1. **The root is the boundary.** Every path is resolved and checked against
 *    `layout.root` before anything touches it, and the walk uses `lstat`, so a
 *    symlink inside the root cannot point the deletion somewhere else. A
 *    hand-configured `D:\crispasr` is outside the boundary by construction — it
 *    is not this plugin's to remove, and the same rule that protects it protects
 *    everything else on the disk.
 * 2. **Groups, not a blind `rm -r`.** Engine, models and download cache are
 *    reported and removed separately, so someone who only wants their GPU build
 *    back can ask for that. The record goes last, and only when nothing failed,
 *    so a partial clean still leaves a truthful `provision.json` behind.
 * 3. **A refusal is a result.** Windows will not delete a running executable, and
 *    a half-finished download may be held open. Those come back as `failed` with
 *    the OS's own words rather than as a success that freed less than it claimed.
 *
 * @module dsh-voice-call/provision/cleanup
 */
import { lstat, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { defaultAudioDir } from '../audio.ts';
import type { ProvisionLayout } from './layout.ts';

/** What may be cleaned, in the order the card offers them. */
export type CleanupGroup = 'engine' | 'models' | 'cache';

export const CLEANUP_GROUPS: readonly CleanupGroup[] = ['engine', 'models', 'cache'];

/** The labels the card shows; kept here so the server and the page cannot drift. */
export const GROUP_LABELS: Record<CleanupGroup, string> = {
  engine: '引擎',
  models: '模型',
  cache: '下载缓存',
};

/** One group's footprint. */
export interface GroupUsage {
  readonly id: CleanupGroup;
  readonly label: string;
  readonly path: string;
  readonly bytes: number;
  /** Files counted, so "0 B" and "40 files of 0 B" are distinguishable. */
  readonly entries: number;
  readonly present: boolean;
}

/** The whole managed root, as measured. */
export interface DiskUsage {
  readonly root: string;
  readonly groups: readonly GroupUsage[];
  readonly totalBytes: number;
  /** Whether a run holds the runner, which is why a clean would be refused. */
  readonly busy: boolean;
}

/** What one group's removal cost or failed to cost. */
export interface RemovalResult {
  readonly id: CleanupGroup;
  readonly bytes: number;
  /** The OS's own complaint when the group is still there. */
  readonly reason?: string;
}

/** The outcome of a cleanup. */
export interface CleanupResult {
  readonly removed: readonly RemovalResult[];
  readonly failed: readonly RemovalResult[];
  readonly freedBytes: number;
  /** Whether `provision.json` went too, i.e. the root is now empty of record. */
  readonly forgetRecord: boolean;
  readonly message: string;
}

/** The directory one group owns. */
export function groupDir(layout: ProvisionLayout, group: CleanupGroup): string {
  if (group === 'models') return layout.modelsDir;
  if (group === 'cache') return layout.downloadDir();
  return layout.engineRootDir();
}

/**
 * Refuse any path that is not strictly inside the root. `relative` answers the
 * question without resolving symlinks, which is what we want: the *written*
 * location is the one the plugin owns.
 */
export function insideRoot(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** Why a root is or is not a directory this plugin may delete inside of. */
export interface RootVerdict {
  readonly ok: boolean;
  readonly reason: string;
}

/**
 * Whether `root` is a directory the plugin may be allowed to empty.
 *
 * {@link insideRoot} cannot answer this, and it used to be the only check in the
 * path — every group is `join(root, …)`, so "is the group inside the root" is
 * true by construction and proves nothing about the root itself. The root comes
 * from `audioDir`, a free-form config string, which means the boundary a person
 * is trusting when they press 清理 was the one line of code that never looked at
 * it. `audioDir: '.'` is a plausible typo and resolves to the working directory,
 * whose `models/`, `engine/` and `downloads/` are then in scope for an
 * `rm -r` — a workspace's own assets, not this plugin's.
 *
 * What is refused is a directory this plugin has no business owning: a drive
 * root, the working directory, the home directory, the DSH home itself, and the
 * temp dir. A one-level path like `D:\voice` stays allowed, because people do
 * put their models there and refusing it would cost a working setup its feature.
 */
export function cleanableRoot(root: string): RootVerdict {
  if (!isAbsolute(root)) {
    return { ok: false, reason: `voice 目录必须是绝对路径，现在配置里写的是「${root}」` };
  }
  const base = resolve(root);
  const anchors: readonly [string, string][] = [
    [parse(base).root, '盘符根目录'],
    [resolve(process.cwd()), '当前工作目录'],
    [resolve(homedir()), '用户主目录'],
    [resolve(defaultAudioDir(), '..'), 'DSH 的配置目录本身'],
    [resolve(defaultAudioDir(), '..'), 'DSH 的配置目录本身'],
  ];
  for (const [anchor, label] of anchors) {
    if (base === anchor) return { ok: false, reason: `voice 目录指向了${label}（${anchor}），这里面的东西不是本插件放进去的` };
  }
  // Where the temp dir actually is is the platform's business: `tmpdir` reads
  // TMP/TEMP/TMPDIR and falls back to /tmp, which the env vars alone do not.
  if (base === resolve(tmpdir())) {
    return { ok: false, reason: `voice 目录指向了系统临时目录（${base}），这里面的东西不是本插件放进去的` };
  }
  return { ok: true, reason: '' };
}

/**
 * Sum a directory tree without following links and without unbounded recursion.
 * The budget exists because this runs on a loop over a directory a person may
 * have dropped anything into — `~/.dsh/voice` is theirs, not only ours.
 */
export async function treeBytes(dir: string, budget = 20_000): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const stack: string[] = [dir];
  while (stack.length > 0 && entries < budget) {
    const current = stack.pop();
    if (current === undefined) continue;
    let items;
    try {
      items = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of items) {
      if (entries >= budget) break;
      const path = join(current, item.name);
      if (item.isDirectory() && !item.isSymbolicLink()) {
        stack.push(path);
        continue;
      }
      try {
        const info = await lstat(path);
        if (!info.isFile()) continue;
        bytes += info.size;
        entries += 1;
      } catch {
        // Unreadable is not the same as absent: it is simply not counted, and the
        // removal step will report whatever the OS says about it.
      }
    }
  }
  return { bytes, entries };
}

/** Measure every group, including the ones that are not there. */
export async function diskUsage(layout: ProvisionLayout, busy = false): Promise<DiskUsage> {
  const groups: GroupUsage[] = [];
  for (const id of CLEANUP_GROUPS) {
    const path = groupDir(layout, id);
    const { bytes, entries } = await treeBytes(path);
    groups.push({
      id,
      label: GROUP_LABELS[id],
      path,
      bytes,
      entries,
      present: await exists(path),
    });
  }
  const recordBytes = (await stat(layout.stateFile).catch(() => undefined))?.size ?? 0;
  return {
    root: layout.root,
    groups,
    // The record is a few hundred bytes; it is counted so the total matches what
    // a file manager says the folder holds.
    totalBytes: groups.reduce((sum, group) => sum + group.bytes, 0) + recordBytes,
    busy,
  };
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

/** Parse and confine the groups asked for; anything unknown or outside is dropped. */
export function requestedGroups(value: unknown, layout: ProvisionLayout): CleanupGroup[] {
  if (!Array.isArray(value)) return [];
  const wanted = value.filter((entry): entry is CleanupGroup =>
    typeof entry === 'string' && (CLEANUP_GROUPS as readonly string[]).includes(entry));
  // The question was never "is `<root>/models` inside `<root>`" — it is, always,
  // and the filter that asked it could not have failed. The question is whether
  // `<root>` is a directory this plugin owns, which is {@link cleanableRoot}.
  if (!cleanableRoot(layout.root).ok) return [];
  return [...new Set(wanted)];
}

/**
 * Delete the named groups under the root. Never throws: a group that cannot go
 * is reported with the reason, and the rest still go.
 *
 * `remove` is injectable for the same reason the unpacker takes a shell: the
 * interesting case is the filesystem saying no, and a test should not have to
 * win that argument with the real OS to check what the plugin does next.
 */
export async function cleanRoot(
  layout: ProvisionLayout,
  groups: readonly CleanupGroup[],
  remove: (path: string) => Promise<void> = (path) => rm(path, { recursive: true, force: false, maxRetries: 0 }),
): Promise<CleanupResult> {
  // Checked again here, and not only in the route, because the consequence of
  // some future caller forgetting it is the deletion of a directory nobody gave
  // this plugin. Every group reports the same refusal, and the record stays.
  const verdict = cleanableRoot(layout.root);
  if (!verdict.ok) {
    return {
      removed: [],
      failed: groups.map((id) => ({ id, bytes: 0, reason: verdict.reason })),
      freedBytes: 0,
      forgetRecord: false,
      message: verdict.reason,
    };
  }
  const removed: RemovalResult[] = [];
  const failed: RemovalResult[] = [];
  for (const id of CLEANUP_GROUPS) {
    if (!groups.includes(id)) continue;
    const path = groupDir(layout, id);
    if (!insideRoot(layout.root, path)) {
      failed.push({ id, bytes: 0, reason: '路径不在 voice 目录内，已拒绝' });
      continue;
    }
    const { bytes } = await treeBytes(path);
    if (!(await exists(path))) {
      // Nothing there is not a failure — a clean run of an empty root should say
      // "0 B freed", not report three errors.
      removed.push({ id, bytes: 0 });
      continue;
    }
    try {
      await remove(path);
      removed.push({ id, bytes });
    } catch (error) {
      failed.push({ id, bytes, reason: reason(error) });
    }
  }
  // The record goes only when every group was asked for and all of them left.
  // Otherwise it would claim a runtime the disk no longer holds, and the card
  // would have nothing to explain the gap with.
  const forgetRecord = groups.length === CLEANUP_GROUPS.length && failed.length === 0;
  if (forgetRecord) await rm(layout.stateFile, { force: true }).catch(() => undefined);
  const freedBytes = removed.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    removed,
    failed,
    freedBytes,
    forgetRecord,
    message: describe(removed, failed, freedBytes, forgetRecord),
  };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(
  removed: readonly RemovalResult[],
  failed: readonly RemovalResult[],
  freedBytes: number,
  forgetRecord: boolean,
): string {
  const parts: string[] = [];
  if (freedBytes > 0) parts.push(`已释放 ${formatBytes(freedBytes)}`);
  else if (removed.length > 0) parts.push('本来就没有占空间的文件');
  if (failed.length > 0) {
    parts.push(`${failed.map((entry) => GROUP_LABELS[entry.id]).join('、')}没能删除${
      failed[0]?.reason !== undefined ? `（${failed[0].reason}）` : ''}，通常是有程序正在用它`);
  }
  if (forgetRecord) parts.push('已清空 voice 目录下的记录');
  return parts.join('；') || '没有可清理的内容';
}

/** The same byte formatting the card uses, kept local so this module has no UI import. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}
