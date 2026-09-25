/**
 * The downloader's promises, checked against a real `node:http` server and real
 * files: no network, no mock that could drift from undici.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DownloadError, downloadAsset, hashFile, matchesAsset, orderByThroughput, partPath } from '../src/provision/download.ts';
import type { Candidate, OriginKind } from '../src/provision/manifest.ts';
import type { FetchLike } from '../src/provision/download.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

/** A body every test serves from, plus its manifest-style digest. */
const BODY = Buffer.from(Array.from({ length: 64 * 1024 }, (_, index) => index % 251));
const DIGEST = createHash('sha256').update(BODY).digest('hex');

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsvc-dl-'));
  roots.push(dir);
  return dir;
}
after(async () => {
  const { rm } = await import('node:fs/promises');
  // Close every fixture server even when a test failed before its own
  // `close()`: a listening socket would otherwise hold the process open.
  for (const closer of closers) await closer();
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

/** Serve one fixture origin on a loopback port; returns its candidate and a closer. */
async function origin(id: string, handler: Handler, kind: OriginKind = 'mirror'): Promise<{ candidate: Candidate; close: () => Promise<void> }> {
  const server = createServer((req, res) => handler(req, res, BODY));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const close = async () => {
    // Keep-alive sockets would otherwise hold `close` open forever, and the
    // stalled-origin test leaves exactly one of those hanging.
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  };
  closers.push(close);
  return { candidate: { url: `http://127.0.0.1:${port}/${id}`, origin: id, kind }, close };
}

function fullBody(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  if (range?.[1] !== undefined) {
    const from = Number(range[1]);
    const to = range[2] === '' ? body.length - 1 : Number(range[2]);
    res.writeHead(206, { 'content-range': `bytes ${from}-${to}/${body.length}`, 'content-length': String(to - from + 1) });
    res.end(body.subarray(from, to + 1));
    return;
  }
  res.writeHead(200, { 'content-length': String(body.length) });
  res.end(body);
}

describe('provision downloader', () => {
  it('delivers the file, verifies the digest, and leaves no .part behind', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'nested', 'asset.bin');
    const served = await origin('good', fullBody);
    const result = await downloadAsset({
      candidates: [served.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
    });
    assert.equal(result.bytes, BODY.length);
    assert.equal(result.sha256, DIGEST);
    assert.equal(result.origin, 'good');
    assert.deepEqual(await readFile(dest), BODY);
    await assert.rejects(stat(partPath(dest)), 'the .part sibling must be gone');
    await served.close();
  });

  it('drops bad bytes and retries on the next origin instead of trusting them', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'asset.bin');
    const corrupt = await origin('corrupt', (_req, res, body) => {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(Buffer.from(body).reverse());
    });
    const good = await origin('good', fullBody);
    const result = await downloadAsset({
      candidates: [corrupt.candidate, good.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
    });
    assert.equal(result.origin, 'good');
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.triedOrigins, ['corrupt', 'good']);
    assert.deepEqual(await readFile(dest), BODY);
    await corrupt.close();
    await good.close();
  });

  it('resumes a truncated transfer where it stopped, on another origin', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'asset.bin');
    const cut = 20 * 1024;
    const ranges: string[] = [];
    const flaky = await origin('flaky', (_req, res, body) => {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.write(body.subarray(0, cut));
      // Destroy only once the bytes are on the wire: an immediate `destroy()`
      // resets the socket before they leave, and there would be nothing to resume.
      const timer = setTimeout(() => res.destroy(), 120);
      res.on('close', () => clearTimeout(timer));
    });
    const steady = await origin('steady', (req, res, body) => {
      ranges.push(req.headers.range ?? '(none)');
      fullBody(req, res, body);
    });
    const result = await downloadAsset({
      candidates: [flaky.candidate, steady.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
    });
    assert.equal(result.resumedFrom, cut, 'the second attempt must continue from the bytes already paid for');
    assert.equal(ranges[0], `bytes=${cut}-`);
    assert.deepEqual(await readFile(dest), BODY);
    await flaky.close();
    await steady.close();
  });

  it('refuses to resume through a prefix accelerator, which would splice its own bytes in', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'asset.bin');
    const cut = 20 * 1024;
    const ranges: string[] = [];
    const flaky = await origin('official', (_req, res, body) => {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.write(body.subarray(0, cut));
      const timer = setTimeout(() => res.destroy(), 120);
      res.on('close', () => clearTimeout(timer));
    }, 'official');
    // A prefix proxy serves its own landing page for a Range request, so
    // continuing at `bytes=20480-` there would splice foreign bytes onto a good
    // prefix and only fail at the digest — after burning the whole transfer.
    const proxy = await origin('proxy', (req, res, body) => {
      ranges.push(req.headers.range ?? '(none)');
      fullBody(req, res, body);
    }, 'proxy');
    const result = await downloadAsset({
      candidates: [flaky.candidate, proxy.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
    });
    assert.deepEqual(ranges, ['(none)'], 'a proxy candidate must be asked from byte 0');
    assert.equal(result.resumedFrom, 0);
    assert.deepEqual(await readFile(dest), BODY);
    await flaky.close();
    await proxy.close();
  });

  it('rotates origins when a body stalls mid-transfer', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'asset.bin');
    const hanging = await origin('hanging', (_req, res, body) => {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.write(body.subarray(0, 4096));
      // then nothing, forever — the "隧道还在但没人推流" shape
      const keep = setInterval(() => undefined, 1000);
      res.on('close', () => clearInterval(keep));
    });
    const good = await origin('good', fullBody);
    const result = await downloadAsset({
      candidates: [hanging.candidate, good.candidate], dest,
      expectedBytes: BODY.length, expectedSha256: DIGEST,
      firstByteMs: 500, stallMs: 300,
    });
    assert.equal(result.origin, 'good');
    assert.deepEqual(await readFile(dest), BODY);
    await hanging.close();
    await good.close();
  });


  it('gives up a lane that answers fast but delivers slowly', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'asset.bin');
    const seen: number[] = [];
    const crawler = await origin('crawler', async (_req, res, body) => {
      res.writeHead(200, { 'content-length': String(body.length) });
      // ~4 KB/s against an injected 20 KB/s floor: the bail has to come after a
      // few KB of measurement, not after the whole body crawled past.
      for (let at = 0; at < body.length; at += 512) {
        if (!res.write(body.subarray(at, Math.min(at + 512, body.length)))) await once(res, 'drain');
        await new Promise((done) => setTimeout(done, 120));
      }
      res.end();
    });
    const fast = await origin('fast', fullBody);
    const result = await downloadAsset({
      candidates: [crawler.candidate, fast.candidate], dest,
      expectedBytes: BODY.length, expectedSha256: DIGEST,
      slowProbeBytes: 4096, slowMinBytesPerSecond: 20_000, progressIntervalMs: 1,
      onProgress: (progress) => {
        if (progress.origin === 'crawler') seen.push(progress.receivedBytes);
      },
    });
    assert.equal(result.origin, 'fast', 'a crawling lane must be abandoned, not waited out');
    assert.ok(seen.length > 0, 'the crawler did start, which is what made the measurement possible');
    const furthest = Math.max(...seen);
    assert.ok(furthest < 24_576, `bailed after ${furthest} bytes of ${BODY.length}`);
    assert.deepEqual(result.triedOrigins, ['crawler', 'fast']);
    assert.deepEqual(await readFile(dest), BODY);
    await crawler.close();
    await fast.close();
  });

  it('finishes on the last origin however slow it is', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'asset.bin');
    const crawler = await origin('only', async (_req, res, body) => {
      res.writeHead(200, { 'content-length': String(body.length) });
      for (let at = 0; at < body.length; at += 8192) {
        res.write(body.subarray(at, Math.min(at + 8192, body.length)));
        await new Promise((done) => setTimeout(done, 40));
      }
      res.end();
    });
    // One candidate, and a floor it cannot clear: bailing here would fail an
    // install that was going to finish, so the floor must not apply last in line.
    const result = await downloadAsset({
      candidates: [crawler.candidate], dest,
      expectedBytes: BODY.length, expectedSha256: DIGEST,
      slowProbeBytes: 4096, slowMinBytesPerSecond: 5_000_000,
    });
    assert.equal(result.origin, 'only');
    assert.deepEqual(await readFile(dest), BODY);
    await crawler.close();
  });

  it('treats a mirror that cannot serve the asset as a miss, not a failure', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'asset.bin');
    const missing = await origin('missing', (_req, res) => {
      res.writeHead(404);
      res.end('no such file');
    });
    const good = await origin('good', fullBody);
    const result = await downloadAsset({
      candidates: [missing.candidate, good.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
    });
    assert.equal(result.origin, 'good');
    await missing.close();
    await good.close();
  });

  it('gives up on a connection that never produces a first byte', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'asset.bin');
    const silent = await origin('silent', (_req, _res) => {
      // no response at all: the GitHub connect-stall shape
    });
    const good = await origin('good', fullBody);
    const result = await downloadAsset({
      candidates: [silent.candidate, good.candidate], dest,
      expectedBytes: BODY.length, expectedSha256: DIGEST, firstByteMs: 250,
    });
    assert.equal(result.origin, 'good', 'a stalled origin must be rotated away from, not waited on');
    await silent.close();
    await good.close();
  });

  it('reports an origin whose declared size contradicts the manifest', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'asset.bin');
    const lying = await origin('lying', (_req, res, body) => {
      res.writeHead(200, { 'content-length': String(body.length + 1) });
      res.end(body);
    });
    const error = await captureRejection(() => downloadAsset({
      candidates: [lying.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
    }));
    assert.ok(error instanceof DownloadError);
    assert.equal(error.reason, 'size');
    assert.match(error.message, /清单/);
    await lying.close();
  });

  it('keeps the partial file on cancel so the next run continues', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'asset.bin');
    const controller = new AbortController();
    const slow = await origin('slow', async (_req, res, body) => {
      res.on('error', () => undefined);
      res.writeHead(200, { 'content-length': String(body.length) });
      res.write(body.subarray(0, 8 * 1024));
      // Pause mid-body so the cancel lands with work still in flight.
      await new Promise((done) => setTimeout(done, 200));
      if (!res.writableEnded) res.write(body.subarray(8 * 1024));
      if (!res.writableEnded) res.end();
    });
    const error = await captureRejection(() => downloadAsset({
      candidates: [slow.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
      signal: controller.signal, progressIntervalMs: 1,
      onProgress: (progress) => {
        if (progress.receivedBytes > 0) controller.abort();
      },
    }));
    assert.ok(error instanceof DownloadError);
    assert.equal(error.reason, 'aborted');
    const kept = await stat(partPath(dest));
    assert.ok(kept.size > 0 && kept.size < BODY.length, 'a cancelled download keeps its .part');
    await assert.rejects(stat(dest), 'the final path must not exist after a cancel');
    await slow.close();
  });

  it('hashes and recognises a file the user placed by hand', async () => {
    const dir = await tempDir();
    const path = join(dir, 'dropped.gguf');
    await writeFile(path, BODY);
    assert.equal(await hashFile(path), DIGEST);
    assert.equal(await matchesAsset(path, BODY.length, DIGEST), true);
    assert.equal(await matchesAsset(path, BODY.length - 1, DIGEST), false, 'a size mismatch must not be trusted');
    assert.equal(await matchesAsset(path, BODY.length, DIGEST.toUpperCase()), true, 'digests are case-insensitive');
    assert.equal(await matchesAsset(join(dir, 'absent'), BODY.length, DIGEST), false);
  });

  it('never emits a progress tick past the expected size and ends on the full count', async () => {
    const dir = await tempDir();
    const dest = join(dir, 'asset.bin');
    const good = await origin('good', fullBody);
    const ticks: number[] = [];
    await downloadAsset({
      candidates: [good.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
      onProgress: (progress) => {
        assert.ok(progress.receivedBytes <= BODY.length);
        assert.equal(progress.totalBytes, BODY.length);
        ticks.push(progress.receivedBytes);
      },
    });
    assert.ok(ticks.length > 0);
    assert.equal(ticks[ticks.length - 1], BODY.length);
    assert.ok(new Set(ticks).size === ticks.length, 'ticks must advance, never repeat a count');
    await good.close();
  });
});

/** Capture a rejection as a value so the reason can be asserted. */
async function captureRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return new Error('expected a rejection');
  } catch (error) {
    return error;
  }
}

describe('origin race', () => {
  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
  /** How each scripted origin behaves: latency + throughput, never, or an HTTP error. */
  const behaviours = new Map<string, { firstByteMs: number; kbps: number } | 'dead' | 'http-error'>();

  function at(origin: string, behaviour: number | { firstByteMs?: number; kbps: number } | 'dead' | 'http-error'): Candidate {
    const scriptedBehaviour = typeof behaviour === 'number'
      ? { firstByteMs: behaviour, kbps: 10_000 }
      : behaviour === 'dead' || behaviour === 'http-error' ? behaviour : { firstByteMs: behaviour.firstByteMs ?? 0, kbps: behaviour.kbps };
    behaviours.set(origin, scriptedBehaviour);
    return { url: `https://race.test/${origin}`, origin, kind: 'proxy' };
  }

  /** A fetch that answers per the script, drip-feeding at the scripted rate. */
  const scripted: FetchLike = async (url, init) => {
    const behaviour = behaviours.get(url.split('/').pop() ?? '');
    if (behaviour === undefined || behaviour === 'dead') {
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    if (behaviour === 'http-error') return { status: 404, headers: { get: () => null }, body: null };
    const { firstByteMs, kbps } = behaviour as { firstByteMs: number; kbps: number };
    const gapMs = Math.max(1, 512 / (kbps * 1024) * 1000);
    return {
      status: 200,
      headers: { get: () => null },
      body: (async function* () {
        await sleep(firstByteMs);
        for (;;) {
          // Abort between chunks, the way a cancelled stream actually stops.
          if (init.signal?.aborted === true) throw new Error('aborted');
          yield Buffer.alloc(512);
          await sleep(gapMs);
        }
      }()),
    };
  };

  async function race(candidates: readonly Candidate[], options: { budgetMs?: number; sampleBytes?: number } = {}): Promise<string[]> {
    const ordered = await orderByThroughput(candidates, { fetchImpl: scripted, sampleBytes: 8192, ...options });
    return ordered.map((candidate) => candidate.origin);
  }

  it('ranks by delivered bytes, not by who answers first', async () => {
    // The exact mistake the first version made: `quick-but-thin` answers in 10 ms
    // at 20 KB/s and `slow-to-connect` answers in 80 ms at 400 KB/s. Ranking by
    // first byte put the 20 KB/s lane in front and cost 2× the wall time.
    const order = await race([at('quick-but-thin', { kbps: 20 }), at('slow-to-connect', { firstByteMs: 80, kbps: 400 })]);
    assert.deepEqual(order, ['slow-to-connect', 'quick-but-thin']);
  });

  it('keeps the shipped order when every origin answers alike', async () => {
    assert.deepEqual(await race([at('a', { kbps: 500 }), at('b', { kbps: 500 })]), ['a', 'b'], 'equal rates must not shuffle');
  });

  it('moves an origin that never answered to the back without dropping it', async () => {
    // Nothing may be dropped: the silent candidate can still be the only one
    // that recovers before the body request goes out.
    assert.deepEqual(await race([at('dead', 'dead'), at('live', { kbps: 500 })], { budgetMs: 300 }), ['live', 'dead']);
    assert.deepEqual(await race([at('gone', 'http-error'), at('live', { kbps: 500 })]), ['live', 'gone'], 'an HTTP error is not an answer');
  });

  it('gives up on the race at its own budget and ranks what did arrive', async () => {
    // 4 KB/s reaches the 8 KB sample only after 2 s, so the budget cuts it to a
    // partial measurement — which still has to outrank a dead origin.
    assert.deepEqual(await race([at('thick', { kbps: 400 }), at('thin', { kbps: 4 }), at('dead', 'dead')], { budgetMs: 250 }), ['thick', 'thin', 'dead']);
    assert.deepEqual(await race([at('x', { kbps: 1 }), at('y', { kbps: 1 })], { budgetMs: 60 }), ['x', 'y'], 'nothing measurable: order is preserved, not invented');
  });
});
