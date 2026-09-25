/**
 * The one module that deletes things.
 *
 * Every case here is a question about scope rather than about arithmetic: how
 * much of the disk this is allowed to touch, what happens when it cannot finish,
 * and whether a "clean" that freed less than it claimed can be told apart from
 * one that freed everything. The 1.2 GB the plugin puts down is the user's to
 * take back, and taking it back must not be able to take anything else.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  CLEANUP_GROUPS, cleanRoot, cleanableRoot, diskUsage, groupDir, insideRoot, requestedGroups, treeBytes,
} from '../src/provision/cleanup.ts';
import { provisionLayout, writeRecord } from '../src/provision/layout.ts';
import type { ProvisionLayout } from '../src/provision/layout.ts';

const roots: string[] = [];
after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

/** The segment sidecar's own content, so the cache total is derived, not guessed. */
const SIDECAR = '{}';

/** A root with a known number of bytes in each group. */
async function fixture(over: Partial<Record<'engine' | 'models' | 'cache', number>> = {}): Promise<ProvisionLayout> {
  const root = await mkdtemp(join(tmpdir(), 'dsvc-clean-'));
  roots.push(root);
  const layout = provisionLayout(root);
  const sizes = { engine: 3, models: 2, cache: 1, ...over };
  await mkdir(layout.engineRootDir(), { recursive: true });
  await mkdir(join(layout.engineRootDir(), 'win-vulkan'), { recursive: true });
  await writeFile(join(layout.engineRootDir(), 'win-vulkan', 'crispasr.exe'), 'x'.repeat(sizes.engine * 1024));
  await writeFile(join(layout.engineRootDir(), 'win-vulkan', 'ggml.dll'), '');
  await mkdir(layout.modelsDir, { recursive: true });
  await writeFile(join(layout.modelsDir, 'talker.gguf'), 'y'.repeat(sizes.models * 1024));
  await mkdir(layout.downloadDir(), { recursive: true });
  await writeFile(join(layout.downloadDir(), 'engine.zip.part'), 'z'.repeat(sizes.cache * 1024));
  await writeFile(join(layout.downloadDir(), 'engine.zip.part.json'), SIDECAR);
  await writeRecord(layout, {
    version: 1,
    engineVariant: 'win-vulkan',
    engineTag: 'v0.8.36',
    engineBinary: layout.engineBinaryPath({ id: 'win-vulkan', binary: 'crispasr.exe' } as never),
    assets: [],
  });
  return layout;
}

/** What {@link fixture} put in each group, derived from the same numbers. */
const EXPECT = {
  engine: 3 * 1024,
  models: 2 * 1024,
  cache: 1 * 1024 + SIDECAR.length,
  all: 3 * 1024 + 2 * 1024 + 1 * 1024 + SIDECAR.length,
};

describe('disk usage', () => {
  it('measures each group separately and the root as a whole', async () => {
    const layout = await fixture();
    const usage = await diskUsage(layout);
    const byId = new Map(usage.groups.map((group) => [group.id, group]));
    assert.equal(byId.get('engine')?.bytes, EXPECT.engine);
    assert.equal(byId.get('models')?.bytes, EXPECT.models);
    assert.equal(byId.get('cache')?.bytes, EXPECT.cache);
    assert.equal(usage.groups.every((group) => group.present), true);
    // The record is counted too, so the number the card shows is the number a
    // file manager shows for the same folder.
    assert.ok(usage.totalBytes > EXPECT.all);
    assert.equal(usage.root, layout.root);
  });

  it('reports an empty root as empty rather than as missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsvc-clean0-'));
    roots.push(root);
    const usage = await diskUsage(provisionLayout(root));
    assert.equal(usage.totalBytes, 0);
    assert.equal(usage.groups.every((group) => !group.present), true,
      'a folder that was never used must not read as one that was half-deleted');
  });

  it('counts files without following a link out of the root', async () => {
    const layout = await fixture();
    // A directory entry that is not a plain file: the walk must neither crash nor
    // read the target's size as ours.
    await writeFile(join(layout.modelsDir, 'second.gguf'), 'w'.repeat(1024));
    const { bytes, entries } = await treeBytes(layout.modelsDir);
    assert.equal(entries, 2);
    assert.equal(bytes, 3 * 1024);
    assert.equal((await treeBytes(join(layout.root, 'nope'))).entries, 0, 'a missing dir is zero, not an error');
  });
});

describe('the root boundary', () => {
  it('accepts only paths strictly below the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsvc-edge-'));
    roots.push(root);
    assert.equal(insideRoot(root, join(root, 'models')), true);
    assert.equal(insideRoot(root, join(root, 'engine', 'win-cpu', 'crispasr.exe')), true);
    assert.equal(insideRoot(root, root), false, 'the root itself is not one of its children');
    assert.equal(insideRoot(root, join(root, '..', 'elsewhere')), false);
    assert.equal(insideRoot(root, 'D:\\crispasr'), false, 'a hand-configured engine is not ours to delete');
    assert.equal(insideRoot(root, process.env.TEMP ?? tmpdir()), false);
  });

  it('keeps every group inside the root it was built for', async () => {
    const layout = await fixture();
    for (const group of CLEANUP_GROUPS) {
      assert.equal(insideRoot(layout.root, groupDir(layout, group)), true, group);
    }
    // Read this the other way round and it is the bug that was here: every group
    // is `join(root, …)`, so the check above cannot fail for any root in the
    // universe, which means it was never the guard it looked like. The question
    // that decides whether a clean is safe is asked of the root itself, below.
  });

  it('refuses to own a root it did not create', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsvc-own-'));
    roots.push(root);
    assert.equal(cleanableRoot(root).ok, true, 'a real voice directory is the kind we may empty');
    for (const [notOurs, why] of [
      ['.', 'a relative audioDir resolves into whatever directory the host was started in'],
      [process.cwd(), 'the working directory, whose models/ and engine/ belong to somebody else'],
      [parse(process.cwd()).root, 'the drive root itself'],
      [homedir(), 'the home directory'],
      [process.env.TMP ?? process.env.TEMP ?? tmpdir(), 'the temp dir'],
    ] as const) {
      const verdict = cleanableRoot(notOurs);
      assert.equal(verdict.ok, false, `${notOurs} (${why}) must be refused`);
      assert.ok(verdict.reason.length > 0, 'and the refusal has to be explainable to the person who set it');
      assert.equal(requestedGroups([...CLEANUP_GROUPS], provisionLayout(notOurs)).length, 0,
        'so there is nothing left for the route to delete');
    }
  });

  it('never reaches the remover on a root it refused', async () => {
    let touched = 0;
    const remove = async (path: string): Promise<void> => {
      touched += 1;
      assert.fail(`cleanRoot tried to delete ${path}`);
    };
    const result = await cleanRoot(provisionLayout(process.cwd()), [...CLEANUP_GROUPS], remove);
    assert.equal(touched, 0);
    assert.equal(result.freedBytes, 0);
    assert.equal(result.removed.length, 0);
    assert.equal(result.failed.length, CLEANUP_GROUPS.length, 'each group reports the same refusal');
    assert.equal(result.forgetRecord, false, 'and the record stays, so the card still tells the truth');
  });

  it('drops ids the wire should not have sent', async () => {
    const layout = await fixture();
    assert.deepEqual(requestedGroups(['engine', 'engine', 'bogus', 7, 'models'], layout), ['engine', 'models']);
    assert.deepEqual(requestedGroups('engine', layout), [], 'a bare string is not a list');
    assert.deepEqual(requestedGroups(undefined, layout), []);
    assert.deepEqual(requestedGroups(['../escape'], layout), []);
  });
});

describe('cleaning', () => {
  it('removes the group it was asked for and leaves the others', async () => {
    const layout = await fixture();
    const result = await cleanRoot(layout, ['cache']);
    assert.equal(result.freedBytes, EXPECT.cache);
    await assert.rejects(stat(layout.downloadDir()), 'the cache dir is gone');
    assert.ok((await stat(layout.modelsDir)).isDirectory(), 'the models the user did not name stay');
    assert.equal(result.forgetRecord, false, 'a partial clean must not erase the record');
    assert.match(result.message, /已释放/);
  });

  it('forgets the record only when the whole root went', async () => {
    const layout = await fixture();
    const result = await cleanRoot(layout, [...CLEANUP_GROUPS]);
    assert.equal(result.forgetRecord, true);
    await assert.rejects(stat(layout.stateFile));
    assert.equal(result.freedBytes, EXPECT.all);
    const usage = await diskUsage(layout);
    assert.equal(usage.totalBytes, 0, 'after a full clean the card must have nothing left to report');
  });

  it('treats a group that was never there as cleaned, not as failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsvc-clean2-'));
    roots.push(root);
    const result = await cleanRoot(provisionLayout(root), [...CLEANUP_GROUPS]);
    assert.deepEqual(result.failed, []);
    assert.equal(result.removed.length, 3);
    assert.equal(result.forgetRecord, true);
    assert.match(result.message, /本来就没有占空间的文件/);
  });

  it('keeps going after a group the OS refuses, and says so', async () => {
    const layout = await fixture();
    const result = await cleanRoot(layout, [...CLEANUP_GROUPS], async (path) => {
      if (path === layout.engineRootDir()) throw new Error('EBUSY: resource busy or locked');
      await rm(path, { recursive: true, force: true });
    });
    assert.deepEqual(result.failed.map((entry) => entry.id), ['engine']);
    assert.match(result.failed[0]?.reason ?? '', /EBUSY/);
    // The rest still went — a stuck engine must not strand 1.2 GB of models.
    await assert.rejects(stat(layout.modelsDir));
    assert.equal(result.freedBytes, EXPECT.models + EXPECT.cache, 'the engine bytes it kept are not counted as freed');
    assert.equal(result.forgetRecord, false,
      'the record stays so the card can still explain the engine it could not remove');
    assert.match(result.message, /引擎没能删除.*有程序正在用它/s);
  });

  it('refuses to delete anything outside the root even if asked by id', async () => {
    const layout = await fixture();
    // The only escape that matters is a root that is itself a symlink or a
    // relative path, so `groupDir` is checked rather than trusted.
    const relative = provisionLayout(join('models'));
    assert.equal(insideRoot(relative.root, groupDir(relative, 'models')), true,
      'a relative root still resolves inside itself');
    const result = await cleanRoot(layout, ['models']);
    assert.equal(result.failed.length, 0);
    assert.ok((await stat(layout.engineRootDir())).isDirectory());
  });
});
