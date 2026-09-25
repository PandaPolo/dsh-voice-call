/**
 * The shell runner every command-based backend shares. Built from `ctx.shell`
 * at plugin load; injected as a plain function so backends stay unit-testable
 * without a live shell service.
 *
 * @module dsh-voice/backends/runner
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';

/**
 * Per-call sandbox policy (structural shape of `SandboxExecutionPolicy` from
 * `@deepseek-ai/dsh-sandbox` — kept local so the plugin needs no direct dep
 * on that package; the shape is compatible when passed to `shell.resolve`).
 */
export interface VoiceSandboxPolicy {
  readonly mode: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly workspaceRoot: string;
  readonly sessionId?: SessionId;
}

/** One foreground command outcome, normalized for backends. */
export interface ShellOutcome {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one shell command; resolves with the outcome (nonzero exit included). */
export type ShellRun = (command: string, opts?: { readonly signal?: AbortSignal; readonly stdin?: string; readonly sandboxPolicy?: VoiceSandboxPolicy }) => Promise<ShellOutcome>;

/** Build the runner from `ctx.shell` (throws on use when the seam is absent). */
export function makeShellRunner(ctx: Context, policy?: VoiceSandboxPolicy): ShellRun {
  return async (command, opts) => {
    const shell = ctx.get('shell');
    if (shell === undefined) {
      throw new Error('dsh-voice: ctx.shell is not available in this deployment');
    }
    const request = {
      command,
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}),
      ...(opts?.sandboxPolicy !== undefined ? { sandboxPolicy: opts.sandboxPolicy } : policy !== undefined ? { sandboxPolicy: policy } : {}),
    };
    const execution = await shell.execute(shell.resolve(request));
    const result = await execution.result();
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.text,
      stderr: result.stderr.text,
    };
  };
}
