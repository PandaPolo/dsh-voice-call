# dsh-voice

**Voice notes in, spoken answers out.** Dictate audio that becomes user messages, and have the agent read replies aloud. A hands-free terminal for DSH.

`dsh-voice` is a DeepSeek Harness bundle. Two tools, one durable event, one toggle:

- **`transcribe({ source })`** — speech-to-text. Pass `{ file }` (an existing audio file) or `{ record }` (record from the mic for a few seconds). The transcript becomes a **user message** the agent responds to — never tool output — and the chat shows a compact **audio card** with play/pause, duration, backend badge, and the transcript as caption.
- **`speak({ text, voice?, rate? })`** — text-to-speech on a background job. The tool returns `{ jobId, audioRef }` immediately and never blocks the turn; playback happens async and a failure surfaces as an injected note. `speak` doubles as **walk-away narration** for long builds and headless runs ("build finished, 0 failures").
- **`readReplies` + `/voice`** — a per-session toggle that auto-narrates the assistant's reply text. Off by default; flip it live with `/voice on`.

The design center is **local-first**: audio is plain files under `~/.dsh/voice/` (inspect them, `rm` them), nothing leaves the machine unless you explicitly configure a cloud backend, and nothing audio-related ever auto-runs — the model must call a tool.

## Why this shape

A terminal agent handles two everyday moments badly: you're away from the keyboard and want to leave an instruction (dictation), and you're mid-task and don't want to read a wall of output (narration). dsh-voice is a thin layer over things DSH already exposes — `ctx.shell`, `ctx.jobs`, `ctx.settings`, `ctx.attachments`, `ctx.conversationEvents` — so it stays useful without owning any audio pipeline itself. Audio is **plain files**, the session log holds only **refs + transcripts** (the attachment/image-ref pattern), and replay reproduces the audio card without re-reading audio.

## Install

```sh
dsh plugin --profile web add @dsh-voice/bundle
```

The bundle installs the `dsh-voice` entry (tools + `/voice` command + the web audio cards). Nothing runs until the model calls a tool.

## Config

All fields optional (profile patch or `cordis.patch.yml`):

```yaml
plugins:
  dsh-voice:
    stt:
      backend: whisper-local | openai | macos | fake   # absent = auto (whisper-local → macos)
      model: whisper-1                                  # STT model
      whisperLocal: { bin: whisper-cli, model: tiny }   # whisper.cpp binary + model
      openai: { baseUrl: https://api.openai.com/v1, apiKeyEnv: OPENAI_API_KEY }
    tts:
      backend: say | piper | edge-tts | fake            # absent = auto (say → piper)
      voice: Samantha                                   # default voice
      rate: 180                                         # say words per minute
      piper: { bin: piper, model: /path/to/model.onnx }
      edgeTts: { voice: en-US-GuyNeural }
    readReplies: false                                  # narrate replies when on
    audioDir: ~/.dsh/voice                              # artifact root
```

Defaults: `stt.backend` auto-selected offline (whisper-local → macos), `tts.backend: say`, `readReplies: false`, `audioDir: ~/.dsh/voice`. **Cloud backends are never auto-selected** — `openai` and `edge-tts` are reachable only when you pin them. The `openai` backend reads its key through the standard credential seam (`OPENAI_API_KEY`, the same convention a polyglot preset would use), falling back to the launching environment.

## Tools

### `transcribe({ source, to? })`

`source` is **exactly one** of:

- `{ file: <path> }` — transcribe an existing audio file.
- `{ record: { seconds? } }` — record from the microphone (default 5s), gated on a recording path being available (ffmpeg or the bundled swift shim on macOS).

The transcript is **inserted as a user message**, not returned as tool output: a `voice/note` session event renders the audio card as a user-authored turn, and the text is delivered to the agent as user input. The canonical return is a compact handle — `{ transcript, audioRef, backend, durationMs }` — so Code Mode callers get structured data.

With **dsh-crosstalk** installed, `transcribe({ source, to: <peer> })` delivers the note to another local session as a labeled peer message with the audio path attached (crosstalk owns provenance framing; the option simply isn't offered without it).

### `speak({ text, voice?, rate? })`

Synthesizes + plays on a **background job** (`ctx.jobs`, kind `voice-speak`), returns `{ jobId, audioRef }` immediately. Every backend writes a durable file under `audioDir` first (the unit-testable seam), then plays it as a separate best-effort step. A job failure is injected as a note, never a thrown turn.

Because it's a plain tool over `ctx.jobs`, `speak` is callable from routines and headless runs — **narration *is* speak called from a job context**. No new surface.

## Voice notes in chat

Audio never enters the session log. The file lands under `audioDir`; the log holds one durable event:

| Event | Role | Required durable facts |
|---|---|---|
| `voice/note` | unique start | `noteId`, turn/step coords, `audioRef` (path + mime + durationMs), `transcript`, `direction: 'in' \| 'out'`, `backend` |

Single-event business in v0.1 — `noteId` is the stable id, no update events. The web client renders `voice-note` cards: inbound notes (STT) read as user turns, outbound (`speak`) as agent-side cards. A missing or deleted file degrades to a transcript-only card — you're free to `rm` audio.

## `/voice`

```sh
/voice on          # narrate the assistant's replies aloud
/voice off         # stop
/voice status      # current state + backend + audioDir
/voice speak <text>  # speak a line directly from the composer
```

`readReplies` defaults follow config; the toggle is per-session and live.

## Backends

Speech-to-text (`dsh-voice-backends` module owns selection + the fake):

- **`whisper-local`** — a whisper.cpp binary on PATH (or configured), invoked via `ctx.shell`. Fully offline.
- **`openai`** — an OpenAI-compatible `whisper-1` endpoint via the standard credential seam. The only STT path that sends audio off-machine; only when configured.
- **`macos`** — built-in `SFSpeechRecognizer` via a tiny bundled swift shim through `ctx.shell`. No install, no network setup.
- **`fake`** — text-to-text fixture mapping (a file whose content is `{"transcript": "…"}` — or whose basename is `fixture-<text>.m4a` — transcribes to that text). Runs the whole tool path with no mic and no network; the CI default.

Text-to-speech:

- **`say`** (default) — macOS `say -o <file> --file-format=m4af --data-format=aac`, then `afplay`. Zero install; writes Chrome/Safari-playable m4a.
- **`piper`** — local Piper binary, offline neural TTS.
- **`edge-tts`** — cloud; only when explicitly configured.
- **`fake`** — writes `{"transcript": "<text>"}` so speak output round-trips through the fake STT exactly.

Selection is pure and unit-tested: configured backend always wins; otherwise offline fallback order (`whisper-local → macos`, `say → piper`); cloud never auto-selected; no offline backend → a clear error telling you what to configure.

## Safety / privacy defaults

- **Local-first** — audio never leaves the machine unless you explicitly set `stt.backend: openai` or `tts.backend: edge-tts`.
- **Plain files** — every artifact is a file under `audioDir` you can inspect or `rm`; the session log holds only refs + transcripts.
- **No auto-run** — recording and playback happen only on an explicit tool call. `readReplies` narrates existing replies; it never records, and it's off unless configured.

## Non-goals (v0.1)

Real-time streaming conversation; outbound synthesized voice calls; audio in group WeChat contexts; speaker diarization; music/effects; storing raw audio in the session log; wake-word / always-listening capture.

## Testing

```sh
pnpm install
pnpm typecheck   # host + client tsconfigs
pnpm test        # node --test (46 tests)
pnpm build       # tsc host + client declarations + the web client bundle
pnpm pack        # publishable tarball
```

The suite covers the spec's testing goals: arg-schema units (the exact-one `{file|record}` union, `speak`'s optional `voice`/`rate`), backend selection with faked probes, the fake text-to-text backend end-to-end through both tool pipelines, the `voice-note` renderer (expected `node.data` from a logged event, transcript-only degradation, replay purity), and a macOS `say` integration test (synthesizes a non-empty m4a under audioDir).

The client bundle (`lib/client.js`) is built by `scripts/build-client.mjs` into the web client's lazy-CJS handoff format and served at `/plugins/@dsh-voice/bundle/client.js` when the bundle is installed in a web profile.

## Development

The repo mirrors the sibling plugin layout: `src/backends/` is the `dsh-voice-backends` module (interfaces, pure selection, probes, the fake, and every concrete backend); `src/tools/` holds the `transcribe`/`speak` pipelines with injected deps so tests run with fakes; `src/client/` is the web half (pure Definition + React audio card); `shims/` are the bundled swift scripts for macOS STT and mic recording.

## License

MIT
