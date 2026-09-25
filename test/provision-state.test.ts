/**
 * The runner's behaviour: what a ready root looks like, what a failed one says,
 * and whether a cancel costs the user the bytes they already paid for.
 *
 * The assets are synthetic (tiny buffers with their own digests) because the
 * manifest's real digests belong to files of 8–900 MB. The download *mechanics*
 * are covered against a real HTTP server in `provision-download.test.ts`; here
 * the question is only whether the state machine drives them correctly.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ProvisionRunner, adviceFor } from '../src/provision/state.ts';
import type { PrepareRequest, ProvisionView, UnpackRequest } from '../src/provision/state.ts';
import type { FetchLike, FetchResponse } from '../src/provision/download.ts';
import { provisionLayout, readRecord } from '../src/provision/layout.ts';
import type { Candidate, EngineVariant, ModelAsset } from '../src/provision/manifest.ts';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The three synthetic assets one test run provisions. */
const ARCHIVE = 'engine-archive-bytes';
const TALKER = 'talker-gguf-bytes';
const CODEC = 'codec-gguf-bytes';

const variant: EngineVariant = {
  id: 'win-cpu', label: 'test engine', os: 'win32', file: 'engine.zip',
  bytes: Buffer.byteLength(ARCHIVE), sha256: digest(ARCHIVE),
  gpu: 'none', archive: 'zip', binary: 'crispasr.exe', rank: 1, note: '',
};
const talker: ModelAsset = {
  role: 'talker', repo: 'cstr/test-GGUF', file: 'talker.gguf',
  bytes: Buffer.byteLength(TALKER), sha256: digest(TALKER), quant: 'q8_0', label: 't', default: true,
  backend: 'qwen3-tts-customvoice', note: 'test talker',
};
const codec: ModelAsset = {
  role: 'codec', repo: 'cstr/test-tok-GGUF', file: 'codec.gguf',
  bytes: Buffer.byteLength(CODEC), sha256: digest(CODEC), quant: 'q8_0', label: 'c', default: true,
  backend: 'qwen3-tts-customvoice', note: 'test codec',
};

const BY_NAME: Record<string, string> = {
  'engine.zip': ARCHIVE, 'talker.gguf': TALKER, 'codec.gguf': CODEC,
};

const dirs: string[] = [];
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsvc-prov-'));
  dirs.push(dir);
  return dir;
}
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function request(over: Partial<PrepareRequest> = {}): PrepareRequest {
  return { variant, talker, codec, ...over };
}

/** Wait for a condition an in-flight run is expected to reach. */
async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('the run never reached that state');
    await new Promise((done) => setTimeout(done, 5));
  }
}

function bodyOf(name: string): Uint8Array {
  const text = BY_NAME[name];
  return Buffer.from(text ?? 'not the asset you asked for');
}

function response(status: number, body: Uint8Array | null): FetchResponse {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' && body !== null ? String(body.length) : null) },
    body: body === null ? null : (async function* () {
      yield body;
    }()),
  };
}

/** A fetch that answers by file name, with per-name fault injection. */
function makeFetch(serve: (name: string) => FetchResponse): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      const name = (url.split('/').pop() ?? '').split('?')[0] ?? '';
      urls.push(name);
      return serve(name);
    },
  };
}

function candidatesLocal(url: string): readonly Candidate[] {
  return [{ url, origin: 'primary', kind: 'official' }];
}

/** The unpacker a provisioned engine needs: puts a fake binary in place. */
function makeUnpacker(): { unpack: (input: UnpackRequest) => Promise<string | undefined>; calls: UnpackRequest[] } {
  const calls: UnpackRequest[] = [];
  return {
    calls,
    unpack: async (input) => {
      calls.push(input);
      await mkdir(input.destDir, { recursive: true });
      const path = join(input.destDir, input.binary);
      await writeFile(path, 'fake engine');
      return path;
    },
  };
}

describe('provision runner', () => {
  it('reports an empty root as unprepared with everything still to fetch', async () => {
    const layout = provisionLayout(await workspace());
    const runner = new ProvisionRunner({ layout, unpack: makeUnpacker().unpack, candidates: candidatesLocal });
    const view = await runner.inspect(request());
    assert.equal(view.phase, 'unprepared');
    assert.deepEqual(view.steps.map((step) => step.status), ['queued', 'queued', 'queued']);
    assert.equal(view.remainingBytes, variant.bytes + talker.bytes + codec.bytes);
    assert.match(view.summary, /还需下载/);
    assert.equal(runner.busy, false);
  });

  it('provisions a whole root: verified models, unpacked engine, no leftover archive', async () => {
    const layout = provisionLayout(await workspace());
    const unpacker = makeUnpacker();
    const served = makeFetch((name) => response(200, bodyOf(name)));
    const runner = new ProvisionRunner({
      layout, unpack: unpacker.unpack, fetchImpl: served.fetch, candidates: candidatesLocal,
    });
    const view = await runner.prepare(request());
    assert.equal(view.phase, 'ready', JSON.stringify(view.steps, null, 1));
    assert.deepEqual(view.steps.map((step) => step.status), ['ready', 'ready', 'ready']);
    assert.equal(view.remainingBytes, 0);
    assert.match(view.summary, /已就绪/);

    assert.deepEqual(await readFile(layout.modelPath(talker), 'utf8'), TALKER);
    assert.deepEqual(await readFile(layout.modelPath(codec), 'utf8'), CODEC);
    assert.equal(unpacker.calls.length, 1, 'the engine archive is unpacked exactly once');
    assert.equal(unpacker.calls[0]?.destDir, layout.engineDir('win-cpu'));
    assert.equal(unpacker.calls[0]?.binary, 'crispasr.exe');
    await assert.rejects(stat(layout.archivePath(variant)), 'the archive is scaffolding, not an artifact');
    const record = JSON.parse(await readFile(layout.stateFile, 'utf8')) as { engineBinary?: string; engineTag?: string };
    assert.equal(record.engineTag, 'v0.8.36');
    assert.equal(record.engineBinary?.endsWith('crispasr.exe'), true);
  });

  it('does nothing on a second run over a ready root', async () => {
    const layout = provisionLayout(await workspace());
    const served = makeFetch((name) => response(200, bodyOf(name)));
    const runner = new ProvisionRunner({
      layout, unpack: makeUnpacker().unpack, fetchImpl: served.fetch, candidates: candidatesLocal,
    });
    await runner.prepare(request());
    served.urls.length = 0;
    const view = await runner.prepare(request());
    assert.equal(view.phase, 'ready');
    assert.deepEqual(served.urls, [], 'a ready root must not re-fetch 1.2 GB');
  });

  it('stops at the first broken asset and keeps the good work', async () => {
    const layout = provisionLayout(await workspace());
    // Same length, different bytes: this is the "a mirror quietly re-encoded it"
    // shape, which only the digest can catch.
    const served = makeFetch((name) => (name === 'talker.gguf' ? response(200, Buffer.from(TALKER.toUpperCase())) : response(200, bodyOf(name))));
    const runner = new ProvisionRunner({
      layout, unpack: makeUnpacker().unpack, fetchImpl: served.fetch, candidates: candidatesLocal,
    });
    const view = await runner.prepare(request());
    assert.equal(view.phase, 'failed');
    const [engine, broken, untouched] = view.steps;
    assert.equal(engine?.status, 'ready');
    assert.equal(broken?.status, 'failed');
    assert.match(broken?.advice ?? '', /校验/);
    assert.equal(untouched?.status, 'queued', 'the run stops rather than fetching past a broken step');
    await assert.rejects(stat(layout.modelPath(talker)), 'a file that failed verification never becomes an artifact');
    assert.equal(served.urls.includes('codec.gguf'), false);
  });

  it('rotates to the next origin when the first cannot serve it', async () => {
    const layout = provisionLayout(await workspace());
    const served = makeFetch((name) => (name === 'codec.gguf' ? response(404, null) : response(200, bodyOf(name))));
    const fallback = makeFetch((name) => response(200, bodyOf(name)));
    const runner = new ProvisionRunner({
      layout,
      unpack: makeUnpacker().unpack,
      candidates: (url, source) => (source.policy === 'auto'
        ? [{ url: `https://dead.example/${url.split('/').pop()}`, origin: 'dead', kind: 'proxy' }, { url, origin: 'primary', kind: 'official' }]
        : candidatesLocal(url)),
      fetchImpl: async (url, init) => (url.includes('dead.example') ? served.fetch(url.replace('https://dead.example/', ''), init) : fallback.fetch(url, init)),
    });
    const view = await runner.prepare(request({ source: { policy: 'auto' } }));
    assert.equal(view.phase, 'ready');
    const codecStep = view.steps.find((step) => step.id === 'codec');
    assert.equal(codecStep?.origin, 'primary', 'the report must name the origin that actually delivered it');
  });

  it('keeps the paid-for bytes when a run is cancelled, and resumes them on the next', async () => {
    const layout = provisionLayout(await workspace());
    const total = Buffer.byteLength(ARCHIVE);
    const asked: (string | undefined)[] = [];
    // A fetch that honours Range like a real origin: it serves the engine
    // archive, hangs mid-body, and answers a resume request with the tail only.
    const fetch: FetchLike = async (url, init) => {
      const name = url.split('/').pop() ?? '';
      if (name !== 'engine.zip') return response(200, bodyOf(name));
      const range = /^bytes=(\d+)-$/.exec(init.headers?.range ?? '');
      asked.push(init.headers?.range);
      if (range?.[1] === undefined) {
        const first = Buffer.from(ARCHIVE.slice(0, 4));
        return {
          status: 200,
          headers: { get: (header: string) => (header.toLowerCase() === 'content-length' ? String(total) : null) },
          body: (async function* () {
            yield first;
            // Hang, but hang the way a socket does: an abort must break out.
            await new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
          }()),
        };
      }
      const from = Number(range[1]);
      const tail = Buffer.from(ARCHIVE.slice(from));
      return {
        status: 206,
        headers: {
          get: (header: string) => {
            const key = header.toLowerCase();
            if (key === 'content-range') return `bytes ${from}-${total - 1}/${total}`;
            if (key === 'content-length') return String(tail.length);
            return null;
          },
        },
        body: (async function* () {
          yield tail;
        }()),
      };
    };
    const runner = new ProvisionRunner({ layout, unpack: makeUnpacker().unpack, fetchImpl: fetch, candidates: candidatesLocal });
    const views: ProvisionView[] = [];
    runner.subscribe((view) => views.push(view));
    const running = runner.prepare(request());
    await until(() => views.some((view) => view.steps.some((step) => step.status === 'downloading' && step.receivedBytes > 0)));
    runner.cancel();
    const view = await running;
    assert.equal(view.phase, 'cancelled');
    assert.equal(view.steps[0]?.status, 'cancelled');
    const kept = await stat(`${layout.archivePath(variant)}.part`);
    assert.ok(kept.size >= 4 && kept.size < total, `kept ${kept.size} of ${total} bytes`);

    // The next run continues from those bytes rather than paying for them again.
    asked.length = 0;
    const second = new ProvisionRunner({ layout, unpack: makeUnpacker().unpack, fetchImpl: fetch, candidates: candidatesLocal });
    const done = await second.prepare(request());
    assert.equal(done.phase, 'ready', JSON.stringify(done.steps, null, 1));
    assert.deepEqual(asked, [`bytes=${kept.size}-`], 'the resume request must start where the cancel stopped');
  });

  it('leaves an engine the config already points at out of the work list', async () => {
    const layout = provisionLayout(await workspace());
    const served = makeFetch((name) => response(200, bodyOf(name)));
    const unpacker = makeUnpacker();
    const runner = new ProvisionRunner({
      layout, unpack: unpacker.unpack, fetchImpl: served.fetch, candidates: candidatesLocal,
    });
    const view = await runner.inspect(request({ engineFromConfig: true }));
    assert.deepEqual(view.steps.map((step) => step.status), ['ready', 'queued', 'queued'], 'the row stays visible');
    assert.equal(view.remainingBytes, talker.bytes + codec.bytes, 'the engine bytes are not part of the ask');
    assert.match(view.summary, /还需下载/);
    await runner.prepare(request({ engineFromConfig: true }));
    assert.deepEqual(served.urls, ['talker.gguf', 'codec.gguf'], 'no engine archive is fetched');
    assert.equal(unpacker.calls.length, 0);
  });

  it('provisions a restricted selection when asked to', async () => {
    const layout = provisionLayout(await workspace());
    const served = makeFetch((name) => response(200, bodyOf(name)));
    const unpacker = makeUnpacker();
    const runner = new ProvisionRunner({
      layout, unpack: unpacker.unpack, fetchImpl: served.fetch, candidates: candidatesLocal,
    });
    const view = await runner.prepare(request({ only: ['codec'] }));
    assert.deepEqual(served.urls, ['codec.gguf'], 'a selection must not fetch the others');
    assert.deepEqual(view.steps.map((step) => step.id), ['codec']);
    assert.equal(unpacker.calls.length, 0);
    // The models the selection skipped stay missing, so the next full run picks them up.
    const full = await runner.inspect(request());
    assert.deepEqual(full.steps.filter((step) => step.status === 'queued').map((step) => step.id), ['engine', 'talker']);
  });


  it('adopts a hand-placed file after checking it, and refuses one that is not it', async () => {
    const layout = provisionLayout(await workspace());
    const dir = await workspace();
    const runner = new ProvisionRunner({ layout, unpack: makeUnpacker().unpack, candidates: candidatesLocal });

    const wrong = join(dir, 'codec.gguf');
    await writeFile(wrong, 'a different file entirely');
    const refusal = await runner.adopt(request(), 'codec', wrong);
    assert.equal(refusal.ok, false);
    assert.match(refusal.message, /对不上/);
    assert.equal((await stat(wrong)).size > 0, true, 'a rejected file stays where the user left it');
    await assert.rejects(stat(layout.modelPath(codec)));

    const right = join(dir, 'talker.gguf');
    await writeFile(right, TALKER);
    const taken = await runner.adopt(request(), 'talker', right);
    assert.equal(taken.ok, true);
    assert.deepEqual(await readFile(layout.modelPath(talker), 'utf8'), TALKER);
    await assert.rejects(stat(right), 'an adopted file moves into the root, it is not copied');
    const view = await runner.inspect(request());
    const talkerStep = view.steps.find((step) => step.id === 'talker');
    assert.equal(talkerStep?.status, 'ready');
    assert.equal(view.steps.find((step) => step.id === 'codec')?.status, 'queued');
  });

  it('holds the root for an adopt, so two writers never share one provision.json', async () => {
    const layout = provisionLayout(await workspace());
    const dir = await workspace();
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const runner = new ProvisionRunner({
      layout,
      // Parked inside the unpacker: `busy` is what is under test, and catching a
      // real run at the right moment is a race rather than a test.
      unpack: async (input: UnpackRequest) => {
        await gate;
        await mkdir(input.destDir, { recursive: true });
        const path = join(input.destDir, input.binary);
        await writeFile(path, 'engine');
        return path;
      },
      candidates: candidatesLocal,
    });
    const archive = join(dir, variant.file);
    await writeFile(archive, ARCHIVE);
    const first = runner.adopt(request(), 'engine', archive);
    await until(() => runner.busy);

    // A perfectly good file, refused only because somebody else owns the root.
    const good = join(dir, talker.file);
    await writeFile(good, TALKER);
    const refused = await runner.adopt(request(), 'talker', good);
    assert.equal(refused.ok, false);
    assert.match(refused.message, /正在装配/, 'two writers of one record is how a 1.2 GB install is forgotten');
    assert.deepEqual(await readFile(good, 'utf8'), TALKER, 'and the refused file stays where the user left it');

    const view = await runner.prepare(request());
    assert.equal(view, runner.snapshot(), 'a prepare that finds the root held starts nothing');

    release();
    const taken = await first;
    assert.equal(taken.ok, true);
    assert.equal(runner.busy, false, 'the hold ends with the adopt, not with the next restart');
    const second = await runner.adopt(request(), 'talker', good);
    assert.equal(second.ok, true, 'the same file is accepted once nobody holds the root');
    assert.deepEqual(await readFile(layout.modelPath(talker), 'utf8'), TALKER);
    await assert.rejects(stat(good), 'an adopted file moves into the root, it is not copied');
  });

  it('shows progress that the card can render, and nothing it cannot serialize', async () => {
    const layout = provisionLayout(await workspace());
    const served = makeFetch((name) => response(200, bodyOf(name)));
    const runner = new ProvisionRunner({
      layout, unpack: makeUnpacker().unpack, fetchImpl: served.fetch, candidates: candidatesLocal,
    });
    const views: ProvisionView[] = [];
    const unsubscribe = runner.subscribe((view) => views.push(view));
    const final = await runner.prepare(request());
    unsubscribe();
    assert.ok(views.some((view) => view.phase === 'preparing'));
    assert.ok(views.some((view) => view.steps.some((step) => step.status === 'downloading' && step.receivedBytes > 0)));
    assert.equal(views.at(-1)?.phase, 'ready');
    for (const view of [...views, final]) {
      assert.deepEqual(JSON.parse(JSON.stringify(view)), view, 'every view must survive the SSE round trip');
    }
  });

  it('records paths relative to the root so the folder can be moved', async () => {
    const root = await workspace();
    const layout = provisionLayout(root);
    const served = makeFetch((name) => response(200, bodyOf(name)));
    const runner = new ProvisionRunner({
      layout, unpack: makeUnpacker().unpack, fetchImpl: served.fetch, candidates: candidatesLocal,
    });
    await runner.prepare(request());
    const raw = JSON.parse(await readFile(layout.stateFile, 'utf8')) as { assets: { path: string }[]; engineBinary: string };
    for (const asset of raw.assets) {
      assert.equal(asset.path.startsWith(root), false, `${asset.path} must not be pinned to an absolute root`);
    }
    assert.equal(raw.engineBinary.startsWith(root), false);
    const again = await readRecord(join(await workspace(), 'elsewhere', 'provision.json'));
    assert.equal(again.assets.length, 0, 'an absent file reads as empty rather than throwing');
  });

  it('names a way out for every failure the network can produce', () => {
    for (const reason of ['first-byte', 'stalled', 'server', 'not-found', 'checksum', 'size', 'aborted', 'unsupported', 'nonsense']) {
      const text = adviceFor(reason, false);
      assert.ok(text.length > 8, `${reason} needs real advice`);
      assert.equal(text.includes('undefined'), false);
    }
    assert.match(adviceFor('aborted', false), /断点|\.part/);
    assert.match(adviceFor('not-found', false), /升级/);
    assert.match(adviceFor('stalled', true), /手动/, 'an oversized download must be pointed at 手动下载');
    assert.match(adviceFor('stalled', false), /换/);
  });
});
