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
 * Same-origin is not something the host enforces for us — its webserver has no
 * session, no token and no origin check, and binds a configurable host — so the
 * one write on this prefix goes through {@link guardWrite}. Reads are open: a
 * cross-site page cannot read a response the server never labels as shareable.
 *
 * @module dsh-voice-call/callcard/web
 */
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { CallBoard, type AnswerDecision } from './board.ts';
import { toneById } from '../client/tones.ts';
import { guardWrite } from '../web-guard.ts';

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
/** The card's presentation, served so the overlay can render before any call. */
export interface CallCardAppearance {
  readonly theme: 'system' | 'light' | 'dark';
  readonly palette: string;
  /** Play a ringtone while a card is ringing. */
  readonly ringtone: boolean;
  /** Which of {@link TONES} the above plays. */
  readonly tone: string;
}

export function installCallCardRoutes(ctx: Context, board: CallBoard, appearance: () => CallCardAppearance): () => void {
  const webServer = ctx.get('webServer') as
    | { register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void }
    | undefined;
  if (webServer === undefined) return () => {};
  return webServer.register({
    kind: 'prefix',
    path: CALL_ROUTE,
    handler: (req, res) => serveCallRoute(board, appearance, req, res),
  });
}

/** Dispatch one `/voice/call/*` request by its path suffix. */
export function serveCallRoute(board: CallBoard, appearance: () => CallCardAppearance, req: IncomingMessage, res: ServerResponse): void {
  let path: string;
  try {
    path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  const suffix = path.slice(CALL_ROUTE.length);
  // `/answer` is the human's decision, so it is the one write here, and it is
  // guarded before the suffix is read the same way the provisioning prefix does
  // it: an endpoint that ends up in front of a new route cannot be trusted to
  // remember this line.
  if (req.method === 'POST' && guardWrite(req, res)) return;
  if (suffix === '/events') {
    if (req.method !== 'GET') return rejectMethod(res, 'GET');
    serveEventStream(board, req, res);
    return;
  }
  if (suffix === '/state') {
    if (req.method !== 'GET') return rejectMethod(res, 'GET');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ calls: board.list(), appearance: appearance() }));
    return;
  }
  if (suffix === '/answer') {
    if (req.method !== 'POST') return rejectMethod(res, 'POST');
    serveAnswer(board, req, res);
    return;
  }
  // The ringtones are files that ship with the plugin, served from the same
  // origin as everything else: the card cannot reach the package directory, and
  // an inline base64 blob would triple the client bundle for one sound. The
  // `?tone=` query is what the settings card's 试听 and a card that picked a
  // different tone both use, and it goes through the table, never through a path.
  if (suffix === '/ringtone') {
    if (req.method !== 'GET') return rejectMethod(res, 'GET');
    serveRingtone(res, new URL(req.url ?? '/', 'http://dsh.local').searchParams.get('tone') ?? undefined);
    return;
  }
  res.writeHead(404);
  res.end();
}

/** The directory the tone files are read from — the one {@link TONES} names into. */
const ASSETS = new URL('../../assets/', import.meta.url);

/** One file per tone, read once each and kept: these bytes never change at runtime. */
const ringtoneCache = new Map<string, Buffer>();
/** Files already known to be missing, so a partial install fails quietly once. */
const ringtoneFailed = new Set<string>();

/**
 * Serve the ringtone named by `requested`, falling back to the configured one and
 * then to the shipped default.
 *
 * The id is looked up in the tone table and the table's own constant says which
 * file to read — an id is never a path, and the resolved URL additionally has to
 * stay under `assets/`. So `?tone=../../package.json` and `?tone=%2e%2e%2f` both
 * ring with `classic` rather than returning the package manifest.
 */
function serveRingtone(res: ServerResponse, requested: string | undefined): void {
  const tone = toneById(requested).file;
  if (ringtoneFailed.has(tone)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const send = (bytes: Buffer): void => {
    res.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': String(bytes.length),
      // Content-addressed by the package version, so an upgrade replaces it. The
      // tone rides in the query, which is part of the cache key, so switching
      // ringtones cannot be answered out of a stale entry.
      'cache-control': 'public, max-age=86400',
    });
    res.end(bytes);
  };
  const cached = ringtoneCache.get(tone);
  if (cached !== undefined) {
    send(cached);
    return;
  }
  const file = new URL(tone, ASSETS);
  if (!file.href.startsWith(ASSETS.href)) {
    ringtoneFailed.add(tone);
    res.writeHead(404);
    res.end();
    return;
  }
  readFile(file)
    .then((bytes) => {
      ringtoneCache.set(tone, bytes);
      send(bytes);
    })
    .catch(() => {
      // A package built without `assets/` (an old tarball, a partial install)
      // must not make the card ring loudly or 500: the card falls back to
      // silence and the call itself is unaffected.
      ringtoneFailed.add(tone);
      res.writeHead(404);
      res.end();
    });
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
