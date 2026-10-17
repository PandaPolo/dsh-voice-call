/**
 * The plugin's declared harness compatibility, checked by the host's own gate.
 *
 * dsh 0.2.0-rc.1 turned peer dependencies into a loader decision.
 * `evaluatePluginCompatibility` (in `@deepseek-ai/dsh-app-boot`) walks
 * `peerDependencies`, and if any `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
 * range does not admit the running version, the bundle is **skipped** — not
 * warned about, not degraded. That is what happened when the baseline moved:
 * 0.3.7 declared `"@deepseek-ai/dsh-tools": "^0.1.7-rc.2"`, and a 0.2.0-rc.1
 * profile printed
 *
 *   dsh: skipping profile bundle "dsh-voice-call": Error: Plugin
 *   dsh-voice-call@0.3.7 is incompatible with dsh 0.2.0-rc.1: peerDependencies
 *   {…} … grant the exact-version exemption with `dsh plugin allow-version`
 *
 * and the plugin was simply not there — every one of its tools, routes and
 * client nodes gone, while all 284 tests stayed green. No test had ever read
 * the manifest against the gate, so nothing knew that "compatible with
 * 0.1.7-rc.2" had been written into the package as "refused by 0.2.0-rc.1".
 *
 * So this file runs the real predicate over the real manifest for every
 * baseline the README claims, and proves the predicate actually bites.
 *
 * Two things moved under it in 0.2.1-rc.2, which is why this file reads the
 * result structure rather than a logged string: the report field is
 * `requirements` (it was `peers`), and an own `engines.dsh` now takes over the
 * whole decision — peers are then ignored. The last case here pins both.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot';

/**
 * Harness releases this plugin claims to run on. Add a line here when claiming
 * one. `0.2.1-rc.2` is what the desktop app (`@deepseek-ai/dsh-desktop`) ships as
 * its bundled runtime today, and npm's `next` tag points at the same version
 * while `latest` is still 0.2.0-rc.2 — so this list is checked by both
 * distributions, and the desktop one is the one that moves first.
 */
const SUPPORTED = ['0.1.7-rc.2', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-rc.2'];

type Manifest = {
  name: string;
  version: string;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines?: Record<string, string>;
  dsh?: { client?: { inject?: string[] } };
};

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as Manifest;

/** The peers the gate looks at: `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`. */
const gated = (deps: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(deps).filter(
      ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
    ),
  );

/** Unsatified peers for a running version, in the host's own words (`undefined` = loads). */
const refused = (source: Manifest, runtimeVersion: string) =>
  evaluatePluginCompatibility(
    { ...source, peerDependencies: { ...source.peerDependencies } },
    {},
    runtimeVersion,
  );

/** Every `@deepseek-ai/dsh*` package name that appears in a source import. */
function usedBySource(): string[] {
  const found = new Set<string>();
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(/['"](@deepseek-ai\/dsh[a-z0-9-]*(?:\/[^'"]*)?)['"]/g)) {
        // The specifier may carry a subpath (`dsh-client-ui-chat/client`); the
        // package name is what the gate looks at.
        found.add(`@deepseek-ai/${(match[1] ?? '').slice('@deepseek-ai/'.length).split('/')[0] ?? ''}`);
      }
    }
  };
  walk(new URL('../src/', import.meta.url));
  return [...found].filter((name) => name.length > '@deepseek-ai/'.length).sort();
}

describe('harness compatibility declaration', () => {
  it('loads on every baseline we claim to support', () => {
    for (const runtimeVersion of SUPPORTED) {
      const issue = refused(manifest, runtimeVersion);
      assert.equal(
        issue === undefined ? '' : JSON.stringify(issue.requirements),
        '',
        `dsh ${runtimeVersion} would skip the bundle`,
      );
    }
  });

  it('the gate really refuses a range that stops at the old baseline', () => {
    // This is 0.3.7 verbatim: one caret, and the new host drops the plugin.
    const single = {
      name: 'dsh-voice-call',
      version: '0.3.7',
      peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.7-rc.2' },
    } as unknown as Manifest;
    const issue = refused(single, '0.2.0-rc.1');
    assert.ok(issue !== undefined, 'a guard that cannot fail is not a guard');
    assert.deepEqual(Object.keys(issue?.requirements ?? {}), ['@deepseek-ai/dsh-tools']);
    assert.equal(issue?.exempted, false);
    // …and the same manifest is fine where it was written to be.
    assert.equal(refused(single, '0.1.7-rc.2'), undefined);
  });

  it('lets the peer list decide, because an own engines.dsh would silence it', () => {
    // dsh 0.2.1-rc.2 added `engines.dsh`: when the manifest carries one, the
    // host checks *only* that range and stops reading `peerDependencies`. That
    // is the weaker guard for us — a peer added later would not have to be
    // widened, so the declaration would stop meaning "every harness package I
    // actually touch". Declaring no `engines.dsh` keeps all 20 peers in force.
    assert.equal(manifest.engines?.dsh, undefined, 'engines.dsh would replace the peer check');
    // And the shape is proven: a manifest that does carry it is judged alone.
    const withEngine = {
      ...manifest,
      engines: { ...manifest.engines, dsh: '^0.2.1-rc.2' },
    };
    assert.equal(refused(withEngine, '0.2.1-rc.2'), undefined);
    assert.deepEqual(Object.keys(refused(withEngine, '0.1.7-rc.2')?.requirements ?? {}), ['engines.dsh']);
  });

  it('keeps every gated devDependency inside the claimed baselines', () => {
    const pins = Object.entries(gated(manifest.devDependencies));
    assert.ok(pins.length > 0, 'the suite is meaningless if nothing is pinned');
    for (const [name, pin] of pins) {
      assert.ok(SUPPORTED.includes(pin), `${name} is pinned to ${pin}, which is not a claimed baseline`);
    }
  });

  it('declares a peer for every harness package the plugin itself uses', () => {
    // A seam the code touches but the manifest does not name is invisible to the
    // gate: the host would happily load the plugin against a release where that
    // package moved, and fail at activation instead of refusing to start.
    const peers = Object.keys(gated(manifest.peerDependencies));
    for (const name of usedBySource()) {
      assert.ok(peers.includes(name), `${name} is imported by src/ but not declared as a peer`);
    }
    for (const name of manifest.dsh?.client?.inject ?? []) {
      assert.ok(peers.includes(name), `${name} is a client inject target but not declared as a peer`);
    }
    assert.ok(usedBySource().length > 8, 'the scan found nothing to check');
  });

  it('does not lean on the next major it has not been run against', () => {
    for (const runtimeVersion of ['0.3.0-rc.1', '0.3.0']) {
      const issue = refused(manifest, runtimeVersion);
      assert.ok(issue !== undefined, `claiming 0.3.0 without testing it is how ${runtimeVersion} breaks silently`);
    }
  });
});
