/**
 * Archive unpacking for provisioned engines, built on the shell seam the
 * backends already use.
 *
 * Two facts shape this file:
 *
 * 1. Release archives wrap their payload in a top-level directory
 *    (`crispasr-windows-x86_64-cpu/` inside the zip, verified against the
 *    v0.8.36 asset), so "where is the executable" is never a fixed path.
 * 2. On Windows the executable only starts if its DLLs sit **beside it**, so
 *    the whole payload directory has to move as a unit — relocating the exe
 *    alone would produce an engine that fails at load with a confusing
 *    "找不到指定的模块".
 *
 * Hence: extract to scratch, find the executable, move *its containing
 * directory* into place, and hand back the canonical path.
 *
 * `tar` is used for `.tar.gz` everywhere (Windows 10+ ships bsdtar, which
 * decompresses) and PowerShell's `Expand-Archive` for `.zip` on Windows —
 * the one archive tool guaranteed present there. A missing unzip on Linux is
 * reported as `unsupported` with the 手动解压 advice rather than tried with a
 * hand-rolled inflater.
 *
 * @module dsh-voice-call/provision/unpack
 */
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { quoteForShell, shq } from '../backends/quote.ts';
import type { ShellRun } from '../backends/runner.ts';
import { walkForFile } from './layout.ts';
import type { UnpackRequest } from './state.ts';

/**
 * The names to look for, in preference order: exactly what the manifest says the
 * archive contains, plus the `.exe` spelling of it for a POSIX build unpacked on
 * Windows and vice versa.
 *
 * Library forms (`crispasr.dll`, `libcrispasr.so`) are deliberately **not**
 * accepted. They are what the release also ships next to the executable, and
 * taking one because it happened to sort first produced an "installed" engine
 * that fails to launch — a wrong answer is worse than no answer, which the card
 * can at least explain.
 */
function binaryNames(binary: string): string[] {
  const bare = binary.replace(/\.exe$/i, '');
  return [binary, `${bare}.exe`, bare];
}

/**
 * Build the unpacker. `run` is the plugin's shell runner (already carrying the
 * sandbox policy the engine needs); tests inject a fake one.
 */
export function createUnpacker(run: ShellRun): (request: UnpackRequest) => Promise<string | undefined> {
  return async (request: UnpackRequest) => {
    const scratch = `${request.destDir}.unpack`;
    await rm(scratch, { recursive: true, force: true });
    await mkdir(scratch, { recursive: true });
    try {
      const command = extractCommand(request.archivePath, scratch, request.format);
      const outcome = await run(command, { signal: request.signal });
      if (outcome.exitCode !== 0) {
        const detail = (outcome.stderr.trim() === '' ? outcome.stdout.trim() : outcome.stderr.trim()).slice(0, 240);
        throw new Error(`解压失败（exit ${outcome.exitCode}）${detail === '' ? '' : `：${detail}`}`);
      }
      const found = await walkForFile(scratch, binaryNames(request.binary), 800);
      if (found === undefined) return undefined;
      // The payload directory travels whole: exe and its DLLs stay together.
      const payload = dirname(found);
      await mkdir(request.destDir, { recursive: true });
      for (const entry of await readdir(payload)) {
        await rename(join(payload, entry), join(request.destDir, entry)).catch(async (error: unknown) => {
          // A leftover from a previous install means the destination is not
          // empty; drop it once and retry, so re-provisioning is idempotent.
          if (!isAlreadyThere(error)) throw error;
          await rm(join(request.destDir, entry), { recursive: true, force: true });
          await rename(join(payload, entry), join(request.destDir, entry));
        });
      }
      return join(request.destDir, found.slice(payload.length + 1));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };
}

/** The platform's archive command; flags stay raw because a quoted flag binds as a value. */
export function extractCommand(archive: string, dest: string, format: 'zip' | 'tar.gz'): string {
  if (format === 'tar.gz') {
    return `tar -xzf ${quoteForShell(archive)} -C ${quoteForShell(dest)}`;
  }
  if (process.platform === 'win32') {
    return `Expand-Archive -LiteralPath ${quoteForShell(archive)} -DestinationPath ${quoteForShell(dest)} -Force`;
  }
  return `unzip -o -q ${shq(archive)} -d ${shq(dest)}`;
}

function isAlreadyThere(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM';
}
