/**
 * The `/voice/call` HTTP half, over a real socket. `callcard.test.ts` covers the
 * board and stays free of I/O, so the routes — including the one that hands the
 * card its ringtone — get checked here against bytes, not mocks.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, describe, it } from 'node:test';
import { CallBoard } from '../src/callcard/board.ts';
import { serveCallRoute, type CallCardAppearance } from '../src/callcard/web.ts';

const DEFAULT: CallCardAppearance = { theme: 'system', palette: 'azure', ringtone: true, tone: 'classic' };

const sites: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of sites) await close();
});

async function mount(appearance: CallCardAppearance = DEFAULT): Promise<string> {
  const board = new CallBoard(() => 0);
  const server = createServer((req, res) => {
    serveCallRoute(board, () => appearance, req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  sites.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  });
  return `http://127.0.0.1:${port}`;
}

describe('call-card routes', () => {
  it('serves the bundled ringtone as audio the card can loop', async () => {
    const url = await mount();
    const response = await fetch(`${url}/voice/call/ringtone`);
    assert.equal(response.status, 200, 'a card that cannot ring is a card with no warning at all');
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(response.headers.get('content-length'), String(bytes.length));
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF', 'a WAV, which every browser plays natively');
    const onDisk = await readFile(new URL('../assets/ringtone.wav', import.meta.url));
    assert.equal(bytes.length, onDisk.length, 'the route serves the shipped file, not a stub');
  });
  it('refuses anything but a GET on the ringtone', async () => {
    const url = await mount();
    const response = await fetch(`${url}/voice/call/ringtone`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
  });

  it('refuses an answer that did not come from the page that owns the card', async () => {
    const url = await mount();
    const self = new URL(url).origin;
    const body = JSON.stringify({ callId: 'call-not-there', decision: 'accepted' });
    const denied: ReadonlyArray<Record<string, string>> = [
      { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'http://evil.example' },
    ];
    for (const headers of denied) {
      const response = await fetch(`${url}/voice/call/answer`, { method: 'POST', headers, body });
      assert.equal(response.status, 403, JSON.stringify(headers));
    }
    // The gate refuses strangers; it must not refuse the card.
    const own = await fetch(`${url}/voice/call/answer`, {
      method: 'POST', headers: { 'sec-fetch-site': 'same-origin', origin: self }, body,
    });
    assert.equal(own.status, 404, 'same-origin gets as far as the board, which does not know that call');
    assert.equal((await own.json() as { ok: boolean }).ok, false);
  });

  it('carries the ringtone flag to the card through the state snapshot', async () => {
    const loud = await mount(DEFAULT);
    const quiet = await mount({ ...DEFAULT, ringtone: false });
    const on = await (await fetch(`${loud}/voice/call/state`)).json() as { appearance: CallCardAppearance };
    const off = await (await fetch(`${quiet}/voice/call/state`)).json() as { appearance: CallCardAppearance };
    assert.equal(on.appearance.ringtone, true);
    assert.equal(off.appearance.ringtone, false, 'a page opened mid-session must inherit the setting, not the default');
    assert.equal(off.appearance.palette, 'azure');
    assert.equal(off.appearance.tone, 'classic');
  });

  it('serves each bundled tone as its own bytes', async () => {
    const url = await mount();
    const one = await fetch(`${url}/voice/call/ringtone?tone=kalimba`);
    const two = await fetch(`${url}/voice/call/ringtone?tone=singing-bowl`);
    assert.equal(one.status, 200);
    assert.equal(two.status, 200);
    const [kalimba, bowl] = [await one.arrayBuffer(), await two.arrayBuffer()];
    assert.notEqual(kalimba.byteLength, bowl.byteLength, 'the dropdown is not repainting one file under eleven names');
    for (const [bytes, file] of [[kalimba, 'ringtones/kalimba.wav'], [bowl, 'ringtones/singing-bowl.wav']] as const) {
      const onDisk = await readFile(new URL(`../assets/${file}`, import.meta.url));
      assert.equal(bytes.byteLength, onDisk.length, `${file} is served from the package, not generated here`);
    }
  });

  it('answers an unknown or hostile tone with the default ringtone, never a path', async () => {
    const url = await mount();
    const onDisk = await readFile(new URL('../assets/ringtone.wav', import.meta.url));
    for (const hostile of ['../../package.json', '%2e%2e%2f%2e%2e%2fpackage.json', 'no-such-tone', '', 'ringtones%2f..%2f..%2fpackage.json']) {
      const response = await fetch(`${url}/voice/call/ringtone?tone=${hostile}`);
      assert.equal(response.status, 200, 'a bad id must not leave the card silent');
      const bytes = await response.arrayBuffer();
      assert.equal(bytes.byteLength, onDisk.length, `"${hostile}" resolved to the default, not to a file the id named`);
    }
  });
});
