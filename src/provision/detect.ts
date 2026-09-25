/**
 * Device detection: ask the engine what it can actually run.
 *
 * The manifest refuses to offer a 693 MB CUDA archive on a guess, which is the
 * right rule — but a rule that never gets the answer turns a 4090 into a
 * "本机跑不了" list of greyed-out options, which is worse than guessing. So the
 * card's `gpu` field comes from here: `crispasr --diagnostics` prints its
 * compiled backends and the devices it sees, and that is the only authority the
 * variant list should trust.
 *
 * Verified output shape (0.8.28 / 0.8.36, Windows, RTX 4090):
 *
 *   ggml backends : cpu,cuda
 *   Device 0: NVIDIA GeForce RTX 4090, compute capability 8.9, VMM: yes, VRAM: 24563 MiB
 *     [0] gpu    name=CUDA0 desc=NVIDIA GeForce RTX 4090 mem=23036/24563 MiB
 *
 * Detection is best-effort by construction: a missing binary, an engine older
 * than `--diagnostics`, or a shell refusal all come back as `unknown` with a
 * reason, never as an exception — the card must still render, and 未探测到 must
 * be explainable rather than fatal.
 *
 * @module dsh-voice-call/provision/detect
 */
import { buildCommandLine } from '../backends/quote.ts';
import type { ShellRun } from '../backends/runner.ts';
import type { DeviceHint } from './manifest.ts';

/** What the machine turned out to have. */
export interface DeviceReport extends DeviceHint {
  /** The engine's own version string, when it answered. */
  readonly version?: string;
  /** Compiled-in ggml backends, e.g. `['cpu','cuda']`. */
  readonly backends: readonly string[];
  readonly deviceName?: string;
  readonly vramMb?: number;
  /** Why the answer is `unknown`, in one line, for the card. */
  readonly reason?: string;
}

/** The report before anything has been asked. */
export function unknownDevice(os: string = process.platform, arch: string = process.arch): DeviceReport {
  return { os, arch, gpu: 'unknown', backends: [], reason: '尚未探测' };
}

/**
 * Parse `--diagnostics` text. Pure, so the shapes above are testable without
 * ever running a binary.
 */
export function parseDiagnostics(text: string, fallback: DeviceHint): DeviceReport {
  const report: {
    os: string; arch: string; gpu: DeviceReport['gpu']; backends: string[];
    version?: string; deviceName?: string; vramMb?: number;
  } = { os: fallback.os, arch: fallback.arch, gpu: 'unknown', backends: [] };

  const version = /^\s*version\s*:\s*([0-9][\w.\-]*)/mi.exec(text);
  if (version?.[1] !== undefined) report.version = version[1];

  const backends = /ggml backends\s*:\s*([^\r\n]*)/i.exec(text);
  if (backends?.[1] !== undefined) {
    report.backends = backends[1].split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '');
  }

  // The device line carries the name and the total VRAM; the `name=CUDA0` line
  // is the same fact in the ggml device table, so either is enough.
  const device = /Device \d+: (.+?), compute capability [\d.]+.*?VRAM:\s*(\d+) MiB/i.exec(text)
    ?? /name=(?:CUDA|VULKAN)\d+ desc=(.+?) mem=\d+\/(\d+) MiB/i.exec(text);
  if (device?.[1] !== undefined) {
    report.deviceName = device[1].trim();
    const vram = Number(device[2]);
    if (Number.isFinite(vram)) report.vramMb = vram;
  }

  const hasCuda = report.backends.includes('cuda');
  const hasVulkan = report.backends.includes('vulkan');
  // A CUDA device with no compiled CUDA backend is a driver, not an engine: the
  // build cannot use it, so the accelerator that *is* compiled wins.
  if (hasCuda) report.gpu = 'cuda12';
  else if (hasVulkan) report.gpu = 'vulkan';
  else if (report.backends.length > 0) report.gpu = 'none';

  return report;
}

/**
 * Ask `bin` for its diagnostics. `bin` may be the provisioned engine, a
 * hand-configured path, or a bare `crispasr` resolved from PATH; anything that
 * goes wrong returns `unknown` plus the reason.
 */
export async function detectDevice(run: ShellRun, bin: string | undefined): Promise<DeviceReport> {
  const fallback: DeviceHint = { os: process.platform, arch: process.arch, gpu: 'unknown' };
  if (bin === undefined || bin === '') return { ...unknownDevice(), reason: '还没有可用的引擎，先装配再看设备' };
  try {
    const outcome = await run(buildCommandLine([bin, '--diagnostics']));
    const text = `${outcome.stdout}\n${outcome.stderr}`;
    const parsed = parseDiagnostics(text, fallback);
    // Parse first, then explain: an engine that answers correctly while exiting
    // nonzero is still an answer, and a reason is only owed when there is none.
    if (parsed.gpu !== 'unknown') return parsed;
    if (outcome.exitCode !== 0) {
      return { ...parsed, reason: `引擎没能运行（exit ${outcome.exitCode}）：${snippet(text)}` };
    }
    return { ...parsed, reason: '这个引擎版本不报告后端列表（太旧或输出格式变了）' };
  } catch (error) {
    return {
      ...unknownDevice(),
      reason: `探测失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The first non-empty line of an engine's complaint, kept short. */
function snippet(text: string): string {
  const line = text.split(/\r?\n/).find((entry) => entry.trim() !== '') ?? '';
  return line.trim().slice(0, 120);
}

/** One line for the card: what we found, or what stopped us. */
export function describeDevice(report: DeviceReport): string {
  if (report.gpu === 'unknown') return report.reason ?? '未探测到设备';
  const device = report.deviceName !== undefined ? ` · ${report.deviceName}` : '';
  const vram = report.vramMb !== undefined ? ` · ${Math.round(report.vramMb / 1024)} GB` : '';
  const engine = report.version !== undefined ? `（引擎 ${report.version}）` : '';
  switch (report.gpu) {
    case 'cuda12': return `已探测到 CUDA${device}${vram}${engine}`;
    case 'vulkan': return `已探测到 Vulkan${device}${vram}${engine}`;
    default: return `只有 CPU 后端${engine}`;
  }
}
