/**
 * The experimental "you have a question waiting" nudge (spike).
 *
 * A host question (`ask_user_question`) is a suspended promise with no timeout
 * anywhere in the harness: `UserQuestionService.ask()` awaits the
 * `user-questions/request` waterfall until a UI provider answers, and nothing
 * gives up (`dsh-user-questions/lib/index.js` carries no timer at all). An
 * agent parked there is parked forever, so it cannot escalate itself — this
 * module is what notices instead.
 *
 * Why wrap the tool dispatch rather than the question waterfall: the waterfall
 * is bridged to the browser by `dsh-api-remotes`, whose listener parks the
 * chain until the remote answers (`forwardWaterfall` in
 * `dsh-api-remotes/lib/index.js`). A listener registered after that bridge
 * never sees the request at all, so observing there means winning a
 * registration-order race. `tools/execute` wraps the tool BODY, which is what
 * awaits the human — its pending span IS the cold-deck time, it needs no
 * ordering win, and it cannot swallow anyone's question.
 *
 * What 接听 does: says one sentence out loud — 有关于「某件事」的问题需要你回答
 * — and takes the card down when the audio is done. It still does NOT answer.
 * Answering from the card would mean claiming the `user-questions/request`
 * waterfall, and this module never touches it: the question stays open in the
 * chat UI, exactly as it was, until the human picks there.
 *
 * @module dsh-voice-call/waiting/nudge
 */
import type { JobOutcome } from '@deepseek-ai/dsh-jobs';
import type { CallLegStatus } from '../domain/call.ts';
import type { CallBoard } from '../callcard/board.ts';
import type { SpeakDeps } from '../tools/speak.ts';
import { startSpeakJob, truncateLabel } from '../tools/speak.ts';

/** The tool the host's ask flow dispatches through (`dsh-tool-ask-user`). */
export const ASK_TOOL_NAME = 'ask_user_question';

/**
 * How long an accepted nudge may wait for its sentence before the card gives
 * up on it. Synthesis is near real-time, so this only catches a wedged TTS
 * process — the same ceiling `offer_call` puts on its leg.
 */
const SPEAK_LEG_CAP_MS = 120_000;

/** The only part of a tool execution this unit reads, so tests need no harness. */
export interface WatchedExecution {
  readonly name: string;
  readonly callId: string;
  readonly arguments?: unknown;
  /**
   * The host's LIVE agent for this call. Only `id` is read here, but the whole
   * object is handed to `speak` — the speak pipeline needs `agent.session.id`
   * and `agent.inject(...)`, so a `{ id }` projection is not enough.
   */
  readonly agent?: { readonly id: string } | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Timer source, injectable so the tests advance time without waiting. */
export interface NudgeClock {
  schedule(task: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/** The real timer, with the handle kept alive-but-not-blocking where possible. */
export const systemClock: NudgeClock = {
  schedule(task, ms) {
    const handle = setTimeout(task, ms);
    // A waiting question must never be the reason a host process stays up.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** Everything the nudge needs; injected so the card board stays the only host coupling. */
export interface WaitingNudgeDeps {
  /** The same board the call-card UI streams from. */
  readonly board: CallBoard;
  /** Config `callCard.callerName`. */
  readonly callerName: () => string;
  /** Config `tts.voice` — the card's badge and the sentence's speaker. */
  readonly voice: () => string;
  /** Cold-deck patience in ms. `<= 0` turns the nudge off. */
  readonly delayMs: () => number;
  /**
   * Build the speak pipeline for an accepted nudge, or `undefined` to leave
   * 接听 as a pure "card goes away". Resolved per call, so a backend the human
   * just configured (or just broke) is the one the next sentence uses.
   */
  readonly speak?: (agent: WatchedExecution['agent']) => SpeakDeps | undefined;
  readonly clock?: NudgeClock;
}

/** One question the human has not answered yet. */
interface WatchedAsk {
  /** The timer handle, filled in by the caller that owns the watch. */
  handle: unknown;
  /** The nudge's own board id, distinct from the tool call it shadows. */
  cardId?: string;
}

/**
 * Escalates an unanswered host question into a ringing card once the human has
 * been gone long enough, and takes that card down the moment the question
 * resolves — including when the answer came from the chat UI.
 */
export class WaitingQuestionNudge {
  private readonly deps: WaitingNudgeDeps;
  private readonly clock: NudgeClock;
  /** Asks being watched, by tool call id. */
  private readonly watched = new Map<string, WatchedAsk>();

  constructor(deps: WaitingNudgeDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Run one tool dispatch, escalating it if it is an ask nobody answers.
   *
   * Anything that is not `ask_user_question` — and any ask while the nudge is
   * switched off or no card client is listening — goes straight through
   * untouched, because this wrapper's only permitted effect is the card.
   */
  async wrap<T>(exec: WatchedExecution, run: () => Promise<T>): Promise<T> {
    if (exec.name !== ASK_TOOL_NAME || this.watched.has(exec.callId)) return await run();
    const delay = this.deps.delayMs();
    if (!(delay > 0) || !this.deps.board.hasSubscribers) return await run();

    const watched: WatchedAsk = { handle: undefined };
    watched.handle = this.clock.schedule(() => this.ring(exec.callId, watched, exec), delay);
    this.watched.set(exec.callId, watched);
    const onAbort = (): void => this.dismiss(exec.callId, '这轮对话已经取消');
    exec.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await run();
    } finally {
      exec.signal?.removeEventListener('abort', onAbort);
      this.dismiss(exec.callId, '问题已经回答了');
    }
  }

  /** Put the card on the board. A card already up is left alone. */
  private ring(callId: string, watched: WatchedAsk, exec: WatchedExecution): void {
    if (!this.watched.has(callId) || watched.cardId !== undefined) return;
    // The board may have lost its client in the meantime (tab closed). Ringing
    // into nobody would park an entry until its own timeout, so re-check.
    if (!this.deps.board.hasSubscribers) return;
    const cardId = `waiting-${callId}`;
    watched.cardId = cardId;
    const asking = describeAsk(exec.arguments, this.deps.delayMs());
    this.deps.board.open(
      {
        callId: cardId,
        text: asking.cardText,
        voice: this.deps.voice(),
        caller: {
          name: this.deps.callerName(),
          ...(exec.agent !== undefined ? { sessionId: sessionTail(exec.agent.id) } : {}),
        },
        ringAt: Date.now(),
      },
      // 拒接/稍后再说 and a timeout only silence the card. 接听 additionally
      // says the one sentence — and the card then lives until the audio is
      // done, like any other call on this board.
      (decision) => {
        if (decision === 'accepted') this.speak(cardId, asking.spoken, exec.agent);
        else this.forget(cardId);
      },
    );
  }

  /** The accepted nudge's one sentence, then the card retires. */
  private speak(cardId: string, text: string, agent: WatchedExecution['agent']): void {
    // Everything below runs inside `CallBoard.answer`'s waiter, i.e. inside the
    // web route's request handler: an exception here is not the card's problem,
    // it is an uncaught exception in the host process. So the whole speak path
    // is fenced — a broken backend, a refused job, a missing audio dir becomes
    // a card that says so, never a dead `dsh web`.
    const retire = (status: CallLegStatus, reason?: string): void => {
      this.deps.board.settle(cardId, status, reason);
      this.forget(cardId);
    };
    let settled: Promise<JobOutcome> | undefined;
    try {
      const deps = this.deps.speak?.(agent);
      if (deps === undefined) {
        // No speak pipeline configured: 接听 behaves exactly as it used to.
        retire('finished');
        return;
      }
      settled = startSpeakJob(deps, {
        text,
        voice: this.deps.voice(),
        onPlay: () => this.deps.board.playing(cardId),
      }).settled;
    } catch (error) {
      retire('failed', `念不出来：${messageOf(error)}`);
      return;
    }
    // A wedged TTS process must not leave a card on screen forever.
    const cap = setTimeout(() => retire('failed', `语音超过 ${SPEAK_LEG_CAP_MS / 60_000} 分钟未结束`), SPEAK_LEG_CAP_MS);
    (cap as { unref?: () => void }).unref?.();
    void settled.then(
      (outcome) => {
        clearTimeout(cap);
        retire(outcome.status === 'completed' ? 'finished' : 'failed', outcome.detail);
      },
      () => {
        clearTimeout(cap);
        retire('failed', '语音任务异常结束');
      },
    );
  }

  /** Take the card down and drop the watch. Idempotent. */
  private dismiss(callId: string, reason: string): void {
    const watched = this.watched.get(callId);
    if (watched === undefined) return;
    this.clock.cancel(watched.handle);
    if (watched.cardId !== undefined) this.deps.board.expire(watched.cardId, reason);
    this.watched.delete(callId);
  }

  /** Forget a card that has finished its business. */
  private forget(cardId: string): void {
    for (const [callId, watched] of this.watched) {
      if (watched.cardId === cardId) this.watched.delete(callId);
    }
  }
}

/** What the card shows and what 接听 says. */
interface AskDescription {
  readonly cardText: string;
  readonly spoken: string;
}

/**
 * Summarise the pending ask. The topic is the host's `header` — but only when
 * every question in the batch shares one, because naming `questions[0]` for a
 * batch of two unrelated questions reads as a lie: the live run said
 * 「有 2 个关于「测试 1：单选」的问题」 about a 单选 *and* a 多选. With no shared
 * topic the count speaks for itself, which is honest and still short enough to
 * understand from across the room.
 */
function describeAsk(args: unknown, delayMs: number): AskDescription {
  const questions = Array.isArray((args as { questions?: unknown })?.questions)
    ? (args as { questions: readonly unknown[] }).questions
    : [];
  const count = questions.length;
  const minutes = Math.max(1, Math.round(delayMs / 60_000));
  const topic = sharedTopic(questions);

  const which = topic === undefined ? '' : `关于「${topic}」的`;
  // The card is read, so it keeps its digits ("有 2 个问题" scans faster than
  // 两个). The sentence is HEARD, and 「有 2 个」 read aloud as "二 个" was the
  // one thing about the whole feature that did not sound like a person.
  return {
    cardText: `有${count > 1 ? ` ${count} 个` : '一个'}${which}问题在等你回答，已经等了 ${minutes} 分钟。回到对话里就能选。`,
    spoken: `${spokenLead(count)}${which}问题需要你回答，请回到对话里选择。`,
  };
}

/**
 * "How many" as the words a Chinese speaker would use out loud: 有两个, not
 * 二个, and no spaces for a voice engine to turn into pauses. Past 十 the
 * digits are as good a guess as any — a batch that large is not a question
 * anyone leaves unanswered for five minutes.
 */
function spokenLead(count: number): string {
  const words = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];
  const word = count >= 1 ? words[count] : undefined;
  return word === undefined ? `有 ${Math.max(1, count)} 个` : `有${word}个`;
}

/** The one topic a batch agrees on, or `undefined` when it does not have one. */
function sharedTopic(questions: readonly unknown[]): string | undefined {
  let topic: string | undefined;
  for (const entry of questions) {
    const question = entry as { header?: unknown, question?: unknown };
    const current = typeof question.header === 'string' && question.header.length > 0
      ? question.header
      : typeof question.question === 'string' && question.question.length > 0
        ? truncateLabel(question.question, 24)
        : undefined;
    if (current === undefined) return undefined;
    if (topic === undefined) topic = current;
    else if (topic !== current) return undefined;
  }
  return topic;
}

/** The short session tag the card shows under the caller name. */
function sessionTail(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(-8);
}

/** One line a card can show for a failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
