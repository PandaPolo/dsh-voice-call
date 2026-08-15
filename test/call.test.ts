/**
 * Call-domain units: the state machine that backs `offer_call` — opening,
 * answering, refusing, and the settled-state guard. Pure logic, no cordis.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { answerCall, isSettled, mintCallId, openCall, refuseCall } from '../src/domain/call.ts';
import { AskUserRingChannel, DirectRingChannel } from '../src/channels/ring.ts';

describe('call domain', () => {
  it('opens a call in the offered state', () => {
    const call = openCall({ text: 'hello', voice: 'dylan' }, () => 123456);
    assert.match(call.callId, /^call-/);
    assert.equal(call.text, 'hello');
    assert.equal(call.voice, 'dylan');
    assert.equal(call.decision, undefined);
    assert.equal(isSettled(call), false);
  });

  it('mints distinct call ids', () => {
    const a = mintCallId();
    const b = mintCallId();
    assert.notEqual(a, b);
    assert.match(a, /^call-/);
  });

  it('settles with the human answer', () => {
    const call = openCall({ text: 'hi', voice: 'aiden' });
    const settled = answerCall(call, { decision: 'accepted' });
    assert.equal(settled.decision, 'accepted');
    assert.equal(isSettled(settled), true);
  });

  it('records deferred and rejected answers', () => {
    assert.equal(answerCall(openCall({ text: 'x', voice: 'aiden' }), { decision: 'later' }).decision, 'later');
    assert.equal(answerCall(openCall({ text: 'x', voice: 'aiden' }), { decision: 'rejected' }).decision, 'rejected');
  });

  it('refuses a call that never rang', () => {
    const call = openCall({ text: 'x', voice: 'aiden' });
    const refused = refuseCall(call, 'off', 'callMode is off');
    assert.equal(refused.refusal, 'off');
    assert.equal(refused.reason, 'callMode is off');
    assert.equal(isSettled(refused), true);
  });

  it('guards against double settlement', () => {
    const call = answerCall(openCall({ text: 'x', voice: 'aiden' }), { decision: 'accepted' });
    assert.throws(() => answerCall(call, { decision: 'rejected' }), /already settled/);
    assert.throws(() => refuseCall(call, 'off'), /already settled/);
  });
});

describe('ring channels', () => {
  it('the ask channel maps 接听 to accepted', async () => {
    const channel = new AskUserRingChannel(async () => ({
      answers: [{ id: 'call-1', selected: ['接听'] }],
    }));
    const outcome = await channel.ring({ call: openCall({ text: 'hi', voice: 'aiden' }) });
    assert.deepEqual(outcome, { kind: 'answered', decision: 'accepted' });
  });

  it('the ask channel maps 拒接 to rejected', async () => {
    const channel = new AskUserRingChannel(async () => ({
      answers: [{ id: 'call-1', selected: ['拒接'] }],
    }));
    const outcome = await channel.ring({ call: openCall({ text: 'hi', voice: 'aiden' }) });
    assert.deepEqual(outcome, { kind: 'answered', decision: 'rejected' });
  });

  it('the ask channel maps 稍后再说 to later', async () => {
    const channel = new AskUserRingChannel(async () => ({
      answers: [{ id: 'call-1', selected: ['稍后再说'] }],
    }));
    const outcome = await channel.ring({ call: openCall({ text: 'hi', voice: 'aiden' }) });
    assert.deepEqual(outcome, { kind: 'answered', decision: 'later' });
  });

  it('the ask channel refuses on an unknown answer', async () => {
    const channel = new AskUserRingChannel(async () => ({
      answers: [{ id: 'call-1', selected: ['wat'] }],
    }));
    const outcome = await channel.ring({ call: openCall({ text: 'hi', voice: 'aiden' }) });
    assert.deepEqual(outcome, { kind: 'answered', decision: 'rejected' });
  });

  it('the direct channel accepts immediately', async () => {
    const channel = new DirectRingChannel();
    const outcome = await channel.ring({ call: openCall({ text: 'hi', voice: 'aiden' }) });
    assert.deepEqual(outcome, { kind: 'answered', decision: 'accepted' });
  });
});