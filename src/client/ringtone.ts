/**
 * The ringtone player — the piece that makes a ringing card audible.
 *
 * Four inputs decide whether sound plays and what it plays, and the rules are the
 * whole point of putting this in its own module rather than an effect in the card:
 *
 *   ringing  — at least one card is on screen and unanswered
 *   enabled  — the user's `callCard.ringtone` config
 *   muted    — the speaker toggle on the card, for this page only
 *   tone     — the user's `callCard.tone` config, i.e. which file is looping
 *
 * `muted` is deliberately NOT written back to the config: a card that goes quiet
 * because you pressed its button should be loud again on the next call, which is
 * what a real phone does.
 *
 * Autoplay is the reason this needs an injected `Audio` at all. A browser
 * rejects `play()` on a page the human has not touched yet, and the rejection
 * arrives as a rejected promise rather than a blocking error, so a naive
 * `play().catch(() => {})` silently loses the ring for good. Instead the player
 * arms one-shot listeners for the first real gesture and retries there — a
 * click anywhere in the app, which any user of a web UI has produced before a
 * call arrives in practice, so the retry is mostly insurance.
 *
 * The other race worth pinning: `play()` resolves late. A stop() that lands
 * while it is pending must still take effect when it resolves, or the loop
 * keeps playing after the card is gone.
 *
 * @module dsh-voice-call/client/ringtone
 */
import { DEFAULT_TONE, toneById } from './tones.ts';

/** The slice of `HTMLAudioElement` this player touches. */
export interface AudioLike {
  loop: boolean;
  volume: number;
  src: string;
  play(): Promise<void> | void;
  pause(): void;
}

/** What the caller can tell the player about the world. */
export interface Ringer {
  /** True while any card on screen is still ringing. */
  setRinging(active: boolean): void;
  /** The `callCard.ringtone` config value. */
  setEnabled(enabled: boolean): void;
  /** The card's speaker toggle. */
  setMuted(muted: boolean): void;
  /** The `callCard.tone` config value: which bundled ringtone to loop. */
  setTone(tone: string): void;
  /** @returns whether sound is playing right now. */
  isPlaying(): boolean;
  /** Stop and forget the gesture listeners. */
  dispose(): void;
}

/**
 * Playback level. The file peaks at −3.3 dBFS, so this lands the ring at about
 * −10 dBFS — audible across a room from a laptop, soft enough not to startle the
 * person who did not hear it coming. Deliberately not 1.0: the loop is loud
 * enough to catch, which is not the same as loud enough to win.
 */
export const RINGTONE_VOLUME = 0.45;

/** The route the bundled ringtone is served from. */
export const RINGTONE_URL = '/voice/call/ringtone';

/**
 * The route for one tone. The tone rides in the query because the server resolves
 * it through its table of bundled files — the client never names a path, and a
 * query is part of the cache key, so picking another ringtone cannot be answered
 * out of the copy the browser already has.
 * @param tone - a tone id; anything the server does not know falls back there.
 */
export function ringtoneUrl(tone: string): string {
  return `${RINGTONE_URL}?tone=${encodeURIComponent(tone)}`;
}

/**
 * Create a ringtone player over an injected audio element.
 * @param createAudio - builds the element (the browser passes `new Audio()`).
 * @param onGesture - subscribes to the first user activation, returning a disposer.
 */
export function createRinger(
  createAudio: () => AudioLike,
  onGesture: (listen: () => void) => () => void = () => () => {},
  /** Told `''` when sound starts and the reason when an attempt is refused. */
  report: (reason: string) => void = () => {},
): Ringer {
  let audio: AudioLike | undefined;
  let ringing = false;
  let enabled = true;
  let muted = false;
  let tone = DEFAULT_TONE;
  let playing = false;
  let disposed = false;
  let forgetGesture: (() => void) | undefined;

  const wanted = (): boolean => ringing && enabled && !muted && !disposed;

  const element = (): AudioLike => {
    if (audio === undefined) {
      audio = createAudio();
      audio.loop = true;
      audio.volume = RINGTONE_VOLUME;
      audio.src = ringtoneUrl(tone);
    }
    return audio;
  };

  const stop = (): void => {
    if (!playing) return;
    playing = false;
    audio?.pause();
  };

  /** Drop the pending gesture subscription, if one is held. */
  const disarm = (): void => {
    const forget = forgetGesture;
    if (forget === undefined) return;
    forgetGesture = undefined;
    forget();
  };

  const start = (): void => {
    if (playing || !wanted()) return;
    playing = true;
    // The attempt consumes the gesture: a blocked play re-arms below, and a
    // successful one must not leave a listener on the window.
    disarm();
    const result = element().play();
    if (isPromise(result)) {
      result.then(
        // A stop() during the pending play has to win: the browser starts on
        // resolution, so the pause belongs here and not on the logical flag.
        () => {
          report('');
          if (!wanted()) audio?.pause();
        },
        (error: unknown) => {
          if (!wanted()) { playing = false; return; }
          // Blocked: keep `playing` honest about the fact that nothing is
          // audible, hand the reason up (the browser gives back only this), and
          // wait for a gesture to try once more.
          playing = false;
          report(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
          if (forgetGesture === undefined) forgetGesture = onGesture(() => sync());
        },
      );
      return;
    }
    // A synchronous implementation (an old browser, or a test double) cannot
    // start late, so the logical stop is enough.
    if (!wanted()) stop();
  };

  const sync = (): void => {
    if (wanted()) start();
    else {
      stop();
      disarm();
    }
  };

  return {
    setRinging: (next) => { ringing = next; sync(); },
    setEnabled: (next) => { enabled = next; sync(); },
    setMuted: (next) => { muted = next; sync(); },
    // Setting `src` on a playing element is how the browser reloads a resource:
    // it keeps playing, so picking another ringtone while a card is on screen
    // lands on the next loop round instead of cutting the current one off. A
    // not-yet-created element just remembers the tone for when it is made.
    setTone: (next) => {
      const resolved = toneById(next).id;
      if (resolved === tone) return;
      tone = resolved;
      if (audio !== undefined) audio.src = ringtoneUrl(tone);
    },
    isPlaying: () => playing,
    dispose: () => {
      disposed = true;
      stop();
      disarm();
      // Belt and braces: a play() still in flight pauses when it resolves, and an
      // element that never got one has nothing to stop.
      audio?.pause();
    },
  };
}

/** One cast: `play()` is documented as returning a promise, and legacy or test
 * implementations return nothing, which the callers must not treat as success. */
function isPromise(result: Promise<void> | void): result is Promise<void> {
  return typeof (result as Promise<void> | undefined)?.then === 'function';
}

/**
 * The browser wiring: retries the ring on the first click or key press, which is
 * exactly the activation a page-wide autoplay allowance is granted for. Both
 * gestures share one handler, so whichever arrives first disarms the other.
 */
export function browserRinger(report?: (reason: string) => void): Ringer {
  return createRinger(
    () => new Audio(),
    (retry) => {
      const events = ['pointerdown', 'keydown'] as const;
      const onGesture = (): void => {
        for (const type of events) window.removeEventListener(type, onGesture, true);
        retry();
      };
      for (const type of events) window.addEventListener(type, onGesture, true);
      return () => {
        for (const type of events) window.removeEventListener(type, onGesture, true);
      };
    },
    report,
  );
}
