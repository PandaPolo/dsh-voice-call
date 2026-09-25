/**
 * The unpacker — the step whose output is the path the plugin later executes,
 * and the step that had no test until it installed a DLL as the engine.
 *
 * The fixtures build archive payloads by hand (a fake shell writes files into
 * the scratch directory), because what needs pinning is not `Expand-Archive`
 * but the decisions around it: which file counts as the executable, where the
 * payload ends up, and what happens when there is no executable at all.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createUnpacker, extractCommand } from '../src/provision/unpack.ts';
import { findEngineBinary } from '../src/provision/layout.ts';
import type { UnpackRequest } from '../src/provision/state.ts';
import type { ShellOutcome, ShellRun } from '../src/backends/runner.ts';

const dirs: string[] = [];
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsvc-unpack-'));
  dirs.push(dir);
  return dir;
}
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/**
 * A payload file: padded past the 1 KiB floor that keeps a stray text file named
 * `crispasr.exe` from being mistaken for the engine.
 */
const payload = (marker: string): string => `${marker}\n${'x'.repeat(2048)}`;

/** A shell that extracts by writing the given tree into the destination its command names. */
function fakeShell(tree: Record<string, string>): { run: ShellRun; commands: string[] } {
  const commands: string[] = [];
  const run: ShellRun = async (command) => {
    commands.push(command);
    // The destination is the last quoted argument, exactly as the real command
    // carries it — so a quoting regression shows up here as a missing payload.
    const quoted = command.match(/'([^']*)'/g) ?? [];
    const dest = quoted[quoted.length - 1]?.slice(1, -1);
    assert.ok(dest !== undefined, 'no destination path in the extraction command');
    for (const [path, content] of Object.entries(tree)) {
      const full = join(dest, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content);
    }
    return { exitCode: 0, stdout: '', stderr: '' } satisfies ShellOutcome;
  };
  return { run, commands };
}

async function request(over: Partial<UnpackRequest> = {}): Promise<UnpackRequest> {
  const root = await workspace();
  return {
    archivePath: join(root, 'engine.zip'),
    destDir: join(root, 'engine', 'win-vulkan'),
    binary: 'crispasr.exe',
    format: 'zip',
    ...over,
  };
}

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

describe('engine unpacking', () => {
  it('takes the executable when a same-named DLL is sitting beside it', async () => {
    // The regression this pins: the Vulkan archive ships crispasr.exe *and*
    // crispasr.dll, and matching either one let readdir order decide — producing
    // a recorded "engine" that cannot be launched.
    const input = await request();
    const { run } = fakeShell({
      'crispasr-windows-x86_64-vulkan/crispasr.dll': payload('a dll, not runnable'),
      'crispasr-windows-x86_64-vulkan/crispasr.exe': payload('the engine'),
      'crispasr-windows-x86_64-vulkan/ggml-cpu.dll': payload('a helper dll'),
    });
    const found = await createUnpacker(run)(input);
    // The archive's wrapper directory is flattened away, which is what lets
    // `engineBinaryPath` name the executable exactly, with no search at run time.
    assert.equal(found, join(input.destDir, 'crispasr.exe'));
  });

  it('moves the whole payload directory, so the DLLs stay beside the exe', async () => {
    const input = await request();
    const { run } = fakeShell({
      'pkg/crispasr.exe': payload('engine'),
      'pkg/openblas.dll': payload('needed at load time'),
      'pkg/LICENSE': payload('notice'),
    });
    const found = await createUnpacker(run)(input);
    assert.ok(found !== undefined);
    const landed = (await readdir(input.destDir)).sort();
    assert.deepEqual(landed, ['LICENSE', 'crispasr.exe', 'openblas.dll'],
      'an exe moved out of its DLL directory fails to start with a confusing error');
    await assert.rejects(stat(`${input.destDir}.unpack`), 'the scratch tree is cleaned up');
  });

  it('refuses to invent an engine that the archive does not contain', async () => {
    const input = await request();
    const { run } = fakeShell({
      'pkg/crispasr.dll': payload('only a dll here'),
      'pkg/libcrispasr.so': payload('only a library here'),
    });
    assert.equal(await createUnpacker(run)(input), undefined,
      'a wrong path is worse than no path: the card can explain this one');
  });

  it('reports the archive tool complaint when extraction fails', async () => {
    const input = await request();
    const failing: ShellRun = async () => ({
      exitCode: 1, stdout: '', stderr: 'New-Object : Cannot open archive: found unexpected content',
    });
    await assert.rejects(createUnpacker(failing)(input), /Cannot open archive/);
  });

  it('keeps a leftover from a previous install from breaking a re-run', async () => {
    const input = await request();
    // Destination already holds a stale copy of one payload file, at the
    // flattened path a previous run would have written it to.
    await mkdir(input.destDir, { recursive: true });
    await writeFile(join(input.destDir, 'LICENSE'), 'stale');
    const { run } = fakeShell({ 'pkg/crispasr.exe': payload('engine'), 'pkg/LICENSE': payload('fresh') });
    const found = await createUnpacker(run)(input);
    assert.ok(found !== undefined);
    assert.match(await readFileText(join(input.destDir, 'LICENSE')), /^fresh/);
  });

  it('builds a command per archive format, with flags left raw', () => {
    const zip = extractCommand('C:\\a b\\engine.zip', 'C:\\out dir', 'zip');
    assert.match(zip, /engine\.zip/);
    assert.match(zip, /out dir/);
    assert.equal(zip.includes("'"), true, 'paths with spaces must be quoted');
    if (process.platform === 'win32') {
      assert.match(zip, /^Expand-Archive -LiteralPath /, 'a quoted flag would bind as a value, not a parameter');
      assert.match(zip, /-Force$/);
    } else {
      assert.match(zip, /^unzip -o -q /);
    }
    const tar = extractCommand('/tmp/e.tar.gz', '/tmp/out', 'tar.gz');
    assert.match(tar, /tar -xzf /);
    assert.match(tar, /-C /);
  });

  it('will not take a library whose name merely starts the same', async () => {
    const root = await workspace();
    const tree = join(root, 'payload');
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, 'libcrispasr.so'), payload('library'));
    await writeFile(join(tree, 'crispasr.dll'), payload('wrong kind of file'));
    const { chmod } = await import('node:fs/promises');
    await chmod(join(tree, 'libcrispasr.so'), 0o755);
    await chmod(join(tree, 'crispasr.dll'), 0o755);
    assert.equal(await findEngineBinary(tree, 'crispasr'), undefined,
      'searching for the executable must not return a shared library');
    await writeFile(join(tree, 'crispasr'), payload('the real one'));
    await chmod(join(tree, 'crispasr'), 0o755);
    assert.equal(await findEngineBinary(tree, 'crispasr'), join(tree, 'crispasr'));
  });
});
