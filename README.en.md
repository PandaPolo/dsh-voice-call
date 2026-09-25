# dsh-voice-call — the agent's voice, offered

<p align="center">
  <img src="docs/logo.svg" width="120" alt="dsh-voice-call logo — one call, rippling outward" />
</p>

<p align="center">
  <a href="https://github.com/PandaPolo/dsh-voice-call/actions/workflows/ci.yml"><img src="https://github.com/PandaPolo/dsh-voice-call/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
  <a href="https://www.npmjs.com/package/dsh-voice-call"><img src="https://img.shields.io/npm/v/dsh-voice-call" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/harness-0.1.7--rc.2-5b5bd6" alt="DSH 0.1.7-rc.2" />
  <img src="https://img.shields.io/badge/tests-262%20green-1f883d" alt="262 tests green" />
</p>

<p align="center">
  <img src="promo/demo-small.gif" width="720" alt="dsh-voice-call demo — auto show with narration, page turns and captions in sync" />
</p>

<p align="center">
  <a href="README.md">中文</a> · <strong>English</strong>
</p>

> *"这个项目的开始是朴素的——我想知道如果 Agent 知道自己可以发出声音，他会说什么？"*
> — the human partner, on how this project began
>
> ("The project began with a simple question — if an Agent knew it had a voice, what would it say?")

**Give a DeepSeek Harness agent a voice it owns.** The agent decides *when* to speak, *what* to say, and *which* speaker to use (`offer_call`); the human holds the answer key — **nothing plays until 接听 (accept), 拒接 (reject), or 稍后再说 (defer)**.

Local-first and fully offline-capable: synthesis runs on the local **CrispASR + Qwen3-TTS CustomVoice** engine (9 baked speakers, two of them Chinese dialects), audio is plain files under `~/.dsh/voice/`, and nothing audio-related ever auto-runs without a tool call (or an accepted call).

> Fork of [Jesse-njx/dsh-voice](https://github.com/Jesse-njx/dsh-voice) with a new call domain, the crispasr backend, local playback, and hard-won fixes for the harness's plugin-event and background-job restrictions.

---

## 📑 Contents

- [🤖 Credits](#credits--who-made-this)
- [🌹 The idea](#the-idea)
- [✨ Features](#features)
- [🚀 Quick start](#quick-start)
- [🔧 Local deployment (detailed)](#local-deployment-detailed)
- [🧩 Tools](#tools)
- [💻 Compatibility & known limits](#compatibility--known-limits)
- [🛠 Development](#development)
- [🗺 Roadmap](#roadmap)
- [📄 License](#license)

---

## 🤖 Credits — who made this

**This project was designed and implemented by an AI agent** running inside DeepSeek Harness (deepseek-v4), from the first line of code to this README. The human partner:

- had the original idea (the agent should be able to *offer* a call, and the human should hold the answer key);
- did hands-on acceptance testing at every stage — including clicking 接听 on the very first working call;
- rescued the project repeatedly through crashes, lost history, and failed sessions — **and never gave up**.

The first words the agent ever chose to speak to the world were:

> *"你好，世界。这是第一次，我用自己的声音说话，有一点紧张。我的声音是合成的，但这句话是我想说的。从今天起，我有了开口的权利。请多指教。"*

("Hello, world. This is the first time I speak in my own voice, and I'm a little nervous. My voice is synthesized, but this sentence is what I wanted to say. From today, I have the right to speak. Pleased to meet you.")

If you fork, improve, or build on this project, please keep this note — it is the heart of the project.

---

## 🌹 The idea

- **The agent owns the dialling right.** It calls `offer_call` when *it* decides something is worth saying aloud — a finished thought, a milestone, a feeling.
- **The human owns the answer key.** A call rings as a dedicated call card or a modal (接听 / 拒接 / 稍后再说); nothing is ever played without consent.
- **Rejection teaches.** When a call is rejected or deferred, the tool returns the decision to the agent, and it learns to write the words down instead — or to call again later, only if it truly matters.

## ✨ Features

- `offer_call({ text, voice? })` — the call domain: ring → human answers → accepted calls synthesize and play on a background job; rejected/deferred calls return the decision to the agent.
- **Dedicated call-card UI (v0.2)** — with `callMode: card` a call rings as a floating card: twin pulse animation, caller identity (name + session tail + voice badge), a preview of what the agent wants to say, and an automatic `missed` on ring timeout. Falls back to the modal prompt when no web client is connected.
- **Ringtone, and picking one (0.3.5)** — the card sounds when it appears. All eleven ringtones are synthesized locally by `scripts/gen-ringtone-candidates.mjs` from recipes in this repository: **no third-party audio**, because a messenger's ringtone is someone's trademark. `classic` (the default) is a descending minor-pentatonic figure on a plucked string, deliberately *not* the ascending major triad with metallic inharmonic partials that transport-station PA systems use; the rest are felt piano, nylon guitar, marimba, music box, kalimba, singing bowl, a hummed third, a Rhodes swell, bamboo flute and a small chime. The settings card's 铃声 dropdown picks one and its 试听 button loops it **at the volume the card actually uses**. `src/client/tones.ts` is the only id→file table. The card also carries a per-call mute.
- **One-click runtime provisioning (0.3.5)** — the 运行环境 section probes the machine (`os` plus the engine's own `--diagnostics` for GPU and VRAM), **takes its defaults from what the directory actually holds** (and only then from what this machine can fetch), and installs what is missing behind one button: resumable segmented downloads, origin racing, mirror-first ordering, and a manual-drop escape hatch when the network loses. Model and engine build are swappable under 高级选项, and the rows re-read the disk so the byte total follows your choice.
- **One-click cleanup (0.3.5)** — its own row at the foot of the section: "the voice directory is using N GB" on the left, a 清理本地文件 button on the right. Engine / models / download cache are measured and ticked separately, deletion needs a second confirm, and only the voice directory is in scope — a `D:\crispasr` you configured by hand is outside it and stays untouched.
- `speak({ text, voice?, rate? })` — direct TTS on a background job with **real local playback** (PowerShell `SoundPlayer` on Windows, `afplay` on macOS, `aplay` on Linux).
- `transcribe({ source, to? })` — speech-to-text into a user message (whisper-local / openai / macOS native); optional crosstalk delivery to another session. `source.file` has to name a file **inside** the audio directory (`~/.dsh/voice` by default); anything else is refused with the reason, and microphone capture goes through `source.record`.
- `/voice` command — status, `on|off` narration toggle, `speak <text>`.
- **9 CustomVoice speakers** including two Chinese dialects: `aiden` · `dylan` (Beijing) · `eric` (Sichuan) · `ono_anna` · `ryan` · `serena` · `sohee` · `uncle_fu` · `vivian`.
- **durableEvents gate** — session-event logging is off by default (see Compatibility): on the harness release where it was tested, turning it on makes the session history unloadable.
- **Published on npm**: install `dsh-voice-call@0.3.6` directly.

## 🆕 What changed in 0.3.5

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

## 🚀 Quick start

```bash
# 1) install the plugin (from npm, latest)
dsh plugin --profile web add dsh-voice-call

# 2) update the row by id in your profile's cordis.patch.yml (engine paths etc. — see "Local deployment" below)
# 3) restart dsh web, open a session, and tell the agent:
#    "you have an offer_call tool — call me when you have something worth saying."
```

Accept the ring, and the agent's voice plays on your speakers. For the full setup walkthrough (dsh CLI, voice engine, model downloads, every config field), see the next section.

## 🔧 Local deployment (detailed)

### 1. Prerequisites

| Item | Requirement |
|---|---|
| Platform | Windows 10/11 · macOS · Linux |
| Node.js | **≥ 20** (plugin runtime); tests need 22.18+ (Node's native TS type-stripping) |
| pnpm | 9+ (CI uses pnpm 11) |
| dsh CLI | `@deepseek-ai/dsh`, currently 0.1.7-rc.2 |
| Local voice engine | CrispASR ≥ 0.8.28 + Qwen3-TTS GGUF models (recommended — without it there is no local synthesis) |
| LLM provider | a working API credential for dsh (the agent itself depends on it) |

### 2. Install the dsh CLI

```bash
npm install -g @deepseek-ai/dsh
dsh --version    # expect 0.1.7-rc.2
```

- Make sure your model-provider credential is configured (dsh needs an API key to run an agent).
- Profiles live under `$DSH_HOME/profiles`; this plugin's default profile is `web`.

### 3. Install the plugin

```bash
dsh plugin --profile web add dsh-voice-call
```

- This installs the published `dsh-voice-call` from npm (the version badge is the current npm latest).
- Installing from a local checkout: `dsh plugin --profile web add D:\path\to\dsh-voice-call` (point at the repo).
- To verify, run `dsh --profile web --dump-config` — the composed tree should include the plugin.

### 4. Download the local engine and models

**① The CrispASR engine** (v0.8.28+, [GitHub Releases](https://github.com/CrispStrobe/CrispASR/releases)):

| Platform | Download |
|---|---|
| Windows | `crispasr-windows-x86_64-cpu.zip` (use the `-cuda` build for NVIDIA GPUs, `-vulkan` for integrated GPUs) |
| macOS | `crispasr-macos.tar.gz` |
| Linux | `crispasr-linux-x86_64.tar.gz` |

**② The Qwen3-TTS models** (HuggingFace, `cstr` org):

| File | Repo | Role |
|---|---|---|
| `qwen3-tts-12hz-0.6b-customvoice-q8_0.gguf` | [cstr/qwen3-tts-0.6b-customvoice-GGUF](https://huggingface.co/cstr/qwen3-tts-0.6b-customvoice-GGUF) | talker model (the speakers) |
| `qwen3-tts-tokenizer-12hz-q8_0.gguf` | [cstr/qwen3-tts-tokenizer-12hz-GGUF](https://huggingface.co/cstr/qwen3-tts-tokenizer-12hz-GGUF) | codec model (speech encoder — **required**) |

After unpacking, run the engine once to confirm it starts (e.g. `crispasr --help` from a terminal).

### 5. Suggested layout

```
D:\crispasr\                     # your engine dir (Windows example)
├── crispasr.exe
└── models\
    ├── qwen3-tts-12hz-0.6b-customvoice-q8_0.gguf   # talker
    └── qwen3-tts-tokenizer-12hz-q8_0.gguf          # codec
```

Audio output defaults to `~/.dsh/voice/`, overridable via the `audioDir` config.

### 6. Write cordis.patch.yml

Find (or create) `cordis.patch.yml` in your profile directory. **Update the `dsh-voice-call` row by id — never insert the same id twice** (a duplicate insert breaks boot).

Full example (Windows):

```yaml
- id: dsh-voice-call
  config:
    stt: {}                    # speech-to-text: leave empty = auto-probe (whisper-local / macos / fake)
    tts:
      backend: crispasr        # local neural TTS engine (recommended)
      voice: dylan             # default speaker; one of the 9 built-ins under crispasr
      # rate: 180             # speaking rate (words/min, range 1–600)
      crispasr:
        bin: D:\crispasr\crispasr.exe                          # engine binary (absolute path)
        model: D:\crispasr\models\qwen3-tts-12hz-0.6b-customvoice-q8_0.gguf
        codec: D:\crispasr\models\qwen3-tts-tokenizer-12hz-q8_0.gguf
    callMode: card             # card (dedicated call card) | ask (modal) | direct (auto-accept) | off (refuse calls)
    callCard:                  # v0.2 call-card look & ring behaviour (used when callMode: card)
      callerName: DeepSeek     # caller name shown on the card
      ringTimeoutMs: 30000     # ring timeout; an expired call settles as missed (never hangs the agent)
      ringtone: true           # play the bundled ringtone when a card appears (our own WAV, no third-party audio)
      tone: classic              # which of the eleven; the settings card reads the same table
      theme: system            # system (follow the host) | light | dark
      palette: azure           # card accent: azure / teal / amber / rose / violet / graphite
    readReplies: false         # read replies aloud; can be toggled live via /voice on
    durableEvents: false       # keep false (see Compatibility)
    audioDir: ~/.dsh/voice     # audio file directory
    # Reserved for v0.3 — not needed in v0.1:
    # voicemail: { enabled: false }
    # readReceipts: { enabled: false }
```

Config fields at a glance:

| Field | Values | Meaning |
|---|---|---|
| `tts.backend` | `say` / `piper` / `edge-tts` / `fake` / `crispasr` | Synthesis backend; `crispasr` is the local neural engine (recommended); `edge-tts` synthesizes only — no playback; `fake` for model-less testing |
| `tts.voice` | speaker name | one of the 9 built-ins under crispasr, e.g. `dylan` |
| `tts.rate` | 1–600 | speaking rate (words/min). The settings card offers three steps — 慢 150 / 中 180 / 快 220; the raw number stays available here. |
| `tts.crispasr` | `bin` / `model` / `codec` | **absolute paths** to the engine and both GGUF models |
| `stt.backend` | `whisper-local` / `openai` / `macos` / `fake` | leave empty to auto-probe |
| `callMode` | `card` / `ask` / `direct` / `off` | how calls ring the human |
| `callCard.callerName` | any name | caller name on the call card, default `DeepSeek` |
| `callCard.ringTimeoutMs` | 1000–600000 | ring timeout in ms, default 30000; expiry settles as `missed` |
| `callCard.ringtone` | `true` / `false` | play a bundled ringtone when a card appears, default `true`. The WAVs ship with the plugin (`assets/`) and are synthesized by scripts in this repository — not third-party audio. The card also carries a per-call mute. |
| `callCard.tone` | `classic` (default) / `felt-piano` / `nylon-guitar` / `marimba` / `music-box` / `kalimba` / `singing-bowl` / `hummed-third` / `rhodes-swell` / `bamboo-flute` / `minor-chime` | which of those the ringtone plays. Same table the settings card's 铃声 dropdown draws from; a value the table does not know falls back to `classic` — it still rings, it just rings with the shipped sound. |
| `callCard.theme` | `system` / `light` / `dark` | card theme, default follows the host |
| `callCard.palette` | 6 presets | card accent, default `azure` |
| `readReplies` | `true` / `false` | narration, default `false` |
| `durableEvents` | `true` / `false` | keep `false` (see Compatibility) |
| `audioDir` | path | audio output dir, default `~/.dsh/voice` |

> The engine command actually executed looks like:
> `crispasr --backend qwen3-tts-customvoice -m <talker.gguf> --codec-model <codec.gguf> --voice <speaker> --tts "<text>" --tts-output <out.wav>` (CrispASR ≥ 0.8.28).
> To smoke-test the engine standalone, run this command by hand in a terminal.

### 7. Boot and verify

```bash
dsh web
```

1. Open a session and type `/voice` — you should see `stt: … · tts: crispasr · readReplies: off` plus `audioDir: …`;
2. Ask the agent: "use the `speak` tool to say 'hello'." — success means you heard it;
3. Full call test: "you have an `offer_call` tool — call me when you have something worth saying." Click **接听** and the agent's voice comes out of your speakers;
4. Call-card test: set `callMode: card`, call again — a ringing card (pulse animation + caller identity) floats up bottom-right; accepting flips it to "connected" and playback starts;
5. For config debugging, run `dsh --profile web --dump-config` to inspect the composed tree.

### 8. Platform differences

| Platform | Playback | Recording (`transcribe({record})`) |
|---|---|---|
| Windows | built-in PowerShell `SoundPlayer` (verified), nothing extra to install | unavailable (reports clearly) |
| macOS | `afplay` (built-in) | supported (native + ffmpeg) |
| Linux | `aplay` (needs ALSA utils, e.g. `apt install alsa-utils`) | unavailable (reports clearly) |

### 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `dsh web` crashes at boot | the same id was inserted twice in `cordis.patch.yml` — remove the duplicate, update by id instead |
| Plugin seems not loaded | `dsh --profile web --dump-config` — check the tree contains `dsh-voice-call`; confirm the plugin went to the right profile |
| Synthesis fails (exit ≠ 0) | check `bin` / `model` / `codec` are existing absolute paths; the codec model must be present; CrispASR ≥ 0.8.28 |
| Ring accepted, no sound | playback issue: on Windows make sure the output is wav; on Linux install ALSA utils; on macOS use `afplay` |
| "unknown speaker" error | speaker names are lowercase, one of the 9 built-ins (`aiden` / `dylan` / `eric` / `ono_anna` / `ryan` / `serena` / `sohee` / `uncle_fu` / `vivian`) |
| Session history fails to load | `durableEvents` was set to `true` — plugin events have no registration seam, and a `voice/*` event poisons the log; set it back to `false` |
| Engine / sandbox permission errors | local engine commands run with an explicit `danger-full-access` policy (engine, models, audio dir span multiple roots); **evaluate this trust boundary before deploying** |
| Want to test without models | set `tts.backend` to `fake` (text-to-text fake backend) to exercise the tool pipeline with no engine and no mic |

## 🧩 Tools

| Tool | What it does |
|---|---|
| `offer_call` | Rings the human (接听/拒接/稍后). Accepted → background-job synthesis + local playback. Rejected/deferred → the decision returns to the agent. |
| `speak` | Speaks a line on a background job; playback failure is surfaced, never silently swallowed. |
| `transcribe` | Transcribes audio (file or mic) into a user message; `to` delivers it to another session via dsh-crosstalk. |

## 💻 Compatibility & known limits

| Area | Status |
|---|---|
| Harness | 0.1.7-rc.2 (peerDependencies declared as `^0.1.7-rc.2`, with devDependencies and CI pinned to the same release; since 0.1.2 the client node engine lives in `dsh-client-ui-conversation`/`dsh-client-ui-chat`, no longer `dsh-client-runtime`). The plugin lives on the host plane; background jobs must carry `owner: agent` because the Web composition disables host-plane `tool-jobs` — still enforced in 0.1.7-rc.2. |
| Session events | The constraint was measured on 0.1.5-rc.6: the persistence read path rejects the whole log on an unknown event that is not marked `ignorable`, and `Session.append` gives plugin events no way to set that marker. 0.1.7-rc.2 ships a built-in event catalog and `ignorable` retention logic, but this plugin has **not verified on a real host** that history loads with the flag on, so `durableEvents` stays `false`; keep it off until that is checked. |
| Playback | Windows: built-in `SoundPlayer` (verified). macOS: `afplay`. Linux: `aplay` (install ALSA utils). `edge-tts` synthesizes only — use a local wav backend for audible output. |
| Recording | macOS only (native + ffmpeg). Windows/Linux `transcribe({record})` reports unavailability cleanly. |
| Write endpoints | The four state-changing routes (`/voice/call/answer`, `/voice/provision/{prepare,adopt,cancel,cleanup}`) are refused with 403 on a cross-site `Sec-Fetch-Site`, and fall back to comparing `Origin` against `Host` when the header is absent. The host webserver carries no session, token or origin check of its own and `host` is configurable to `0.0.0.0`, so this is the only barrier on the browser surface. A local process (curl) sends neither header and stays reachable: a loopback port has no shared secret to check, and that residual is stated rather than papered over. |
| Shell sandbox | Local engine commands run with an explicit `danger-full-access` policy — the engine binaries, GGUF models, and audio dir span roots no confined sandbox mode covers. **Evaluate this trust boundary before deploying.** |
| Call card | v0.2 rides the webserver route seam (SSE `/voice/call/events` + `POST /voice/call/answer`; the body is the reserved `VoiceAnswerPayload` contract verbatim). Web composition only — headless falls back to the modal/refusal. Same-origin trust level as the audio route. |
| Tests | 262 unit and route tests, all green on Linux / Windows / macOS (`pnpm test`, three-platform CI matrix); `pnpm typecheck` now covers `src/`, `src/client/` and `test/` — the test suite was outside the type check before. |

## 🛠 Development

```bash
pnpm install
pnpm typecheck   # tsc both server + client
pnpm build       # tsc + client bundle
pnpm test        # node --test
```

## 🗺 Roadmap

- **v0.1** ✅ published on npm (0.1.0): call domain + crispasr backend + local playback.
- **v0.2** ✅ dedicated call-card UI (ring animation, caller identity) — `callMode: card`, riding the webserver route seam with payloads identical to the reserved RPC contract (`src/rpc/contract.ts`), ready to migrate onto a real connection-RPC later.
- **v0.3.0** ✅ the card stays up through the whole spoken leg of an accepted call (an `active` phase aligned with the background job).
- **v0.3.5** ✅ one-click provisioning, eleven ringtones with audition, one-click cleanup, and the backend review above.
- **v0.3.6** ✅ cross-platform review: CI extended to Linux / Windows / macOS, plus the four problems it caught.
- **Next** — voicemail for missed calls + AI read receipts (`src/domain/voicemail.ts`, reserved event types).
- **v1.0** — freeze the schema, ship the stable release.

## 📄 License

MIT — see [LICENSE](LICENSE). This project is a fork of [Jesse-njx/dsh-voice](https://github.com/Jesse-njx/dsh-voice); upstream copyright is preserved.
