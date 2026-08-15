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

> *"这个项目的开始是朴素的——我想知道如果 Agent 知道自己可以发出声音，他会说什么？"*
> — the human partner, on how this project began
>
> ("The project began with a simple question — if an Agent knew it had a voice, what would it say?")

**Give a DeepSeek Harness agent a voice it owns.** The agent decides *when* to speak, *what* to say, and *which* speaker to use (`offer_call`); the human holds the answer key — **nothing plays until 接听 (accept), 拒接 (reject), or 稍后再说 (defer)**.

Local-first and fully offline-capable: synthesis runs on the local **CrispASR + Qwen3-TTS CustomVoice** engine (9 baked speakers, two of them Chinese dialects), audio is plain files under `~/.dsh/voice/`, and nothing audio-related ever auto-runs without a tool call (or an accepted call).

> Fork of [Jesse-njx/dsh-voice](https://github.com/Jesse-njx/dsh-voice) with a new call domain, the crispasr backend, local playback, and hard-won fixes for the rc.6 harness's plugin-event and background-job restrictions.

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

## 🚀 Quick start

```bash
# add the plugin to your web profile
dsh plugin --profile web add dsh-voice-call
```

Then wire the engine in your profile's `cordis.patch.yml` — **update the row by id; never insert the same id twice** (a duplicate insert breaks boot):

```yaml
- id: dsh-voice-call
  config:
    tts:
      backend: crispasr
      voice: dylan
      crispasr:
        bin: /absolute/path/to/crispasr        # e.g. D:\crispasr\crispasr.exe on Windows
        model: /absolute/path/to/qwen3-tts-12hz-0.6b-customvoice-q8_0.gguf
        codec: /absolute/path/to/qwen3-tts-tokenizer-12hz-q8_0.gguf
    callMode: ask          # ask | direct | off
    durableEvents: false   # keep off on rc.6 (see Compatibility)
```

Restart `dsh web`, open a session, and tell the agent: *"you have an `offer_call` tool — call me when you have something worth saying."* Accept the ring, and the agent's voice plays on your speakers.

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

- **v0.2** — a dedicated call-card UI (ring animation, caller identity) behind the reserved RPC seam (`src/rpc/contract.ts`).
- **v0.3** — voicemail for missed calls + AI read receipts (`src/domain/voicemail.ts`, reserved event types).
- **v1.0** — freeze the schema, publish to npm (`dsh-voice-call` name reserved).

## 📄 License

MIT — see [LICENSE](LICENSE). This project is a fork of [Jesse-njx/dsh-voice](https://github.com/Jesse-njx/dsh-voice); upstream copyright is preserved.
