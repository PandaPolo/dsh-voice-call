/**
 * The call-card client transport: the browser half of the `/voice/call`
 * endpoints. Same-origin fetch/EventSource only — no SDK connection layer
 * exists on the 0.1.2-rc.1 baseline (see `src/rpc/contract.ts` for the wire
 * map and the future migration path).
 *
 * Reconnect policy: EventSource auto-reconnects transient network drops; an
 * HTTP error (e.g. 404 from a headless host without the routes) closes it
 * permanently, so this module re-opens on a capped backoff instead of
 * hammering a host that will never answer.
 *
 * @module dsh-voice-call/client/callcard-api
 */

/** The `ringing` / `active` payload (client mirror of `CallCardRingState`). */
export interface CallCardRingState {
  readonly callId: string;
  readonly text: string;
  readonly voice: string;
  readonly caller: { readonly name: string; readonly sessionId?: string };
  readonly ringAt: number;
  /** `active` = the human answered and the agent is (about to be) speaking. */
  readonly phase: 'ringing' | 'active';
  /** Epoch ms the human pressed 接听 — the card counts the call from here. */
  readonly answeredAt?: number;
  /** Playback started; until then the card is waiting on synthesis. */
  readonly playing?: boolean;
}

/** The `settled` payload (client mirror of the host's `CallCardSettledState`). */
export interface CallCardSettledState {
  readonly callId: string;
  readonly decision: 'accepted' | 'rejected' | 'later' | 'missed';
  readonly reason?: string;
  /** How an ACCEPTED call's active leg ended, when there was one. */
  readonly status?: 'finished' | 'failed';
}

/** The human's answer — the reserved `VoiceAnswerPayload` contract verbatim. */
export interface VoiceAnswerPayload {
  readonly callId: string;
  readonly decision: 'accepted' | 'rejected' | 'later';
}

/** The host's answer response — the reserved `VoiceAnswerResult` contract. */
export interface VoiceAnswerResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/** The answerable decisions the card's buttons offer. */
export type CardDecision = VoiceAnswerPayload['decision'];

/** POST the human's answer to the host. */
export async function answerCallOnHost(payload: VoiceAnswerPayload): Promise<VoiceAnswerResult> {
  const response = await fetch('/voice/call/answer', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await response.json() as VoiceAnswerResult;
}

/** The card's server-resolved presentation, carried by the state snapshot. */
export interface CallCardAppearance {
  readonly theme: 'system' | 'light' | 'dark';
  readonly palette: string;
  /** Play a ringtone while a card is ringing. */
  readonly ringtone: boolean;
  /** Which of the bundled ringtones the above plays (`src/client/tones.ts`). */
  readonly tone?: string;
}

/** Fetch the live call table (boot catch-up without SSE) and the card appearance. */
export async function fetchLiveCalls(): Promise<{ calls: CallCardRingState[]; appearance?: CallCardAppearance }> {
  const response = await fetch('/voice/call/state', { headers: { accept: 'application/json' } });
  if (!response.ok) return { calls: [] };
  const body = await response.json() as { calls?: readonly CallCardRingState[]; appearance?: CallCardAppearance };
  return { calls: [...(body.calls ?? [])], ...(body.appearance !== undefined ? { appearance: body.appearance } : {}) };
}

/** The live-event handlers the overlay registers. */
export interface CallEventHandlers {
  readonly onRinging: (call: CallCardRingState) => void;
  readonly onActive: (call: CallCardRingState) => void;
  readonly onSettled: (call: CallCardSettledState) => void;
}

/** Backoff bounds for the reconnect loop (ms). */
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * Subscribe to the ring stream. Returns the disposer closing the stream and
 * cancelling any pending reconnect. Safe to call again after dispose.
 */
export function connectCallEvents(handlers: CallEventHandlers): () => void {
  let source: EventSource | null = null;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let delay = RECONNECT_MIN_MS;
  let disposed = false;

  const open = (): void => {
    if (disposed) return;
    source = new EventSource('/voice/call/events');
    source.addEventListener('ringing', (event) => {
      handlers.onRinging(JSON.parse((event as MessageEvent<string>).data) as CallCardRingState);
    });
    source.addEventListener('active', (event) => {
      handlers.onActive(JSON.parse((event as MessageEvent<string>).data) as CallCardRingState);
    });
    source.addEventListener('settled', (event) => {
      handlers.onSettled(JSON.parse((event as MessageEvent<string>).data) as CallCardSettledState);
    });
    source.addEventListener('open', () => {
      delay = RECONNECT_MIN_MS;
    });
    source.addEventListener('error', () => {
      // A permanent close (HTTP error status) needs the manual loop; transient
      // drops keep the browser's own auto-reconnect, guarded by the state check.
      if (disposed || source === null || source.readyState !== EventSource.CLOSED) return;
      source.close();
      source = null;
      reconnect = setTimeout(open, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    });
  };
  open();

  return () => {
    disposed = true;
    clearTimeout(reconnect);
    source?.close();
    source = null;
  };
}
