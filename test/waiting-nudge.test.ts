/**
 * The experimental waiting-question nudge: an ask nobody answers becomes a
 * card, and the card comes down when the answer finally arrives — without this
 * module ever answering on the human's behalf.
 *
 * Uses the real {@link CallBoard} (the card UI's own semantics are the point of
 * the feature) with a hand-advanced clock, so nothing here sleeps and nothing
 * here needs a harness.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { JobId, JobSpec } from '@deepseek-ai/dsh-jobs';
import { FakeTtsBackend } from '../src/backends/fake.ts';
import { CallBoard, type CallCardEvent } from '../src/callcard/board.ts';
import type { SpeakDeps } from '../src/tools/speak.ts';
import { ASK_TOOL_NAME, WaitingQuestionNudge, type NudgeClock, type WaitingNudgeDeps, type WatchedExecution } from '../src/waiting/nudge.ts';

/** A clock whose due tasks the test releases by hand. */
function fakeClock(): { clock: NudgeClock; fire: () => void; pending: () => number } {
  let seq = 0;
  const tasks = new Map<number, () => void>();
  return {
    clock: {
      schedule(task) {
        const id = ++seq;
        tasks.set(id, task);
        return id;
      },
      cancel(handle) {
        tasks.delete(handle as number);
      },
    },
    fire() {
      for (const [id, task] of [...tasks]) {
        tasks.delete(id);
        task();
      }
    },
    pending() {
      return tasks.size;
    },
  };
}

/**
 * Wait for a real async chain (a speak job writing a file) to reach `want`.
 * Polling rather than a fixed tick count: the job spans several awaits, and a
 * magic number of `setImmediate`s is the kind of test that fails on a busy CI
 * machine and passes on the author's.
 */
async function waitFor(want: () => boolean, what: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!want()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A board with one connected card client, plus the events it received. */
function boardWithClient(): { board: CallBoard; events: CallCardEvent[] } {  const board = new CallBoard();
  const events: CallCardEvent[] = [];
  board.subscribe((event) => events.push(event));
  return { board, events };
}

const ASK = (over: Partial<WatchedExecution> = {}): WatchedExecution => ({
  name: ASK_TOOL_NAME,
  callId: 'call-1',
  arguments: { questions: [{ id: 'q1', question: '要哪个方案?' }] },
  agent: { id: 'session-abcdef12345' },
  ...over,
});

function nudge(board: CallBoard, clock: NudgeClock, delayMs = 300_000, speak?: WaitingNudgeDeps['speak']): WaitingQuestionNudge {
  return new WaitingQuestionNudge({
    board,
    clock,
    callerName: () => 'DeepSeek',
    voice: () => 'customvoice-1',
    delayMs: () => delayMs,
    ...(speak === undefined ? {} : { speak }),
  });
}

describe('waiting-question nudge', () => {
  it('leaves every other tool call completely alone', async () => {
    const { board } = boardWithClient();
    const { clock, pending } = fakeClock();
    const service = nudge(board, clock);
    let ran = 0;
    const out = await service.wrap({ name: 'bash', callId: 'call-b' }, async () => {
      ran++;
      return 'result';
    });
    assert.equal(out, 'result');
    assert.equal(ran, 1);
    assert.equal(pending(), 0, 'no timer for a call that cannot wait on a human');
    assert.equal(board.list().length, 0);
  });

  it('stays out of the way while the feature is off or nobody is watching the card', async () => {
    const { board } = boardWithClient();
    const { clock, pending } = fakeClock();
    const off = new WaitingQuestionNudge({
      board, clock, callerName: () => 'DeepSeek', voice: () => 'v', delayMs: () => 0,
    });
    assert.equal(await off.wrap(ASK(), async () => 'answered'), 'answered');
    assert.equal(pending(), 0);

    const headless = new CallBoard();
    const on = nudge(headless, clock);
    assert.equal(await on.wrap(ASK(), async () => 'answered'), 'answered');
    assert.equal(pending(), 0, 'with no card client connected there is nothing to ring');
  });

  it('rings once the human has been gone long enough, and still never answers', async () => {
    const { board, events } = boardWithClient();
    const { clock, fire } = fakeClock();
    const service = nudge(board, clock);
    let answer: () => void = () => {};
    const pending = new Promise<void>((resolve) => { answer = resolve; });

    const running = service.wrap(ASK(), async () => {
      await pending;
      return { decision: 'accepted' };
    });
    assert.equal(board.list().length, 0, 'a fresh ask is not a nudge');

    fire();
    const card = board.list()[0];
    assert.ok(card, 'the timeout put a card on the board');
    assert.match(card.text, /有一个关于「要哪个方案\?」的问题在等你回答/);
    assert.match(card.text, /5 分钟/);
    assert.equal(card.caller.name, 'DeepSeek');
    assert.equal(card.caller.sessionId, 'def12345');
    assert.equal(events.filter((e) => e.kind === 'ringing').length, 1);

    answer();
    assert.deepEqual(await running, { decision: 'accepted' }, 'the ask result passes through untouched');
  });

  it('counts the questions it is nagging about', () => {
    const { board } = boardWithClient();
    const { clock, fire } = fakeClock();
    const service = nudge(board, clock);
    void service.wrap(ASK({
      callId: 'call-3',
      arguments: { questions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    }), () => new Promise(() => {}));
    fire();
    const card = board.list()[0];
    assert.ok(card);
    assert.match(card.text, /有 3 个问题在等你回答/);
  });

  it('names a topic only when the whole batch agrees on one', () => {
    const { board } = boardWithClient();
    const { clock, fire } = fakeClock();
    const service = nudge(board, clock);
    // The live run said 「有 2 个关于「测试 1：单选」的问题」 about a 单选 AND a
    // 多选: naming questions[0] for a mixed batch tells the human the wrong
    // thing, and the count alone was never the problem.
    void service.wrap(ASK({
      callId: 'call-mixed',
      arguments: { questions: [{ id: 'a', header: '测试 1：单选' }, { id: 'b', header: '测试 2：多选' }] },
    }), () => new Promise(() => {}));
    fire();
    const mixed = board.list()[0];
    assert.ok(mixed);
    assert.match(mixed.text, /有 2 个问题在等你回答/);
    assert.equal(mixed.text.includes('测试 1'), false, 'a mixed batch must not be labelled by its first item');

    const second = new CallBoard();
    second.subscribe(() => {});
    const clock2 = fakeClock();
    const agreed = nudge(second, clock2.clock);
    void agreed.wrap(ASK({
      callId: 'call-agreed',
      arguments: { questions: [{ id: 'a', header: '部署方案' }, { id: 'b', header: '部署方案' }] },
    }), () => new Promise(() => {}));
    clock2.fire();
    assert.match(second.list()[0]?.text ?? '', /有 2 个关于「部署方案」的问题在等你回答/);
  });

  it('takes the card down by itself the moment the question is answered', async () => {
    const { board, events } = boardWithClient();
    const { clock, fire, pending } = fakeClock();
    const service = nudge(board, clock);
    await service.wrap(ASK(), async () => {
      fire();
      assert.equal(board.list().length, 1, 'the card is up while the human still has not answered');
      return 'answered in the chat UI';
    });
    assert.equal(board.list().length, 0, 'answering over there brings this card down');
    assert.equal(pending(), 0, 'no timer is left behind');
    const last = events.at(-1);
    assert.equal(last?.kind, 'settled');
    assert.ok(last?.kind === 'settled' && last.call.reason === '问题已经回答了');
  });

  it('pressing any button on the nudge card only silences it', async () => {
    const { board } = boardWithClient();
    const { clock, fire } = fakeClock();
    const service = nudge(board, clock);
    let release: () => void = () => {};
    const running = service.wrap(ASK({ callId: 'call-ack' }), async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return 'still the human answer';
    });
    fire();
    const ringing = board.list()[0];
    assert.ok(ringing);
    assert.equal(board.answer(ringing.callId, 'accepted').ok, true);
    assert.equal(board.list().length, 0, '接听 does not start a speaking leg — there is nothing to speak');
    release();
    assert.equal(await running, 'still the human answer');
  });

  it('drops the card when the turn is cancelled out from under the ask', async () => {
    const { board } = boardWithClient();
    const { clock, fire, pending } = fakeClock();
    const service = nudge(board, clock);
    const controller = new AbortController();
    let release: () => void = () => {};
    const running = service.wrap(ASK({ callId: 'call-abort', signal: controller.signal }), async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return 'aborted body';
    });
    fire();
    assert.equal(board.list().length, 1);
    controller.abort();
    assert.equal(board.list().length, 0, 'a cancelled conversation leaves no card ringing');
    assert.equal(pending(), 0);
    release();
    assert.equal(await running, 'aborted body');
  });

  it('will not ring into a card UI that closed while the timer was running', () => {
    const board = new CallBoard();
    const disconnect = board.subscribe(() => {});
    const { clock, fire } = fakeClock();
    const service = nudge(board, clock);
    void service.wrap(ASK({ callId: 'call-late' }), () => new Promise(() => {}));
    disconnect();
    fire();
    assert.equal(board.list().length, 0);
  });
});

describe('answering the nudge card out loud', () => {
  /** Speak deps on the fake backend: synthesis writes a file, playback is a no-op. */
  const speakDeps = (dir: string, spoken: string[]): SpeakDeps => ({
    tts: new FakeTtsBackend(),
    startJob: (spec: JobSpec) => {
      spoken.push((spec as { label?: string }).label ?? '');
      return spec.kind as unknown as JobId;
    },
    audioPath: () => join(dir, 'voice-nudge-1.wav'),
    appendNote: () => {},
    injectFailure: () => {},
    coords: () => ({ turn: 1, step: 1 }),
    now: () => 1723600000000,
  });

  /** Ring a card and hand back the board, its events and the still-open ask. */
  async function rung(board: CallBoard, speak: WaitingNudgeDeps['speak']) {
    const events: CallCardEvent[] = [];
    board.subscribe((event) => events.push(event));
    const { clock, fire } = fakeClock();
    const service = nudge(board, clock, 300_000, speak);
    let release: () => void = () => {};
    const running = service.wrap(ASK({ callId: 'call-speak' }), async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return 'the human answered in the chat';
    });
    fire();
    return { events, release, running };
  }

  it('接听 says one sentence about what is waiting, and the card lives until it is done', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-nudge-'));
    try {
      const { board } = boardWithClient();
      const spoken: string[] = [];
      const { events, release, running } = await rung(board, () => speakDeps(dir, spoken));
      const cardId = board.list()[0]?.callId;
      assert.ok(cardId);

      assert.equal(board.answer(cardId, 'accepted').ok, true);
      // 接听 must not retire the card: the sentence has not been heard yet.
      const still = board.list()[0];
      assert.equal(still?.phase, 'active', 'the card stays up on its speaking leg');
      assert.ok(events.some((event) => event.kind === 'active'));

      await waitFor(() => board.list().length === 0, 'the card to retire when the audio is done');
      assert.equal(spoken.length, 1, 'one speak job started');
      assert.match(spoken[0] ?? '', /要哪个方案/, 'the sentence names what is waiting');
      assert.match(spoken[0] ?? '', /有一个关于/, 'one of them is 一个 out loud, not 1 个');
      const last = events.at(-1);
      assert.ok(last?.kind === 'settled' && last.call.status === 'finished');

      release();
      assert.equal(await running, 'the human answered in the chat');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('拒接 says nothing at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-nudge-'));
    try {
      const { board } = boardWithClient();
      const spoken: string[] = [];
      const { release, running } = await rung(board, () => speakDeps(dir, spoken));
      const cardId = board.list()[0]?.callId;
      assert.ok(cardId);
      board.answer(cardId, 'rejected');
      assert.equal(board.list().length, 0);
      assert.deepEqual(spoken, [], 'a call the human declined is not spoken');
      release();
      await running;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a speak path that throws cannot take the host down', async () => {
    // The waiter runs inside CallBoard.answer, i.e. inside the web route's
    // request handler: an exception escaping here is an uncaught exception in
    // the host process. This is the shape the crash had — the wiring handed a
    // `{ id }` projection where the speak pipeline needed the live agent.
    const { board } = boardWithClient();
    const { clock, fire } = fakeClock();
    const service = nudge(board, clock, 300_000, () => {
      throw new TypeError("Cannot read properties of undefined (reading 'id')");
    });
    void service.wrap(ASK({ callId: 'call-throw' }), () => new Promise(() => {}));
    fire();
    const cardId = board.list()[0]?.callId;
    assert.ok(cardId);
    const answered = board.answer(cardId, 'accepted');
    assert.equal(answered.ok, true, 'the answer itself still succeeds');
    assert.equal(board.list().length, 0, 'the card is taken down instead of the process');
  });

  it('a speak pipeline that dies mid-sentence still retires the card', async () => {
    const { board } = boardWithClient();
    const { clock, fire } = fakeClock();
    const brokenTts = {
      id: 'broken',
      synthesize: async () => {
        throw new Error('crispasr.exe 不存在');
      },
      play: async () => {},
    } as unknown as SpeakDeps['tts'];
    const failures: string[] = [];
    const service = nudge(board, clock, 300_000, () => ({
      tts: brokenTts,
      startJob: (spec: JobSpec) => spec.kind as unknown as JobId,
      audioPath: () => join(tmpdir(), 'dsh-voice-nudge-broken.wav'),
      appendNote: () => {},
      injectFailure: (message: string) => failures.push(message),
      coords: () => ({ turn: 1, step: 1 }),
    }));
    void service.wrap(ASK({ callId: 'call-dying' }), () => new Promise(() => {}));
    fire();
    const cardId = board.list()[0]?.callId;
    assert.ok(cardId);
    board.answer(cardId, 'accepted');
    await waitFor(() => board.list().length === 0, 'a failed leg to retire the card');
    assert.equal(failures.length, 1, 'the failure is surfaced, not swallowed');
  });

  it('counts out loud the way Chinese says it: 两个, not 二个', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-voice-nudge-'));
    try {
      const { board } = boardWithClient();
      const spoken: string[] = [];
      const { clock, fire } = fakeClock();
      const service = nudge(board, clock, 300_000, () => speakDeps(dir, spoken));
      void service.wrap(ASK({
        callId: 'call-two',
        arguments: { questions: [{ id: 'a', header: '部署方案' }, { id: 'b', header: '部署方案' }] },
      }), () => new Promise(() => {}));
      fire();
      const cardId = board.list()[0]?.callId;
      assert.ok(cardId);
      // The card is read and keeps its digits; the sentence is heard.
      assert.match(board.list()[0]?.text ?? '', /有 2 个关于「部署方案」的问题在等你回答/);
      board.answer(cardId, 'accepted');
      await waitFor(() => spoken.length > 0, 'the sentence to reach the speak job');
      assert.match(spoken[0] ?? '', /有两个关于「部署方案」的问题需要你回答/);
      assert.equal((spoken[0] ?? '').includes('有二'), false, 'TTS reading 二个 is what this avoids');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still works as a plain dismiss when no speak pipeline is configured', async () => {
    const { board } = boardWithClient();
    const { clock, fire } = fakeClock();
    const service = nudge(board, clock);
    void service.wrap(ASK({ callId: 'call-nospeak' }), () => new Promise(() => {}));
    fire();
    const cardId = board.list()[0]?.callId;
    assert.ok(cardId);
    board.answer(cardId, 'accepted');
    assert.equal(board.list().length, 0, 'without a speak pipeline 接听 is only silence');
  });
});
