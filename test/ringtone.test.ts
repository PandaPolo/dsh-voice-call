/**
 * The ringtone player's decision table. An audio element in a test is not the
 * subject — the timing rules are: when sound is allowed to start, when it must
 * stop, and what happens when the browser refuses the first play. Those are the
 * cases that produce "my card never rang" and "it rang after I answered".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRinger, ringtoneUrl, RINGTONE_URL, RINGTONE_VOLUME, type AudioLike } from '../src/client/ringtone.ts';
import { DEFAULT_TONE } from '../src/client/tones.ts';

/** An audio element whose every `play()` is held until the test resolves it. */
class FakeAudio implements AudioLike {
  loop = false;
  volume = 1;
  src = '';
  pauses = 0;
  readonly pending: Array<{ settle: () => void; fail: () => void }> = [];

  play(): Promise<void> {
    let settle = (): void => {};
    let fail = (): void => {};
    const promise = new Promise<void>((resolve, reject) => {
      settle = () => { this.audible = true; resolve(); };
      fail = () => reject(new DOMExceptionLike('not allowed'));
    });
    this.pending.push({ settle, fail });
    return promise;
  }

  pause(): void {
    this.pauses += 1;
    this.audible = false;
  }

  audible = false;

  /** The n-th play() call, resolved as the browser would. */
  accept(index = this.pending.length - 1): void { this.pending[index]?.settle(); }

  /** The n-th play() call, rejected as an autoplay block would. */
  block(index = this.pending.length - 1): void { this.pending[index]?.fail(); }
}

/**
 * The browser's refusal. A real `DOMException` carries a `name` — that name is
 * the whole difference between "the browser blocked autoplay" and "the asset is
 * broken", so the double has to have one too.
 */
class DOMExceptionLike extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'NotAllowedError';
  }
}

/** A gesture source the test fires by hand. */
function gestures(): { listen: (retry: () => void) => () => void; fire: () => void; armed: () => boolean } {
  let retry: (() => void) | undefined;
  let armed = false;
  return {
    listen: (next) => {
      retry = next;
      armed = true;
      return () => { armed = false; retry = undefined; };
    },
    fire: () => { if (armed) retry?.(); },
    armed: () => armed,
  };
}

describe('ringtone player', () => {
  it('plays on the ring and stops when the card goes away', async () => {
    const audio = new FakeAudio();
    const ringer = createRinger(() => audio);
    ringer.setRinging(true);
    assert.equal(audio.loop, true, 'a looping ring, not one 3-second chime');
    // The tone rides in the query even for the default, because the query is the
    // cache key: `?tone=classic` and `?tone=kalimba` are different objects to the
    // browser, so switching ringtones cannot be answered out of a cached WAV.
    assert.equal(audio.src, ringtoneUrl(DEFAULT_TONE));
    assert.equal(audio.volume, RINGTONE_VOLUME);
    assert.equal(ringer.isPlaying(), true);
    audio.accept();
    await Promise.resolve();
    assert.equal(audio.audible, true);

    ringer.setRinging(false);
    assert.equal(ringer.isPlaying(), false);
    assert.equal(audio.pauses, 1);
  });

  it('stays silent when the config turns the ringtone off', () => {
    const audio = new FakeAudio();
    const ringer = createRinger(() => audio);
    ringer.setEnabled(false);
    ringer.setRinging(true);
    assert.equal(audio.pending.length, 0, 'no play() attempted at all');
    assert.equal(ringer.isPlaying(), false);
    // Turning it back on mid-ring catches up with the state it was given.
    ringer.setEnabled(true);
    assert.equal(audio.pending.length, 1);
    assert.equal(ringer.isPlaying(), true);
  });

  it('lets the card mute a ring without losing the next one', () => {
    const audio = new FakeAudio();
    const ringer = createRinger(() => audio);
    ringer.setRinging(true);
    ringer.setMuted(true);
    assert.equal(audio.pauses, 1);
    assert.equal(ringer.isPlaying(), false);
    // Un-muting while a card is still ringing must bring the sound back: the
    // toggle is per-call, and 静音 is pressed against the ring you can hear.
    ringer.setMuted(false);
    assert.equal(audio.pending.length, 2);
    assert.equal(ringer.isPlaying(), true);
  });

  it('retries once the human touches the page after an autoplay block', async () => {
    const audio = new FakeAudio();
    const source = gestures();
    const ringer = createRinger(() => audio, source.listen);
    ringer.setRinging(true);
    audio.block();
    await Promise.resolve();
    assert.equal(ringer.isPlaying(), false, 'a blocked play must not claim it is ringing');
    assert.equal(source.armed(), true);

    source.fire();
    assert.equal(audio.pending.length, 2, 'the first gesture re-attempts the ring');
    assert.equal(source.armed(), false, 'and the retry is one-shot, not a listener per attempt');
  });

  it('says why the ring is inaudible, and stops saying so once it sounds', async () => {
    // A card that rings in silence reads as a broken plugin. The browser gives
    // back only a rejection, so the player has to hold onto it and hand it up —
    // `NotAllowedError` is autoplay ("点一下页面就会响"), anything else is the
    // asset, and the card needs the two apart.
    const audio = new FakeAudio();
    const source = gestures();
    const reported: string[] = [];
    const ringer = createRinger(() => audio, source.listen, (reason) => reported.push(reason));
    ringer.setRinging(true);
    audio.block();
    await Promise.resolve();
    assert.equal(reported.length, 1, 'the refusal is reported');
    assert.match(reported[0] ?? '', /NotAllowedError/, 'with the browser error name, not just "failed"');

    source.fire();
    audio.pending[1]?.settle();
    await Promise.resolve();
    assert.equal(reported.at(-1), '', 'a ring that starts has nothing left to explain');
  });

  it('never arms a retry once the call is over', async () => {
    const audio = new FakeAudio();
    const source = gestures();
    const ringer = createRinger(() => audio, source.listen);
    ringer.setRinging(true);
    audio.block();
    await Promise.resolve();
    ringer.setRinging(false);
    assert.equal(source.armed(), false, 'a listener left on window rings a dead call');
    source.fire();
    assert.equal(audio.pending.length, 1);
  });

  it('honours a stop that lands while the play is still pending', async () => {
    const audio = new FakeAudio();
    const ringer = createRinger(() => audio);
    ringer.setRinging(true);
    ringer.setRinging(false);
    // The browser only starts on resolution, which is after the card is gone:
    // the pause has to happen there, not on the logical flag that is already off.
    audio.accept();
    await Promise.resolve();
    assert.equal(audio.audible, false, 'the ring kept playing after the card was dismissed');
    assert.equal(ringer.isPlaying(), false);
  });

  it('disposes cleanly from any state', () => {
    const audio = new FakeAudio();
    const source = gestures();
    const ringer = createRinger(() => audio, source.listen);
    ringer.setRinging(true);
    ringer.dispose();
    assert.equal(audio.pauses >= 1, true);
    assert.equal(ringer.isPlaying(), false);
    // A late state change after unmount must not resurrect the sound.
    ringer.setEnabled(true);
    ringer.setRinging(true);
    assert.equal(audio.pending.length, 1);
  });

  it('treats a synchronous play() implementation as immediate success', () => {
    const calls: string[] = [];
    const sync = {
      loop: false,
      volume: 1,
      src: '',
      play() { calls.push('play'); },
      pause() { calls.push('pause'); },
    };
    const ringer = createRinger(() => sync);
    ringer.setRinging(true);
    assert.equal(ringer.isPlaying(), true);
    ringer.setRinging(false);
    assert.deepEqual(calls, ['play', 'pause']);
  });
});

describe('ringtone tone switching', () => {
  it('points the element at the chosen tone, and lazily if there is no element yet', () => {
    const audio = new FakeAudio();
    const ringer = createRinger(() => audio);
    // Nothing has rung yet, so nothing has been created: the tone is remembered
    // and applied when the element is made.
    ringer.setTone('kalimba');
    assert.equal(audio.pending.length, 0, 'choosing a ringtone is not a request to hear it');
    ringer.setRinging(true);
    assert.equal(audio.src, '/voice/call/ringtone?tone=kalimba');

    // A live card takes the new tone on the next loop round, which is what
    // setting `src` on a playing element does — it reloads and keeps playing.
    ringer.setTone('singing-bowl');
    assert.equal(audio.src, `${RINGTONE_URL}?tone=singing-bowl`);
    assert.equal(audio.pauses, 0, 'switching tones must not cut the ring short');
  });

  it('ignores a tone the table does not know rather than pointing at nothing', () => {
    const audio = new FakeAudio();
    const ringer = createRinger(() => audio);
    ringer.setRinging(true);
    const before = audio.src;
    ringer.setTone('../../package.json');
    assert.equal(audio.src, before, 'an id is looked up in the table, never used as a path');
    ringer.setTone('classic');
    assert.equal(audio.src, before, 'the resolved default equals the tone already loaded, so no reload');
  });

  it('keeps the query out of the path and the tone inside it', () => {
    assert.equal(ringtoneUrl('minor-chime'), '/voice/call/ringtone?tone=minor-chime');
    // The card never builds a path, so the only thing a hostile tone id can reach
    // is a longer query string — which the server answers from its own table.
    assert.match(ringtoneUrl('a/b'), /tone=a%2Fb$/);
  });
});
