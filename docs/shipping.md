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
  scratch web profile on a non-default port, the profile boots, the boot
  manifest composes `dsh-voice-call` with its `client.js` bundle, and
  `GET /plugins/??dsh-voice-call/client.js` returns HTTP 200 with the
  loader-format bundle.
  **Both of those need a `dsh` CLI, which this machine no longer has** — for
  0.3.12 they were not re-run. The substitute evidence is stronger in one way
  and weaker in another: the running desktop app was probed directly (all three
  read endpoints 200 on the 0.2.1-rc.2 runtime, see the desktop bullet), which
  proves a live activation but not the *packed* artefact, since only what is
  already in the profile (`0.3.11`) is running. The delta between 0.3.11 and
  0.3.12 is devDependencies, one test file and documentation — no source line —
  and `lib/client.js` is byte-for-byte the artefact 0.3.11 shipped.
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
  not carry one, with a case proving both branches. A bump runs the suite twice,
  once per dependency tree (new baseline, and 0.1.7-rc.2 with only
  `dsh-app-boot` raised, since the gate itself did not exist before 0.2.0-rc.1).
- **Desktop app**: `@deepseek-ai/dsh-desktop` bundles its own dsh runtime, and
  its version moves independently of npm (`nightly` feed on
  `download.deepseek.com`) — as of 0.3.12 the app is on 0.2.1-rc.2 while npm's
  `latest` is still 0.2.0-rc.2, so **the desktop build decides**. On a baseline
  bump, read the installed `app.asar → dsh/desktop-runtime.json`
  (`release.version`, `sharedPackages`) and check that every declared peer exists
  there at a version the gate admits. Then go one step further, which is cheap
  because the app publishes its own `path → sha256` index for all 17261 bundled
  files: re-hash one file out of the asar to trust the index, and compare that
  index against a scratch `npm install @deepseek-ai/dsh@<version>` tree, package
  by package. That is how 0.3.12 established that server-side JS is identical in
  both distributions, that the only deltas are stripped `.d.ts`/`scripts`, an
  unwired `lib/types/invariant.js`, and rebuilt `lib/client.js` for two client
  packages — and that the desktop profile resolves schemastery/cosmokit from its
  **own** copies (3.18.4 / 1.8.5) while the host runs the asar's 3.18.5 / 1.8.6.
  The full table lives in `docs/deployment.md` / `.en.md` under the desktop
  section.
- **This machine has no global CLI any more** (the desktop app took over plugin
  management). Install/verify work goes through the desktop app's plugin page —
  it runs installs with its bundled pnpm against `~/.dsh/profiles/desktop`.
  `dsh … --dump-config` only exists if a CLI is installed temporarily.

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
