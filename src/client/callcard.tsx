/**
 * The v0.2 call-card overlay: the dedicated incoming-call UI. Self-mounted
 * onto `document.body` (no host slot exists for an overlay on this baseline)
 * and driven entirely by the `/voice/call` transport — ringing calls arrive
 * over SSE, answers go back as `POST /voice/call/answer`.
 *
 * The card shows the caller identity (name from `callCard.callerName`, the
 * calling session's tail, the voice badge), the text the agent wants to say,
 * the ring animation, and the three answer keys — 接听/拒接/稍后再说, weighted
 * one primary over two secondary. Answering does NOT dismiss it: the card
 * follows the call through its active leg (合成中 → 播放中 → 通话结束) and only
 * retires a beat after the audio is really over, so 接听 is never a dead
 * button. 拒接/稍后再说 and an unanswered timeout retire the card on the spot;
 * an already-settled POST answer reports `ok: false` and the client dismisses
 * without a retry loop.
 *
 * An unanswered ring also has to be heard, so the overlay owns one looping
 * `Audio` over the `/voice/call/ringtone` asset — started with the first
 * unanswered card, stopped by 接听/拒接/timeout, and quiet when the config says
 * so or when the card's own 静音 is pressed. The rules live in `ringtone.ts`.
 *
 * Everything below `CallCard` is presentation only. `CARD_STYLES` is scoped to
 * `.dsvc-*` class names and resolves every colour through a two-tier token
 * layer: the host's `--dsw-alias-*` design tokens first, then a literal that
 * matches the host palette for that tier. The light tier sits on `.dsvc-stack`
 * and the dark tier on `body[data-ds-dark-theme] .dsvc-stack` — the attribute
 * the host's ThemePresenter owns and re-emits live, including when a `system`
 * preference follows the OS. So the card tracks 浅色/深色/跟随系统 without a
 * reload, and stays correct on a host that registers no tokens at all. Under
 * `prefers-reduced-motion` it stops moving but still reads as ringing.
 *
 * @module dsh-voice-call/client/callcard
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import ReactDOM from 'react-dom';
import { paletteStyles, themeDecls } from './palettes.ts';
import { getAppearance, setAppearance, subscribeAppearance } from './appearance.ts';
import { browserRinger } from './ringtone.ts';
import {
  answerCallOnHost,
  connectCallEvents,
  fetchLiveCalls,
  type CallCardRingState,
  type CardDecision,
} from './callcard-api.ts';

/** Element id of the overlay host div (guards double-mount). */
export const OVERLAY_ID = 'dsh-voice-call-overlay';

/** At most three cards render; older rings keep ringing on the host. */
const MAX_CARDS = 3;

/** How long a finished call's card stays after the audio stops (ms). */
const HOLD_FINISHED_MS = 2_400;
/** A failed one stays longer — its reason has to be readable. */
const HOLD_FAILED_MS = 6_000;

/** One held card: an accepted call that just ended, waiting to be retired. */
interface HeldCall {
  readonly callId: string;
  readonly status: 'finished' | 'failed';
  readonly reason?: string;
  readonly at: number;
}

/** Structural react-dom root — the module table supplies `react-dom` at runtime. */
interface ReactRoot {
  render(node: ReactNode): void;
  unmount(): void;
}

/**
 * Mount the overlay onto `document.body`. Returns the disposer unmounting it
 * (a no-op when `createRoot` is unavailable or the overlay already exists —
 * very old react-dom or a hot-reload double mount; the v0.1 prompt channel
 * keeps working without the card).
 */
export function mountCallCard(): () => void {
  if (document.getElementById(OVERLAY_ID) !== null) return () => {};
  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  document.body.appendChild(host);
  const createRoot = (ReactDOM as unknown as { createRoot?: (container: Element) => ReactRoot }).createRoot;
  if (createRoot === undefined) {
    host.remove();
    console.warn('dsh-voice-call: react-dom createRoot unavailable — call-card UI disabled');
    return () => {};
  }
  const root = createRoot(host);
  root.render(<CallCardOverlay />);
  return () => {
    root.unmount();
    host.remove();
  };
}

/** The overlay: one card per live call, newest first. */
export function CallCardOverlay(): ReactNode {
  const [calls, setCalls] = useState<readonly CallCardRingState[]>([]);
  const [busyIds, setBusyIds] = useState<readonly string[]>([]);
  const [acceptedIds, setAcceptedIds] = useState<readonly string[]>([]);
  const [failedIds, setFailedIds] = useState<readonly string[]>([]);
  const [held, setHeld] = useState<readonly HeldCall[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [appearance, setShown] = useState(getAppearance);
  // One ringtone loop for the whole stack — several cards ringing at once are
  // one caller, not a chord. Lazy: nothing is created until a card rings.
  // Why the ringtone is currently inaudible ('' when it is not): the browser
  // refuses `play()` and gives back only a rejection, so the player reports it
  // here and the card says so out loud instead of looking broken.
  const [silent, setSilent] = useState('');
  const [ringer] = useState(() => browserRinger(setSilent));
  const [muted, setMuted] = useState(false);
  // Only a real pin sets the attribute: 跟随系统 stays a pure CSS concern, keyed
  // off the host's own body attribute, so an OS flip repaints live without this
  // component observing anything.
  const pinnedTheme = appearance.theme === 'system' ? undefined : appearance.theme;

  // The settings card and this overlay live in the same bundle, so an accepted
  // config write repaints a card that is already on screen — no reload, and no
  // waiting for the next ring to see the palette you just picked.
  useEffect(() => subscribeAppearance(() => setShown(getAppearance())), []);
  useEffect(() => ringer.setEnabled(appearance.ringtone), [appearance.ringtone]);
  // Which ringtone, as well as whether: the settings card writes the same store
  // this reads, so a card already on screen loops the new tone on its next round.
  useEffect(() => ringer.setTone(appearance.tone), [appearance.tone]);
  useEffect(() => ringer.setMuted(muted), [muted]);
  useEffect(() => () => ringer.dispose(), []);

  // A card stops ringing the moment the human touches one of its buttons, not
  // when the host's `active`/`settled` event comes back: the round trip is a few
  // hundred ms, and a ringtone still looping after 接听 is the sound of a plugin
  // that did not hear you.
  const anyRinging = calls.some((call) => call.phase === 'ringing'
    && !acceptedIds.includes(call.callId) && !busyIds.includes(call.callId));
  useEffect(() => {
    ringer.setRinging(anyRinging);
    // 静音 is per-call: once nothing is ringing, the next caller deserves the
    // ringtone the config still asks for.
    if (!anyRinging) {
      setMuted(false);
      setSilent('');
    }
  }, [anyRinging]);

  useEffect(() => {
    // Boot catch-up: a page opened mid-ring — or mid-call — replays the live
    // table before the stream's own replay arrives. The same response carries
    // the server's resolved appearance, which seeds the store for this page.
    void fetchLiveCalls().then(({ calls: live, appearance: seeded }) => {
      if (seeded !== undefined) setAppearance(seeded);
      setCalls(live);
    }).catch(() => {});
    // Ringing and active payloads describe the same call: replace in place so
    // the card does not jump to the top of the stack when it is answered.
    const upsert = (call: CallCardRingState): void => {
      setCalls((prev) => prev.some((c) => c.callId === call.callId)
        ? prev.map((c) => (c.callId === call.callId ? call : c))
        : [call, ...prev]);
    };
    const forget = (callId: string): void => {
      setCalls((prev) => prev.filter((c) => c.callId !== callId));
      setBusyIds((prev) => prev.filter((id) => id !== callId));
      setAcceptedIds((prev) => prev.filter((id) => id !== callId));
      setFailedIds((prev) => prev.filter((id) => id !== callId));
      setHeld((prev) => prev.filter((h) => h.callId !== callId));
    };
    return connectCallEvents({
      onRinging: upsert,
      onActive: (call) => {
        upsert(call);
        setAcceptedIds((prev) => prev.includes(call.callId) ? prev : [...prev, call.callId]);
      },
      onSettled: (settled) => {
        setBusyIds((prev) => prev.filter((id) => id !== settled.callId));
        if (settled.decision === 'accepted') {
          // The human answered, so let the card say how it ended before it
          // goes; every other decision retires the card on the spot.
          setHeld((prev) => [...prev.filter((h) => h.callId !== settled.callId), {
            callId: settled.callId,
            status: settled.status ?? 'finished',
            ...(settled.reason !== undefined ? { reason: settled.reason } : {}),
            at: Date.now(),
          }]);
          setFailedIds((prev) => prev.filter((id) => id !== settled.callId));
          return;
        }
        forget(settled.callId);
      },
    });
  }, []);

  // The elapsed / call-duration timer only runs while something is on screen.
  useEffect(() => {
    if (calls.length === 0) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [calls.length]);

  // Held cards retire on the same clock that drives the timers, so there is no
  // per-card timeout to track and a reload cannot orphan one.
  useEffect(() => {
    if (held.length === 0) return;
    const gone = new Set(held
      .filter((h) => now - h.at > (h.status === 'failed' ? HOLD_FAILED_MS : HOLD_FINISHED_MS))
      .map((h) => h.callId));
    if (gone.size === 0) return;
    setHeld((prev) => prev.filter((h) => !gone.has(h.callId)));
    setCalls((prev) => prev.filter((c) => !gone.has(c.callId)));
  }, [held, now]);

  const answer = async (callId: string, decision: CardDecision): Promise<void> => {
    setBusyIds((prev) => [...prev, callId]);
    setFailedIds((prev) => prev.filter((id) => id !== callId));
    try {
      const result = await answerCallOnHost({ callId, decision });
      if (!result.ok) setFailedIds((prev) => [...prev, callId]);
      else if (decision === 'accepted') setAcceptedIds((prev) => [...prev, callId]);
    } catch {
      setFailedIds((prev) => [...prev, callId]);
    } finally {
      setBusyIds((prev) => prev.filter((id) => id !== callId));
    }
  };

  if (calls.length === 0) return null;
  const hidden = Math.max(0, calls.length - MAX_CARDS);
  return (
    <div className="dsvc-stack"
      data-dsvc-theme={pinnedTheme}
      data-dsvc-palette={appearance.palette}>
      <style>{CARD_STYLES}</style>
      <style>{PALETTE_CSS}</style>
      {anyRinging ? <RingtoneToggle muted={muted} onToggle={() => setMuted((was) => !was)} /> : null}
      {/* A card that rings in silence reads as a broken plugin. The browser
          refuses `play()` on a page it has not seen touched, retries on the
          first gesture, and tells us only the error name — so the card says
          which of the two happened rather than leaving the human to find out. */}
      {anyRinging && silent !== ''
        ? (
            <div className="dsvc-silent" role="status">
              {silent.startsWith('NotAllowedError')
                ? '浏览器拦住了铃声 —— 点一下这个页面就会响。'
                : `铃声没能响（${silent}）—— 点一下这个页面重试。`}
            </div>
          )
        : null}
      {calls.slice(0, MAX_CARDS).map((call) => (
        <CallCard key={call.callId} call={call} now={now}
          busy={busyIds.includes(call.callId)}
          accepted={acceptedIds.includes(call.callId)}
          failed={failedIds.includes(call.callId)}
          held={held.find((h) => h.callId === call.callId)}
          onAnswer={(decision) => void answer(call.callId, decision)}
        />
      ))}
      {hidden > 0 ? <div className="dsvc-more">还有 {hidden} 个来电</div> : null}
    </div>
  );
}

/** One incoming-call card, in its ringing, active, or held state. */
export function CallCard(props: {
  readonly call: CallCardRingState;
  readonly now: number;
  readonly busy: boolean;
  readonly accepted: boolean;
  readonly failed: boolean;
  readonly held?: HeldCall;
  readonly onAnswer: (decision: CardDecision) => void;
}): ReactNode {
  const { call, now, busy, accepted, failed, held, onAnswer } = props;
  const inCall = held !== undefined || call.phase === 'active' || accepted;
  // The ringing counter counts from the ring; the call counter from 接听.
  const from = inCall ? call.answeredAt ?? call.ringAt : call.ringAt;
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  const textId = `dsvc-text-${call.callId}`;
  return (
    <div className={inCall ? 'dsvc-card dsvc-card-live' : 'dsvc-card'}
      role="alertdialog" aria-label={inCall ? '通话中' : '来电'} aria-describedby={textId}>
      <div className="dsvc-head">
        <div className="dsvc-ringer" aria-hidden="true">
          <span className="dsvc-echo" />
          <span className="dsvc-echo dsvc-echo-late" />
          <span className="dsvc-avatar"><PhoneIcon /></span>
        </div>
        <div className="dsvc-caller">
          <div className="dsvc-top">
            <div className="dsvc-eyebrow"><span className="dsvc-beacon" />{inCall ? '通话中' : '来电'}</div>
            <div className="dsvc-elapsed">
              {inCall ? clock(seconds) : <>{seconds}<small>s</small></>}
            </div>
          </div>
          <div className="dsvc-name">{call.caller.name}</div>
          <div className="dsvc-tags">
            {call.caller.sessionId !== undefined ? <span className="dsvc-tag">#{call.caller.sessionId}</span> : null}
            <span className="dsvc-tag"><WaveIcon /> {call.voice}</span>
          </div>
        </div>
      </div>

      <p className="dsvc-text" id={textId}>{call.text}</p>

      {held !== undefined ? (
        held.status === 'failed' ? (
          <div className="dsvc-error dsvc-error-leg" role="status">
            <AlertIcon />
            <span className="dsvc-error-detail">语音没有播出来{held.reason !== undefined ? ` · ${held.reason}` : ''}</span>
          </div>
        ) : (
          <div className="dsvc-accepted dsvc-accepted-still" role="status">
            <span className="dsvc-accepted-dot" />
            <span className="dsvc-accepted-label">通话结束</span>
          </div>
        )
      ) : inCall ? (
        <div className="dsvc-accepted" role="status">
          <span className="dsvc-accepted-dot" />
          <span className="dsvc-accepted-label">
            {call.playing === true ? '正在播放' : '已接听 · 正在合成语音'}
          </span>
          <span className="dsvc-sweep" aria-hidden="true" />
        </div>
      ) : (
        <div className="dsvc-actions">
          <div className="dsvc-wave" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <button type="button" className="dsvc-accept" disabled={busy} aria-busy={busy}
            onClick={() => onAnswer('accepted')}>
            <PhoneIcon /> 接听
          </button>
          <div className="dsvc-secondary">
            <button type="button" className="dsvc-decline" disabled={busy} aria-busy={busy}
              onClick={() => onAnswer('rejected')}>
              <PhoneIcon hangup /> 拒接
            </button>
            <button type="button" className="dsvc-later" disabled={busy} aria-busy={busy}
              onClick={() => onAnswer('later')}>
              <ClockIcon /> 稍后再说
            </button>
          </div>
        </div>
      )}
      {failed ? <div className="dsvc-error" role="status"><AlertIcon /> 接听失败，请重试</div> : null}
    </div>
  );
}

/**
 * The ringtone toggle. Its own component so the offline preview can render the
 * real thing rather than a copy of its markup; the overlay only decides whether
 * a ring is currently worth muting.
 */
export function RingtoneToggle(props: { readonly muted: boolean; readonly onToggle: () => void }): ReactNode {
  return (
    // `data-muted` rather than the `[aria-pressed="true"]` selector it would
    // otherwise need: React stringifies aria-* into "true"/"false" while other
    // renderers drop the value, and a style that keys off that difference is a
    // style that silently stops applying.
    <button type="button" className="dsvc-mute" onClick={props.onToggle}
      aria-pressed={props.muted} data-muted={props.muted ? '' : undefined}
      title={props.muted ? '恢复铃声' : '本次来电静音'}>
      {props.muted ? <MuteIcon /> : <SpeakerIcon />}
      <span>{props.muted ? '铃声已关' : '静音'}</span>
    </button>
  );
}

/** Call duration as `m:ss`. */
function clock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/** 24px stroke glyph, tinted by the surrounding text colour. */
function Glyph(props: { readonly children: ReactNode; readonly className?: string }): ReactNode {
  return (
    <svg className={props.className} viewBox="0 0 24 24" width="1em" height="1em" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {props.children}
    </svg>
  );
}

/** Telephone handset; `hangup` rotates it 135° — the universal hang-up glyph. */
function PhoneIcon(props: { readonly hangup?: boolean }): ReactNode {
  return (
    <Glyph className={props.hangup === true ? 'dsvc-glyph-hangup' : undefined}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </Glyph>
  );
}

/** Three voice bars, used as the voice-id badge. */
function WaveIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M7 14v-4M12 18V6M17 13v-2" />
    </Glyph>
  );
}

/** Clock face — the 稍后再说 (call back later) glyph. */
function ClockIcon(): ReactNode {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </Glyph>
  );
}

/** Speaker with sound — the ringtone is on, and this button turns it off. */
function SpeakerIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M11 5 6 9H3v6h3l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </Glyph>
  );
}

/** Speaker with the waves struck through — the ringtone is off for this call. */
function MuteIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M11 5 6 9H3v6h3l5 4V5z" />
      <path d="M22 9l-6 6M16 9l6 6" />
    </Glyph>
  );
}

/** Triangle exclamation — the failed-answer glyph. */
function AlertIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </Glyph>
  );
}

/**
 * The palette layer, emitted once for every preset — the stack's attribute
 * picks which one applies, so a card already on screen repaints on change.
 */
const PALETTE_CSS = paletteStyles();

/** Exported for the offline preview harness, which renders the real stylesheet. */
export const CARD_STYLES = `
.dsvc-stack {
  /* ---------- token layer: light, following the host ----------
     Every value reads a host design token first; the literals are what those
     tokens resolve to in the host's own light palette, so a host that never
     registers them still gets a correct card. The values live in
     src/client/palettes.ts, which generates this block and its three siblings. */
${themeDecls('light', true)}
  --dsvc-ease: cubic-bezier(0.22, 0.85, 0.28, 1);
  --dsvc-ring: 1.9s;

  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  display: flex; flex-direction: column; gap: 10px; align-items: flex-end;
  font-family: inherit; color: var(--dsvc-fg);
}
/* ---------- token layer: dark, following the host ----------
     The host's ThemePresenter owns data-ds-dark-theme on <body>, resolves the
     system preference against prefers-color-scheme, and re-emits the snapshot
     when the OS flips — so keying off that attribute is what makes 跟随系统 work
     live, with no reload and no duplicated media query here. A pinned card opts
     out by carrying data-dsvc-theme, which is why the :not() guard is on the
     ATTRIBUTE and not on a value. */
body[data-ds-dark-theme] .dsvc-stack:not([data-dsvc-theme]) {
${themeDecls('dark', true)}
}
/* ---------- pinned themes ----------
     A pinned half cannot read host tokens at all: the host only re-points them
     under its own dark attribute, so a card pinning dark inside a light host
     would get light values back. These two blocks therefore use the literal
     tier, and the overlay resolves the system mode against the host attribute itself
     (see CallCardOverlay) so that only a real pin sets the attribute. */
.dsvc-stack[data-dsvc-theme="dark"] {
${themeDecls('dark', false)}
}
body[data-ds-dark-theme] .dsvc-stack[data-dsvc-theme="light"] {
${themeDecls('light', false)}
}

.dsvc-more {
  font-size: 11px; font-weight: 500; color: var(--dsvc-fg-2);
  background: var(--dsvc-surface);
  border: 1px solid var(--dsvc-line); border-radius: 999px;
  padding: 4px 11px; box-shadow: var(--dsvc-shadow);
}
/* The "your ringtone was refused" line: readable, not alarming — it is a
   browser policy, not a failure of the call. */
.dsvc-silent {
  font-size: 12px; font-weight: 500; color: var(--dsvc-fg-1);
  background: var(--dsvc-surface);
  border: 1px solid var(--dsvc-line); border-left: 3px solid var(--dsvc-accent);
  border-radius: 8px; padding: 6px 11px;
  box-shadow: var(--dsvc-shadow); align-self: stretch; text-align: center;
}

/* ---------- the mute toggle ----------
   Out of flow on purpose: the stack is bottom-anchored, so a control in the
   normal flow would shove every card already on screen downward. A pill above
   the newest card, small and quiet, so the primary actions keep all the weight. */
.dsvc-mute {
  position: absolute; right: 0; bottom: calc(100% + 8px);
  display: inline-flex; align-items: center; gap: 5px;
  font-family: inherit; font-size: 11px; font-weight: 500; line-height: 1;
  color: var(--dsvc-fg-2); background: var(--dsvc-surface);
  border: 1px solid var(--dsvc-line); border-radius: 999px;
  padding: 6px 11px 6px 9px; cursor: pointer;
  box-shadow: var(--dsvc-shadow);
  transition: color 170ms ease, border-color 170ms ease, background-color 170ms ease;
}
.dsvc-mute svg { font-size: 13px; flex: none; opacity: 0.85; }
.dsvc-mute:hover { color: var(--dsvc-fg); border-color: var(--dsvc-accent); }
.dsvc-mute:focus-visible { outline: 2px solid var(--dsvc-accent); outline-offset: 2px; }
.dsvc-mute[data-muted] { color: var(--dsvc-hangup); border-color: var(--dsvc-hangup); }

/* ---------- card ---------- */
.dsvc-card {
  width: min(338px, calc(100vw - 32px));
  padding: 16px 16px 14px; border-radius: 18px;
  border: 1px solid var(--dsvc-line);
  background: var(--dsvc-surface);
  color: var(--dsvc-fg);
  box-shadow: var(--dsvc-topline), var(--dsvc-shadow);
  animation: dsvc-in 300ms var(--dsvc-ease) both, dsvc-halo 2.6s ease-out 300ms infinite;
}
@keyframes dsvc-in {
  from { opacity: 0; transform: translateY(14px) scale(0.965); }
  to { opacity: 1; transform: none; }
}
/* A soft accent glow that breathes on the ring cycle. */
@keyframes dsvc-halo {
  0%, 100% { box-shadow: var(--dsvc-topline), var(--dsvc-shadow), 0 0 0 0 transparent; }
  35% { box-shadow: var(--dsvc-topline), var(--dsvc-shadow), 0 0 26px -6px var(--dsvc-accent-glow); }
}

/* ---------- the active leg ----------
   Answered: nobody needs to be poked any more, so the card stops ringing but
   keeps the accent. The entrance animation is re-declared without the halo
   rather than switched off, so a card mid-flight-in is not cut short. */
.dsvc-card-live { animation: dsvc-in 300ms var(--dsvc-ease) both; }
.dsvc-card-live .dsvc-avatar { animation: none; }
.dsvc-card-live .dsvc-echo { display: none; }
.dsvc-card-live .dsvc-beacon { animation: none; opacity: 1; }

/* ---------- header ---------- */
.dsvc-head { display: flex; align-items: center; gap: 12px; }
.dsvc-ringer { position: relative; width: 50px; height: 50px; flex: none; }
.dsvc-avatar {
  position: absolute; inset: 7px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; color: var(--dsvc-accent-ink);
  background: var(--dsvc-accent);
  box-shadow: 0 4px 12px -3px var(--dsvc-accent-glow), inset 0 -7px 10px -6px #00000059;
  animation: dsvc-beat var(--dsvc-ring) ease-in-out infinite;
}
.dsvc-echo {
  position: absolute; inset: 3px; border-radius: 50%;
  border: 1.5px solid var(--dsvc-accent);
  opacity: 0; animation: dsvc-echo var(--dsvc-ring) cubic-bezier(0.16, 0.7, 0.3, 1) infinite;
}
.dsvc-echo-late { animation-delay: calc(var(--dsvc-ring) / 2); }
@keyframes dsvc-echo {
  0% { transform: scale(0.72); opacity: 0.6; }
  70%, 100% { transform: scale(1.5); opacity: 0; }
}
/* The handset "buzzes" like a vibrating receiver rather than bobbing. */
@keyframes dsvc-beat {
  0%, 46%, 100% { transform: scale(1) rotate(0deg); }
  8% { transform: scale(1.09) rotate(-7deg); }
  16% { transform: scale(0.97) rotate(6deg); }
  24% { transform: scale(1.05) rotate(-4deg); }
  32% { transform: scale(1) rotate(0deg); }
}
.dsvc-caller { flex: 1; min-width: 0; }
.dsvc-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsvc-eyebrow {
  display: flex; align-items: center; gap: 5px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.16em;
  color: var(--dsvc-accent); text-transform: uppercase;
}
.dsvc-beacon {
  width: 5px; height: 5px; flex: none; border-radius: 50%; background: currentColor;
  animation: dsvc-blink var(--dsvc-ring) steps(1, end) infinite;
}
@keyframes dsvc-blink { 0%, 45% { opacity: 1; } 46%, 100% { opacity: 0.25; } }
.dsvc-name {
  margin-top: 3px; font-size: 15px; font-weight: 600; line-height: 1.25;
  letter-spacing: -0.005em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dsvc-tags { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 5px; }
.dsvc-tag {
  display: inline-flex; align-items: center; gap: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px; line-height: 1; letter-spacing: 0.03em;
  color: var(--dsvc-fg-2); background: var(--dsvc-fill);
  border: 1px solid var(--dsvc-line); border-radius: 5px; padding: 3px 6px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsvc-tag svg { font-size: 11px; flex: none; opacity: 0.8; }
.dsvc-elapsed {
  flex: none; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--dsvc-fg-3);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.dsvc-elapsed small { font-size: 9px; margin-left: 1px; opacity: 0.7; }

/* ---------- the message ---------- */
.dsvc-text {
  margin: 12px 0 0; padding: 8px 0 8px 11px; font-size: 13px; line-height: 1.55;
  color: var(--dsvc-fg);
  border-left: 2px solid var(--dsvc-accent);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  overflow: hidden; overflow-wrap: anywhere;
}

/* ---------- actions ---------- */
/* The ringing band: an equaliser breathing on the ring cycle, so the card
   reads as audio before you even look at the handset. */
.dsvc-wave {
  display: flex; align-items: center; justify-content: center; gap: 3px;
  height: 16px; margin: 4px 0 10px;
}
.dsvc-wave i {
  width: 2px; height: 4px; flex: none; border-radius: 2px;
  background: var(--dsvc-accent);
  animation: dsvc-wave var(--dsvc-ring) ease-in-out infinite;
}
/* Negative delays so the wave is already travelling on the first frame. */
.dsvc-wave i:nth-child(1) { animation-delay: -0.70s; }
.dsvc-wave i:nth-child(2) { animation-delay: -0.52s; }
.dsvc-wave i:nth-child(3) { animation-delay: -0.34s; }
.dsvc-wave i:nth-child(4) { animation-delay: -0.16s; }
@keyframes dsvc-wave {
  0%, 100% { height: 4px; opacity: 0.5; }
  50% { height: 15px; opacity: 1; }
}

.dsvc-accept, .dsvc-decline, .dsvc-later {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  border-radius: 11px; transition: transform 130ms var(--dsvc-ease), box-shadow 170ms ease,
    background-color 170ms ease, border-color 170ms ease, color 170ms ease, opacity 170ms ease;
}
.dsvc-accept svg, .dsvc-decline svg, .dsvc-later svg { font-size: 14px; flex: none; }
/* The universal hang-up glyph: the same handset, tipped over. */
.dsvc-glyph-hangup { transform: rotate(135deg); }
.dsvc-accept {
  width: 100%; padding: 11px 0; border: 0;
  color: var(--dsvc-accent-ink); letter-spacing: 0.01em;
  background: var(--dsvc-accent);
  /* Two glow layers instead of a stronger token: the accent glow alone is too
     soft to carry a full-width primary button. */
  box-shadow: 0 6px 18px -6px var(--dsvc-accent-glow), 0 2px 6px -2px var(--dsvc-accent-glow),
    inset 0 1px 0 #ffffff4d;
}
.dsvc-accept:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 10px 24px -6px var(--dsvc-accent-glow), 0 2px 6px -2px var(--dsvc-accent-glow), inset 0 1px 0 #ffffff4d; }
.dsvc-accept:active:not(:disabled) { transform: translateY(1px) scale(0.995); }
.dsvc-secondary { display: flex; gap: 8px; margin-top: 8px; }
.dsvc-decline, .dsvc-later {
  flex: 1; min-width: 0; padding: 9px 0;
  border: 1px solid var(--dsvc-line); background: var(--dsvc-fill);
}
.dsvc-decline { color: var(--dsvc-hangup); }
.dsvc-later { color: var(--dsvc-fg-2); }
.dsvc-decline:hover:not(:disabled) { border-color: var(--dsvc-hangup); background: var(--dsvc-hangup-wash); }
.dsvc-later:hover:not(:disabled) { color: var(--dsvc-fg); background: var(--dsvc-fill-hover); }
.dsvc-decline:active:not(:disabled), .dsvc-later:active:not(:disabled) { transform: translateY(1px); }
.dsvc-card button:focus-visible { outline: 2px solid var(--dsvc-accent); outline-offset: 2px; }
.dsvc-card button:disabled { opacity: 0.5; cursor: default; transform: none; }

/* ---------- accepted / failed ---------- */
.dsvc-accepted {
  position: relative; overflow: hidden;
  display: flex; align-items: center; gap: 8px;
  margin-top: 13px; padding: 11px 12px; border-radius: 11px;
  background: var(--dsvc-accent-wash);
  font-size: 12px; font-weight: 600; color: var(--dsvc-accent);
}
.dsvc-accepted-dot {
  width: 7px; height: 7px; flex: none; border-radius: 50%;
  background: currentColor; animation: dsvc-blink 1.1s ease-in-out infinite;
}
.dsvc-accepted-label { position: relative; z-index: 1; }
.dsvc-sweep {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--dsvc-accent-glow), transparent);
  transform: translateX(-100%); animation: dsvc-sweep 1.5s ease-in-out infinite;
}
@keyframes dsvc-sweep { to { transform: translateX(100%); } }
/* An ended leg holds still: the message is over, nothing is being worked on. */
.dsvc-accepted-still .dsvc-accepted-dot { animation: none; opacity: 0.55; }
.dsvc-error {
  display: flex; align-items: center; gap: 5px;
  margin-top: 9px; font-size: 11px; font-weight: 500; color: var(--dsvc-hangup);
}
.dsvc-error svg { font-size: 12px; flex: none; }
/* A failed leg reports where the action band sat, so it takes the strip's
   offset; the reason is engine output and gets ellipsised, not wrapped. */
.dsvc-error-leg { margin-top: 13px; }
.dsvc-error-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Reduced motion: the card still reads as ringing (the beacon and the wave
   stay lit, the wave keeps a shaped silhouette), it just stops moving. */
@media (prefers-reduced-motion: reduce) {
  .dsvc-stack *, .dsvc-stack *::before, .dsvc-stack *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
  .dsvc-echo { opacity: 0.35; transform: scale(1.1); }
  .dsvc-beacon { opacity: 0.9; }
  .dsvc-wave { height: auto; }
  .dsvc-wave i { height: 6px; }
  .dsvc-wave i:nth-child(2) { height: 11px; }
  .dsvc-wave i:nth-child(3) { height: 15px; }
  .dsvc-wave i:nth-child(4) { height: 9px; }
}
`;
