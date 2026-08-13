/**
 * Integration (macOS `say`, available on this machine): `speak("build
 * finished")` produces a playable file under audioDir and returns its ref
 * within the job. We assert the file exists and is non-empty (no assertion
 * on audible output, per the spec). Skipped when say is unavailable.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { probeSay } from '../src/backends/probe.ts';
import { SayTtsBackend } from '../src/backends/say.ts';
import { makeShellRunner, type ShellRun } from '../src/backends/runner.ts';

const sayAvailable = process.platform === 'darwin' && probeSay();

/** A fake context whose shell seam runs commands through the real `sh`. */
function realShellCtx(): { get(key: string): unknown } {
  const run = async (spec: { command: string }): Promise<{
    exitCode: number | null;
    signal: null;
    timedOut: boolean;
    aborted: boolean;
    timeoutMs: number;
    stdout: { text: string; truncated: boolean };
    stderr: { text: string; truncated: boolean };
  }> => {
    const { execFile } = await import('node:child_process');
    return await new Promise((resolve, reject) => {
      execFile('/bin/sh', ['-c', spec.command], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 60000, stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false } });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : 1;
        resolve({ exitCode: code, signal: null, timedOut: false, aborted: false, timeoutMs: 60000, stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false } });
      });
    });
  };
  return {
    get(key: string): unknown {
      if (key === 'shell') {
        return {
          resolve: (request: { command: string }) => ({ ...request, workdir: '.', timeoutMs: 60000, stdoutMaxBytes: 4 * 1024 * 1024, sandboxPolicy: undefined }),
          run,
        };
      }
      return undefined;
    },
  };
}

describe('say backend integration', { skip: sayAvailable ? false : 'macOS say is not available' }, () => {
  it('synthesizes a non-empty playable file under audioDir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-say-'));
    try {
      const run: ShellRun = makeShellRunner(realShellCtx() as never);
      const backend = new SayTtsBackend(run);
      const dest = join(dir, 'build-finished.m4a');
      const result = await backend.synthesize({ text: 'build finished, zero failures' }, dest);
      assert.equal(result.mime, 'audio/mp4');
      const info = await stat(dest);
      assert.ok(info.size > 0, 'synthesized file must be non-empty');
      // The m4a header is readable by `file`-style sniffing: first bytes are
      // the ISO BMFF box ("ftyp").
      const { readFile } = await import('node:fs/promises');
      const head = await readFile(dest);
      assert.equal(head.subarray(4, 8).toString('ascii'), 'ftyp');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes voice and rate through to the command line', async () => {
    const commands: string[] = [];
    const run: ShellRun = async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const backend = new SayTtsBackend(run);
    await backend.synthesize({ text: 'hi', voice: 'Samantha', rate: 180 }, '/tmp/x.m4a');
    assert.equal(commands.length, 1);
    assert.match(commands[0] ?? '', /--voice 'Samantha'/);
    assert.match(commands[0] ?? '', /-r '180'/);
    assert.match(commands[0] ?? '', /--data-format=aac/);
  });
});
