/**
 * Call-card units (v0.2): the board registry behind the card UI and the
 * ring channel that presents calls through it. Pure logic — no cordis, no
 * HTTP; the wire glue in `src/callcard/web.ts` stays thin on purpose.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { CallBoard } from '../src/callcard/board.ts';
import { CallCardRingChannel } from '../src/channels/callcard.ts';
import { openCall } from '../src/domain/call.ts';
import type { RingChannel, RingOutcome } from '../src/channels/ring.ts';

/** A minimal caller identity for board state assertions. */
const CALLER = { name: 'DeepSeek', sessionId: 'test-1234' } as const;

describe('call-card board', () => {
  it('opens a call and broadcasts ringing to subscribers', () => {
    const board = new CallBoard();
    const events: unknown[] = [];
    board.subscribe((event) => events.push(event));
    assert.equal(board.hasSubscribers, true);
    board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 1000 }, () => {});
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      kind: 'ringing',
      call: { callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 1000 },
    });
  });

  it('replays the ringing table to a subscriber that connects mid-ring', () => {
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

  it('delivers the first answer to the waiter and settles the call', async () => {
    const board = new CallBoard();
    const events: string[] = [];
    board.subscribe((event) => events.push(event.kind));
    const settled = new Promise<string>((resolve) => {
      board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 0 }, (decision) => resolve(decision));
    });
    assert.deepEqual(board.answer('call-1', 'accepted'), { ok: true });
    assert.equal(await settled, 'accepted');
    assert.deepEqual(events, ['ringing', 'settled']);
    assert.equal(board.list().length, 0);
  });

  it('rejects answers for unknown or already-settled calls', async () => {
    const board = new CallBoard();
    board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 0 }, () => {});
    assert.deepEqual(board.answer('call-1', 'accepted'), { ok: true });
    assert.deepEqual(board.answer('call-1', 'rejected'), { ok: false, reason: 'unknown or already settled call' });
    assert.deepEqual(board.answer('call-never-opened', 'accepted'), { ok: false, reason: 'unknown or already settled call' });
  });

  it('expires an unanswered ring as missed with the reason', async () => {
    const board = new CallBoard();
    const settled = new Promise<{ decision: string; reason?: string }>((resolve) => {
      board.open({ callId: 'call-1', text: 'hi', voice: 'dylan', caller: CALLER, ringAt: 0 }, (decision, reason) => resolve({ decision, reason }));
    });
    board.expire('call-1', 'the ring timed out after 30ms');
    assert.deepEqual(await settled, { decision: 'missed', reason: 'the ring timed out after 30ms' });
    assert.equal(board.list().length, 0);
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
