/**
 * The call-card web routes: the host half of the v0.2 call-card transport,
 * registered on `ctx.webServer` exactly like the audio route. Three endpoints
 * under the `/voice/call` prefix:
 *
 * - `GET /voice/call/events` — the call stream (SSE). On connect the current
 *   live table is replayed, then `ringing` / `active` / `settled` events
 *   follow. A heartbeat comment keeps idle proxies from closing the stream.
 * - `GET /voice/call/state` — the live table as plain JSON (a client that
 *   cannot hold an EventSource can poll this instead).
 * - `POST /voice/call/answer` — the human's answer. The body is the reserved
 *   `VoiceAnswerPayload` contract verbatim; the response is `VoiceAnswerResult`.
 *
 * Same-origin only (the webserver is loopback-bound by default), same trust
 * level as the audio route.
 *
 * @module dsh-voice-call/callcard/web
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { CallBoard, type AnswerDecision } from './board.ts';

/** The route prefix serving the call-card endpoints. */
export const CALL_ROUTE = '/voice/call';

/** The SSE event names the client subscribes to. */
export const RINGING_EVENT = 'ringing' as const;
export const ACTIVE_EVENT = 'active' as const;
export const SETTLED_EVENT = 'settled' as const;

/** Heartbeat interval for the SSE stream (ms). */
const HEARTBEAT_MS = 15_000;
/** POST body cap — a valid answer payload is a few dozen bytes. */
const MAX_BODY_BYTES = 4096;

const ANSWERABLE: readonly AnswerDecision[] = ['accepted', 'rejected', 'later'];

/**
 * Register the call-card routes on `ctx.webServer` when present; returns the
 * disposer. Headless deployments (no webserver) skip it — the board then has
 * no subscribers and the ring channel falls back to the v0.1 prompt channel.
 */
export function installCallCardRoutes(ctx: Context, board: CallBoard): () => void {
  const webServer = ctx.get('webServer') as
    | { register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void }
    | undefined;
  if (webServer === undefined) return () => {};
  return webServer.register({
    kind: 'prefix',
    path: CALL_ROUTE,
    handler: (req, res) => serveCallRoute(board, req, res),
  });
}

/** Dispatch one `/voice/call/*` request by its path suffix. */
export function serveCallRoute(board: CallBoard, req: IncomingMessage, res: ServerResponse): void {
  let path: string;
  try {
    path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const suffix = path.slice(CALL_ROUTE.length);
  if (suffix === '/events') {
    if (req.method !== 'GET') return rejectMethod(res, 'GET');
    serveEventStream(board, req, res);
    return;
  }
  if (suffix === '/state') {
    if (req.method !== 'GET') return rejectMethod(res, 'GET');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ calls: board.list() }));
    return;
  }
  if (suffix === '/answer') {
    if (req.method !== 'POST') return rejectMethod(res, 'POST');
    serveAnswer(board, req, res);
    return;
  }
  res.writeHead(404);
  res.end();
}

/** Hold one SSE response open and mirror the board onto it. */
function serveEventStream(board: CallBoard, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const send = (event: string, data: unknown): void => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // A write against a dead socket must not break the publisher.
    }
  };
  const unsubscribe = board.subscribe((event) => {
    if (event.kind === 'settled') send(SETTLED_EVENT, event.call);
    else send(event.kind === 'active' ? ACTIVE_EVENT : RINGING_EVENT, event.call);
  });
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // The close handler cleans this up.
    }
  }, HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  res.on('error', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/** Read, validate, and apply one answer payload; respond `VoiceAnswerResult`. */
function serveAnswer(board: CallBoard, req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, reason: 'payload too large' }));
      return;
    }
    if (!aborted) chunks.push(chunk);
  });
  req.on('error', () => {
    aborted = true;
  });
  req.on('end', () => {
    if (aborted) return;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, reason: 'invalid JSON' }));
      return;
    }
    const verdict = validateAnswer(payload);
    if (verdict !== null) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, reason: verdict }));
      return;
    }
    const answer = payload as { callId: string; decision: AnswerDecision };
    const result = board.answer(answer.callId, answer.decision);
    res.writeHead(result.ok ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(result));
  });
}

/** Shape-check one answer payload; returns the error reason or null. */
function validateAnswer(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return 'payload must be an object';
  const { callId, decision } = payload as Record<string, unknown>;
  if (typeof callId !== 'string' || callId === '') return 'callId must be a non-empty string';
  if (!ANSWERABLE.includes(decision as AnswerDecision)) return `decision must be one of ${ANSWERABLE.join(', ')}`;
  return null;
}

/** Answer 405 with the single method the endpoint accepts. */
function rejectMethod(res: ServerResponse, allowed: string): void {
  res.writeHead(405, { allow: allowed });
  res.end();
}
