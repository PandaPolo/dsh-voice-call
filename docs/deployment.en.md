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
| DSH (desktop app) | 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-rc.2 / 0.2.1-rc.3 (0.2.1-rc.3 is what the desktop app ships today; npm's `latest` is 0.2.1-rc.2 and `next` is 0.2.1-rc.3) |
| Local voice engine | CrispASR ≥ 0.8.28 + Qwen3-TTS GGUF models (recommended — without it there is no local synthesis) |
| LLM provider | a working API credential for dsh (the agent itself depends on it) |

### 2. Install (desktop app)

1. Open the **DeepSeek Harness desktop app** → the Plugins page (under Settings).
2. Install the plugin from the plugin market (search for `dsh-voice-call`), then let it take effect on the same page (this plugin has no hot reload).
3. Configure it on the plugin's own settings page on first use.

> The old CLI flow (`npm install -g @deepseek-ai/dsh`, then `dsh plugin --profile web add <name>`) is retired along with the global CLI — plugin management now happens in the desktop app.

- Make sure your model-provider credential is configured (the desktop app needs an API key to run an agent).
- Plugin data lives under `$DSH_HOME` (`C:\Users\Juser\.dsh` on this machine).

### 3. Install the plugin

Install it from the desktop app's **Plugins** page:

- Search the plugin market and install the published `dsh-voice-call` (the version badge is the current npm latest).
- Installing from a local checkout: use the Plugins page to install from a local path / GitHub spec (point at the repo).
- After installing, reload the plugin on the Plugins page, or restart the desktop app, to make it take effect.

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
    callMode: card             # default card (dedicated call card) | ask (modal) | direct (auto-accept) | off (refuse calls)
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
| `callMode` | `card` / `ask` / `direct` / `off` | how calls ring the human — **default `card`**, which degrades to the modal prompt when no card client is connected |
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

Open the **DeepSeek Harness desktop app**; the plugin's features come alive in its interface (the call card floats up bottom-right).

1. Open a session and type `/voice` — you should see `stt: … · tts: crispasr · readReplies: off` plus `audioDir: …`;
2. Ask the agent: "use the `speak` tool to say 'hello'." — success means you heard it;
3. Full call test: "you have an `offer_call` tool — call me when you have something worth saying." Click **接听** and the agent's voice comes out of your speakers;
4. Call-card test: **the card is the default**, so step 3 is what should have appeared — a ringing card (pulse animation + caller identity) bottom-right, and accepting flips it to "connected" before playback starts. To check the other path, set `callMode: ask` and call again; with `card` and no card client connected, the call degrades to the modal prompt rather than becoming a call nobody could answer;
5. For config debugging, inspect `~/.dsh/profiles/desktop/package.json` and `cordis.patch.yml` (or the CLI's `web` profile). To see the composed tree, install a CLI temporarily and run `dsh --profile desktop --dump-config`.

### 8. Platform differences

| Platform | Playback | Recording (`transcribe({record})`) |
|---|---|---|
| Windows | built-in PowerShell `SoundPlayer` (verified), nothing extra to install | unavailable (reports clearly) |
| macOS | `afplay` (built-in) | supported (native + ffmpeg) |
| Linux | `aplay` (needs ALSA utils, e.g. `apt install alsa-utils`) | unavailable (reports clearly) |

### 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| The desktop app crashes at boot | the same id was inserted twice in `cordis.patch.yml` — remove the duplicate, update by id instead |
| Plugin seems not loaded | First look at the desktop app's Plugins page: if `dsh-voice-call` has no settings row, the host almost certainly skipped it. Then check `~/.dsh/profiles/desktop/package.json` — is the version right in `dependencies`, and is `dsh-voice-call` listed in `dsh.profile.bundles`? Nothing hot-reloads: reload the plugin or restart the app after any change |
| The plugin disappeared after upgrading dsh / the desktop app (tools, settings card, call card all gone) | from 0.2.0-rc.1 the host decides load-or-skip from `peerDependencies`, and a bundle that fails is simply not loaded. The desktop app is a GUI, so the `skipping profile bundle "dsh-voice-call": … is incompatible with dsh <version>` line never reaches your screen — the symptom is just a plugin that vanished. Update to a release that declares that baseline (0.3.11 through 0.3.13 all carry the identical peer declaration, covering 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-rc.2 / 0.2.1-rc.3). The plugin manager can grant an exact-version exemption for one plugin version on one runtime (the CLI equivalent is `dsh plugin allow-version`), which is a way of running an untested combination on purpose. To read the host's verdict verbatim, install a CLI temporarily and run `dsh --profile desktop --dump-config` — its first lines are exactly that. A second, unrelated kind of disappearance exists on desktop: pnpm's release-age window can refuse the newly published version (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`) and leave the older one installed — and if that older release does not declare the new baseline, it hits both problems at once |
| Synthesis fails (exit ≠ 0) | check `bin` / `model` / `codec` are existing absolute paths; the codec model must be present; CrispASR ≥ 0.8.28 |
| Ring accepted, no sound | first check whether the card itself said 「浏览器拦住了铃声」 — that is the browser's autoplay policy, and one click on the page restores it. Otherwise it is a playback issue: on Windows make sure the output is wav; on Linux install ALSA utils; on macOS use `afplay` |
| Plugin listed as failing, nothing activates | the config schema was written in a way the host rejects (e.g. a `volatile` object wrapped around `volatile` fields) — the desktop app prints the `ValidationError` naming the field; read that line |
| "unknown speaker" error | speaker names are lowercase, one of the 9 built-ins (`aiden` / `dylan` / `eric` / `ono_anna` / `ryan` / `serena` / `sohee` / `uncle_fu` / `vivian`) |
| Session history fails to load | `durableEvents` was set to `true` — plugin events have no registration seam, and a `voice/*` event poisons the log; set it back to `false` |
| Engine / sandbox permission errors | local engine commands run with an explicit `danger-full-access` policy (engine, models, audio dir span multiple roots); **evaluate this trust boundary before deploying** |
| Want to test without models | set `tts.backend` to `fake` (text-to-text fake backend) to exercise the tool pipeline with no engine and no mic |

---

## 💻 Compatibility & known limits

| Area | Status |
|---|---|
| Harness | **0.1.7-rc.2, 0.2.0-rc.1, 0.2.0-rc.2, 0.2.1-rc.2 and 0.2.1-rc.3** are supported: peerDependencies declares `^0.1.7-rc.2 || ^0.2.0-rc.1` (the second arm covers the whole 0.2.x run), with devDependencies and CI pinned to 0.2.1-rc.3 (cordis 4.0.5, schemastery 3.18.5). Since 0.1.2 the client node engine lives in `dsh-client-ui-conversation`/`dsh-client-ui-chat`, no longer `dsh-client-runtime`. **From 0.2.0-rc.1 this declaration is a load decision**: the host runs `evaluatePluginCompatibility` (from `@deepseek-ai/dsh-app-boot`, semver with `includePrerelease`) over every `@deepseek-ai/dsh*` peer range, and if one does not admit the running version the whole bundle is skipped — one startup line, `dsh: skipping profile bundle "<id>"`, and the tools, routes and client nodes are simply gone. That is how 0.3.7 vanished on 0.2.0-rc.1. **0.2.1-rc.2 changed two things**: the report field `peers` is now `requirements`, and a manifest carrying its own `engines.dsh` is judged on that range **alone** — peers stop being read. **0.2.1-rc.3 did not move the gate**: the file holding it, `@deepseek-ai/dsh-app-boot/lib/index.js`, is byte-identical (203572 bytes) between the rc.2 and rc.3 desktop asars. We deliberately do not write `engines.dsh`, because keeping all 20 peers in force is what makes "every harness package the code touches is declared" a real guard; both paths are pinned by `test/harness-compat.test.ts`, including a negative control for the silencing itself — freeze `dsh-tools` at `^0.1.7-rc.2` and the host refuses the manifest, then add an `engines.dsh` and the same manifest passes. The plugin lives on the host plane; background jobs must carry `owner: agent` because the Web composition disables host-plane `tool-jobs` — still true on every baseline. The desktop app is audited in its own section below. |
| Session events | The constraint was measured on 0.1.5-rc.6: the persistence read path rejects the whole log on an unknown event that is not marked `ignorable`, and `Session.append` gives plugin events no way to set that marker. 0.1.7-rc.2 ships a built-in event catalog and `ignorable` retention logic, but this plugin has **not verified on a real host** that history loads with the flag on, so `durableEvents` stays `false`; keep it off until that is checked. |
| Playback | Windows: built-in `SoundPlayer` (verified). macOS: `afplay`. Linux: `aplay` (install ALSA utils). `edge-tts` synthesizes only — use a local wav backend for audible output. |
| Recording | macOS only (native + ffmpeg). Windows/Linux `transcribe({record})` reports unavailability cleanly. |
| Write endpoints | The five state-changing routes (`/voice/call/answer`, `/voice/provision/{prepare,adopt,cancel,cleanup}`) are refused with 403 on a cross-site `Sec-Fetch-Site`, and fall back to comparing `Origin` against `Host` when the header is absent. The host webserver carries no session, token or origin check of its own and `host` is configurable to `0.0.0.0`, so on a CLI/browser deployment this is the only barrier on the browser surface. A local process (curl) sends neither header and stays reachable: a loopback port has no shared secret to check, and that residual is stated rather than papered over. **Under the desktop app the wall is not ours**: the main-process forwarder deletes `Origin`/`Sec-Fetch-Site`/`Host`/`Cookie`, substitutes its own host cookie, and 403s anything not originating from `dsh-app://app` — so our routes see a header-less local request and take the allow branch. Details in the desktop section below. |
| Shell sandbox | Local engine commands run with an explicit `danger-full-access` policy — the engine binaries, GGUF models, and audio dir span roots no confined sandbox mode covers. **Evaluate this trust boundary before deploying.** |
| Call card | v0.2 rides the webserver route seam (SSE `/voice/call/events` + `POST /voice/call/answer`; the body is the reserved `VoiceAnswerPayload` contract verbatim). Web composition only — headless falls back to the modal/refusal. Same-origin trust level as the audio route. |
| Tests | 302 unit and route tests, green on Linux and Windows, with two more executing on macOS — those are the `say` integration cases, which only run where there is a real voice and skip elsewhere (the front page states the count all three platforms share). Three-platform CI matrix (`pnpm test`); `pnpm typecheck` covers `src/`, `src/client/` and `test/` — the test suite was outside the type check before. The plugin config schema is validated through the host's own entry point (`test/plugin-config.test.ts`), and the declared harness compatibility through the host's own predicate (`test/harness-compat.test.ts`), which pins "the devDependencies release must be one of the claimed baselines", "a major we have not run against must not be claimed", and both `engines.dsh` paths. A baseline move is run through two dependency trees: the new one, and 0.1.7-rc.2 (where only `dsh-app-boot` is raised, since the load decision itself was born in 0.2.0-rc.1) — for 0.3.13 both trees are 302 green with all three `tsc` passes clean. Every field pinned in the shipped `cordis.patch.yml` is checked against the plugin's own defaults (`test/bundle-config.test.ts`) — that row outranks the schema's `.default()`, so it is the place that decides what a new install gets. |

## 🔒 Desktop compatibility (in full)

The DeepSeek Harness desktop app (`@deepseek-ai/dsh-desktop`) is a separate distribution that packs the whole harness into Electron. Every row below was read out of the installed `app.asar`, the `dsh/desktop-runtime.json` it carries, and `resources/app.asar.unpacked/` on this machine — not inferred from CLI behaviour. Audited against plugin release 0.3.13; the file-by-file sha256 comparison of the desktop runtime against the npm tree was established in 0.3.12 and re-run for 0.2.1-rc.3 with the same method and the app's own published index.

| Aspect | What was measured | What it means for this plugin |
|---|---|---|
| Distribution | Electron 44.7.0, bundled node 24.21.0 and pnpm 11.28.5 (plus a python 3.12.14 with the office packages); `app.asar` holds a complete `dsh/` runtime. rc.3 rearranged the runtime directory: node is at `resources/runtime/bin/node`, pnpm at `resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`, and a new `runtime.json` beside it carries `desktopVersion`. Update feed `https://download.deepseek.com/dsh-desk/feeds/win-x64/`, channel `nightly` — **independent of npm's `latest`** | The desktop app can carry a runtime newer than npm, possibly outside anything we claim; then the host skips the plugin silently. Today's case: the app ships 0.2.1-rc.3, npm's `latest` is 0.2.1-rc.2 and `next` is 0.2.1-rc.3 |
| Runtime version | `desktop-runtime.json` → `release.version` = **0.2.1-rc.3**, `hostProtocolVersion` 4, `platform/arch` = win32/x64; the app's `runtime.json` agrees (`desktopVersion: 0.2.1-rc.3`) | That is the version the host's load decision matches our peer ranges against; `^0.2.0-rc.1` admits it, and `test/harness-compat.test.ts` pins that |
| Shared packages | 305 `sharedPackages` (304 last release), 297 of them `@deepseek-ai/dsh-*` all at 0.2.1-rc.3 (cordis 4.0.5, schemastery 3.18.5 and cosmokit 1.8.6 stayed where they were); the runtime's `package.json` flattens them into direct dependencies | **All 20 peers we declare are present and every range admits the version found there** — checked one by one with `satisfies()`. We import cordis only at the type level, so it is not a runtime need; `@deepseek-ai/schemastery` resolves from the profile copy — see the two-schemastery row below. One counter-example worth naming: `@deepseek-ai/dsh-client-ui-slots` is a devDependency and the desktop runtime **does not ship it at all** (rc.2 did not either). `src/` never imports it, so nothing breaks — but a devDependency list is not a statement about the runtime |
| Same version, two distributions | The app's own 17141-entry file-hash index (120 entries fewer than rc.2), compared against an installed `npm install @deepseek-ai/dsh@0.2.1-rc.3` tree: across the 24 packages we declare, **292 files are byte-identical and all server-side JS matches exactly**. Three kinds of difference and nothing else: `scripts` stripped from `package.json` (4 packages); every `.d.ts`/`.d.ts.map` stripped (of the 355 stripped files, 349 are types and 4 docs — only 2 are runtime files, both belonging to that unshipped `dsh-client-ui-slots`); and `dsh-client-ui-chat` / `dsh-client-ui-conversation` ship a **rebuilt** `lib/client.js` (159 and 54 bytes apart). **The fourth kind from 0.3.12 is gone**: the extra `lib/types/invariant.js` that the app used to pack is not in rc.3, so the two distributions now agree there. The app adds 9 files of its own — `dsh-host-webserver` embeds a whole `node_modules/negotiator/` where npm resolves it by hoisting | Settled, and reproduced on the next release: one version number means one codebase across both distributions, so none of the seams we depend on shift because a user runs the app instead of the CLI. The rebuild cannot reach us — our client uses relative URLs and its own class names (`dsh-voice-call-overlay`), never the host's module names — and the inject target `dsh-client-ui-settings` has an identical `client.js` on both sides. The stripped `.d.ts` means the app's tree cannot be used to compile against; this repository has always built against the npm tree, so nothing changes |
| Two schemastery copies are real | The `desktop` profile is initialised by the app itself (`nodeLinker: hoisted`, `autoInstallPeers: false` — those two lines are the app's own `WORKSPACE_SETTINGS` template) with the `web` bundle template (`dsh-base` + `dsh-web-app`). Its tree holds only `@deepseek-ai/schemastery@3.18.4` and `@deepseek-ai/cosmokit@1.8.5` besides the plugins, and pnpm injects our plugin (and three others) onto **those**, while the host runs the asar's 3.18.5 / 1.8.6. Re-checked against the rc.3 profile: still 3.18.4 / 1.8.5 | **Two schemastery instances in one process.** The plugin is unaffected because the schemas it hands to the host travel as plain objects, never through `instanceof`. It also sets a floor on our declaration: the `@deepseek-ai/schemastery` peer must keep admitting 3.18.4, because that copy genuinely exists on desktop |
| DSH home | Shares `~/.dsh` with the CLI; profile directory `~/.dsh/profiles/desktop`, with its own `package.json`, `cordis.patch.yml` and `node_modules` | Audio dir `~/.dsh/voice`, provisioning and caches live under the same home, but the two profiles never overwrite each other's config. Do not write desktop settings into the `web` profile, or the reverse |
| Installing plugins | The app installs with its own pinned node and pnpm. On rc.3 the runtime moved: node is at `resources/runtime/bin/node`, pnpm at `resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`; `versions.json` declares pnpm 11.28.5 while running that `pnpm.mjs --version` prints 11.23.0 — the app is not lying: the shell that invoked it had a global pnpm 11.23.0 on `PATH`, and with the PATH scrubbed (`env -i PATH=/usr/bin:/bin`) the same file reports **11.28.5**, which is also the version that actually completed an install inside the profile. The profile's `pnpm-workspace.yaml` keeps a **name-level** `minimumReleaseAgeExclude` list, and writing it is `dshmarket`'s job, not the harness's | Same conclusion as the CLI: **every `@deepseek-ai/*` must stay a peer, never a dependency**, or the profile grows a second copy of the harness and tool dispatch breaks. Separately observed: a plugin version published inside pnpm's release-age window refuses to install (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`) and the profile keeps the older version. The threshold is not written in that profile file, and neither the plugin manager nor the app's `command-manager.js` sets it — but `dshmarket`'s `pnpm-compat.js` documents that pnpm 11 revalidates the **whole lockfile** against it before any later mutation, recovering with `--config.minimum-release-age=0`. Practical consequence unchanged: "publish, then have the user install right now" does not hold on desktop; wait for the window or go through the app's own plugin page |
| UI and request path | Renderer runs on the custom scheme **`dsh-app://app`**, registered `standard/secure/supportFetchAPI/corsEnabled/stream`. The main process splits `dsh-app://app/*` into: the static front-end, `/plugins/**` (served with `cache-control: no-store`), everything else forwarded to `http://127.0.0.1:<random port>` | The main process **writes a rule specifically for `/plugins/`**, so plugin client bundles are a supported path on this chain — read out of the `app.asar` code. **rc.3 supplied the live proof, plus a catch**: the host now serves a bundle only at the URL its boot manifest advertises — `plugins/??dsh-voice-call/client.js&rev=ece8910da42d` — and fetching exactly that, with the host cookie, returns **200 / 70215 bytes / `text/javascript`** with our class names and all `/voice/*` paths inside. **The same path without `&rev=` is a 404**: `@deepseek-ai/dsh-client-modules`' `bundleResource()` looks `pathname + search` up in a pre-built table. We never hardcode that URL — the host composes it — so the plugin is unaffected, but the older doc line "one GET and it is 200" stopped being true and is corrected here. Our client uses only relative URLs (`fetch('/voice/…')`, `new EventSource('/voice/call/events')`), so the cards and both SSE channels land on that forwarding path with no hardcoded host to change |
| Measured: the server half is alive | **Desktop** (2026-10-17, direct GETs against the host port of the desktop app **while it was running**, `127.0.0.1:62998`): 200 on all three read endpoints — `/voice/call/state` reported `"tone":"marimba"`, `/voice/provision/state` reported `phase: ready`, `variantId: win-vulkan`, `引擎 v0.8.36`, and `/voice/provision/disk` reported the directory measurements, all read from the `desktop` profile. `GET /` on that same port returned **401** `dsh web authentication required`. That round ran the 0.2.1-rc.2 desktop runtime with `dsh-voice-call@0.3.11`. **npm** (2026-10-24, with the packed 0.3.13): the whole harness home moved into a scratch directory via `$DSH_HOME`, `npm i @deepseek-ai/dsh@0.2.1-rc.3` + `dsh plugin --profile web add <tarball>`, then boot — **no `skipping profile bundle` line**, `/voice/call/state` and `/voice/provision/state` both 200 (`tone: classic`, `phase: unprepared`, `variantId: win-cpu` — that scratch profile's own values), `GET /` 401, the advertised bundle URL 200/70215 bytes, and the headless profile stopping only at `MISSING_CREDENTIAL` | The plugin genuinely activates on both runtimes: routes, config, provisioning state and its client bundle. **This round has no desktop live probe** — when this was written `DeepSeek Harness.exe` was not in the process list, so the app was not running. The 2026-10-17 result still frames one thing worth stating: **the host's own paths demand the cookie, while routes a plugin registers are not behind that door** — any local process can read these read-only endpoints (card and provisioning state, no credentials, on a random loopback port). Our write branch takes the "allow" path there; the real interception is the shell's own two checks (origin, then host cookie) |

| Auth and the origin gate | The forwarder deletes `origin`, `sec-fetch-site`, `host` and `cookie` and sets its own host cookie; an `origin` header that is not `dsh-app://app` is 403ed by the shell. The WebSocket hook is stricter still: `origin !== "dsh-app://app"` → cancel | On desktop our routes receive a header-less local request, so our `Sec-Fetch-Site`/`Origin` gate takes the "not a browser" allow branch — the browser attack surface is closed one level up, and more firmly (private port, private cookie). That is a change in where the defence lives, not a hole in it; on CLI/browser deployments our gate remains the only barrier |
| Streaming | Scheme has `stream: true`; the forwarder documents "preserving streaming and cancellation", passes `body`/`signal` through and uses `redirect: manual` | Both SSE endpoints (`/voice/call/events`, `/voice/provision/events`) are on the supported path. In use that reads as: the card ticks live, the provisioning bar does not stall |
| Sandbox | `dsh-sandbox-policy` still offers `read-only / workspace-write / danger-full-access`, with `danger-full-access` meaning "the file sandbox does not restrict" | The local CrispASR call is unaffected; the trust boundary is the same one to evaluate as in a CLI deployment |
| Playback and recording | No `--autoplay-policy` override in the desktop main process; `installMicrophonePermissions(...)` is installed for the renderer | Chromium's autoplay rules therefore still apply inside Electron — when a ring is blocked the card says why and retries on the first click (added in 0.3.7). Recording stays macOS-only: `transcribe({record})` on the Windows desktop app reports unavailable explicitly |

**What still needs a click**: the settings card rendering inside Electron, the ringtone actually sounding, an accepted call playing the entire sentence, and the provisioning bar streaming updates. Those can only be confirmed in the running app (nothing hot-reloads — reload the plugin or restart it after an update). Everything at the dependency and request-path level is settled above; the remainder is on-screen audio and layout.
