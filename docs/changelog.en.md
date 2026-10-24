# Release notes

> Moved out of the [README](../README.en.md). The front page keeps one line about the current
> release; the ledgers live here, newest first. Every version also has a
> [GitHub Release](https://github.com/PandaPolo/dsh-voice-call/releases) page.
>
> 中文版：[changelog.md](changelog.md)

## What changed in 0.3.13 — the baseline follows 0.2.1-rc.3, the consumer simulation is runnable again, and the host turned out to have changed how plugin bundles are fetched

**Nothing in this release is a code change**: the shipped `lib/index.js` (19781 bytes) and `lib/client.js` (70144 bytes) are **byte-identical** to the ones 0.3.12 published. What moved is the declared baseline, the devDependencies, the strength of one test, and the facts in the docs that got re-measured.

This time the desktop app and npm moved **together**: `dsh/desktop-runtime.json → release.version` inside the asar is **0.2.1-rc.3** (npm's `next` agrees, `latest` is still 0.2.1-rc.2; rc.3 was published 2026-10-23T07:54Z). The standing rule applies — **the desktop build decides**.

| Item | Change |
|---|---|
| devDependencies / CI | All 22 `@deepseek-ai/dsh-*` pins raised 0.2.1-rc.2 → **0.2.1-rc.3**. cordis stays `~4.0.5` and schemastery stays `^3.18.4` — neither moved in the rc.3 train (the app still ships cordis 4.0.5 / schemastery 3.18.5 / cosmokit 1.8.6). 71 `minimumReleaseAgeExclude` rows in `pnpm-workspace.yaml` each gained `\|\| 0.2.1-rc.3`; the threshold itself was untouched |
| peerDependencies | **Still not one character**: the host's own `includePrerelease` `satisfies()` says `^0.1.7-rc.2 \|\| ^0.2.0-rc.1` already covers 0.2.1-rc.3 (and 0.2.2, while refusing 0.3.0-rc.1). The `schemastery` floor stays at 3.18.4 because that is the copy that genuinely exists in the desktop profile |
| The gate did not move this time | `@deepseek-ai/dsh-app-boot/lib/index.js` — the file holding `evaluatePluginCompatibility` — is **byte-identical** between the rc.2 and rc.3 desktop asars (203572 bytes). The `requirements` field name and the "`engines.dsh` decides alone" rule carried over unchanged, so nothing had to be migrated |
| Claimed baselines | `SUPPORTED` = 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-rc.2 / **0.2.1-rc.3**, each run through its own dependency tree: the rc.3 install, and a 0.1.7-rc.2 install (again with only `dsh-app-boot` raised, since the load decision was born in 0.2.0-rc.1) |
| Tests | **302, none added** — what changed is how hard the `engines.dsh` guard bites. It used to prove only that a manifest with `engines.dsh` is judged on that range alone; it now also proves that `engines.dsh` **silences** a peer: freeze `@deepseek-ai/dsh-tools` back at `^0.1.7-rc.2` and the host refuses the manifest on that peer, while the very same manifest plus an `engines.dsh` is waved through. That negative control is the argument for not declaring one |
| Source | Not one line. Three `tsc` passes clean on both trees; `pnpm build` clean |

**What rc.2 → rc.3 actually changed** (per-package diff over the 21 packages npm publishes that we touch): one real code change, and it is entirely on the **client** side of `@deepseek-ai/dsh-client-ui-conversation` — `lib/client.js` rebuilt, 8 `.d.ts` files edited, one new `view-pins.d.ts` — and every delta is an **added export** (`ConversationViewActionEntry`, `ConversationViewActionsOwnerProps`), nothing removed. `@deepseek-ai/dsh-api-session-controller` moved a single `.d.ts`. The other 19 packages did not even change their file list. None of the three symbols we import (`ConversationLocation`, `ConversationNodeContext`, `ConversationNodeDefinition`) sits in that delta, and the three `tsc` passes went through on rc.3 untouched — so this release is not a migration, it is the confirmation that there was nothing to migrate.

**The per-file hash comparison was run again** (the app's index is 17141 `path → sha256` entries now, 120 fewer than last version), against a plain `npm install @deepseek-ai/dsh@0.2.1-rc.3`:

- Across the 24 packages we declare, **292 files are byte-identical**; server-side JS is still exactly the same on both sides.
- Of the 355 npm files the desktop build strips, 349 are `.d.ts` and 4 are docs. Only 2 are runtime files — and both belong to `@deepseek-ai/dsh-client-ui-slots`, **a package the desktop runtime does not carry at all** (it did not carry it in rc.2 either). It is a devDependency, not a peer, and `src/` never imports it, so the host cannot skip us over it; it does say something worth keeping in mind: a devDependency can be a package the host never ships, so never treat that list as a runtime need.
- 6 content differences: 4 rewritten `package.json` files (`scripts` removed) plus the rebuilt `lib/client.js` of `dsh-client-ui-chat` and `dsh-client-ui-conversation` (159 and 54 bytes apart). Still unreachable for us, for the same reason as last release — our client uses relative URLs and its own class names, and the inject target `dsh-client-ui-settings` ships a byte-identical `client.js`.
- **The fourth difference kind from 0.3.12 is gone**: that build carried an extra `lib/types/invariant.js` in several packages; rc.3's packing stopped shipping it, so the two distributions agree on that point now.
- 9 files exist only on desktop: `dsh-host-webserver` embeds a whole `node_modules/negotiator/`, which npm resolves by hoisting instead.
- **The desktop profile's two-schemastery condition still holds**: its tree resolves `schemastery@3.18.4` + `cosmokit@1.8.5` while the host runs the asar's 3.18.5 / 1.8.6. So the `^3.18.4` peer floor still must not be raised.
- All 20 declared peers exist among the app's 305 shared packages and every range admits the version it finds there (checked one by one with `satisfies()`).

**The consumer simulation is back in full, and goes deeper than last release.** This machine still has no global CLI, but the harness home moves entirely with `$DSH_HOME`, so a real round was completed: `npm i @deepseek-ai/dsh@0.2.1-rc.3` → `dsh plugin --profile web add <tarball>` → boot. In order:

- **No** `skipping profile bundle "dsh-voice-call"` line — rc.3's gate let us in.
- `--dump-config` shows our entry carrying `callMode: card`, `durableEvents: false`, `audioDir: ~/.dsh/voice`, so the bundle's patch layer really does outrank `.default()`.
- Read endpoints all 200: `/voice/call/state` answered `{"calls":[],"appearance":{…,"tone":"classic"}}` and `/voice/provision/state` answered `phase: unprepared` / `variantId: win-cpu` — values from that scratch profile, nothing written into `~/.dsh`; `GET /` on the same port stayed 401; the headless profile stopped at `MISSING_CREDENTIAL`.
- **A new fact worth its own bullet**: on rc.3 the host fetches a plugin bundle **only with `&rev=`**. The boot manifest advertises `plugins/??dsh-voice-call/client.js&rev=ece8910da42d`; fetching exactly that returns **200, 70215 bytes, `text/javascript`**, with our class names and all `/voice/*` paths inside. Fetching `plugins/??dsh-voice-call/client.js` without the rev returns **404**. The reason is `@deepseek-ai/dsh-client-modules`' `bundleResource()`: it looks up `pathname + search` in a pre-built table. Our manifest never hardcodes that URL — the host composes it — so the plugin is unaffected, but the line "one GET and it is 200" in our docs is no longer true and has been corrected.
- The app also rearranged its runtime directory: node is now `resources/runtime/bin/node`, pnpm is `resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`, and a new `runtime.json` next to them declares `desktopVersion: 0.2.1-rc.3` plus its own Python toolchain. `versions.json` claims pnpm 11.28.5 while running that `pnpm.mjs --version` prints 11.23.0 — recorded as observed, not resolved.

**Still untested this round**: the desktop app was not running (no `DeepSeek Harness.exe` in the process list), so there is no rc.3 desktop live probe. The four things that only count when a human sees them — the settings card rendering inside Electron, the ringtone actually sounding, an accepted call playing the whole sentence, the provisioning bar streaming — still need one click each. After updating, reload the plugin or restart the app; nothing hot-reloads.

**Anyone already installed**: 0.3.12 already loads on 0.2.1-rc.3, because no peer range changed. Updating now hands you the same bytes as 0.3.12 — this is a pure baseline-declaration release.

## What changed in 0.3.12 — the baseline follows 0.2.1-rc.2, and the desktop copy was hash-compared with the npm one

**The question this release answers is not "does our code run on the new version" but "is the desktop app's 0.2.1-rc.2 the same thing as npm's".** The app is ahead of npm again: its `release.version` is **0.2.1-rc.2** while npm's `latest` is still 0.2.0-rc.2 (`next` points at 0.2.1-rc.2). Most people install plugins through the app, so this release follows the rule that came out of that: **the desktop build decides**.

| Item | Change |
|---|---|
| devDependencies / CI | Pinned to 0.2.1-rc.2 (cordis `~4.0.5`, schemastery resolving to 3.18.5, `dsh-app-boot` 0.2.1-rc.2). The `minimumReleaseAgeExclude` list in `pnpm-workspace.yaml` was regenerated by the install — every `@deepseek-ai/*` entry gains `\|\| 0.2.1-rc.2`. That is this repository's standing baseline-move chore; the threshold itself was not touched |
| peerDependencies | **Unchanged**: `^0.1.7-rc.2 \|\| ^0.2.0-rc.1` already admitted 0.2.1-rc.2. `@deepseek-ai/schemastery` stays at `^3.18.4`, because 3.18.4 is the copy that genuinely exists in the desktop profile — raising the floor would write the code we actually run out of our own declaration |
| The gate itself changed shape | In `evaluatePluginCompatibility` the report field `peers` is now `requirements` (the test followed). Bigger: a manifest carrying its own `engines.dsh` is judged on **that range alone**, `peerDependencies` not consulted at all. We deliberately do not write one — with all 20 peers in force, "every harness package the code touches is declared" stays a real guard. Both paths, with and without `engines.dsh`, are pinned by cases now |
| Claimed baselines | `SUPPORTED` = 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-rc.2, each run through its own dependency tree: the 0.2.1-rc.2 install, and a 0.1.7-rc.2 install (where only `dsh-app-boot` is raised, since the load decision was born in 0.2.0-rc.1) |
| Source | Not one line. Three `tsc` passes clean; the client bundle is still 70144 bytes |
| Tests | 301 → **302** (the new `engines.dsh` case, positive and negative in one). The three-platform CI ran for real (run 39024760650, all green): 302 on Linux, 302 on Windows, 304 on macOS — the two extra are still the integration cases that only run where `say` exists. Both local dependency trees were run through the suite as well, 302 each |

**How the comparison was done**: the app carries its own answer key — `dsh/desktop-runtime.json` holds 17261 `path → sha256` entries. One file was pulled out of the asar and re-hashed to prove the index is honest (`dsh-app-boot/lib/index.js`, 203572 bytes, exact match), then it was used against a plain `npm install @deepseek-ai/dsh@0.2.1-rc.2`:

- The 18 `@deepseek-ai/dsh-*` packages `src/` imports, plus cordis / schemastery / cosmokit: **server-side JS is byte-identical**. "One version number means one codebase across both distributions" is now a measured statement rather than an assumption.
- Four kinds of difference, none behavioural: ① `scripts` stripped from `package.json`; ② every `.d.ts`/`.d.ts.map` stripped (so the app's tree cannot be compiled against — this repository has always built from npm, nothing changes); ③ a few packages ship an extra `lib/types/invariant.js` that **nothing in the runtime imports** and that has no `exports` subpath, so it cannot even be reached; ④ `dsh-client-ui-chat` and `dsh-client-ui-conversation` ship a **rebuild** of `lib/client.js` — different CSS-module name salts, build comments reading `D:\develop\dsh-harness-windows-x64` where npm's copy says `/home/runner/work/deepseek-harness/…`.
- ④ cannot reach us: our client uses relative URLs and its own class names (`dsh-voice-call-overlay`), never the host's module names, and the inject target `dsh-client-ui-settings` has a byte-identical `client.js` on both sides.
- **The desktop-only finding**: the `desktop` profile is initialised by the app (`nodeLinker: hoisted` + `autoInstallPeers: false` are its own hard-coded template, bundles from the `web` template), and its tree holds just `@deepseek-ai/schemastery@3.18.4` and `cosmokit@1.8.5` besides the plugins — pnpm injects our plugin (and three others) onto **those**, while the host runs the asar's 3.18.5 / 1.8.6. **Two schemastery instances in one process.** The plugin is unaffected, because the schemas we hand to the host travel as plain objects, never through `instanceof`.
- That profile's `minimumReleaseAgeExclude` list is maintained by `dshmarket`, not by the harness. Observed once already: a version published inside pnpm's release-age window refuses to install (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`) and the profile keeps the older one. The threshold is not in that profile file, and no write point turned up in `app.asar` or in either pnpm build — recorded as open. Practical consequence: **"publish, then have the user install immediately" does not hold on desktop.**
- **Measured this round** (2026-10-17, with the desktop app running): on the host port `127.0.0.1:62998` all three read endpoints answered 200 — `/voice/call/state`, `/voice/provision/state`, `/voice/provision/disk` — with values from the `desktop` profile (`tone: marimba`, `phase: ready`, `variantId: win-vulkan`, engine v0.8.36); `GET /` on the same port is still 401. That was the 0.2.1-rc.2 runtime with `dsh-voice-call@0.3.11` installed.

**Unlike 0.3.7 / 0.3.8 / 0.3.10 / 0.3.11 there was no bug to fix here.** Every seam is where it was (`webServer.register` still hands back a disposer, both gate paths are now watched). What this release closes is a gap in knowledge: we used to know *which version number* the desktop app carries, and now we know where its bytes differ from npm's, and whether any of those differences can touch us.

**Already installed?** Nothing to do: no source change, no config change. The four things that still need a real click on desktop — the settings card rendering, the ringtone sounding, an accepted call playing the whole sentence, the provisioning bar streaming — are unchanged from the last release.



## What changed in 0.3.11 — the card still rings after a reload

**Three routes outlived the plugin instance that owned them.** In 0.3.10 the routes were registered by **calling the installers directly** from inside the `ctx.inject(['webServer'], …)` callback: `mountRoute()` kept the return value for `/voice/audio` alone, and the disposers handed back by `installCallCardRoutes` and `installProvisionRoutes` were dropped on the spot. The host webserver keys handlers by path, and that disposer is **the only way back out** — it is bound to no fiber, so the host will not hold it for you.

So the moment the plugin reloads (the plugins page toggle, a market toggle, `patchReload: live` — which is what this machine runs), the old handlers stay in the table while the new instance's mount dies on its first statement with `webserver: duplicate prefix route "/voice/audio"`. The throw lands mid-callback: the two installers after it never run, and the table is still answering from the **old instance's `CallBoard`**.

That matters more than the error line: `/voice/call/events` is answered by a board nobody rings any more, so the new `CallCardRingChannel` never sees a subscriber and degrades to the `ask` prompt by design. What a user sees is "the card stopped working", with one duplicate line in the log — **a silent downgrade, not a crash**.

| Item | Change |
|---|---|
| Fix | New `src/web-mount.ts`: `mountWebRoutes(ctx, mounts)` wraps each installer in `ctx.effect(() => …, label)`; `src/index.ts` hands the whole mount to the **scoped ctx** of `ctx.inject(['webServer'], (scoped) => …)` |
| Why the scoped ctx | `ctx.inject(deps, cb)` *is* `ctx.plugin({ inject, apply: cb })`: when a dependency changes or the fiber unloads, cordis releases the effects registered on that child fiber first and re-runs the callback when the service is back. On the root ctx the only way out is a hand-held `dispose()` — the exact line 0.3.10 broke |
| While there | All three routes now mount in one place (`src/web-mount.ts`), each labelled (`voice-call: /voice/audio` and friends), and all three roll back together; "did anyone keep that installer's return value?" is no longer a question |
| New `test/web-mount.test.ts` | Seven cases over a **real cordis `Context`** and a fake webserver that mirrors the host (same throw on a path collision, disposer deletes the entry): all three prefixes mount / only two without a configured engine / none at all without a webserver / **the table is empty once the fiber unloads** / a webserver that goes away and comes back re-mounts (the audio prefix attempted exactly twice) / re-activating after a reload of the same fiber no longer collides |
| What it bit on the first run | The last case re-creates the 0.3.10 mount shape verbatim (`let disposeRoute` + `mountRoute()` + the dropped `installCallCardRoutes` return value) and asserts "two routes are still in the table after unload" plus "the second activation must throw `duplicate prefix route "/voice/audio"`" — that negative control is this fix's failure condition |
| Tests | 294 → **301** (seven new). All three `tsc` passes clean, `pnpm build` clean, the client bundle is byte-identical at 70144 (this release touches the host half only). The three-platform CI ran for real: 301 green on Linux and Windows, 303 on macOS — the two extra are still the integration cases that only run where `say` exists. Windows' first attempt went red on one timing case (`test/provision-download.test.ts`, the stalled-body one) and green on the rerun — same run 38685211607, second attempt, all three jobs green |

**Not the same disease as 0.3.7 / 0.3.8 / 0.3.10, but the same root: the host's own entry point was bypassed.** Those three were "one fact written in two places and a test that read one of them"; this one is **the host handing the release back to you and it being dropped**. So the new guard does not compare two constants — it **unloads the plugin on a real cordis** and then looks at the route table. The negative control also proves the guard turns red the day someone strips the `ctx.effect` wrapper again.

**If you already have it installed:** only sessions that reloaded the plugin are affected; an unreloaded 0.3.10 and 0.3.11 behave identically. Reload the plugin after updating (the client half is untouched).

## What changed in 0.3.10 — the first call on a fresh install now rings the card

**This plugin kept the default ring mode in four places, and the one place that actually reaches a user had not moved since the card shipped in v0.2.** `callMode` is written in the `cordis.patch.yml` that ships inside the package, in the `Config` schema's `.default()`, in `resolveConfig`'s `??`, and in the settings card's display `FALLBACK`. In 0.3.9 all four **agreed**: `ask`. So this was never a typo in one file.

What matters is precedence. That `cordis.patch.yml` is the manifest's `dsh.bundle.patch` and it is listed in `files`, so it is **the row that gets written into the profile when the plugin is installed**. While that row carries a value, the schema's `.default()` never applies — which meant "the default is a modal" stayed well hidden behind three consistent-looking places, while **what a new user gets had only ever been decided by the first one**.

The author's own machine could not see it: his profile had long since pinned `callMode: card` by hand, following the README example, and a user row outranks the bundle layer. The first time the plugin went onto someone else's machine — "I talked my brother into installing it" — it surfaced: the first call was a modal, not the card that cost an entire v0.2 to build.

| Item | Change |
|---|---|
| Default ring mode | All four places flipped to `card` together: `cordis.patch.yml`, `Config.default()`, `resolveConfig`, and the settings card `FALLBACK` |
| Why that default is safe | `card` does not mean "refuse if no card is around". `CallCardRingChannel` degrades to the `ask` prompt when no SSE subscriber is connected, so a headless composition still has a path a human can answer — and `test/bundle-config.test.ts` now pins that degradation contract |
| Existing configs | A profile that explicitly says `callMode: ask` is **untouched** — the user's own row always wins. This release changes only what someone who never wrote the field gets |
| New `test/bundle-config.test.ts` | Reads the shipped `cordis.patch.yml` line by line and aligns **every field it pins** with what `resolveConfig` and the schema default to; `audioDir` is compared as "does `~/.dsh/voice` expand to `defaultAudioDir()`"; and it requires that none of those fields quietly disappear (deleting a row turning the guard red is one of its failure conditions) |
| What it bit on the first run | `Config['~standard'].validate({})` returns a cosmokit reference, not a literal, for a `.volatile()` field. Comparing that against the patch would have made the test pass **for the wrong reason**; it now detaches through the repo's own `plainConfig()` first |
| Why no YAML library | On this machine `yaml` exists only as a transitive dependency under `.pnpm/`, not as one this plugin declares. Naming something the host does not guarantee is exactly the rule `src/plain.ts:12-17` sets down for the same reason — so the parse is hand-written and line-based |
| Comment corrections | `src/channels/ring.ts` still opened with "v0.1 ships ONE channel" and listed the call card and `direct` as FUTURE — both shipped well before 0.3.x. It now describes four channels, one chosen by `callMode`, defaulting to the card |
| Tests | 289 → **294** (five guards). All three `tsc` passes (server / client / test) clean, `pnpm build` clean, client bundle 70143 → 70144 bytes. The three-platform CI ran for real: 294 green on Linux and Windows, 296 on macOS — the two extra are the integration cases that only execute where `say` exists (the same pair, as in 0.3.9's 289 / 289 / 291). The front page and the deployment doc state **the count every platform shares**, as this repo always has |

**Same disease as 0.3.7 and 0.3.8.** Three times over, the pattern is "the declaration lives in two places and a test only ever read one": 0.3.7 — the plugin's own config schema had never been put through the host's validation entry point (one `volatile` nested in another deactivated the whole plugin while 270 tests stayed green); 0.3.8 — the compatibility claim had never been put through the host's load predicate (0.2.0-rc.1 skipped the entire bundle with 284 tests green); this time — the default ring mode had never been read against the copy that ships. The fix is the same shape too: not "put the right value in", but "put both sources of truth into one assertion". The three artefacts inside the packed tarball (`cordis.patch.yml`, `lib/index.js`, `lib/client.js`) are now verified field by field as well.

**If you already have it installed, you do not need this release.** `callMode` is a `.volatile()` field: open Plugins → dsh-voice-call → Settings, pick 来电卡片 for 来电方式, and the very next ring uses the card — no plugin reload, no restart. (The README's "nothing hot-reloads here" is about swapping versions, not about this field.)

## What changed in 0.3.9 — baseline 0.2.0-rc.2, and an audit of the desktop app

npm's `latest` and `next` for dsh both point at **0.2.0-rc.2** now, and DeepSeek Harness has shipped a **desktop app** (`@deepseek-ai/dsh-desktop`: Electron 44, its own node 24.18.1 and pnpm 11.7.0). This release does two things: follows the baseline to rc.2, and checks every seam the plugin depends on against the runtime that the desktop app actually installs.

| Area | Change |
|---|---|
| devDependencies / CI | Pinned to 0.2.0-rc.2 (cordis 4.0.4 and schemastery 3.18.4 unchanged) |
| peerDependencies | **Not one character changed**: `^0.1.7-rc.2 \|\| ^0.2.0-rc.1` already admits 0.2.0-rc.2, under the host's `includePrerelease` semantics and under npm/pnpm's default ones. Both are now proven by the third baseline added to `test/harness-compat.test.ts` |
| Claimed baselines | `SUPPORTED` is 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2. The desktop app runs 0.2.0-rc.2 as its bundled runtime, so this list is also what the packaged build judges the manifest against |
| Source | Untouched. The client bundle is byte-identical in size to the previous release (70143) |

**What the desktop audit found** — all of it read out of the `app.asar` and the `desktop-runtime.json` installed on this machine, not inferred:

- The desktop app **shares the same DSH home** (`~/.dsh`) with its own `desktop` profile: its own `cordis.patch.yml`, its own `node_modules`. Plugins install into it from npm exactly as into a CLI profile.
- It ships a per-version runtime inventory: 287 shared packages, and **all 20 peers we declare are in it**, at 0.2.0-rc.2 (cordis 4.0.4, schemastery 3.18.4).
- Its UI runs on a custom scheme, **`dsh-app://app`**. Requests the page makes to `/voice/...` and `/plugins/...` are forwarded by the main process to the local `http://127.0.0.1:<random port>` through `forwardWebRequest`, whose purpose is authentication: it **strips `origin`, `sec-fetch-site`, `host` and `cookie`**, replaces them with the desktop's own host cookie, and 403s anything whose origin is not `dsh-app://app` before it ever reaches the host.
- For our **same-origin write gate** that moves where the defence lives, it does not disable it: on the desktop our routes see neither `Sec-Fetch-Site` nor `Origin`, so they take the "not a browser process" branch and pass. The cross-site wall is the main-process check above, and it is firmer than the browser one (the port is private and cookieed). Documented now, so nobody assumes our gate is the first line there.
- Our own client only ever uses **relative URLs** (`fetch('/voice/…')`, `new EventSource('/voice/call/events')`), so under `dsh-app://app` they resolve into that forwarding path — there is no hardcoded `127.0.0.1` anywhere. The scheme is registered with `stream` and `supportFetchAPI`, and the forwarder states that it preserves streaming and cancellation, so both SSE channels (call events, provisioning progress) are on the supported path.
- Sandbox vocabulary is unchanged: `read-only / workspace-write / danger-full-access`, so the local engine path is unaffected.
- **The real desktop-specific risk is a coupling change**: npm's `latest` and the desktop feed (`download.deepseek.com/dsh-desk/feeds/…`, channel `nightly`) move independently, so the desktop app can carry a runtime newer than npm `latest` — possibly outside anything we have claimed. Then the host silently **skips the plugin**, which looks like "dsh-voice-call has no settings row any more". The answer is not a wider range; it is claiming only what has been run, and re-running on every baseline move.

Verified: three `tsc` passes and 289 tests green on 0.2.0-rc.2; the 0.1.7-rc.2 tree was measured against this same source (at 0.3.8 — the source has not moved since). The desktop half of the acceptance is one click on your machine — see the desktop section of the README.

## What changed in 0.3.8 — dsh 0.2.0-rc.1 stopped warning and started skipping

**The host turned the peer range into a load decision.** 0.2.0-rc.1 ships `evaluatePluginCompatibility` in `@deepseek-ai/dsh-app-boot`: it walks the plugin manifest's `peerDependencies`, looks only at `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*`, and tests the running version against each range with semver (`includePrerelease: true`). One range that does not admit it and the host **does not load the bundle at all** — tools, routes and client nodes all gone, leaving a single startup line:

```
dsh: skipping profile bundle "dsh-voice-call": Error: Plugin dsh-voice-call@0.3.7
is incompatible with dsh 0.2.0-rc.1: peerDependencies {…}. … grant the
exact-version exemption with `dsh plugin allow-version`, then retry …
```

`^0.1.7-rc.2` never meant "anything from 0.1.7 on"; it means exactly `>=0.1.7-rc.2 <0.2.0`. It used to cost a warning, so everyone wrote it loosely. Now it decides whether the plugin exists. `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` are not part of the check — the host only reads the `dsh` series.

**What this release changed — the manifest, not the behaviour:**

| Area | Change |
|---|---|
| peerDependencies | Every `@deepseek-ai/dsh-*` entry is now `^0.1.7-rc.2 \|\| ^0.2.0-rc.1` — both baselines claimed, and 0.3.0 not claimed, because it has not been run against |
| devDependencies / CI | Pinned to 0.2.0-rc.1, with cordis following the host to 4.0.4 |
| Seams that were never declared | `dsh-client-ui-chat`, `dsh-client-ui-conversation`, `dsh-client-ui-settings`, `dsh-api-session-controller` and `dsh-host-webserver` are now peers. `src/` imports all five; a seam the code touches but the manifest omits is invisible to the gate, so the host cannot catch it moving |
| Source | Not one executable line changed (only one comment's version stamp). The three seams the plugin works along are intact on the new tree, down to the line numbers: `tools/execute` at `dsh-tools/lib/index.js:3331`, `user-questions/request` at `dsh-user-questions/lib/index.js:69`, `webServer.register(route): () => void` at `dsh-host-webserver/lib/types/index.d.ts:90`. The client bundle still needs nothing from the host in the browser but `react` |
| Tests | 284 → **289**, all green on 0.2.0-rc.1. The same source was then run twice more, once per dependency tree: three `tsc` passes (server / client / test) and 289 green cases on 0.2.0-rc.1, and the same again on 0.1.7-rc.2 |

**`test/harness-compat.test.ts` invites the host's own predicate into the suite.** It runs the real manifest through `evaluatePluginCompatibility` for every baseline the test file claims, and pins three more things besides: the release `devDependencies` locks must be one of the claimed baselines; every `@deepseek-ai/dsh*` package `src/` imports must be a declared peer; and 0.3.0 — a major nobody has run against — must **fail** the check, because a guard that can never go red is not a guard.

This is the same class of lesson as 0.3.7's: there, no test had ever walked the host's config validation; here, no test had ever walked the host's load decision. The new file paid for itself on its first run — the five undeclared peers above are what it found.

**Already on 0.2.0-rc.1?** Updating to 0.3.8 brings the plugin back. `dsh plugin allow-version` writes a pass for one plugin version on one runtime version, which is a way of running an untested combination on purpose, not a way of making it tested. To see the host's own verdict: the first lines of `dsh --profile web --dump-config` are exactly that.

## 🆕 What changed in 0.3.7

"The agent stopped to ask you something" and "the agent stopped forever" used to look identical: the harness puts **no timeout** on a question (there is not a single timer in `dsh-user-questions`), and an agent parked on one cannot nudge you — its loop is stopped. So if you walked away for five minutes, it waited five minutes.

This release has the plugin watch the clock on its behalf:

| What you would notice | Now |
|---|---|
| A question appears and you walk away | after the patience (5 minutes by default, 1/5/10/30 selectable) a call card appears: "有 2 个关于「部署方案」的问题在等你回答，已经等了 5 分钟" |
| You want to hear it | press **接听**: it reads one sentence naming what is waiting, then the card retires |
| You go back and answer in the chat | the card **takes itself down**; nothing to dismiss |
| You press 拒接/稍后再说 on the card | that only silences the card. **It never answers for you** — the question is still there |
| A batch holds two unrelated questions | it reports the count ("有 2 个问题") instead of labelling the batch with the first question's title |
| The card appears with no sound | the card now says why: "浏览器拦住了铃声 —— 点一下这个页面就会响". A browser that refuses autoplay always recovered on the first click; what was missing was being told |

It ships **off**: turn on 「等问题振铃（实验性新功能）」 in the settings card, and pick the patience on the same row.

This release also fences two ways the plugin could take the host down — both surfaced by this experiment. A card's answer is handled inside a web route, so an exception thrown there used to become a process-level uncaught exception and kill `dsh web` (it is now fenced and answers with a reason). And the plugin's own config schema had **no test** that walked the host's validation at all — one `volatile` inside another `volatile` is enough to stop the plugin from activating at all, while 270 tests stayed green. Both classes are now covered by tests.

One more: the settings row 「振铃超时（秒）」 is now 「**铃声持续时间**」. Not a byte of behaviour changed; the old name read as though it governed something else.

---

## 0.3.6 / 0.3.5 — the bill, and three platforms

The previous release put the features in: one-click provisioning, eleven ringtones you can pick, the call card. This release is the bill paid afterwards — I went back through the backend line by line, and what I found was not broken features but **features that did not keep their promises**. Every one of them shipped with a green test suite, which is the actual lesson.

| What you would notice | Before | Now |
|---|---|---|
| Opening the settings card while a download runs | the progress bar is wiped and the card says "not installed" | looking is just looking; the run keeps its progress |
| Retrying an interrupted 1.9 GB download | it re-fetches the whole file (despite the 断点续传 label) | it resumes; segments already paid for are not paid for twice |
| Cancelling a call that is ringing | the card keeps ringing, up to ten minutes | the card comes down with the cancellation |
| Pressing 清理本地文件 | a loosely written `audioDir` could reach a `models/` belonging to something else | roots this plugin did not create are refused, with the reason shown |
| Any web page reaching this local port | one cross-site request could delete your models or answer a call for you | state-changing requests are origin-checked first |
| Deleting an audio file yourself, or holding one open | the whole chat UI could die with it | that one playback fails and everything else carries on |
| Recording from the microphone | the raw capture stayed in the OS temp dir forever | it is deleted afterwards, including when transcription fails |

The parts that were already kind to you stay where they were, unfurled and unhidden: **试听** next to the ringtone dropdown loops the tone you picked *at the volume the card will actually use*; the 运行环境 row takes its defaults from what the directory really holds; cleanup is a visible button that states its weight rather than a checkbox buried in advanced options.

---

**0.3.6** holds the same bar on three platforms: CI now runs Linux, Windows and macOS. It immediately found four problems that only exist on the other systems — the cleanup root check on Linux (it read `TMP/TEMP/TMPDIR` directly, and those are unset on Linux, so `/tmp` was not refused; it now asks `os.tmpdir()`), unpack fixtures whose fake engine binary had no executable bit, two tests written with Windows assumptions, and a macOS integration fake that no longer matched the harness seam it stands in for (the production runner was right all along). All 262 tests are green on all three, and the macOS pair is confirmed to actually run `say` and produce a readable audio file rather than being skipped into greenness.
