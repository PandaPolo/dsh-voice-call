# Shipping dsh-voice-call

The repo lives at `https://github.com/PandaPolo/dsh-voice-call` and the package
is published to npm as `dsh-voice-call` (unscoped). Everything below is
verified locally except the push and the publish themselves.

## 0. Preflight (verified locally)

- `pnpm test` — 262 green on the current baseline: arg-schema units (the exact-one
  `{file|record}` union, `speak`'s optional `voice`/`rate`), backend
  selection with faked probes, the fake text-to-text backend end-to-end
  through both tool pipelines, the `voice-note` renderer (node.data from a
  logged event, transcript-only degradation, replay purity), the call domain
  and call-card board, the durability contract (`durableEvents` stays off),
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
- **Dependency pattern**: every `@deepseek-ai/*` package — `schemastery`
  included — is a `peerDependency` (the ecosystem convention; regular deps
  would install duplicate copies into DSH profiles and break tool dispatch),
  mirrored in devDependencies. There is no `dependencies` block at all.

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

With a real provider configured (your DSH web profile):

```sh
dsh plugin --profile web add D:\path\to\dsh-voice-call   # from the repo checkout
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
0.1.2-rc.1 retarget); a baseline bump that ships new behaviour takes a minor
(`0.3.0` for 0.1.5-rc.2 plus the card restyle and the answer-to-playback leg).

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
