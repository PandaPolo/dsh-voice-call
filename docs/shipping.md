# Shipping dsh-voice

The repo lives at `https://github.com/Jesse-njx/dsh-voice`. **Deliberate scope:
GitHub only — npm publishing is deferred.** Everything below is verified
locally except the push itself.

## 0. Preflight (verified locally)

- `pnpm test` — 46 tests green: arg-schema units (the exact-one
  `{file|record}` union, `speak`'s optional `voice`/`rate`), backend
  selection with faked probes, the fake text-to-text backend end-to-end
  through both tool pipelines, the `voice-note` renderer (node.data from a
  logged event, transcript-only degradation, replay purity), and a macOS
  `say` integration test (non-empty m4a under audioDir).
- `pnpm typecheck` (host + client tsconfigs) and `pnpm build` (host tsc +
  client declarations + the web client bundle) — clean.
- `pnpm pack` — tarball contains `lib/` (host + `client.js` + client d.ts),
  `shims/`, `cordis.patch.yml`, `README.md`, `README.zh.md`, `LICENSE`;
  manifest carries `dsh.bundle.patch` and `dsh.client`.
- **Consumer simulation (host)**: the packed tarball installs into a scratch
  DSH profile (`dsh plugin --profile headless add <tarball>`) and the profile
  boots with zero dsh-voice errors (only the expected MISSING_CREDENTIAL for
  the scratch env's absent API key).
- **Consumer simulation (web client)**: with the tarball installed into a
  scratch web profile on a non-default port, the profile boots, the boot
  manifest composes `@dsh-voice/bundle` with its `client.js` bundle, and
  `GET /plugins/@dsh-voice/bundle/client.js` returns HTTP 200 with the
  loader-format bundle.
- **Dependency pattern**: all `@deepseek-ai/*` packages are
  `peerDependencies` (the ecosystem convention — regular deps would install
  duplicate copies into DSH profiles and break tool dispatch), mirrored in
  devDependencies; `schemastery` is a runtime dependency (the config
  validator), matching the sibling plugins.

## 1. Create + push the GitHub repo

```sh
gh repo create Jesse-njx/dsh-voice --public --source . --push
```

Repo settings:

- **Topics**: `dsh-plugin` (required by deepseek-harness CONTRIBUTING.md)
  plus `deepseek-harness`, `voice`, `stt`, `tts`, `speech-to-text`,
  `text-to-speech`, `plugin`.
- **Description**: "Voice notes in, spoken answers out — dictate audio that
  becomes user messages (transcribe), have the agent read replies aloud
  (speak), and leave walk-away narration on long headless runs. Local-first:
  plain audio files under ~/.dsh/voice/."

## 2. Live DSH verification (follow-ups)

With a real provider configured (your DSH web profile):

```sh
dsh plugin --profile web add @dsh-voice/bundle   # from the repo checkout
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

## 3. Post-push follow-ups

- Add the repo to the awesome-dsh-plugin list (one line in `README.md`).
- Post a short note on
  https://github.com/deepseek-ai/deepseek-harness/discussions (the ecosystem
  channel CONTRIBUTING.md points at).

## 4. npm publishing (deferred, not planned)

Per the current scope the package is **not** published to npm. When it is:
`pnpm publish --access public` under the `@dsh-voice` scope. Until then the
install line installs from the repo (see the README).

## 5. Follow-ups (v0.2)

- Duration reporting for say/whisper via ffprobe (`ffprobe` is usually
  present next to ffmpeg), so the audio card shows real durations.
- Whisper.cpp `stream` mode for near-live dictation once whisper-cli is
  installed (still explicit tool calls only).
- A `/voice record` variant wired to the web composer for browser-side mic
  capture.
