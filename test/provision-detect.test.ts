/**
 * Device detection, pinned against the real `--diagnostics` output this plugin
 * runs on (RTX 4090, engine 0.8.28), plus the shapes it must survive: a Vulkan
 * box, a CPU-only build, an engine that says nothing, and a shell that throws.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectDevice, describeDevice, parseDiagnostics, unknownDevice } from '../src/provision/detect.ts';
import type { ShellOutcome, ShellRun } from '../src/backends/runner.ts';

const CUDA_BOX = `
=== build info ===
  version       : 0.8.28
  git sha       : 99e990ae
  os            : windows
  arch          : x86_64
  ggml backends : cpu,cuda
  cuda archs    : 60-real,86-real,89-real,120-virtual
=== ggml backends + devices ===
ggml_cuda_init: found 1 CUDA devices (Total VRAM: 24563 MiB):
  Device 0: NVIDIA GeForce RTX 4090, compute capability 8.9, VMM: yes, VRAM: 24563 MiB
  registered backends: 2
    [0] CUDA (devices: 1)
    [1] CPU (devices: 1)
  registered devices : 2
    [0] gpu    name=CUDA0 desc=NVIDIA GeForce RTX 4090 mem=23036/24563 MiB id=0000:01:00.0
    [1] cpu    name=CPU desc=13th Gen Intel(R) Core(TM) i9-13900KF mem=18751/32534 MiB id=?
`;

const VULKAN_BOX = `
  version       : 0.8.36
  ggml backends : cpu,vulkan
  registered devices : 2
    [0] gpu    name=VULKAN0 desc=Intel(R) Arc(TM) A770 Graphics mem=14300/16384 MiB id=?
`;

const CPU_BOX = `
  version       : 0.8.36
  ggml backends : cpu
`;

const win = { os: 'win32', arch: 'x64', gpu: 'unknown' } as const;

function runner(result: Partial<ShellOutcome>, throws = false): ShellRun {
  return async () => {
    if (throws) throw new Error('shell is not available in this deployment');
    return { exitCode: 0, stdout: '', stderr: '', ...result };
  };
}

describe('device detection', () => {
  it('reads the CUDA box from its own words', () => {
    const report = parseDiagnostics(CUDA_BOX, win);
    assert.equal(report.gpu, 'cuda12');
    assert.deepEqual(report.backends, ['cpu', 'cuda']);
    assert.equal(report.version, '0.8.28');
    assert.equal(report.deviceName, 'NVIDIA GeForce RTX 4090');
    assert.equal(report.vramMb, 24563);
    assert.equal(describeDevice(report), '已探测到 CUDA · NVIDIA GeForce RTX 4090 · 24 GB（引擎 0.8.28）');
  });

  it('reads a Vulkan-only box, and a CPU-only build', () => {
    const vulkan = parseDiagnostics(VULKAN_BOX, win);
    assert.equal(vulkan.gpu, 'vulkan');
    assert.equal(vulkan.deviceName, 'Intel(R) Arc(TM) A770 Graphics');
    assert.match(describeDevice(vulkan), /Vulkan/);
    const cpu = parseDiagnostics(CPU_BOX, win);
    assert.equal(cpu.gpu, 'none', 'a compiled CPU-only build has no accelerator to offer');
    assert.equal(describeDevice(cpu), '只有 CPU 后端（引擎 0.8.36）');
  });

  it('does not claim an accelerator the build cannot use', () => {
    // A driver present but no CUDA compiled in: the CPU build sees the GPU and
    // still cannot drive it, which is exactly the case a 693 MB download must
    // not be offered for.
    const report = parseDiagnostics('  ggml backends : cpu\n  Device 0: NVIDIA GeForce RTX 4090, compute capability 8.9, VMM: yes, VRAM: 24563 MiB\n', win);
    assert.equal(report.gpu, 'none');
  });

  it('says unknown, with a reason, when the output means nothing', () => {
    for (const text of ['', 'usage: crispasr [options]', 'no such option: --diagnostics']) {
      const report = parseDiagnostics(text, win);
      assert.equal(report.gpu, 'unknown', `interpreted "${text.slice(0, 24)}" as ${report.gpu}`);
      assert.deepEqual(report.backends, []);
    }
    assert.match(describeDevice(unknownDevice()), /尚未探测/);
  });

  it('keeps the os/arch it was given', () => {
    const report = parseDiagnostics(CUDA_BOX, { os: 'darwin', arch: 'arm64', gpu: 'unknown' });
    assert.equal(report.os, 'darwin');
    assert.equal(report.arch, 'arm64');
  });

  it('asks the binary the plugin would actually run', async () => {
    const asked: string[] = [];
    const run: ShellRun = async (command) => {
      asked.push(command);
      return { exitCode: 0, stdout: CUDA_BOX, stderr: '' };
    };
    const report = await detectDevice(run, 'D:\\crispasr\\crispasr.exe');
    assert.equal(report.gpu, 'cuda12');
    assert.match(asked[0] ?? '', /diagnostics/);
    assert.ok((asked[0] ?? '').includes('crispasr.exe'), 'the configured path is the one asked');
  });

  it('degrades to unknown instead of throwing when the engine cannot answer', async () => {
    const noBin = await detectDevice(runner({}), undefined);
    assert.equal(noBin.gpu, 'unknown');
    assert.match(noBin.reason ?? '', /还没有可用的引擎/);

    const broken = await detectDevice(runner({}, true), 'crispasr');
    assert.equal(broken.gpu, 'unknown');
    assert.match(broken.reason ?? '', /shell is not available/);

    // A missing binary fails with *text* from the shell, so the reason has to
    // name the exit rather than blaming the engine version.
    const absent = await detectDevice(runner({
      exitCode: 1, stdout: '', stderr: "The term 'D:\\nope\\crispasr.exe' is not recognized as a cmdlet\n",
    }), 'D:\\nope\\crispasr.exe');
    assert.equal(absent.gpu, 'unknown');
    assert.match(absent.reason ?? '', /引擎没能运行（exit 1）/, absent.reason);
    assert.match(absent.reason ?? '', /not recognized/, 'the engine said why');

    const old = await detectDevice(runner({ stdout: 'usage: crispasr' }), 'crispasr');
    assert.equal(old.gpu, 'unknown');
    assert.match(old.reason ?? '', /不报告后端列表/);
  });

  it('trusts an answer over a nonzero exit', async () => {
    // Some builds print diagnostics to stderr and still exit nonzero; the device
    // fact is real and must not be discarded because of the status code.
    const report = await detectDevice(runner({ exitCode: 3, stdout: '', stderr: CUDA_BOX }), 'crispasr');
    assert.equal(report.gpu, 'cuda12');
    assert.equal(report.deviceName, 'NVIDIA GeForce RTX 4090');
  });
});
