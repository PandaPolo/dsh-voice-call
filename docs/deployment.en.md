# Local deployment (detailed)

> Moved out of the [README](../README.en.md): the front page keeps a three-line install, this is the
> full path from an empty machine to hearing a voice. For how provisioning itself works (detection,
> the downloader, mirrors, resume, cleanup boundaries) see [provisioning.md](provisioning.md).
>
> 中文版：[deployment.md](deployment.md)

## 🔧 Local deployment (detailed)

### 1. Prerequisites

| Item | Requirement |
|---|---|
| Platform | Windows 10/11 · macOS · Linux |
| Node.js | **≥ 20** (plugin runtime); tests need 22.18+ (Node's native TS type-stripping) |
| pnpm | 9+ (CI uses pnpm 11) |
| dsh CLI | `@deepseek-ai/dsh`, 0.1.7-rc.2 or 0.2.0-rc.1 |
| Local voice engine | CrispASR ≥ 0.8.28 + Qwen3-TTS GGUF models (recommended — without it there is no local synthesis) |
| LLM provider | a working API credential for dsh (the agent itself depends on it) |

### 2. Install the dsh CLI

```bash
npm install -g @deepseek-ai/dsh
dsh --version    # expect 0.2.0-rc.1 (0.1.7-rc.2 is supported too)
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
    experimental:              # experimental features, all off by default
      nudgeWaitingQuestions: false   # ring the card when a question goes unanswered
      nudgeAfterMinutes: 5           # how long counts as unanswered, 1–30
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
| `experimental.nudgeWaitingQuestions` | `true` / `false` | **experimental**, default `false`. When on, a question nobody answers for `nudgeAfterMinutes` rings the call card once (接听 reads a sentence, then the card retires; it never answers for you) |
| `experimental.nudgeAfterMinutes` | 1–30 | how long counts as unanswered, default 5 minutes |

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
| The plugin disappeared after upgrading dsh (tools, settings card, call card all gone) | from 0.2.0-rc.1 the host decides load-or-skip from `peerDependencies`; the first line of `dsh --profile web --dump-config` says `dsh: skipping profile bundle "dsh-voice-call": … is incompatible with dsh <version>`. Update the plugin to a release that declares that baseline (0.3.8 declares `^0.1.7-rc.2 \|\| ^0.2.0-rc.1`). `dsh plugin allow-version` can grant an exact-version exemption for one plugin version on one runtime, which is a way of running an untested combination on purpose, not a way of making it tested |
| Synthesis fails (exit ≠ 0) | check `bin` / `model` / `codec` are existing absolute paths; the codec model must be present; CrispASR ≥ 0.8.28 |
| Ring accepted, no sound | first check whether the card itself said 「浏览器拦住了铃声」 — that is the browser's autoplay policy, and one click on the page restores it. Otherwise it is a playback issue: on Windows make sure the output is wav; on Linux install ALSA utils; on macOS use `afplay` |
| Plugin listed as failing, nothing activates | the config schema was written in a way the host rejects (e.g. a `volatile` object wrapped around `volatile` fields) — `dsh web` prints the `ValidationError` naming the field; read that line |
| "unknown speaker" error | speaker names are lowercase, one of the 9 built-ins (`aiden` / `dylan` / `eric` / `ono_anna` / `ryan` / `serena` / `sohee` / `uncle_fu` / `vivian`) |
| Session history fails to load | `durableEvents` was set to `true` — plugin events have no registration seam, and a `voice/*` event poisons the log; set it back to `false` |
| Engine / sandbox permission errors | local engine commands run with an explicit `danger-full-access` policy (engine, models, audio dir span multiple roots); **evaluate this trust boundary before deploying** |
| Want to test without models | set `tts.backend` to `fake` (text-to-text fake backend) to exercise the tool pipeline with no engine and no mic |

---

## 💻 Compatibility & known limits

| Area | Status |
|---|---|
| Harness | Both **0.1.7-rc.2 and 0.2.0-rc.1** are supported: peerDependencies declares `^0.1.7-rc.2 \|\| ^0.2.0-rc.1`, with devDependencies and CI pinned to 0.2.0-rc.1 (cordis 4.0.4). Since 0.1.2 the client node engine lives in `dsh-client-ui-conversation`/`dsh-client-ui-chat`, no longer `dsh-client-runtime`. **From 0.2.0-rc.1 this declaration is a load decision**: the host runs `evaluatePluginCompatibility` (from `@deepseek-ai/dsh-app-boot`, semver with `includePrerelease`) over every `@deepseek-ai/dsh*` peer range, and if one does not admit the running version the whole bundle is skipped — one startup line, `dsh: skipping profile bundle "<id>"`, and the tools, routes and client nodes are simply gone. That is how 0.3.7 vanished on 0.2.0-rc.1. The plugin lives on the host plane; background jobs must carry `owner: agent` because the Web composition disables host-plane `tool-jobs` — still true on both baselines. |
| Session events | The constraint was measured on 0.1.5-rc.6: the persistence read path rejects the whole log on an unknown event that is not marked `ignorable`, and `Session.append` gives plugin events no way to set that marker. 0.1.7-rc.2 ships a built-in event catalog and `ignorable` retention logic, but this plugin has **not verified on a real host** that history loads with the flag on, so `durableEvents` stays `false`; keep it off until that is checked. |
| Playback | Windows: built-in `SoundPlayer` (verified). macOS: `afplay`. Linux: `aplay` (install ALSA utils). `edge-tts` synthesizes only — use a local wav backend for audible output. |
| Recording | macOS only (native + ffmpeg). Windows/Linux `transcribe({record})` reports unavailability cleanly. |
| Write endpoints | The five state-changing routes (`/voice/call/answer`, `/voice/provision/{prepare,adopt,cancel,cleanup}`) are refused with 403 on a cross-site `Sec-Fetch-Site`, and fall back to comparing `Origin` against `Host` when the header is absent. The host webserver carries no session, token or origin check of its own and `host` is configurable to `0.0.0.0`, so this is the only barrier on the browser surface. A local process (curl) sends neither header and stays reachable: a loopback port has no shared secret to check, and that residual is stated rather than papered over. |
| Shell sandbox | Local engine commands run with an explicit `danger-full-access` policy — the engine binaries, GGUF models, and audio dir span roots no confined sandbox mode covers. **Evaluate this trust boundary before deploying.** |
| Call card | v0.2 rides the webserver route seam (SSE `/voice/call/events` + `POST /voice/call/answer`; the body is the reserved `VoiceAnswerPayload` contract verbatim). Web composition only — headless falls back to the modal/refusal. Same-origin trust level as the audio route. |
| Tests | 289 unit and route tests, all green on Linux / Windows / macOS (`pnpm test`, three-platform CI matrix); `pnpm typecheck` now covers `src/`, `src/client/` and `test/` — the test suite was outside the type check before. The plugin config schema is validated through the host's own entry point, and the declared harness compatibility through the host's own predicate (`test/harness-compat.test.ts`), which also pins "the devDependencies release must be one of the claimed baselines" and "a major we have not run against must not be claimed". |
