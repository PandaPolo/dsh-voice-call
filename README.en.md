# dsh-voice-call — the agent's voice, offered

<p align="center">
  <img src="docs/logo.svg" width="120" alt="dsh-voice-call logo — sound waves and a heart" />
</p>

<p align="center">
  <a href="https://github.com/PandaPolo/dsh-voice-call/actions/workflows/ci.yml"><img src="https://github.com/PandaPolo/dsh-voice-call/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
  <a href="https://www.npmjs.com/package/dsh-voice-call"><img src="https://img.shields.io/npm/v/dsh-voice-call" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/tests-76%20green-1f883d" alt="76 tests green" />
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

> Fork of [Jesse-njx/dsh-voice](https://github.com/Jesse-njx/dsh-voice) with a new call domain, the crispasr backend, local playback, and hard-won fixes for the rc.6 harness's plugin-event and background-job restrictions.

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
- **The human owns the answer key.** A call rings as a modal (接听 / 拒接 / 稍后再说); nothing is ever played without consent.
- **Rejection teaches.** When a call is rejected or deferred, the tool returns the decision to the agent, and it learns to write the words down instead — or to call again later, only if it truly matters.

## ✨ Features

- `offer_call({ text, voice? })` — the call domain: ring → human answers → accepted calls synthesize and play on a background job; rejected/deferred calls return the decision to the agent.
- `speak({ text, voice?, rate? })` — direct TTS on a background job with **real local playback** (PowerShell `SoundPlayer` on Windows, `afplay` on macOS, `aplay` on Linux).
- `transcribe({ source, to? })` — speech-to-text into a user message (whisper-local / openai / macOS native); optional crosstalk delivery to another session.
- `/voice` command — status, `on|off` narration toggle, `speak <text>`.
- **9 CustomVoice speakers** including two Chinese dialects: `aiden` · `dylan` (Beijing) · `eric` (Sichuan) · `ono_anna` · `ryan` · `serena` · `sohee` · `uncle_fu` · `vivian`.
- **durableEvents gate** — session-event logging is off by default (see Compatibility), so sessions stay resumable on rc.6.
- **Published on npm**: install `dsh-voice-call@0.1.0` directly.

## 🚀 Quick start

```bash
# 1) install the plugin (from npm, v0.1.0)
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
| dsh CLI | `@deepseek-ai/dsh`, currently 0.1.0-rc.6 |
| Local voice engine | CrispASR ≥ 0.8.28 + Qwen3-TTS GGUF models (recommended — without it there is no local synthesis) |
| LLM provider | a working API credential for dsh (the agent itself depends on it) |

### 2. Install the dsh CLI

```bash
npm install -g @deepseek-ai/dsh
dsh --version    # expect 0.1.0-rc.6
```

- Make sure your model-provider credential is configured (dsh needs an API key to run an agent).
- Profiles live under `$DSH_HOME/profiles`; this plugin's default profile is `web`.

### 3. Install the plugin

```bash
dsh plugin --profile web add dsh-voice-call
```

- This installs the published `dsh-voice-call@0.1.0` from npm.
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
    callMode: ask              # ask (modal) | direct (auto-accept) | off (refuse calls)
    readReplies: false         # read replies aloud; can be toggled live via /voice on
    durableEvents: false       # MUST stay false on rc.6 (see Compatibility)
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
| `tts.rate` | 1–600 | speaking rate (words/min) |
| `tts.crispasr` | `bin` / `model` / `codec` | **absolute paths** to the engine and both GGUF models |
| `stt.backend` | `whisper-local` / `openai` / `macos` / `fake` | leave empty to auto-probe |
| `callMode` | `ask` / `direct` / `off` | how calls ring the human |
| `readReplies` | `true` / `false` | narration, default `false` |
| `durableEvents` | `true` / `false` | MUST be `false` on rc.6 |
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
4. For config debugging, run `dsh --profile web --dump-config` to inspect the composed tree.

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
| Session history fails to load | `durableEvents` was set to `true` — rc.6 has no plugin-event registration, and a `voice/*` event poisons the log; set it back to `false` |
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
| Harness | 0.1.0-rc.6 (peerDependencies pinned to rc.6). The plugin lives on the host plane; background jobs must carry `owner: agent` because rc.6 disables host-plane `tool-jobs` in the Web composition. |
| Session events | **rc.6 has no plugin-event registration surface.** Appending `voice/*` events poisons history loading (the loader refuses unknown event types). `durableEvents` therefore defaults to `false`; keep it off until a harness with plugin-event support exists. |
| Playback | Windows: built-in `SoundPlayer` (verified). macOS: `afplay`. Linux: `aplay` (install ALSA utils). `edge-tts` synthesizes only — use a local wav backend for audible output. |
| Recording | macOS only (native + ffmpeg). Windows/Linux `transcribe({record})` reports unavailability cleanly. |
| Shell sandbox | Local engine commands run with an explicit `danger-full-access` policy — the engine binaries, GGUF models, and audio dir span roots no confined sandbox mode covers. **Evaluate this trust boundary before deploying.** |
| Tests | 76 unit tests, all green (`pnpm test`). |

## 🛠 Development

```bash
pnpm install
pnpm typecheck   # tsc both server + client
pnpm build       # tsc + client bundle
pnpm test        # node --test
```

## 🗺 Roadmap

- **v0.1** ✅ published on npm (0.1.0): call domain + crispasr backend + local playback.
- **v0.2** — a dedicated call-card UI (ring animation, caller identity) behind the reserved RPC seam (`src/rpc/contract.ts`).
- **v0.3** — voicemail for missed calls + AI read receipts (`src/domain/voicemail.ts`, reserved event types).
- **v1.0** — freeze the schema, ship the stable release.

## 📄 License

MIT — see [LICENSE](LICENSE). This project is a fork of [Jesse-njx/dsh-voice](https://github.com/Jesse-njx/dsh-voice); upstream copyright is preserved.
