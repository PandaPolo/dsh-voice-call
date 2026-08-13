/**
 * `readReplies` — the per-session toggle that auto-narrates the assistant's
 * reply text. A `session/event` listener watches for assembled
 * `assistant/message` events and, while the toggle is on, runs the same
 * speak job pipeline (synthesis + best-effort playback + outbound
 * `voice/note` card). It never records, and it is off unless configured or
 * flipped on with `/voice on`.
 *
 * @module dsh-voice/read-replies
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { JobOutcome } from '@deepseek-ai/dsh-jobs';
import { startSpeakJob, type SpeakDeps } from './tools/speak.ts';

/** The live readReplies state: per-session value, defaulted from config. */
export class ReadRepliesToggle {
  private value: boolean;

  constructor(defaultValue: boolean) {
    this.value = defaultValue;
  }

  /** Whether narration is currently on. */
  get enabled(): boolean {
    return this.value;
  }

  /** Flip the live value; returns the new state. */
  set(enabled: boolean): boolean {
    this.value = enabled;
    return this.value;
  }
}

/** Extract the plain text of an assistant message's content blocks. */
export function assistantText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content
    .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text' && typeof block.text === 'string' && block.text !== '')
    .map((block) => block.text)
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * Install the narration listener. `makeSpeakDeps` builds the speak pipeline
 * bound to the session that owns each event; the toggle decides whether to
 * fire.
 */
export function installReadReplies(
  ctx: Context,
  toggle: ReadRepliesToggle,
  makeSpeakDeps: (session: Session) => SpeakDeps,
): void {
  ctx.on('session/event', (session, event) => {
    if (!toggle.enabled) return;
    if (event.type !== 'assistant/message') return;
    const text = assistantText(event.data.message.content);
    if (text === '') return;
    try {
      startSpeakJob(makeSpeakDeps(session), { text }).settled.catch((error: unknown) => {
        ctx.logger.warn('dsh-voice: readReplies narration job errored', error);
      });
    } catch (error) {
      ctx.logger.warn('dsh-voice: could not start readReplies narration', error);
    }
  });
}

/** Shared narration outcome type for consumers that await it. */
export type NarrationOutcome = JobOutcome;
