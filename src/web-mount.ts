/**
 * The three web prefixes, mounted as one repeatable step.
 *
 * The harness webserver keys its route table by `(kind, path)` and *throws* on a
 * second registration of the same path ("webserver: duplicate prefix route"),
 * which is the right call for a composition-level contract and the wrong shape for
 * a plugin that can be switched off and on again. The disposer `register()` hands
 * back is the only way to take a route down and nothing ties it to a fiber, so the
 * mount has to supply that tie itself: `ctx.effect` releases every route when the
 * fiber that asked for them unloads, and the next activation — the plugin page, a
 * market toggle, the webserver service itself coming back — starts from an empty
 * table instead of colliding with its own leftovers.
 *
 * 0.3.10 parked only the audio disposer in a local (`disposeRoute`, re-disposed by
 * hand on the way in) and dropped the other two on the floor. That guard covered a
 * re-run *inside one activation*, which is not the reload that happens: the plugin
 * fiber is disposed and `apply()` runs again with fresh locals, so
 * `/voice/audio` was still in the table while the callback mounted it a second
 * time. The throw lands on the first mount, so the routes after it were never
 * installed at all: a reloaded plugin answered `/voice/audio` from the old handler,
 * left the call-card overlay polling a `/voice/call/state` that 404s, and never
 * offered provisioning again.
 *
 * @module dsh-voice-call/web-mount
 */
import type { Context } from '@deepseek-ai/cordis';
import { installAudioRoute } from './web.ts';
import { installCallCardRoutes } from './callcard/web.ts';
import type { CallBoard } from './callcard/board.ts';
import type { CallCardAppearance } from './callcard/web.ts';
import { installProvisionRoutes } from './provision/web.ts';
import type { DeviceReport } from './provision/detect.ts';
import type { ProvisionLayout } from './provision/layout.ts';
import type { PrepareRequest, ProvisionRunner } from './provision/state.ts';

/** The provisioning prefix's dependencies, resolved by the plugin body. */
export interface ProvisionMount {
  readonly runner: ProvisionRunner;
  readonly layout: ProvisionLayout;
  /** The plan the currently connected client is shown. */
  readonly request: () => PrepareRequest;
  readonly device: () => DeviceReport;
  /** Whether the configured engine already speaks, so the download stays off the card. */
  readonly usableFromConfig: () => boolean;
}

/** Everything the web prefixes close over. */
export interface WebMounts {
  readonly audioRoot: string;
  readonly board: CallBoard;
  readonly appearance: () => CallCardAppearance;
  /** Absent when the config names no engine yet — the prefix is then not mounted. */
  readonly provision?: ProvisionMount;
}

/**
 * Mount `/voice/audio`, `/voice/call` and (when configured) `/voice/provision`
 * on `ctx`'s fiber; every route is released when that fiber unloads.
 *
 * Call this from the context of the fiber that owns the routes — the scoped
 * context `ctx.inject(['webServer'], (scoped) => ...)` passes in — because that is
 * the fiber cordis disposes when the service goes away or the plugin is reloaded.
 */
export function mountWebRoutes(ctx: Context, mounts: WebMounts): void {
  ctx.effect(() => installAudioRoute(ctx, mounts.audioRoot), 'voice-call: /voice/audio');
  ctx.effect(
    () => installCallCardRoutes(ctx, mounts.board, mounts.appearance),
    'voice-call: /voice/call',
  );
  const provision = mounts.provision;
  if (provision === undefined) return;
  ctx.effect(
    () => installProvisionRoutes(
      ctx, provision.runner, provision.layout,
      provision.request, provision.device, provision.usableFromConfig,
    ),
    'voice-call: /voice/provision',
  );
}
