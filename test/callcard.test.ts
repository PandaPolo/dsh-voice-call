/**
 * Call-card units (v0.2): the board registry behind the card UI, the ring
 * channel that presents calls through it, and the leg reporting that keeps an
 * accepted call on screen until its audio is done. Pure logic — no cordis, no
 * HTTP; the wire glue in `src/callcard/web.ts` stays thin on purpose.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JobId, JobSpec } from '@deepseek-ai/dsh-jobs';
import { FakeTtsBackend } from '../src/backends/fake.ts';
import { CallBoard, type CallCardSettledState } from '../src/callcard/board.ts';
import { CallCardRingChannel } from '../src/channels/callcard.ts';
import { openCall } from '../src/domain/call.ts';
import type { RingChannel, RingOutcome } from '../src/channels/ring.ts';
import { runOfferCall } from '../src/tools/offer-call.ts';
import type { SpeakDeps } from '../src/tools/speak.ts';
import type { VoiceCallData } from '../src/types.ts';

/** A minimal caller identity for board state assertions. */
const CALLER = { name: 'DeepSeek', sessionId: 'test-1234' } as const;

/** A board with one connected card client and a fixed clock. */
function boardWithClient(now = 555): { board: CallBoard; events: unknown[] } {
  const board = new CallBoard(() => now);
  const events: unknown[] = [];
  board.subscribe((event) => events.push(event));
  return { board, events };
}

/** The kinds only, which is what the lifecycle assertions are about. */
function kinds(events: readonly unknown[]): string[] {
  return events.map((event) => (event as { kind: string }).kind);
}

describe('call-card board', () => {
  it('opens a call and broadcasts ringing to subscribers', () => {
    const { board, events } = boardWithClient();
    board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 1000 }, () => {});
    assert.deepEqual(events, [{
      kind: 'ringing',
      call: { callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 1000, phase: 'ringing' },
    }]);
  });

  it('replays the live table to a subscriber that connects mid-ring', () => {
    const board = new CallBoard();
    board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 1000 }, () => {});
    board.open({ callId: 'call-2', text: 'yo', voice: 'aiden', caller: CALLER, ringAt: 2000 }, () => {});
    const replayed: string[] = [];
    board.subscribe((event) => {
      if (event.kind === 'ringing') replayed.push(event.call.callId);
    });
    // Newest first, so a refreshed page renders the latest ring on top.
    assert.deepEqual(replayed, ['call-2', 'call-1']);
  });

  it('replays an accepted call to a subscriber that connects mid-call as active', () => {
    const { board } = boardWithClient();
    board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 1000 }, () => {});
    board.answer('call-1', 'accepted');
    const replayed: unknown[] = [];
    board.subscribe((event) => replayed.push(event));
    assert.equal(replayed.length, 1);
    assert.deepEqual(replayed[0], {
      kind: 'active',
      call: { callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 1000, phase: 'active', answeredAt: 555 },
    });
  });

  it('keeps an accepted call on the board: the answer starts the active leg', async () => {
    const { board, events } = boardWithClient();
    const settled = new Promise<string>((resolve) => {
      board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 0 }, (decision) => resolve(decision));
    });
    assert.deepEqual(board.answer('call-1', 'accepted'), { ok: true });
    assert.equal(await settled, 'accepted');
    assert.deepEqual(kinds(events), ['ringing', 'active']);
    assert.equal(board.list().length, 1);
    assert.equal(board.list()[0]?.phase, 'active');
    assert.equal(board.list()[0]?.answeredAt, 555);
  });

  it('settles a rejected answer on the spot', () => {
    const { board, events } = boardWithClient();
    board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 0 }, () => {});
    board.answer('call-1', 'rejected');
    assert.deepEqual(kinds(events), ['ringing', 'settled']);
    assert.equal(board.list().length, 0);
  });

  it('advances the active leg to playing once, then ends it when the audio is done', () => {
    const { board, events } = boardWithClient();
    board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 0 }, () => {});
    board.answer('call-1', 'accepted');
    board.playing('call-1');
    board.playing('call-1');
    assert.deepEqual(kinds(events), ['ringing', 'active', 'active']);
    assert.equal(board.list()[0]?.playing, true);
    board.settle('call-1', 'finished');
    assert.deepEqual(events.at(-1), { kind: 'settled', call: { callId: 'call-1', decision: 'accepted', status: 'finished' } });
    assert.equal(board.list().length, 0);
  });

  it('reports a failed leg with the reason the card should show', () => {
    const { board, events } = boardWithClient();
    board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 0 }, () => {});
    board.answer('call-1', 'accepted');
    board.settle('call-1', 'failed', 'crispasr: synthesis failed (exit 1)');
    assert.deepEqual(events.at(-1), {
      kind: 'settled',
      call: { callId: 'call-1', decision: 'accepted', status: 'failed', reason: 'crispasr: synthesis failed (exit 1)' },
    });
  });

  it('ignores leg reporting for a call that never reached its active leg', () => {
    const { board, events } = boardWithClient();
    board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 0 }, () => {});
    board.playing('call-1');
    board.settle('call-1', 'finished');
    board.playing('call-never-opened');
    board.settle('call-never-opened', 'failed');
    assert.deepEqual(kinds(events), ['ringing']);
    assert.equal(board.list().length, 1);
  });

  it('rejects answers for unknown or already-settled calls', async () => {
    const { board } = boardWithClient();
    board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 0 }, () => {});
    assert.deepEqual(board.answer('call-1', 'accepted'), { ok: true });
    assert.deepEqual(board.answer('call-1', 'rejected'), { ok: false, reason: 'unknown or already settled call' });
    assert.deepEqual(board.answer('call-never-opened', 'accepted'), { ok: false, reason: 'unknown or already settled call' });
  });

  it('expires an unanswered ring as missed with the reason', async () => {
    const { board } = boardWithClient();
    const settled = new Promise<{ decision: string; reason?: string }>((resolve) => {
      board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 0 }, (decision, reason) => resolve({ decision, reason }));
    });
    board.expire('call-1', 'the ring timed out after 30ms');
    assert.deepEqual(await settled, { decision: 'missed', reason: 'the ring timed out after 30ms' });
    assert.equal(board.list().length, 0);
  });

  it('never lets a timed-out ring settle an answered call', () => {
    const { board, events } = boardWithClient();
    board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 0 }, () => {});
    board.answer('call-1', 'accepted');
    board.expire('call-1', 'the ring timed out after 30ms');
    assert.deepEqual(kinds(events), ['ringing', 'active']);
    assert.equal(board.list().length, 1);
  });

  it('never lets a broken subscriber break the board', () => {
    const board = new CallBoard();
    board.subscribe(() => {
      throw new Error('broken tab');
    });
    board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 0 }, () => {});
    assert.equal(board.list().length, 1);
  });
});

describe('call-card ring channel', () => {
  const call = () => openCall({ text: 'hello there', voice: 'serena' }, () => 123456);

  /** A board with one connected card client. */
  const ringingBoard = (): CallBoard => {
    const board = new CallBoard();
    board.subscribe(() => {});
    return board;
  };

  /** A fallback channel recording that it was used. */
  const fallbackChannel = (): RingChannel & { used: () => boolean } => {
    let used = false;
    return {
      used: () => used,
      async ring(): Promise<RingOutcome> {
        used = true;
        return { kind: 'answered', decision: 'later' };
      },
    };
  };

  it('rings the card and resolves with the human answer', async () => {
    const board = ringingBoard();
    const channel = new CallCardRingChannel({
      board,
      callerName: () => 'DeepSeek',
      ringTimeoutMs: () => 5_000,
    });
    const pending = channel.ring({ call: call() });
    await Promise.resolve();
    const [state] = board.list();
    assert.ok(state);
    assert.equal(state.caller.name, 'DeepSeek');
    assert.equal(state.text, 'hello there');
    board.answer(state.callId, 'accepted');
    assert.deepEqual(await pending, { kind: 'answered', decision: 'accepted' });
    // Resolving the ring does not clear the card: the call is now on its leg.
    assert.equal(board.list().length, 1);
  });

  it('takes the card down when the turn is cancelled, rather than ringing to the ceiling', async () => {
    const board = ringingBoard();
    // The schema allows a ten-minute ring, which is how long this one would have
    // run: the channel used to read `request.signal` not at all, so a cancelled
    // conversation left the card on screen, its timer armed, its board entry and
    // its text held, and the agent's turn still awaiting an answer nobody was
    // going to give. The v0.1 prompt channel has always passed the signal on.
    const channel = new CallCardRingChannel({ board, callerName: () => 'DeepSeek', ringTimeoutMs: () => 600_000 });
    const controller = new AbortController();
    const pending = channel.ring({ call: call(), signal: controller.signal });
    await Promise.resolve();
    assert.equal(board.list().length, 1, 'the card is up');
    controller.abort();
    assert.deepEqual(await pending, { kind: 'refused', reason: 'the turn was cancelled while the call was ringing' });
    assert.equal(board.list().length, 0, 'and it came down with the cancellation');
  });

  it('never rings a card for a turn that was already gone', async () => {
    const board = ringingBoard();
    const channel = new CallCardRingChannel({ board, callerName: () => 'DeepSeek', ringTimeoutMs: () => 5_000 });
    const controller = new AbortController();
    controller.abort();
    const outcome = await channel.ring({ call: call(), signal: controller.signal });
    assert.equal(outcome.kind, 'refused');
    assert.equal(board.list().length, 0, 'a card that flashes for one tick is worse than no card');
  });

  it('shows the calling session tail as the caller identity', async () => {
    const board = ringingBoard();
    const channel = new CallCardRingChannel({ board, callerName: () => 'DeepSeek', ringTimeoutMs: () => 5_000 });
    const agent = { id: 'sess-abcdefgh1234' } as Agent;
    const pending = channel.ring({ call: call(), agent });
    await Promise.resolve();
    const [state] = board.list();
    assert.ok(state);
    assert.equal(state.caller.sessionId, 'efgh1234');
    board.answer(state.callId, 'later');
    await pending;
  });

  it('routes leg reports for one call onto that call on the board', async () => {
    const { board, events } = boardWithClient();
    const channel = new CallCardRingChannel({ board, callerName: () => 'DeepSeek', ringTimeoutMs: () => 5_000 });
    const pending = channel.ring({ call: call() });
    await Promise.resolve();
    const [state] = board.list();
    assert.ok(state);
    const leg = channel.leg(state.callId);
    board.answer(state.callId, 'accepted');
    await pending;
    leg.playing();
    leg.settle('failed', 'playback failed (exit 1)');
    assert.deepEqual(kinds(events), ['ringing', 'active', 'active', 'settled']);
    assert.equal(board.list().length, 0);
  });

  it('settles a timed-out ring as missed', async () => {
    const board = ringingBoard();
    const channel = new CallCardRingChannel({ board, callerName: () => 'DeepSeek', ringTimeoutMs: () => 15 });
    const outcome = await channel.ring({ call: call() });
    assert.deepEqual(outcome, { kind: 'answered', decision: 'missed' });
    assert.equal(board.list().length, 0);
  });

  it('falls back to the prompt channel when no card client is connected', async () => {
    const board = new CallBoard(); // no subscribers
    const fallback = fallbackChannel();
    const channel = new CallCardRingChannel({ board, callerName: () => 'DeepSeek', ringTimeoutMs: () => 5_000, fallback });
    const outcome = await channel.ring({ call: call() });
    assert.equal(fallback.used(), true);
    assert.deepEqual(outcome, { kind: 'answered', decision: 'later' });
    assert.equal(board.list().length, 0);
  });

  it('refuses when no card client is connected and no fallback exists', async () => {
    const board = new CallBoard();
    const channel = new CallCardRingChannel({ board, callerName: () => 'DeepSeek', ringTimeoutMs: () => 5_000 });
    const outcome = await channel.ring({ call: call() });
    assert.deepEqual(outcome, { kind: 'refused', reason: 'no call-card client is connected' });
  });
});

describe('offer_call with the card channel', () => {
  /** Speak deps on the fake backend: synthesis writes a file, playback is a no-op. */
  const speakDeps = (dir: string): SpeakDeps => ({
    tts: new FakeTtsBackend(),
    startJob: (spec: JobSpec) => spec.kind as unknown as JobId,
    audioPath: () => join(dir, 'voice-speak-1.wav'),
    appendNote: () => {},
    injectFailure: () => {},
    coords: () => ({ turn: 1, step: 1 }),
    now: () => 1723600000000,
  });

  it('holds the card from the answer to the end of the speak job', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-leg-'));
    try {
      const { board, events } = boardWithClient();
      let ended!: (call: CallCardSettledState) => void;
      const settledEvent = new Promise<CallCardSettledState>((resolve) => {
        ended = resolve;
      });
      board.subscribe((event) => {
        if (event.kind === 'settled') ended(event.call);
      });
      const channel = new CallCardRingChannel({ board, callerName: () => 'DeepSeek', ringTimeoutMs: () => 5_000 });
      const calls: VoiceCallData[] = [];
      const pending = runOfferCall({
        ring: channel,
        callMode: () => 'card',
        speak: speakDeps(dir),
        appendCall: (data) => calls.push(data),
      }, { text: 'the build is green' });

      await Promise.resolve();
      const [state] = board.list();
      assert.ok(state);
      board.answer(state.callId, 'accepted');
      const output = await pending;

      // The tool returns while the audio is still being made...
      assert.equal(output.status, 'accepted');
      assert.deepEqual(kinds(events), ['ringing', 'active']);
      assert.equal(board.list().length, 1);
      // ...and the card is only retired once the job has played it: a `playing`
      // advance, then the settle the client holds the card on.
      const settled = await settledEvent;
      assert.deepEqual(settled, { callId: state.callId, decision: 'accepted', status: 'finished' });
      assert.deepEqual(kinds(events), ['ringing', 'active', 'active', 'settled']);
      assert.equal(board.list().length, 0);
      assert.equal(calls[0]?.decision, 'accepted');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
