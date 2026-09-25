/**
 * The segmented downloader, against a real `node:http` server that serves
 * ranges and can be told to misbehave per request. The point is the assembly:
 * lanes finish out of order, one lane dies mid-segment, and the file still has
 * to come out byte-identical — or the run must say so and leave a resumable
 * state behind.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_SEGMENT_BYTES, MIN_SEGMENTED_BYTES, downloadSegmented, planSegments,
  shouldSegment, statePath,
} from '../src/provision/segmented.ts';
import { partPath } from '../src/provision/download.ts';
import type { Candidate } from '../src/provision/manifest.ts';

/** 11 MiB: three 4 MiB segments with a remainder, so the tail is exercised too. */
const BODY = Buffer.from(Array.from({ length: 11 * 1024 * 1024 }, (_unused, index) => (index * 31 + 7) % 251));
const DIGEST = createHash('sha256').update(BODY).digest('hex');

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];

after(async () => {
  for (const closer of closers) await closer();
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsvc-seg-'));
  roots.push(dir);
  return dir;
}

/** How an origin should answer a range request. */
interface Faults {
  /** Ignore Range and send the whole file, like a non-byte-serving mirror. */
  readonly ignoresRange?: boolean;
  /** Send this many bytes of each segment, then drop the connection. */
  readonly truncatesAfter?: number;
  /** Serve shifted bytes: a mirror that is quietly wrong. */
  readonly corrupt?: boolean;
  /** Serve this many ranges in full, then drop every connection after them. */
  readonly failAfter?: number;
  /** Delay every segment except the first, so lanes finish out of order. */
  readonly slowFirst?: boolean;
  readonly answerless?: boolean;
}

interface Origin {
  readonly candidate: Candidate;
  readonly requests: string[];
  readonly close: () => Promise<void>;
}

async function origin(id: string, faults: Faults = {}): Promise<Origin> {
  const requests: string[] = [];
  let served = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    requests.push(req.headers.range ?? '(none)');
    if (faults.answerless === true) return;
    if (faults.ignoresRange === true || match === null) {
      res.writeHead(200, { 'content-length': String(BODY.length) });
      res.end(BODY);
      return;
    }
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (faults.failAfter !== undefined) {
      // A mirror that begins throttling halfway through the file, which is the
      // shape the resume exists for: the first `failAfter` ranges are delivered
      // in full and every one after that is dropped.
      if (served >= faults.failAfter) {
        res.destroy();
        return;
      }
      served += 1;
    }
    let slice: Uint8Array = BODY.subarray(from, to + 1);
    if (faults.corrupt === true) slice = Buffer.from(slice).map((byte) => byte ^ 0xff);
    res.writeHead(206, {
      'content-range': `bytes ${from}-${to}/${BODY.length}`,
      'content-length': String(slice.length),
    });
    if (faults.slowFirst === true && from === 0) {
      // Hold the head of the file back so a later segment provably lands first.
      setTimeout(() => res.end(slice), 250);
      return;
    }
    if (faults.truncatesAfter !== undefined) {
      res.write(slice.subarray(0, faults.truncatesAfter));
      const timer = setTimeout(() => res.destroy(), 150);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    res.end(slice);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const close = async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  };
  closers.push(close);
  return { candidate: { url: `http://127.0.0.1:${port}/${id}`, origin: id, kind: 'mirror' }, requests, close };
}

const toDisk = (dir: string): string => join(dir, 'asset.bin');

describe('segmented download', () => {
  it('plans segments that cover the file exactly once', () => {
    const exact = planSegments(8 * 1024 * 1024, 4 * 1024 * 1024);
    assert.equal(exact.length, 2);
    assert.deepEqual(exact.map((segment) => [segment.from, segment.to]), [[0, 4194303], [4194304, 8388607]]);
    const remainder = planSegments(11 * 1024 * 1024, 4 * 1024 * 1024);
    assert.equal(remainder.length, 3);
    assert.equal(remainder[2]?.to, 11 * 1024 * 1024 - 1, 'the tail segment stops at the file, not at the segment size');
    const covered = remainder.reduce((sum, segment) => sum + (segment.to - segment.from + 1), 0);
    assert.equal(covered, 11 * 1024 * 1024);
    assert.deepEqual(planSegments(0, 1024), []);
    assert.equal(shouldSegment(MIN_SEGMENTED_BYTES), true);
    assert.equal(shouldSegment(MIN_SEGMENTED_BYTES - 1), false, 'an 8 MB archive is not worth six handshakes');
  });

  it('assembles a file whose lanes finish out of order', async () => {
    const dir = await workspace();
    const dest = toDisk(dir);
    const lagging = await origin('lagging', { slowFirst: true });
    const result = await downloadSegmented({
      candidates: [lagging.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
      connections: 4, segmentBytes: DEFAULT_SEGMENT_BYTES,
    });
    assert.equal(result.bytes, BODY.length);
    assert.equal(result.lanes, 4);
    assert.deepEqual(await readFile(dest), BODY, 'a segment written late must still land at its own offset');
    await assert.rejects(stat(statePath(dest)), 'a finished run leaves no resume bookkeeping');
    await assert.rejects(stat(partPath(dest)), 'the .part became the file');
  });

  it('re-fetches a truncated segment from the next origin and still matches', async () => {
    const dir = await workspace();
    const dest = toDisk(dir);
    const flaky = await origin('flaky', { truncatesAfter: 4096 });
    const steady = await origin('steady');
    const result = await downloadSegmented({
      candidates: [flaky.candidate, steady.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
      connections: 3,
    });
    assert.equal(result.bytes, BODY.length);
    // The flaky origin never *completed* a segment, so it is not in the origin
    // list — which only records lanes that delivered. It was still tried.
    assert.ok(flaky.requests.length > 0, 'the bad lane was attempted');
    assert.deepEqual(result.origins, ['steady'], 'only an origin that finished a segment counts as a contributor');
    assert.deepEqual(await readFile(dest), BODY);
    assert.ok(steady.requests.length > 0, 'the fallback origin was actually used');
  });

  it('refuses an origin that ignores the Range request instead of writing the wrong slice', async () => {
    const dir = await workspace();
    const dest = toDisk(dir);
    const naive = await origin('naive', { ignoresRange: true });
    const steady = await origin('steady');
    const result = await downloadSegmented({
      candidates: [naive.candidate, steady.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
      connections: 2,
    });
    assert.deepEqual(result.origins, ['steady'], 'a 200 to a range request is not a usable lane');
    assert.deepEqual(await readFile(dest), BODY);
  });

  it('discards a quietly corrupted assembly and remembers nothing to resume', async () => {
    const dir = await workspace();
    const dest = toDisk(dir);
    const liar = await origin('liar', { corrupt: true });
    await assert.rejects(downloadSegmented({
      candidates: [liar.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST, connections: 2,
    }), /校验和不符/);
    await assert.rejects(stat(partPath(dest)), 'wrong bytes are not worth keeping');
    await assert.rejects(stat(statePath(dest)), 'a stale bitmap would resume a poisoned file');
  });

  it('resumes from the segments already finished, and claims each one once', async () => {
    const dir = await workspace();
    const dest = toDisk(dir);
    // A crashed earlier run is constructed rather than raced: the `.part` holds
    // the first two segments for real, and the sidecar says so. Racing a local
    // server to death would test the scheduler, not the resume.
    const size = DEFAULT_SEGMENT_BYTES;
    const part = partPath(dest);
    await writeFile(part, Buffer.concat([BODY.subarray(0, 2 * size), Buffer.alloc(BODY.length - 2 * size)]));
    await writeFile(statePath(dest), JSON.stringify({
      total: BODY.length, size, done: [true, true, false],
    }), 'utf8');

    const steady = await origin('steady');
    const result = await downloadSegmented({
      candidates: [steady.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST, connections: 2,
    });
    assert.equal(result.bytes, BODY.length);
    assert.deepEqual(await readFile(dest), BODY, 'the resumed bytes must survive the assembly');
    assert.equal(steady.requests.length, 1, `only the missing tail segment is fetched, got ${steady.requests.length}`);
    assert.equal(steady.requests[0], `bytes=${2 * size}-${BODY.length - 1}`);
    assert.equal(new Set(steady.requests).size, steady.requests.length, 'no segment is claimed twice by one run');
    await assert.rejects(stat(statePath(dest)), 'a finished run clears the sidecar');
  });

  it('records what an interrupted run had already paid for, and resumes from it', async () => {
    const dir = await workspace();
    const dest = toDisk(dir);
    const size = DEFAULT_SEGMENT_BYTES;
    const total = planSegments(BODY.length, size).length;
    // The sidecar in the test above is written by hand. This one is produced by
    // a run that dies, which is the only way to test the promise the module
    // header makes — the bitmap used to be saved *after* every lane had returned
    // cleanly, so a cancelled or throttled run arrived at the next one with
    // nothing to show for itself and re-fetched the whole 1.9 GB model, while the
    // advice text under the failure still read 从断点继续.
    const halfway = await origin('halfway', { failAfter: 2 });
    await assert.rejects(
      downloadSegmented({
        candidates: [halfway.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST, connections: 1,
      }),
      () => true,
      'the run that loses its origin fails, as it always did',
    );
    const state = JSON.parse(await readFile(statePath(dest), 'utf8')) as { total: number; size: number; done: boolean[] };
    assert.equal(state.total, BODY.length);
    assert.equal(state.size, size);
    assert.deepEqual(state.done.slice(0, 2), [true, true], 'the two delivered segments are on record');
    assert.equal(state.done[2], false, 'and the segment nobody finished is not');

    const steady = await origin('steady');
    await downloadSegmented({
      candidates: [steady.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST, connections: 1,
    });
    assert.equal(steady.requests.length, 1, `the resumed run asks for the hole only, got ${steady.requests.length} of ${total}`);
    assert.deepEqual(await readFile(dest), BODY, 'and the assembly is still byte-identical');
    await assert.rejects(stat(statePath(dest)), 'a finished run clears the sidecar');
  });

  it('ignores a bitmap whose .part has been deleted', async () => {
    const dir = await workspace();
    const dest = toDisk(dir);
    // The claim is that segments are done; the file that would prove it is gone.
    await writeFile(statePath(dest), JSON.stringify({
      total: BODY.length, size: DEFAULT_SEGMENT_BYTES, done: [true, true, true],
    }), 'utf8');
    const steady = await origin('steady');
    await downloadSegmented({
      candidates: [steady.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST, connections: 2,
    });
    assert.equal(steady.requests.length, planSegments(BODY.length, DEFAULT_SEGMENT_BYTES).length,
      'a bitmap without its file refetches everything rather than shipping holes');
    assert.deepEqual(await readFile(dest), BODY);
  });

  it('reports progress in whole-file bytes, not per-lane ones', async () => {
    const dir = await workspace();
    const dest = toDisk(dir);
    const steady = await origin('steady');
    const ticks: number[] = [];
    await downloadSegmented({
      candidates: [steady.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
      connections: 4, onProgress: (progress) => {
        ticks.push(progress.receivedBytes);
        assert.ok(progress.receivedBytes <= BODY.length);
        assert.equal(progress.totalBytes, BODY.length);
        assert.equal(progress.lanes, 4);
      },
    });
    assert.ok(ticks.length > 1, 'four lanes should produce several ticks');
    assert.equal(ticks[ticks.length - 1], BODY.length);
    for (let index = 1; index < ticks.length; index += 1) {
      assert.ok((ticks[index] ?? 0) >= (ticks[index - 1] ?? 0), 'a whole-file counter must never go backwards');
    }
  });

  it('fails loudly when no origin can serve a segment', async () => {
    const dir = await workspace();
    const dest = toDisk(dir);
    const dead = await origin('dead', { answerless: true });
    const error = await downloadSegmented({
      candidates: [dead.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST,
      connections: 2, firstByteMs: 200,
    }).then(() => null, (caught: unknown) => caught as Error);
    assert.ok(error instanceof Error);
    assert.match(error.message, /连不上|分段/);
    const kept = await stat(partPath(dest)).catch(() => null);
    assert.ok(kept !== null && kept.size === BODY.length, 'the pre-allocated file stays for a later resume');
  });

  it('writes into a nested destination it has to create', async () => {
    const dir = await workspace();
    const dest = join(dir, 'models', 'deep', 'asset.bin');
    const steady = await origin('steady');
    await downloadSegmented({
      candidates: [steady.candidate], dest, expectedBytes: BODY.length, expectedSha256: DIGEST, connections: 2,
    });
    assert.deepEqual(await readFile(dest), BODY);
    assert.equal(dirname(dest).includes(dir), true);
  });
});
