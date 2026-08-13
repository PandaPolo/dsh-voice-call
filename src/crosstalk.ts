/**
 * Voice notes across sessions (soft dependency on dsh-crosstalk). When the
 * crosstalk bundle is installed, `transcribe({ to })` delivers the transcript
 * to another local session as a labeled peer message with the audio file
 * path attached; crosstalk owns provenance framing. Absent the bundle, the
 * option is simply not offered (the tool errors with a clear message).
 *
 * @module dsh-voice/crosstalk
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AudioRef } from './types.ts';

/** The minimal crosstalk service face dsh-voice consumes (type-only import). */
export interface CrosstalkSendResult {
  readonly messageId: string;
  readonly to: { readonly name: string };
}

/** Deliver one voice note to a peer session; undefined when crosstalk is absent. */
export async function deliverToPeer(
  ctx: Context,
  to: string,
  transcript: string,
  audioRef: AudioRef,
): Promise<{ readonly messageId: string; readonly peer: string } | undefined> {
  const crosstalk = ctx.get('crosstalk') as
    | { send(address: string, input: { readonly text: string; readonly summary?: string }): Promise<CrosstalkSendResult> }
    | undefined;
  if (crosstalk === undefined) {
    throw new Error('dsh-voice: transcribe({ to }) needs the dsh-crosstalk bundle installed — add it to the profile, or drop the `to` argument');
  }
  const sent = await crosstalk.send(to, {
    text: transcript,
    summary: `voice note (audio: ${audioRef.path})`,
  });
  return { messageId: sent.messageId, peer: sent.to.name };
}
