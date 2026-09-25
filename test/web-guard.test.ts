/**
 * The gate in front of the state-changing `/voice/*` endpoints.
 *
 * `fetch(url, { method: 'POST', body: '…' })` with a text body is a *simple*
 * request: a browser sends it to another site without asking anyone, and the
 * same-origin policy then only stops the page from reading the reply. The
 * deletion of 1.2 GB of models does not need to read the reply. So what is
 * tested here is the one thing a page cannot forge — `Sec-Fetch-Site`, and
 * failing that, the `Origin` a page cannot point at the loopback port.
 */
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';
import { crossOriginWrite } from '../src/web-guard.ts';

const SELF = '127.0.0.1:3080';

/** A request carrying only the headers under test. */
const req = (headers: Record<string, string>): IncomingMessage => ({ headers } as IncomingMessage);

describe('the write gate', () => {
  it('refuses the request a drive-by page cannot avoid sending', () => {
    assert.match(crossOriginWrite(req({ 'sec-fetch-site': 'cross-site', origin: 'http://evil.test', host: SELF })) ?? '', /cross-site/);
    assert.match(crossOriginWrite(req({ 'sec-fetch-site': 'cross-site', host: SELF })) ?? '', /cross-site/,
      'the header alone is enough — a page can send a POST with no Origin at all');
  });

  it('accepts the plugin’s own client', () => {
    assert.equal(crossOriginWrite(req({ 'sec-fetch-site': 'same-origin', origin: `http://${SELF}`, host: SELF })), undefined);
    assert.equal(crossOriginWrite(req({ 'sec-fetch-site': 'same-site', host: SELF })), undefined,
      'another port of the same deploy is the same person');
  });

  it('falls back to Origin for a browser that sends no Sec-Fetch-Site', () => {
    assert.equal(crossOriginWrite(req({ origin: 'http://evil.test', host: SELF })), 'origin evil.test is not this host');
    assert.equal(crossOriginWrite(req({ origin: `http://${SELF}`, host: SELF })), undefined);
    assert.equal(crossOriginWrite(req({ origin: `http://${SELF.toUpperCase()}`, host: SELF })), undefined, 'hosts are case-insensitive');
    assert.equal(crossOriginWrite(req({ origin: 'null', host: SELF })), undefined,
      'a file:// or sandboxed document is not a remote site');
    assert.match(crossOriginWrite(req({ origin: 'not a url', host: SELF })) ?? '', /not a URL/);
  });

  it('lets a local process through, because that is what a loopback port is', () => {
    // Not an oversight: curl and any program this person runs send neither
    // header, and there is no shared secret a plugin could check them against.
    // What the gate buys is the browser, which is the surface nobody was
    // defending before it.
    assert.equal(crossOriginWrite(req({ host: SELF })), undefined);
  });
});
