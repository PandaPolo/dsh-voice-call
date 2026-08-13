/**
 * The web audio route: serves synthesized/recorded audio files from
 * audioDir to the chat UI's audio cards. Registered only when the webserver
 * service is present (the web profile); headless deployments skip it. Range
 * requests are honored so `<audio>` seeking works in browsers.
 *
 * @module dsh-voice/web
 */
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { isUnderRoot, mimeForPath } from './audio.ts';

/** The route path prefix serving audio artifacts. */
export const AUDIO_ROUTE = '/voice/audio';

/** Register the audio route on `ctx.webServer` when present; returns the disposer. */
export function installAudioRoute(ctx: Context, root: string): () => void {
  const webServer = ctx.get('webServer') as
    | { register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void }
    | undefined;
  if (webServer === undefined) return () => {};
  return webServer.register({
    kind: 'prefix',
    path: AUDIO_ROUTE,
    handler: (req, res) => serveAudio(root, req, res),
  });
}

/** Serve one audio file under the root, honoring Range. */
export function serveAudio(root: string, req: IncomingMessage, res: ServerResponse): void {
  const suffix = AUDIO_ROUTE.length;
  const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  const rel = rawPath.slice(suffix).replace(/^\/+/, '');
  if (rel === '' || rel.includes('..') || rel.includes('\0')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const file = `${root}/${rel}`;
  if (!isUnderRoot(root, file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  let info;
  try {
    info = statSync(file);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  const mime = mimeForPath(file);
  const range = req.headers.range;
  if (range === undefined) {
    res.writeHead(200, {
      'content-type': mime,
      'content-length': String(info.size),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
    });
    createReadStream(file).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match === null) {
    res.writeHead(416, { 'content-range': `bytes */${info.size}` });
    res.end();
    return;
  }
  const start = match[1] !== undefined && match[1] !== '' ? Number(match[1]) : 0;
  const end = match[2] !== undefined && match[2] !== '' ? Number(match[2]) : info.size - 1;
  if (start >= info.size || end < start) {
    res.writeHead(416, { 'content-range': `bytes */${info.size}` });
    res.end();
    return;
  }
  const length = Math.min(end, info.size - 1) - start + 1;
  res.writeHead(206, {
    'content-type': mime,
    'content-length': String(length),
    'content-range': `bytes ${start}-${start + length - 1}/${info.size}`,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
  });
  createReadStream(file, { start, end: start + length - 1 }).pipe(res);
}
