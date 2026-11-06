# Shipping dsh-voice-call

The repo lives at `https://github.com/PandaPolo/dsh-voice-call` and the package
is published to npm as `dsh-voice-call` (unscoped). Everything below is
verified locally except the push and the publish themselves.

## 0. Preflight (verified locally)

- `pnpm test` — 302 green on the current baseline: arg-schema units (the exact-one
  `{file|record}` union, `speak`'s optional `voice`/`rate`), backend
  selection with faked probes, the fake text-to-text backend end-to-end
  through both tool pipelines, the `voice-note` renderer (node.data from a
  logged event, transcript-only degradation, replay purity), the call domain
  and call-card board, the durability contract (`durableEvents` stays off),
  the shipped `cordis.patch.yml` against the plugin's own defaults
  (`test/bundle-config.test.ts` — that row outranks `.default()`, so it is what a
  new install really gets),
  the web-route mount lifecycle (`test/web-mount.test.ts` — a route must not outlive
  the fiber that owns it),
  plus the macOS `say` integration suite — which skips where `say` is absent.
- `pnpm typecheck` (host + client + **test** tsconfigs — `test/` was added to the gate
  because a `DeviceReport` used without being imported had been sitting in a route
  suite unnoticed, and nothing in CI reads the types of a test file) and `pnpm build` (host tsc +
  client declarations + the web client bundle) — clean.
- `pnpm pack` — tarball contains `lib/` (host + `client.js` + client d.ts),
  `shims/`, `assets/` (the eleven ringtones the card and the 试听 button read over
  `/voice/call/ringtone`), `cordis.patch.yml`, `README.md`, `README.en.md`, `LICENSE`;
  manifest carries `dsh.bundle.patch` and `dsh.client`.
- **Consumer simulation (host)**: the packed tarball installs into a scratch
  DSH profile (`dsh plugin --profile headless add <tarball>`) and the profile
  boots with zero dsh-voice-call errors (only the expected MISSING_CREDENTIAL
  for the scratch env's absent API key).
- **Consumer simulation (web client)**: with the tarball installed into a
  scratch web profile, the profile boots, `--dump-config` composes
  `dsh-voice-call` with its patch layer visible (`callMode: card`,
  `durableEvents: false`), the read endpoints answer 200, and the client bundle
  is served over the URL the boot manifest advertises — **which since 0.2.1-rc.3
  carries a revision, and still does at 0.2.2-rc.1**: `plugins/??dsh-voice-call/client.js&rev=<hash>` returns
  200 / 70215 bytes of `text/javascript` containing our class names and every
  `/voice/*` path, while the same path **without `&rev=` returns 404**
  (`@deepseek-ai/dsh-client-modules`' `bundleResource()` matches `pathname +
  search` against a pre-built table). Nothing we ship hardcodes that URL — the
  host composes it — so the change is a documentation correction, not a plugin
  fix, but any future probe must read the advertised URL out of `/` rather than
  assuming the old path.
  **Both simulations need a `dsh` CLI.** 0.3.12 could not run them (the global CLI
  had been retired) and settled for a live probe of the running desktop app, which
  proves activation but not the *packed* artefact. Since 0.3.13 they run without
  reinstalling anything globally: `npm i @deepseek-ai/dsh@<baseline>` into a scratch
  directory, then `node node_modules/@deepseek-ai/dsh/lib/bin.js …` with **`DSH_HOME`
  pointed at a scratch home**, so no profile, cache or `cordis.yml` under the user's
  real `~/.dsh` is touched. Verified that way on 2026-10-24 (0.2.1-rc.3) and again on
  2026-11-06 (0.2.2-rc.1 + the packed 0.3.14): no `skipping profile
  bundle` line, `/voice/call/state`, `/voice/provision/state` and `/voice/provision/disk` all
  200, `GET /` 401 without the token, and the advertised bundle URL 200 / 70215 bytes
  (`rev=c8e6687c0aa0` this round) — 404 once the query is stripped.
  Two details worth keeping straight when reading those numbers: an empty scratch home
  reports *defaults*, not the user's state (`tone: classic`, `phase: unprepared`,
  `variantId: win-cpu`), so those values are not a regression signal; and `--dump-config`
  is only accepted without `--no-open` on that command line — passing both prints
  `error: unknown option '--dump-config'` and writes an almost empty file, which is easy
  to misread as the plugin not composing. **The 0.3.14 artefacts are byte-identical to
  0.3.13's** — `lib/index.js` (19781 bytes) and `lib/client.js` (70144 bytes) — even
  though the harness moved real code this round, which is the opposite of 0.3.13's
  "version-string release" situation. **After publishing, re-run the same round against
  the registry copy** (`dsh plugin --profile web add dsh-voice-call@0.3.14`): that is
  the check that what users install is what was tested, rather than only what I built —
  for 0.3.13 it came back 200 / 70215 bytes with rev `684a396a0347`, and for 0.3.14
  with rev `a76377041660`.
- **Desktop profile update (the user's own install)**: the reliable way to move
  `~/.dsh/profiles/desktop` without the GUI is the app's *own* toolchain —
  `resources/runtime/primary-runtime/dependencies/node/bin/node.exe` running
  `…/dependencies/pnpm/bin/pnpm.mjs add dsh-voice-call@<version>` inside the profile
  directory, with `package.json` and `pnpm-lock.yaml` backed up first
  (`.pre-<version>.bak`). Run that way on 2026-11-06 for 0.3.14: node v24.21.0,
  "Lockfile passes supply-chain policies (190 entries)", `Done in 4s using pnpm
  v11.28.5`, and **no `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`** — the profile's
  `minimumReleaseAgeExclude` names `dsh-voice-call` at *package-name* level, so a new
  version of an already-installed plugin is exempt by name. Two notes on what that
  output means: `pnpm.mjs --version` invoked directly prints **11.23.0** when the
  calling shell has a global pnpm on `PATH`, while the same file reports 11.28.5 for
  the install itself (the app's `bin/node` wrapper prepends its own `bin` to `PATH`);
  and `--config.minimum-release-age=0` was not needed, so do not add it reflexively —
  it silences the very check that tells you a *new* package name is being blocked.
- **Dependency pattern**: every `@deepseek-ai/*` package — `schemastery`
  included — is a `peerDependency` (the ecosystem convention; regular deps
  would install duplicate copies into DSH profiles and break tool dispatch),
  mirrored in devDependencies. There is no `dependencies` block at all.
- **Baseline gate**: `test/harness-compat.test.ts` runs the host's own
  `evaluatePluginCompatibility` over the real manifest, for every release named
  in its `SUPPORTED` list. Since dsh 0.2.0-rc.1 that predicate is a load
  decision, not a warning — an unsatisfied `@deepseek-ai/dsh*` peer range makes
  the host skip the entire bundle — so a baseline bump is not done until the
  peer range has been widened in the same commit and `SUPPORTED` lists both the
  old and the new release. Packages `src/` imports must appear there too: a seam
  the code touches but the manifest omits is invisible to the gate. Two things
  moved in 0.2.1-rc.2 and the file tracks them: the report field is
  `requirements` (was `peers`), and an own `engines.dsh` **replaces** the peer
  check rather than adding to it — which is why the manifest deliberately does
  not carry one. 0.2.1-rc.3 did **not** move the predicate: `dsh-app-boot/lib/index.js`
  is byte-identical (203572 bytes) between the rc.2 and rc.3 desktop asars. **0.2.2-rc.1
  grew that file to 225678 bytes without moving the predicate either** — the way to see
  that is to brace-match `evaluatePluginCompatibility`, `unmetRequirements` and
  `satisfies` out of both asars and diff the three snippets (630 / 1033 / 147 bytes,
  identical); reading the whole bundle's diff just shows you locales and relocated
  constants. The
  engines case now also proves the silencing is real: a manifest with one peer
  frozen at `^0.1.7-rc.2` is refused, and the same manifest plus `engines.dsh`
  passes. A bump runs the suite once per dependency tree: new baseline, 0.1.7-rc.2
  with only `dsh-app-boot` raised (the gate itself did not exist before 0.2.0-rc.1),
  and — since the support packages moved this round — a third tree pinning
  schemastery at the version the host runs, because the other two resolve the
  3.18.4 floor. All three green (302) for 0.3.14.
- **Desktop app**: `@deepseek-ai/dsh-desktop` bundles its own dsh runtime, and
  its version moves independently of npm (`nightly` feed on
  `download.deepseek.com`) — as of 0.3.14 the app is on **0.2.2-rc.1**, and npm's
  `latest` *and* `next` point at the same version, so **the desktop build had
  nothing to overtake this round**. That is new: until now the two were always a
  version apart, so do not assume it next time — read both. On a baseline bump, read the installed `app.asar →
  dsh/desktop-runtime.json` (`release.version`, `sharedPackages`) — and, since
  rc.3, `resources/runtime/primary-runtime/runtime.json` (`desktopVersion`) too —
  and check that every declared peer exists there at a version the gate admits.
  Then go one step further, which is cheap because the app publishes its own
  `path → sha256` index (17261 files in rc.2, 17141 in rc.3, **21046** now): re-hash one
  asar file first to trust the index, and compare that index against the published
  tarballs, package by package — plus cordis / schemastery / cosmokit at the versions
  listed in `sharedPackages`, which the harness-version string does not cover. That is how
  0.3.12 established that server-side JS is identical in both distributions, and
  re-running it for 0.3.13 and again for 0.3.14 confirmed the conclusion; the
  desktop-only `lib/types/invariant.js` difference kind went away in rc.3, and
  `@deepseek-ai/dsh-client-ui-slots` — a devDependency — is still not in
  the desktop runtime at all (the only two non-type, non-doc "stripped" files are
  exactly its own). The desktop profile still resolves schemastery /
  cosmokit from its **own** copies (3.18.4 / 1.8.5) while the host now runs the asar's
  3.19.0 / 1.9.0, which is why the `^3.18.4` peer floor must stay — and why the
  suite also runs against 3.19.0.
  Note the app's runtime layout, set in rc.3: node lives at
  `resources/runtime/bin/node` and pnpm at
  `resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`. **0.3.14 settled
  which copy the plugin page installs with, by reading `app.asar`**: `runDesktopCli`
  passes `command: process.execPath` (Electron as node, `ELECTRON_RUN_AS_NODE=1`) with
  `args: [<supportDir>/primary-runtime/dependencies/pnpm/bin/pnpm.mjs]` and prepends
  `<supportDir>/bin` to `PATH`, where `supportDir` is the `runtime` directory next to
  `app.asar`. `~/.dsh/dsh-runtimes/dsh-primary-runtime` is a *different* thing — the
  **office** plugin's materialised payload (`root: join(resolveDshHome(), "dsh-runtimes",
  "dsh-primary-runtime")`, `source:` that same `primary-runtime`), and on this machine it
  is still the October 1 copy (desktopVersion 0.2.0-rc.2, pnpm 11.7.0). `versions.json` claims pnpm
  11.28.5; invoking that `pnpm.mjs --version` from a shell whose PATH holds a
  global pnpm prints 11.23.0 instead — with the PATH scrubbed the same file
  reports 11.28.5, which is exactly what the app's own `PATH` prefixing avoids.
  The full table lives in `docs/deployment.md` / `.en.md` under the desktop section.
- **This machine has no global CLI** (the desktop app took over plugin
  management). Installing into the user's own profile therefore goes through the
  desktop app's plugin page, which runs its bundled pnpm against
  `~/.dsh/profiles/desktop`. A CLI is still available for *verification* without
  touching a global install: `npm i @deepseek-ai/dsh@<version>` into a scratch
  directory and call `node node_modules/@deepseek-ai/dsh/lib/bin.js`, with
  **`DSH_HOME` set to a scratch home** so no real profile, cache or `cordis.yml`
  is written. That is how the 0.3.13 and 0.3.14 consumer simulations ran, and it is the
  cheaper route whenever `dsh … --dump-config` or a live boot is what the check
  needs.

## 1. Push the GitHub repo

The repo already exists and is public; push the branch and open the release
from it.

```sh
git push origin main
```

Repo settings (already applied — re-check after any rename):

- **Topics**: `dsh-plugin` (required by deepseek-harness CONTRIBUTING.md)
  plus `deepseek-harness`, `voice`, `tts`, `text-to-speech`, `call-card`,
  `local-first`, `plugin`.
- **Description**: "Give the agent a voice it owns: the agent decides when to
  speak (offer_call), the human holds the answer key (accept / reject / later).
  Local-first TTS, plain audio files under ~/.dsh/voice/, and a dedicated
  incoming-call card."

## 2. Live DSH verification (follow-ups)

With a real provider configured, in the **desktop app** (there is no global CLI
on this machine any more; the app installs plugins through its own bundled pnpm
into `~/.dsh/profiles/desktop`):

```sh
# desktop app → Plugins page → install dsh-voice-call@<version>, then reload the
# plugin or restart the app — it has no hot reload.
# A local build can be checked by packing (`pnpm pack`) and installing the
# tarball path from the plugin page, the same way a CLI profile would.
```

Then in a session:

- Ask the model to `transcribe` a recorded note (or a fixture file with
  `stt.backend: fake` for a no-mic check) and confirm the transcript arrives
  as a user message and the audio card renders with play/pause.
- Ask the model to `speak` a line and confirm the background job completes,
  the m4a exists under `~/.dsh/voice/`, and the outbound audio card renders.
- `/voice on`, complete a turn, and confirm the reply is narrated;
  `/voice off` stops it.
- With dsh-crosstalk installed, `transcribe({ to: <peer> })` delivers a note
  to another live session.
- **Call card (v0.2)**: ask the model to `offer_call` and confirm the ringing
  card appears bottom-right with caller identity; `接听` synthesizes and plays,
  `拒接` settles without audio, `稍后再说` defers. Ring a second tab and settle
  it in the first — the other tab must dismiss without a retry loop. Let it
  time out and confirm the missed state. In a headless profile the same call
  must fall back to the prompt channel instead of the card.
- **Call leg (v0.2)**: after `接听`, the card must stay on screen as 通话中
  through 已接听 · 正在合成语音 → 正在播放 (with the call clock running) and
  only retire a couple of seconds after the audio finishes. Kill the TTS
  player mid-call and confirm the red 语音没有播出来 strip carries the job
  reason and lingers longer than a clean finish.
- **Call card theming**: with a call still ringing, switch 设置 → 外观 across
  浅色 / 深色 / 跟随系统. The card must recolour with the host without a reload
  (it reads `--dsw-alias-*` tokens and keys its dark tier off the
  `data-ds-dark-theme` attribute the ThemePresenter owns); with 跟随系统 on,
  flipping the OS scheme must move the card too.

## 3. Post-push follow-ups

- Add the repo to the awesome-dsh-plugin list (one line in `README.md`).
- Post a short note on
  https://github.com/deepseek-ai/deepseek-harness/discussions (the ecosystem
  channel CONTRIBUTING.md points at).

## 4. npm publishing

The package is published to npm **unscoped** as `dsh-voice-call`; the README
install line and the live version badge both read from it.

```sh
pnpm pack                # sanity-check the tarball first
npm publish              # prepublishOnly runs the build
```

Bump `version` in the same commit that changes what users get. A harness
baseline bump with no functional change takes a patch bump (`0.1.1` for the
0.1.2-rc.1 retarget, `0.3.8` for the 0.2.0-rc.1 retarget); a baseline bump that
ships new behaviour takes a minor (`0.3.0` for 0.1.5-rc.2 plus the card restyle
and the answer-to-playback leg).

## 5. Follow-ups

Shipped: the dedicated call card (v0.2) with its answer-to-playback leg
(v0.3), the CrispASR + Qwen3-TTS backend, the Windows `SoundPlayer` playback
path.

- Duration reporting for say/whisper via ffprobe (`ffprobe` is usually
  present next to ffmpeg), so the audio card shows real durations.
- Whisper.cpp `stream` mode for near-live dictation once whisper-cli is
  installed (still explicit tool calls only).
- A `/voice record` variant wired to the web composer for browser-side mic
  capture.
- Voicemail and read receipts: the event and payload contracts are already
  reserved (`src/domain/voicemail.ts`, `src/rpc/contract.ts`); nothing
  renders them yet.
- Session-log durability: `durableEvents` is still off by default because
  `Session.append` gives plugin events no way to set `SessionEvent.ignorable`.
  Revisit if the harness ever exposes that write path.
