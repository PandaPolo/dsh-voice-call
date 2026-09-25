/**
 * The artifact store's boundary, and the route that streams from inside it.
 *
 * Two promises live here and both are stated in SECURITY.md, so both get tested
 * against a real socket rather than against a reading of the source: nothing
 * outside the audio root is readable, and a read that fails on the way out is an
 * aborted download — not an unhandled stream error, which is what a piped
 * `createReadStream` becomes and what used to take the host process down.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { AudioStore, confineAudioInput } from '../src/audio.ts';
import { pipeFile, serveAudio } from '../src/web.ts';

const closers: Array<() => Promise<void>> = [];
const roots: string[] = [];

after(async () => {
  for (const close of closers) await close();
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsvc-audio-'));
  roots.push(dir);
  return dir;
}

/** A server whose routes are the two halves of `src/web.ts`, plus a liveness probe. */
async function mount(root: string): Promise<string> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://dsh.local').pathname;
    if (path === '/gone') {
      // The head is written first: the file has to vanish *after* the response
      // starts, which is the only shape of this bug the browser can see.
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': '4096' });
      pipeFile(join(root, 'never-existed.wav'), res);
      return;
    }
    if (path.startsWith('/voice/audio')) return serveAudio(root, req, res);
    if (path === '/') {
      res.writeHead(200);
      res.end('alive');
      return;
    }
    // Anything else is 404 here, the way the host's prefix router would treat it:
    // a probe that lands outside the route must not read as a successful leak.
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  closers.push(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  });
  return `http://127.0.0.1:${port}`;
}

describe('the audio root boundary', () => {
  it('resolves what is inside and refuses what is not', async () => {
    const root = await tempRoot();
    const store = new AudioStore(root);
    assert.equal(store.resolve('voice-in-1.m4a'), join(root, 'voice-in-1.m4a'));
    assert.equal(store.resolve(join(root, 'a', 'b.wav')), join(root, 'a', 'b.wav'));
    for (const escape of ['../secret.txt', join(root, '..', 'secret.txt'), '/etc/passwd', 'C:\\Windows\\win.ini']) {
      assert.throws(() => store.resolve(escape), /escapes the audio root/, `"${escape}" is not ours to read`);
    }
  });

  it('tells a caller what to do instead, in the message the agent sees', async () => {
    const root = await tempRoot();
    const inside = join(root, 'take.mp3');
    await writeFile(inside, 'bytes');
    assert.equal(confineAudioInput(root, inside), inside);
    assert.equal(confineAudioInput(root, 'take.mp3'), inside);
    assert.throws(() => confineAudioInput(root, '/etc/hosts'), /has to sit inside the audio directory/);
  });
});

describe('the audio route', () => {
  it('will not serve a path that climbs out of the root', async () => {
    const root = await tempRoot();
    const outside = join(root, '..', 'secret.txt');
    await writeFile(outside, 'do not serve this');
    const url = await mount(root);
    // Encoded, because a literal `../` never survives the client: the URL layer
    // collapses it into `/secret.txt` before it is sent, which is a different
    // (also safe) path. The route's own job is the encoded form, which arrives at
    // its decoder as `../`.
    for (const attempt of ['..%2Fsecret.txt', '%2e%2e%2Fsecret.txt', 'nested/..%2f..%2fsecret.txt', '..%c0%afsecret.txt']) {
      const response = await fetch(`${url}/voice/audio/${attempt}`);
      // 404 for a path that resolves out of the root, 400 for an overlong
      // encoding the decoder will not even name. Both are refusals; the claim is
      // that the file never comes back.
      assert.ok([400, 404].includes(response.status), `"${attempt}" answered ${response.status}`);
      assert.doesNotMatch(await response.text(), /do not serve this/);
    }
  });

  it('serves a real artifact, and honors a range', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, 'nested', 'note.wav'), Buffer.alloc(1000, 7));
    const url = await mount(root);
    const whole = await fetch(`${url}/voice/audio/nested/note.wav`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal((await whole.arrayBuffer()).byteLength, 1000);
    const slice = await fetch(`${url}/voice/audio/nested/note.wav`, { headers: { range: 'bytes=10-19' } });
    assert.equal(slice.status, 206);
    assert.equal(slice.headers.get('content-range'), 'bytes 10-19/1000');
    assert.equal((await slice.arrayBuffer()).byteLength, 10);
  });

  it('aborts a read that fails instead of ending the process', async () => {
    // The regression this pins: `createReadStream(file).pipe(res)` listens for
    // the destination's errors only, so the source's ENOENT/EBUSY arrives as an
    // uncaught exception. If the handler is ever lost again, this request kills
    // the test process rather than failing the assertion — which is the point.
    const url = await mount(await tempRoot());
    await assert.rejects(fetch(`${url}/gone`), 'a destroyed socket is how a browser learns the file went away');
    const alive = await fetch(`${url}/`);
    assert.equal(await alive.text(), 'alive', 'still serving, which is the whole claim');
  });
});
