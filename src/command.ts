/**
 * The `/voice` slash command: flips the `readReplies` toggle live, reports
 * status, or speaks a line directly from the composer. `on`/`off` change the
 * per-session narration toggle; the default follows config.
 *
 * @module dsh-voice/command
 */
import type { Context } from '@deepseek-ai/cordis';
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands';
import type { Session } from '@deepseek-ai/dsh-session';
import { startSpeakJob, type SpeakDeps } from './tools/speak.ts';

/** Facts the command needs; injected so it stays testable. */
export interface VoiceCommandDeps {
  /** The live readReplies toggle. */
  readonly readReplies: () => boolean;
  /** Flip the toggle; returns the new state. */
  readonly setReadReplies: (enabled: boolean) => boolean;
  /** The configured backend ids (for status display). */
  readonly statusLine: () => string;
  /** Build the speak pipeline bound to one session (for `voice speak`). */
  readonly speakDeps: (session: Session) => SpeakDeps;
  /** Current config display (audioDir, backends). */
  readonly configLine: () => string;
  /** The current call mode (ask | direct | off). */
  readonly callMode: () => string;
}

/** Register the `/voice` command on `ctx.commands`. */
export function registerVoiceCommand(ctx: Context, deps: VoiceCommandDeps): void {
  const commands = ctx.get('commands');
  if (commands === undefined) return; // headless deployments without the command registry
  commands.register({
    name: 'voice',
    description: 'dsh-voice: readReplies narration on/off, status, or speak a line directly',
    input: { hint: 'on | off | status | speak <text>' },
    handler: (invocation) => voiceCommand(invocation, deps),
  });
}

async function voiceCommand(invocation: CommandInvocation, deps: VoiceCommandDeps): Promise<CommandResult> {
  const raw = invocation.rawInput.trim();
  if (raw === 'on' || raw === 'off') {
    const now = deps.setReadReplies(raw === 'on');
    return { kind: 'success', text: `dsh-voice readReplies is now ${now ? 'ON' : 'off'}. ${now ? 'The assistant\'s replies will be spoken aloud.' : 'Replies will not be narrated.'}` };
  }
  if (raw === 'status' || raw === '') {
    const state = deps.readReplies() ? 'on' : 'off';
    return {
      kind: 'success',
      text: [
        `dsh-voice-call readReplies: ${state}`,
        deps.statusLine(),
        `callMode: ${deps.callMode()}`,
        deps.configLine(),
        'Use /voice on|off to flip narration, /voice speak <text> to speak a line.',
      ].join('\n'),
    };
  }
  if (raw.startsWith('speak ')) {
    const text = raw.slice('speak '.length).trim();
    if (text === '') return { kind: 'error', text: '/voice speak needs text after "speak".' };
    try {
      const depsForSession = deps.speakDeps(invocation.agent.session);
      const handle = await speakNow(depsForSession, text);
      return { kind: 'success', text: `Speaking on job ${handle.jobId}: "${text}" (audio: ${handle.audioRef.path}).` };
    } catch (error) {
      return { kind: 'error', text: `dsh-voice: could not speak — ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { kind: 'error', text: 'dsh-voice: unknown /voice argument — use on | off | status | speak <text>.' };
}

/** Speak a line and await the background job (for the composer path). */
export async function speakNow(deps: SpeakDeps, text: string): Promise<{ readonly jobId: string; readonly audioRef: { readonly path: string } }> {
  const started = startSpeakJob(deps, { text });
  const outcome = await started.settled;
  if (outcome.status === 'failed') throw new Error(outcome.detail ?? 'speak job failed');
  return { jobId: started.jobId, audioRef: started.audioRef };
}
