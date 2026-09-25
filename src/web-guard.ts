/**
 * The guard in front of every state-changing `/voice/*` request.
 *
 * The host's webserver (`@deepseek-ai/dsh-host-webserver`) carries no session,
 * no token and no `Origin` check of its own — it installs a gzip middleware and
 * hands a matched route direct ownership of the response — and `host` is a
 * configurable value whose legal set includes `0.0.0.0`. So each plugin route is
 * answering whoever reaches the port.
 *
 * That is fine to read and dangerous to write. `POST /voice/provision/cleanup`
 * frees 1.2 GB, `POST /voice/provision/prepare` spends a 1.9 GB transfer, and
 * `POST /voice/call/answer` puts words in the human's mouth. A body flag is not
 * a defence for the first of those: `confirm: true` is visible to anyone who can
 * read the source, and the route never looked at the request's origin at all —
 * while a JSON body posted with `fetch(url, { method: 'POST', body: '…' })` is a
 * *simple* request, so a browser sends it cross-site without a preflight and the
 * page just cannot read the reply. The deletion still happens.
 *
 * The check that actually holds is `Sec-Fetch-Site`, which the browser computes
 * from the initiator and a page cannot set. Cross-site writes are refused;
 * `same-site` and `none` pass, and a request with no such header at all falls
 * back to comparing `Origin` against the `Host` it was addressed to (older
 * browsers), which is what a same-origin page always satisfies because both
 * carry the authority the person typed.
 *
 * Residual, stated plainly: a non-browser process on this machine — curl, or any
 * program the user runs — sends none of these headers and stays free to call.
 * A loopback port cannot tell that from the plugin's own client without a shared
 * secret, and minting one is the host's job, not this plugin's.
 *
 * @module dsh-voice-call/web-guard
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Why this write did not come from the page the plugin was served by, or
 * `undefined` when it did.
 */
export function crossOriginWrite(req: IncomingMessage): string | undefined {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '') {
    // `same-origin` is our own client; `same-site` is the same person on another
    // port of the same deploy; `none` is a non-HTTP context (a bookmarklet, a
    // file:// page) that a remote site cannot reach either.
    if (site === 'cross-site') return `sec-fetch-site: ${site}`;
    return undefined;
  }
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return undefined;
  let from: string;
  try {
    from = new URL(origin).host;
  } catch {
    return `origin ${origin} is not a URL`;
  }
  const host = req.headers.host;
  return host !== undefined && from.toLowerCase() !== host.toLowerCase()
    ? `origin ${from} is not this host`
    : undefined;
}

/**
 * Answer `req` with 403 when it is a cross-site write; returns true when the
 * handler must stop. Both payload shapes are filled because the two clients on
 * these prefixes read different fields (`reason` for the card, `message` for the
 * settings page).
 */
export function guardWrite(req: IncomingMessage, res: ServerResponse): boolean {
  const reason = crossOriginWrite(req);
  if (reason === undefined) return false;
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({
    ok: false,
    reason,
    message: '这个请求不是从插件页面发出的，已拒绝',
  }));
  return true;
}
