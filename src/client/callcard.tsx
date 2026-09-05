/**
 * The v0.2 call-card overlay: the dedicated incoming-call UI. Self-mounted
 * onto `document.body` (no host slot exists for an overlay on this baseline)
 * and driven entirely by the `/voice/call` transport — ringing calls arrive
 * over SSE, answers go back as `POST /voice/call/answer`.
 *
 * The card shows the caller identity (name from `callCard.callerName`, the
 * calling session's tail, the voice badge), the text the agent wants to say,
 * the ring animation, and the three answer keys — 接听/拒接/稍后再说. A
 * settled broadcast (this tab's answer, another tab's answer, or a timeout)
 * removes the card; an already-settled POST answer reports `ok: false` and
 * the client dismisses without a retry loop.
 *
 * @module dsh-voice-call/client/callcard
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import ReactDOM from 'react-dom';
import {
  answerCallOnHost,
  connectCallEvents,
  fetchRingingCalls,
  type CallCardRingState,
  type CardDecision,
} from './callcard-api.ts';

/** Element id of the overlay host div (guards double-mount). */
export const OVERLAY_ID = 'dsh-voice-call-overlay';

/** At most three cards render; older rings keep ringing on the host. */
const MAX_CARDS = 3;

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

/** The overlay: one card per ringing call, newest first. */
export function CallCardOverlay(): ReactNode {
  const [calls, setCalls] = useState<readonly CallCardRingState[]>([]);
  const [busyIds, setBusyIds] = useState<readonly string[]>([]);
  const [acceptedIds, setAcceptedIds] = useState<readonly string[]>([]);
  const [failedIds, setFailedIds] = useState<readonly string[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Boot catch-up: a page opened mid-ring replays the ringing table before
    // the stream's own replay arrives.
    void fetchRingingCalls().then(setCalls).catch(() => {});
    return connectCallEvents({
      onRinging: (call) => setCalls((prev) => [call, ...prev.filter((c) => c.callId !== call.callId)]),
      onSettled: (settled) => {
        setCalls((prev) => prev.filter((c) => c.callId !== settled.callId));
        setBusyIds((prev) => prev.filter((id) => id !== settled.callId));
        setAcceptedIds((prev) => prev.filter((id) => id !== settled.callId));
        setFailedIds((prev) => prev.filter((id) => id !== settled.callId));
      },
    });
  }, []);

  // The elapsed-ringing timer only runs while something is on screen.
  useEffect(() => {
    if (calls.length === 0) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [calls.length]);

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
    <div className="dsvc-stack">
      <style>{CARD_STYLES}</style>
      {calls.slice(0, MAX_CARDS).map((call) => (
        <CallCard key={call.callId} call={call} now={now}
          busy={busyIds.includes(call.callId)}
          accepted={acceptedIds.includes(call.callId)}
          failed={failedIds.includes(call.callId)}
          onAnswer={(decision) => void answer(call.callId, decision)}
        />
      ))}
      {hidden > 0 ? <div className="dsvc-more">还有 {hidden} 个来电</div> : null}
    </div>
  );
}

/** One incoming-call card. */
function CallCard(props: {
  readonly call: CallCardRingState;
  readonly now: number;
  readonly busy: boolean;
  readonly accepted: boolean;
  readonly failed: boolean;
  readonly onAnswer: (decision: CardDecision) => void;
}): ReactNode {
  const { call, now, busy, accepted, failed, onAnswer } = props;
  const elapsed = Math.max(0, Math.round((now - call.ringAt) / 1000));
  return (
    <div className="dsvc-card" role="alertdialog" aria-label="来电">
      <div className="dsvc-head">
        <div className="dsvc-ringer" aria-hidden="true">
          <span className="dsvc-pulse" />
          <span className="dsvc-pulse dsvc-pulse-late" />
          <div className="dsvc-avatar">📞</div>
        </div>
        <div className="dsvc-caller">
          <div className="dsvc-name">{call.caller.name}</div>
          <div className="dsvc-tags">
            {call.caller.sessionId !== undefined ? <span className="dsvc-tag">#{call.caller.sessionId}</span> : null}
            <span className="dsvc-tag">voice: {call.voice}</span>
          </div>
          <div className="dsvc-status">{accepted ? '已接听 · 正在准备语音…' : `正在振铃 · ${elapsed}s`}</div>
        </div>
      </div>
      <p className="dsvc-text">{call.text}</p>
      {accepted ? null : (
        <div className="dsvc-actions">
          <button type="button" className="dsvc-accept" disabled={busy} onClick={() => onAnswer('accepted')}>接听</button>
          <button type="button" className="dsvc-ghost" disabled={busy} onClick={() => onAnswer('rejected')}>拒接</button>
          <button type="button" className="dsvc-ghost" disabled={busy} onClick={() => onAnswer('later')}>稍后再说</button>
        </div>
      )}
      {failed ? <div className="dsvc-error">接听失败，请重试</div> : null}
    </div>
  );
}

const CARD_STYLES = `
.dsvc-stack {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  display: flex; flex-direction: column; gap: 12px; align-items: flex-end;
  font-family: inherit;
}
.dsvc-more {
  font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b94a6);
  background: var(--dsw-specific-surface-2, rgba(30,34,44,0.92));
  border: 1px solid var(--dsw-alias-border-l2, rgba(140,155,190,0.22));
  border-radius: 999px; padding: 3px 10px;
}
.dsvc-card {
  width: 320px; padding: 16px; border-radius: 16px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(140,155,190,0.22));
  background: var(--dsw-specific-surface-1, rgba(24,27,35,0.96));
  box-shadow: 0 12px 32px rgba(0,0,0,0.35);
  color: var(--dsw-alias-label-primary, #e8edf7);
}
.dsvc-head { display: flex; align-items: center; gap: 12px; }
.dsvc-ringer { position: relative; width: 52px; height: 52px; flex: none; }
.dsvc-avatar {
  position: absolute; inset: 8px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; font-size: 20px;
  background: var(--dsw-alias-accent-strong, #2dd4bf);
  color: #10231f;
}
.dsvc-pulse {
  position: absolute; inset: 0; border-radius: 50%;
  border: 2px solid var(--dsw-alias-accent-strong, #2dd4bf);
  opacity: 0; animation: dsvc-pulse 1.6s ease-out infinite;
}
.dsvc-pulse-late { animation-delay: 0.8s; }
@keyframes dsvc-pulse {
  0% { transform: scale(0.55); opacity: 0.7; }
  100% { transform: scale(1.45); opacity: 0; }
}
.dsvc-caller { min-width: 0; }
.dsvc-name { font-size: 15px; font-weight: 600; line-height: 1.2; }
.dsvc-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.dsvc-tag {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px; letter-spacing: 0.05em;
  color: var(--dsw-alias-label-secondary, #c3ccdd);
  border: 1px solid var(--dsw-alias-border-l2, rgba(140,155,190,0.22));
  border-radius: 999px; padding: 1px 7px;
}
.dsvc-status {
  margin-top: 6px; font-size: 11px;
  color: var(--dsw-alias-accent-strong, #2dd4bf);
}
.dsvc-text {
  margin: 12px 0 0; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary, #e8edf7);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  overflow: hidden; overflow-wrap: anywhere;
}
.dsvc-actions { display: flex; gap: 8px; margin-top: 14px; }
.dsvc-actions button {
  flex: 1; padding: 8px 0; border-radius: 10px; cursor: pointer;
  font-size: 13px; font-weight: 600; font-family: inherit;
}
.dsvc-actions button:disabled { opacity: 0.55; cursor: default; }
.dsvc-accept {
  border: 0; color: #10231f;
  background: var(--dsw-alias-accent-strong, #2dd4bf);
}
.dsvc-ghost {
  border: 1px solid var(--dsw-alias-border-l2, rgba(140,155,190,0.22));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #c3ccdd);
}
.dsvc-error { margin-top: 8px; font-size: 11px; color: #f87171; }
`;
