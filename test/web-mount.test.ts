/**
 * The web prefixes against a real cordis context.
 *
 * `/voice/audio`, `/voice/call` and `/voice/provision` go into the harness
 * webserver's table, which is keyed by `(kind, path)` and throws on a second
 * registration of the same path. `register()` returns the only disposer for a
 * route and ties it to no fiber, so a mount that keeps its routes in the plugin
 * body's own locals is one reload away from colliding with itself — and the
 * reload is not exotic: the plugin page's toggle, a market update and the
 * webserver service coming back all dispose the fiber and run `apply()` again.
 *
 * 0.3.10 shipped that shape. `apply()` registered the three prefixes, parked the
 * audio disposer in a local (`disposeRoute`, released by hand on the way in) and
 * dropped the other two; the next activation threw `duplicate prefix route
 * "/voice/audio"` from the *first* mount, so the routes after it were never
 * installed at all. The visible failure was the call-card overlay polling
 * `/voice/call/state` into a 404 with nothing in the log to explain it.
 *
 * The last case in this file keeps the old shape on purpose. Every assertion
 * above it only means something if the same sequence really does fail when the
 * mount does not own its disposers.
 */
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { CallBoard } from '../src/callcard/board.ts';
import { CALL_ROUTE, installCallCardRoutes, type CallCardAppearance } from '../src/callcard/web.ts';
import { unknownDevice } from '../src/provision/detect.ts';
import { provisionLayout } from '../src/provision/layout.ts';
import type { PrepareRequest, ProvisionRunner } from '../src/provision/state.ts';
import { PROVISION_ROUTE } from '../src/provision/web.ts';
import { AUDIO_ROUTE, installAudioRoute } from '../src/web.ts';
import { mountWebRoutes, type WebMounts } from '../src/web-mount.ts';

/** A webserver stub with the two rules that matter: duplicates throw, the disposer removes. */
function routeTable() {
  const table = new Map<string, { kind: string; path: string; handler: unknown }>();
  return {
    table,
    /** Every path a mount asked for, in order — a re-registration shows up here twice. */
    attempts: [] as string[],
    register(route: { kind: 'prefix' | 'exact'; path: string; handler: unknown }): () => void {
      this.attempts.push(route.path);
      if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      table.set(route.path, route);
      return () => {
        table.delete(route.path);
      };
    },
  };
}

const APPEARANCE: () => CallCardAppearance = () => ({ theme: 'system', palette: 'default', ringtone: false, tone: 'marimba' });

const AUDIO_ROOT = join(tmpdir(), 'dsh-voice-call-web-mount');

/**
 * The mount payload. The provisioning route's dependencies are only ever carried
 * into the handler closure — mounting calls none of them — so a shape stands in
 * for the runner; the layout and the device report are the real ones.
 */
function mounts(provision: boolean): WebMounts {
  return {
    audioRoot: AUDIO_ROOT,
    board: new CallBoard(),
    appearance: APPEARANCE,
    provision: provision ? {
      runner: {} as unknown as ProvisionRunner,
      layout: provisionLayout(AUDIO_ROOT),
      request: () => ({}) as PrepareRequest,
      device: unknownDevice,
      usableFromConfig: () => false,
    } : undefined,
  };
}

/** Let cordis finish reacting to a service change before asserting on it. */
const settle = (): Promise<void> => new Promise((resolve) => {
  setImmediate(resolve);
});

/** Mount the real thing behind a provided webserver, and hand back the fiber. */
function activate(ctx: Context, routes: ReturnType<typeof routeTable>, provision = true) {
  // Providing twice throws, and a reload re-uses the service that is already there.
  if (ctx.get('webServer') === undefined) ctx.provide('webServer', routes);
  return ctx.inject(['webServer'], (scoped) => mountWebRoutes(scoped, mounts(provision)));
}

const sorted = (keys: Iterable<string>): string[] => [...keys].sort();

describe('mounting the web routes', () => {
  it('mounts all three prefixes behind one webserver', async () => {
    const ctx = new Context();
    const routes = routeTable();
    await activate(ctx, routes);
    assert.deepEqual(sorted(routes.table.keys()), sorted([AUDIO_ROUTE, CALL_ROUTE, PROVISION_ROUTE]));
  });

  it('leaves the provisioning prefix off the table when the config names no engine', async () => {
    const ctx = new Context();
    const routes = routeTable();
    await activate(ctx, routes, false);
    assert.deepEqual(sorted(routes.table.keys()), sorted([AUDIO_ROUTE, CALL_ROUTE]));
  });

  it('registers nothing at all when there is no webserver to register on', () => {
    const ctx = new Context();
    const routes = routeTable();
    // No service provided: the installers are the headless path here, and the
    // route table they would have written to is unreachable anyway.
    mountWebRoutes(ctx, mounts(true));
    assert.deepEqual(routes.attempts, []);
  });

  it('takes every route back down when its fiber unloads', async () => {
    const ctx = new Context();
    const routes = routeTable();
    const fiber = await activate(ctx, routes);
    assert.equal(routes.table.size, 3);
    await fiber.dispose();
    assert.deepEqual(sorted(routes.table.keys()), [], 'a disposal that leaves routes behind bricks the next activation');
  });

  it('re-activates after the webserver comes back instead of colliding', async () => {
    const ctx = new Context();
    const routes = routeTable();
    const unprovide = ctx.provide('webServer', routes);
    ctx.inject(['webServer'], (scoped) => mountWebRoutes(scoped, mounts(true)));
    await settle();
    assert.equal(routes.table.size, 3, 'the first activation mounted nothing');
    unprovide();
    await settle();
    assert.deepEqual(sorted(routes.table.keys()), [], 'losing the webserver must release the prefixes');
    ctx.provide('webServer', routes);
    await settle();
    assert.deepEqual(
      sorted(routes.table.keys()), sorted([AUDIO_ROUTE, CALL_ROUTE, PROVISION_ROUTE]),
      're-gaining the webserver must re-register every prefix, not trip on its own leftovers',
    );
    assert.equal(routes.attempts.filter((path) => path === AUDIO_ROUTE).length, 2, 'the audio prefix was attempted exactly twice');
  });

  it('survives a reload of the same plugin fiber', async () => {
    // What the plugin page does: dispose the whole fiber, then activate again.
    // The routes have to be gone by the time the second activation mounts.
    const ctx = new Context();
    const routes = routeTable();
    const first = await activate(ctx, routes);
    await first.dispose();
    const second = await activate(ctx, routes);
    assert.deepEqual(sorted(routes.table.keys()), sorted([AUDIO_ROUTE, CALL_ROUTE, PROVISION_ROUTE]));
    await second.dispose();
  });

  it('would have caught the mount 0.3.10 shipped', async () => {
    // The old shape, verbatim where it matters: register straight onto the
    // plugin body's context, keep the audio disposer in a local, hand the call
    // card's disposer to nobody. Two prefixes are enough — the collision is on
    // the first one, which is what made the throw invisible from the outside.
    const legacy = (ctx: Context): void => {
      let disposeRoute: (() => void) | undefined;
      const mountRoute = (): void => {
        disposeRoute?.();
        disposeRoute = installAudioRoute(ctx, AUDIO_ROOT);
      };
      mountRoute();
      installCallCardRoutes(ctx, new CallBoard(), APPEARANCE);
    };
    const ctx = new Context();
    const routes = routeTable();
    ctx.provide('webServer', routes);
    const first = ctx.inject(['webServer'], legacy);
    await first;
    await first.dispose();
    assert.equal(routes.table.size, 2, 'the old mount left its routes in the table');
    await assert.rejects(
      async () => {
        await ctx.inject(['webServer'], legacy);
      },
      new RegExp('duplicate prefix route "/voice/audio"'),
      'the old shape must fail on the second activation, or these tests prove nothing',
    );
  });
});
