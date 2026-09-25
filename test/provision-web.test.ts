/**
 * The provisioning HTTP surface — driven with real `fetch` against a real
 * server, because the two things worth proving are what crosses the wire: the
 * shape the card parses, and the fact that a client can only *name* an asset,
 * never define its URL, size or digest.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { serveProvisionRoute } from '../src/provision/web.ts';
import { ProvisionRunner } from '../src/provision/state.ts';
import type { PrepareRequest, UnpackRequest } from '../src/provision/state.ts';
import { provisionLayout } from '../src/provision/layout.ts';
import { ENGINE_VARIANTS, MODEL_ASSETS, defaultModels } from '../src/provision/manifest.ts';
import type { EngineVariant, ModelAsset } from '../src/provision/manifest.ts';
import type { FetchLike } from '../src/provision/download.ts';
import type { DeviceReport } from '../src/provision/detect.ts';

const CUDA: DeviceReport = { os: 'win32', arch: 'x64', gpu: 'cuda12', backends: ['cpu', 'cuda'], deviceName: 'NVIDIA GeForce RTX 4090', vramMb: 24563 };
const UNKNOWN: DeviceReport = { os: 'win32', arch: 'x64', gpu: 'unknown', backends: [], reason: '尚未探测' };
let DEVICE: DeviceReport = CUDA;
const variant = ENGINE_VARIANTS.find((entry) => entry.id === 'win-cpu') as EngineVariant;
const talker = MODEL_ASSETS.find((asset) => asset.role === 'talker') as ModelAsset;
const codec = MODEL_ASSETS.find((asset) => asset.role === 'codec') as ModelAsset;

/** The bodies a provisioned root gets replaced with: same name, tiny content. */
const BODIES: Record<string, Buffer> = {
  [variant.file]: Buffer.from('tiny engine archive'),
  [talker.file]: Buffer.from('tiny talker gguf'),
  [codec.file]: Buffer.from('tiny codec gguf'),
};

/**
 * The test request: the manifest's identities (repo, file, URL) with the tiny
 * bodies' byte expectations, so the real verification path runs end to end.
 */
function testRequest(over: Partial<PrepareRequest> = {}): PrepareRequest {
  const pin = <T extends { file: string }>(asset: T): T & { bytes: number; sha256: string } => {
    const body = BODIES[asset.file] ?? Buffer.alloc(0);
    return { ...asset, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  };
  return {
    variant: pin(variant),
    talker: pin(talker),
    codec: pin(codec),
    ...over,
  };
}

const state: { requested: string[] } = { requested: [] };
const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];

after(async () => {
  // A failed assertion skips its own close(), and a listening socket would
  // otherwise hold the test process open until the runner kills it.
  for (const closer of closers) await closer();
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

const fakeFetch: FetchLike = async (url) => {
  state.requested.push(url);
  const file = decodeURIComponent((url.split('/').pop() ?? '').split('?')[0] ?? '');
  const body = BODIES[file];
  if (body === undefined) return { status: 404, headers: { get: () => null }, body: null };
  return {
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(body.length) : null) },
    body: (async function* () {
      yield body;
    }()),
  };
};

/** A runner driven by the real route, against a real temp root. */
async function mount(
  request: () => PrepareRequest = () => testRequest(),
): Promise<{ url: string; close: () => Promise<void>; layout: ReturnType<typeof provisionLayout>; runner: ProvisionRunner }> {
  const root = await mkdtemp(join(tmpdir(), 'dsvc-provw-'));
  roots.push(root);
  const layout = provisionLayout(root);
  const runner = new ProvisionRunner({
    layout,
    unpack: async (input: UnpackRequest) => {
      await mkdir(input.destDir, { recursive: true });
      const path = join(input.destDir, input.binary);
      await writeFile(path, 'fake engine');
      return path;
    },
    fetchImpl: fakeFetch,
    // One candidate, named `fixture`, so a rotation bug cannot hide behind a
    // mirror list. The URL itself still comes from `engineUrl`/`modelUrl`.
    candidates: (url) => [{ url, origin: 'fixture', kind: 'official' }],
  });
  const server = createServer((req, res) => {
    void serveProvisionRoute(runner, layout, request, () => DEVICE, () => false, req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const site = {
    url: `http://127.0.0.1:${port}`,
    layout,
    runner,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
  // Registered here rather than by each test: an assertion that throws before
  // `site.close()` would otherwise leave a listening socket holding the whole
  // runner open, and a *hanging* suite is a far worse report than a failing one.
  closers.push(site.close);
  return site;
}

/** Put something on disk in each group so there is a number to report — and a
 *  file to notice still missing (or still there) after a cleanup. */
async function seed(layout: ReturnType<typeof provisionLayout>): Promise<void> {
  await mkdir(layout.modelsDir, { recursive: true });
  await writeFile(join(layout.modelsDir, 'talker.gguf'), 'm'.repeat(4096));
  await mkdir(layout.engineRootDir(), { recursive: true });
  await writeFile(join(layout.engineRootDir(), 'crispasr.exe'), 'e'.repeat(2048));
}

describe('provision routes', () => {
  it('serves the state with the catalogue the card renders', async () => {
    const site = await mount();
    const payload = await (await fetch(`${site.url}/voice/provision/state`)).json() as {
      view: { phase: string };
      catalogue: {
        dropDir: string; device: string;
        selection: { variantId: string; talkerFile: string; codecQuant: string; policy: string };
        variants: { id: string; offered: boolean; whyNot: string }[];
      };
    };
    assert.ok(['unknown', 'unprepared', 'ready'].includes(payload.view.phase));
    assert.equal(payload.catalogue.dropDir, join(site.layout.root, 'downloads'));
    assert.ok(payload.catalogue.variants.some((entry) => entry.offered), 'the machine must be offered something');
    assert.equal(payload.catalogue.selection.variantId, 'win-cpu', 'the card starts from what the server would act on');
    assert.equal(payload.catalogue.selection.talkerFile, talker.file);
    assert.equal(payload.catalogue.device, '已探测到 CUDA · NVIDIA GeForce RTX 4090 · 24 GB');
    // Every build the machine cannot run must say why, in the dropdown itself.
    for (const entry of payload.catalogue.variants) {
      const reason = `${entry.id}: offered=${String(entry.offered)} but whyNot=${entry.whyNot}`;
      assert.equal(entry.whyNot === '', entry.offered, reason);
    }
    const mac = payload.catalogue.variants.find((entry) => entry.id === 'mac-cpu');
    assert.equal(mac?.offered, false);
    assert.equal(mac?.whyNot, '不是这个平台的包');
    DEVICE = UNKNOWN;
    const blind = await (await fetch(`${site.url}/voice/provision/state`)).json() as typeof payload;
    assert.match(blind.catalogue.device, /尚未探测/);
    assert.equal(blind.catalogue.variants.find((entry) => entry.id === 'win-cuda')?.whyNot, '未探测到设备');
    DEVICE = CUDA;
    await site.close();
  });

  it('names the models already on disk as the default, not the manifest favourite', async () => {
    // The bug this pins: a root provisioned with the 1.7B talker was shown the
    // 0.6B one selected, so its row read `未安装 · 还需下载 923 MB` next to a
    // runtime that worked. The catalogue must describe the disk.
    const big = MODEL_ASSETS.find((asset) => asset.role === 'talker' && asset.file.includes('1.7b')) as ModelAsset;
    const cuda = ENGINE_VARIANTS.find((entry) => entry.id === 'win-cuda') as EngineVariant;
    const site = await mount(() => testRequest({ variant: cuda, talker: big }));
    const payload = await (await fetch(`${site.url}/voice/provision/state`)).json() as {
      catalogue: {
        selection: { variantId: string; talkerFile: string };
        models: { role: string; file: string; isDefault: boolean }[];
      };
    };
    assert.equal(payload.catalogue.selection.variantId, 'win-cuda', 'an installed CUDA build is not shown as Vulkan');
    assert.equal(payload.catalogue.selection.talkerFile, big.file);
    assert.equal(payload.catalogue.models.find((entry) => entry.role === 'talker' && entry.isDefault)?.file, big.file,
      'the default flag marks the pair this root holds');
    await site.close();
  });

  it('previews a selection without downloading anything', async () => {
    const site = await mount();
    state.requested.length = 0;
    const response = await fetch(`${site.url}/voice/provision/preview`, {
      method: 'POST', body: JSON.stringify({ variantId: 'win-vulkan' }),
    });
    const body = await response.json() as { view: { variantId: string; steps: { id: string; status: string }[] } };
    assert.equal(response.status, 200);
    assert.equal(body.view.variantId, 'win-vulkan', 'the rows describe the build on screen, not the last one read');
    assert.equal(state.requested.length, 0, 'a preview is a stat walk, not a fetch');
    await site.close();
  });

  it('leaves an engine the config already names out of the plan', async () => {
    const site = await mount(() => testRequest({ engineFromConfig: true }));
    // `/preview` rather than `/state`: the state route kicks off the re-read and
    // answers from the previous snapshot, so only the preview waits for the walk.
    const { view } = await (await fetch(`${site.url}/voice/provision/preview`, {
      method: 'POST', body: JSON.stringify({}),
    })).json() as { view: { steps: { id: string; status: string }[]; remainingBytes: number } };
    assert.equal(view.steps.find((step) => step.id === 'engine')?.status, 'ready',
      'the row stays visible, but it is not work to pay for');
    assert.equal(view.remainingBytes, (BODIES[talker.file] ?? Buffer.alloc(0)).length + (BODIES[codec.file] ?? Buffer.alloc(0)).length,
      'only the two models are counted');
    await site.close();
  });

  it('refuses a selection the manifest does not know, and starts nothing', async () => {
    const site = await mount();
    state.requested.length = 0;
    const response = await fetch(`${site.url}/voice/provision/prepare`, {
      method: 'POST',
      body: JSON.stringify({ variantId: 'win-nvidia-turbo' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(state.requested, []);
    await site.close();
  });

  it('refuses a talker the manifest does not carry', async () => {
    const site = await mount();
    state.requested.length = 0;
    const response = await fetch(`${site.url}/voice/provision/prepare`, {
      method: 'POST',
      body: JSON.stringify({ talkerFile: 'my-own-model.gguf' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(state.requested, [], 'an unknown talker must not be fetched from anywhere');
    await site.close();
  });

  it('lets a client name a build but never define where its bytes come from', async () => {
    const site = await mount();
    state.requested.length = 0;
    const response = await fetch(`${site.url}/voice/provision/prepare`, {
      method: 'POST',
      body: JSON.stringify({
        variantId: 'win-cpu',
        url: 'http://evil.example/payload.zip',
        bytes: 1,
        sha256: 'a'.repeat(64),
      }),
    });
    assert.equal(response.status, 202);
    const view = await waitForReady(site.runner);
    assert.equal(view.phase, 'ready', JSON.stringify(view.steps, null, 1));
    assert.equal(state.requested.some((url) => url.includes('evil.example')), false, 'a wire-supplied URL must never be fetched');
    assert.equal(state.requested.every((url) => url.includes('github.com/CrispStrobe') || url.includes('huggingface.co/cstr')), true);
    const engine = view.steps.find((step) => step.id === 'engine');
    assert.equal(engine?.totalBytes, BODIES[variant.file]?.length, 'the size comes from the request builder, not the client');
    assert.equal(engine?.status, 'ready');
    await site.close();
  });

  it('adopts only a file already sitting in the plugin’s own drop directory', async () => {
    const site = await mount();
    const missing = await fetch(`${site.url}/voice/provision/adopt`, { method: 'POST', body: JSON.stringify({ role: 'codec' }) });
    assert.equal(missing.status, 409);
    assert.match((await missing.json() as { message: string }).message, /downloads/);

    // A path from the wire is not accepted at all: the field is ignored and the
    // name is resolved inside the root, so no page can name a file to move.
    const elsewhere = join(site.layout.root, '..', 'somewhere-else.gguf');
    await writeFile(elsewhere, 'not for us');
    const bypass = await fetch(`${site.url}/voice/provision/adopt`, {
      method: 'POST',
      body: JSON.stringify({ role: 'codec', path: elsewhere }),
    });
    assert.equal(bypass.status, 409, 'an out-of-root path must not be adopted');

    await mkdir(site.layout.downloadDir(), { recursive: true });
    const dropped = join(site.layout.downloadDir(), codec.file);
    await writeFile(dropped, BODIES[codec.file] ?? Buffer.alloc(0));
    const adopted = await fetch(`${site.url}/voice/provision/adopt`, { method: 'POST', body: JSON.stringify({ role: 'codec' }) });
    assert.equal(adopted.status, 200, JSON.stringify(await adopted.json()));
    assert.equal((await stat(site.layout.modelPath(codec))).size, BODIES[codec.file]?.length);
    await rm(elsewhere, { force: true });
    await site.close();
  });

  it('answers a wrong method with 405 and an unknown suffix with 404', async () => {
    const site = await mount();
    assert.equal((await fetch(`${site.url}/voice/provision/prepare`)).status, 405);
    assert.equal((await fetch(`${site.url}/voice/provision/state`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${site.url}/voice/provision/nope`)).status, 404);
    assert.equal((await fetch(`${site.url}/voice/provision/../etc/passwd`)).status, 404);
    await site.close();
  });

  it('streams the view over SSE so the card can follow a run', async () => {
    const site = await mount();
    const controller = new AbortController();
    const stream = await fetch(`${site.url}/voice/provision/events`, { signal: controller.signal });
    assert.equal(stream.headers.get('content-type')?.includes('text/event-stream'), true);
    const reader = stream.body?.getReader();
    assert.ok(reader !== undefined);
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value ?? new Uint8Array());
    assert.match(text, /^data: \{.*"phase"/, 'the first frame is the current view');
    JSON.parse(text.slice('data: '.length).trim());
    controller.abort();
    await site.close();
  });
});

describe('a run in flight', () => {
  it('answers /state with the live view rather than re-planning over it', async () => {
    const site = await mount();
    const live = {
      phase: 'preparing', variantId: 'win-cpu', steps: [],
      remainingBytes: 123, receivedBytes: 456, updatedAt: 1, summary: '已收到 456 B，剩 123 B',
    };
    let inspected = 0;
    // Busy by construction: racing a real download to catch it mid-flight is not
    // a test. `inspect` is the call under watch — it rebuilds the whole view from
    // the plan, so answering a card refresh with it reset the bar to zero and
    // renamed the run `unprepared` while bytes were still arriving.
    const busy = {
      busy: true,
      inspect: async () => {
        inspected += 1;
        return live;
      },
      snapshot: () => live,
    } as unknown as ProvisionRunner;
    const server = createServer((req, res) => {
      void serveProvisionRoute(busy, site.layout, () => testRequest(), () => CUDA, () => false, req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const state = await (await fetch(`${url}/voice/provision/state`)).json() as {
      view: { phase: string; receivedBytes: number };
    };
    assert.equal(inspected, 0, 'a live run owns the view; /state may not rebuild it');
    assert.equal(state.view.phase, 'preparing');
    assert.equal(state.view.receivedBytes, 456, 'the progress someone is watching has to survive the refresh');
    // `/preview` had this rule from the start; the two endpoints must not disagree.
    const preview = await (await fetch(`${url}/voice/provision/preview`, { method: 'POST', body: '{}' })).json() as {
      view: { phase: string };
    };
    assert.equal(preview.view.phase, 'preparing');
    assert.equal(inspected, 0);
    server.closeAllConnections();
    server.close();
    await site.close();
  });
});

describe('the write gate on the provision prefix', () => {
  const denied: ReadonlyArray<Record<string, string>> = [
    { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'http://evil.example' },
  ];

  it('refuses a cleanup that arrived from another site, and deletes nothing', async () => {
    for (const headers of denied) {
      const site = await mount();
      await seed(site.layout);
      const response = await fetch(`${site.url}/voice/provision/cleanup`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ groups: ['engine', 'models', 'cache'], confirm: true }),
      });
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.match((await response.json() as { message: string }).message, /已拒绝/);
      assert.equal((await stat(join(site.layout.modelsDir, 'talker.gguf'))).size, 4096,
        'the second confirm button is not a defence against a page that already knows the shape');
      await site.close();
    }
  });

  it('refuses to start a 1.9 GB download on somebody else’s behalf', async () => {
    const site = await mount();
    const response = await fetch(`${site.url}/voice/provision/prepare`, {
      method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(site.runner.busy, false, 'no run was started');
    await site.close();
  });

  it('still serves the page it was loaded from', async () => {
    const site = await mount();
    await seed(site.layout);
    const origin = new URL(site.url).origin;
    const response = await fetch(`${site.url}/voice/provision/cleanup`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', origin },
      body: JSON.stringify({ groups: ['models'], confirm: true }),
    });
    assert.equal(response.status, 200, 'the card must not be locked out of the endpoint it exists for');
    await assert.rejects(stat(join(site.layout.modelsDir, 'talker.gguf')));
    await site.close();
  });
});

describe('cleanup routes', () => {
  it('reports what the root holds', async () => {
    const site = await mount();
    await seed(site.layout);
    const usage = await (await fetch(`${site.url}/voice/provision/disk`)).json() as {
      root: string; totalBytes: number; busy: boolean; groups: { id: string; bytes: number; present: boolean }[];
    };
    assert.equal(usage.root, site.layout.root);
    assert.equal(usage.busy, false);
    assert.deepEqual(usage.groups.map((group) => group.id), ['engine', 'models', 'cache']);
    assert.equal(usage.groups.find((group) => group.id === 'models')?.bytes, 4096);
    assert.equal(usage.groups.find((group) => group.id === 'cache')?.present, false);
    assert.ok(usage.totalBytes >= 6144);
    await site.close();
  });

  it('refuses to delete on the first ask, and answers with what it would cost', async () => {
    const site = await mount();
    await seed(site.layout);
    const response = await fetch(`${site.url}/voice/provision/cleanup`, {
      method: 'POST', body: JSON.stringify({ groups: ['models'] }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { ok: boolean; needConfirm?: boolean; usage?: { totalBytes: number } };
    assert.equal(body.ok, false);
    assert.equal(body.needConfirm, true, 'the card needs the "this is what you will lose" reply');
    assert.equal((await stat(join(site.layout.modelsDir, 'talker.gguf'))).size, 4096,
      'a request that did not confirm must not have deleted anything');
    await site.close();
  });

  it('deletes only the groups a confirmed request names', async () => {
    const site = await mount();
    await seed(site.layout);
    const response = await fetch(`${site.url}/voice/provision/cleanup`, {
      method: 'POST', body: JSON.stringify({ groups: ['models'], confirm: true }),
    });
    const body = await response.json() as { ok: boolean; freedBytes: number; forgetRecord: boolean; message: string };
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.freedBytes, 4096);
    assert.equal(body.forgetRecord, false);
    await assert.rejects(stat(join(site.layout.modelsDir, 'talker.gguf')));
    // The engine the user did not name is still there, which is the whole point of
    // groups rather than one destructive button.
    assert.equal((await stat(join(site.layout.engineRootDir(), 'crispasr.exe'))).size, 2048);
    await site.close();
  });

  it('accepts only the ids the server knows, and says no to the rest', async () => {
    const site = await mount();
    await seed(site.layout);
    const bogus = await fetch(`${site.url}/voice/provision/cleanup`, {
      method: 'POST', body: JSON.stringify({ groups: ['../models', 'engine-root'], confirm: true }),
    });
    assert.equal(bogus.status, 400, 'nothing recognised is nothing deleted');
    assert.equal((await stat(join(site.layout.modelsDir, 'talker.gguf'))).size, 4096);
    assert.equal((await fetch(`${site.url}/voice/provision/disk`, { method: 'POST' })).status, 405);
    await site.close();
  });

  it('answers an unconfirmed cleanup with the usage report, not with deletion', async () => {
    const site = await mount();
    await seed(site.layout);
    // A string is not the boolean a person clicked, and this is the request that
    // deletes 1.2 GB.
    const sloppy = await fetch(`${site.url}/voice/provision/cleanup`, {
      method: 'POST', body: JSON.stringify({ groups: ['models'], confirm: 'yes' }),
    });
    assert.equal(sloppy.status, 400);
    assert.equal((await stat(join(site.layout.modelsDir, 'talker.gguf'))).size, 4096);
    await site.close();
  });

  it('refuses to clean while a run holds the root', async () => {
    const site = await mount();
    await seed(site.layout);
    // A runner that is busy and nothing else: waiting for a real download to be
    // mid-flight at exactly the right moment is not a test, it is a race.
    const busy = { busy: true, inspect: async () => undefined, snapshot: () => ({}) } as unknown as ProvisionRunner;
    const server = createServer((req, res) => {
      void serveProvisionRoute(busy, site.layout, () => testRequest(), () => CUDA, () => false, req, res);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/voice/provision/cleanup`, {
      method: 'POST', body: JSON.stringify({ groups: ['models'], confirm: true }),
    });
    assert.equal(response.status, 409, 'deleting over a half-written .part corrupts the resume');
    assert.match((await response.json() as { message: string }).message, /先取消/);
    assert.equal((await stat(join(site.layout.modelsDir, 'talker.gguf'))).size, 4096);
    server.closeAllConnections();
    server.close();
    await site.close();
  });
});

/** Poll the runner until its run settles, the way the card would over SSE. */
async function waitForReady(runner: ProvisionRunner, timeoutMs = 4000): Promise<ReturnType<ProvisionRunner['snapshot']>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = runner.snapshot();
    if (view.phase !== 'preparing' && view.phase !== 'unknown') return view;
    if (Date.now() > deadline) return view;
    await new Promise((done) => setTimeout(done, 10));
  }
}
