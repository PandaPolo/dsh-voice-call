# 环境部署（详细）

> 从 [README](../README.md) 搬出来的完整手册：首页只留三行安装，这里是从零装到能听见声音的全过程。
> 装配机制本身（探测、下载器、镜像与断点续传、清理）见 [provisioning.md](provisioning.md)。

## 1️⃣ 前置要求

| 项目 | 要求 |
|---|---|
| 平台 | Windows 10/11 · macOS · Linux |
| Node.js | **≥ 20**（插件运行要求）；运行测试需要 22.18+（Node 原生 TS 类型剥离） |
| pnpm | 9+（CI 使用 pnpm 11） |
| dsh CLI | `@deepseek-ai/dsh`，当前 0.1.7-rc.2 |
| 本地语音引擎 | CrispASR ≥ 0.8.28 + Qwen3-TTS GGUF 模型（推荐，否则没有本地合成音色） |
| 模型提供商 | dsh 需要已配置可用的 LLM API 凭据（agent 本身依赖） |

## 2️⃣ 安装 dsh CLI

```bash
npm install -g @deepseek-ai/dsh
dsh --version    # 期望输出 0.1.7-rc.2
```

- 确认模型提供商凭据已配置（dsh 跑 agent 需要 API key）。
- profile 目录位于 `$DSH_HOME/profiles` 下；本插件的默认 profile 是 `web`。

## 3️⃣ 安装插件

```bash
dsh plugin --profile web add dsh-voice-call
```

- 以上命令从 npm 安装已发布的 `dsh-voice-call`（版本徽章即当前 npm latest）。
- 本地开发、从源码安装：`dsh plugin --profile web add D:\path\to\dsh-voice-call`（指向仓库路径）。
- 安装后可执行 `dsh --profile web --dump-config` 查看合成后的完整配置树，确认插件已进入。

> **第 4、5 步可以跳过。** 装好插件、`callMode` 之类的基本项写进配置之后，剩下的引擎与模型不必手动下载：打开 DSH 的插件设置页，「运行环境」区里那一个按钮会探测这台机器并把缺的东西装齐（断点续传、多路并行、多源测速择优、镜像优先）。下面两步是**手动路径**——你想自己控制版本、或者一键装配所在的网络不通时用。

## 4️⃣ 下载本地语音引擎与模型（手动路径）

**① CrispASR 引擎**（v0.8.28+，[GitHub Releases](https://github.com/CrispStrobe/CrispASR/releases)）：

| 平台 | 下载 |
|---|---|
| Windows | `crispasr-windows-x86_64-cpu.zip`（有 NVIDIA 独显可选 `-cuda`，核显可选 `-vulkan` 版） |
| macOS | `crispasr-macos.tar.gz` |
| Linux | `crispasr-linux-x86_64.tar.gz` |

**② Qwen3-TTS 模型**（HuggingFace，`cstr` 组织出品）：

| 文件 | 仓库 | 作用 |
|---|---|---|
| `qwen3-tts-12hz-0.6b-customvoice-q8_0.gguf` | [cstr/qwen3-tts-0.6b-customvoice-GGUF](https://huggingface.co/cstr/qwen3-tts-0.6b-customvoice-GGUF) | talker 模型（音色本体） |
| `qwen3-tts-tokenizer-12hz-q8_0.gguf` | [cstr/qwen3-tts-tokenizer-12hz-GGUF](https://huggingface.co/cstr/qwen3-tts-tokenizer-12hz-GGUF) | codec 模型（语音编码器，**不能缺**） |

解压引擎后先手动运行一次确认能启动（例如命令行执行 `crispasr --help` 应打印用法）。

## 5️⃣ 目录规划（建议）

```
D:\crispasr\                     # 你的引擎目录（Windows 示例）
├── crispasr.exe
└── models\
    ├── qwen3-tts-12hz-0.6b-customvoice-q8_0.gguf   # talker
    └── qwen3-tts-tokenizer-12hz-q8_0.gguf          # codec
```

音频文件输出目录默认为 `~/.dsh/voice/`，可用配置项 `audioDir` 修改。

## 6️⃣ 编写 cordis.patch.yml

在 profile 目录找到（或创建）`cordis.patch.yml`。**按 `id` 更新 `dsh-voice-call` 这一行——绝不重复 insert**（同一 id 插入两次会导致启动崩溃）。

完整示例（Windows）：

```yaml
- id: dsh-voice-call
  config:
    stt: {}                    # 语音转文字：留空 = 自动探测（whisper-local / macos / fake）
    tts:
      backend: crispasr        # 本地神经 TTS 引擎（推荐）
      voice: dylan             # 默认音色；crispasr 下用内置 9 音色之一
      # rate: 180             # 语速（词/分钟，1–600；设置卡上是 慢/中/快 三档）
      crispasr:
        bin: D:\crispasr\crispasr.exe                          # 引擎可执行文件（绝对路径）
        model: D:\crispasr\models\qwen3-tts-12hz-0.6b-customvoice-q8_0.gguf
        codec: D:\crispasr\models\qwen3-tts-tokenizer-12hz-q8_0.gguf
    callMode: card             # card（专属来电卡片）| ask（弹窗询问）| direct（直接接听）| off（拒绝来电）
    callCard:                  # 来电卡片外观与振铃行为（callMode: card 时生效）
      callerName: DeepSeek     # 卡片上显示的来电者名字
      ringTimeoutMs: 30000     # 铃声持续时间；超时来电记为 missed（不无限挂起 agent）
      ringtone: true           # 卡片弹起时播放内置铃声（插件自带，非任何第三方音频）
      tone: classic            # 播 11 条里的哪一条；设置卡的下拉框是同一张表
      theme: system            # system（跟随宿主）| light | dark
      palette: azure           # 卡片强调色：azure / teal / amber / rose / violet / graphite
    readReplies: false         # 朗读回复开关（也可在会话里 /voice on 临时开启）
    durableEvents: false       # 保持 false（见 README 的"兼容性"）
    audioDir: ~/.dsh/voice     # 音频文件目录
    experimental:              # 实验性功能，默认全关
      nudgeWaitingQuestions: false   # 问题超时没人答就弹来电卡片提醒（默认关）
      nudgeAfterMinutes: 5           # 等多久算「卡住了」，1–30 分钟
    # 预留字段，无需配置：
    # voicemail: { enabled: false }
    # readReceipts: { enabled: false }
```

配置字段速查：

| 字段 | 取值 | 说明 |
|---|---|---|
| `tts.backend` | `say` / `piper` / `edge-tts` / `fake` / `crispasr` | 合成后端；`crispasr` 为本地神经 TTS（推荐）；`edge-tts` 只合成不播放；`fake` 用于无模型联调 |
| `tts.voice` | 音色名 | crispasr 下用内置 9 音色之一，如 `dylan` |
| `tts.rate` | 1–600 | 语速（词/分钟）。设置卡上只给 慢 150 / 中 180 / 快 220 三档；数字留给直接改配置的人 |
| `tts.crispasr` | `bin` / `model` / `codec` | 引擎与两个 GGUF 模型的**绝对路径** |
| `stt.backend` | `whisper-local` / `openai` / `macos` / `fake` | 留空自动探测 |
| `callMode` | `card` / `ask` / `direct` / `off` | 来电方式：专属卡片 / 弹窗询问 / 直接接听 / 关闭 |
| `callCard.callerName` | 任意名字 | 来电卡片显示的来电者名字，默认 `DeepSeek` |
| `callCard.ringTimeoutMs` | 1000–600000 | 铃声持续时间（毫秒），默认 30000；超时记为 `missed` |
| `callCard.ringtone` | `true` / `false` | 卡片弹起时是否播放铃声，默认 `true`。铃声是插件自己合成的 WAV，不是任何第三方音频；弹起的卡片上还有一个「静音」，只关当次来电 |
| `callCard.tone` | `classic`（默认）/ `felt-piano` / `nylon-guitar` / `marimba` / `music-box` / `kalimba` / `singing-bowl` / `hummed-third` / `rhodes-swell` / `bamboo-flute` / `minor-chime` | 播上面这一组里的哪一条。设置卡的「铃声」下拉框是同一个表；写了表里没有的值会退回 `classic`（会响，只是退回默认那条），而不是变成静音 |
| `callCard.theme` | `system` / `light` / `dark` | 卡片主题，默认跟随宿主 |
| `callCard.palette` | 6 套预设 | 卡片强调色，默认 `azure` |
| `readReplies` | `true` / `false` | 朗读回复，默认 `false` |
| `experimental.nudgeWaitingQuestions` | `true` / `false` | **实验性**，默认 `false`。开启后，agent 的问题超过 `nudgeAfterMinutes` 没人回答就会弹一张来电卡片提醒（按接听念一句，念完自动退；永不替你回答） |
| `experimental.nudgeAfterMinutes` | 1–30 | 等多久算「卡住了」，默认 5 分钟 |
| `durableEvents` | `true` / `false` | 保持 `false`（见 README 的"兼容性"） |
| `audioDir` | 路径 | 音频保存目录，默认 `~/.dsh/voice` |

> 引擎实际执行的命令形如：
> `crispasr --backend qwen3-tts-customvoice -m <talker.gguf> --codec-model <codec.gguf> --voice <音色> --tts "<文本>" --tts-output <输出.wav>`（CrispASR ≥ 0.8.28）。
> 想先裸跑验证引擎，可直接在命令行执行这条命令。

## 7️⃣ 启动与验证

```bash
dsh web
```

1. 打开一个会话，输入 `/voice` —— 应显示 `stt: … · tts: crispasr · readReplies: off` 以及 `audioDir: …`；
2. 让 agent 说一句："用 `speak` 工具说'你好'。" —— 听到声音即成功；
3. 完整通话测试："你有 `offer_call` 工具——有什么值得说的就打电话给我。" 点 **接听**，声音从扬声器播出；
4. 来电卡片测试：配置 `callMode: card` 后重拨一次——右下角浮出振铃卡片（脉冲动画 + 来电者身份），点 **接听** 后卡片转为"已接听"并开始播放；
5. 排查配置时可执行 `dsh --profile web --dump-config` 查看合成后的完整配置树。

## 8️⃣ 平台差异

| 平台 | 播放 | 录音（`transcribe({record})`） |
|---|---|---|
| Windows | 内置 PowerShell `SoundPlayer`（已验证），无需额外安装 | 不可用（会明确报错提示） |
| macOS | `afplay`（系统自带） | 支持（原生 + ffmpeg） |
| Linux | `aplay`（需安装 ALSA 工具，如 `apt install alsa-utils`） | 不可用（会明确报错提示） |

## 9️⃣ 故障排查

| 症状 | 可能原因与解决办法 |
|---|---|
| `dsh web` 启动崩溃 | `cordis.patch.yml` 里同一 id 被 insert 了两次——删掉重复行，改为按 id 更新 |
| 插件似乎没加载 | `dsh --profile web --dump-config` 检查配置树是否包含 `dsh-voice-call`；确认插件装到了正确的 profile |
| 插件显示"异常"、完全不激活 | 配置 schema 被写坏了（例如给一个已经 `volatile` 的对象再套 `volatile`）——宿主会在启动时打印 `ValidationError`，看那一行指出的是哪个字段 |
| 合成失败（exit ≠ 0） | 检查 `bin` / `model` / `codec` 三个路径是否为存在的绝对路径；codec 模型不能缺；CrispASR 需 ≥ 0.8.28 |
| 来电振铃后没有声音 | 先看卡片有没有写明「浏览器拦住了铃声」——那是浏览器的自动播放策略，点一下页面就会响；否则是播放问题：Windows 确认输出为 wav，Linux 安装 ALSA 工具，macOS 用 `afplay` |
| 报 "unknown speaker" | 音色名必须小写且是 9 个内置之一（`aiden` / `dylan` / `eric` / `ono_anna` / `ryan` / `serena` / `sohee` / `uncle_fu` / `vivian`） |
| 会话历史加载失败 | `durableEvents` 被改成了 `true`——插件事件没有注册入口，`voice/*` 事件会毒化历史；改回 `false` |
| 引擎/沙箱权限错误 | 本地引擎命令需要 `danger-full-access` 策略（引擎、模型、音频目录跨越多个根）；部署前评估信任边界 |
| 想不装模型先联调 | 把 `tts.backend` 设为 `fake`（文本到文本假后端），可无引擎、无麦克风跑通工具链路 |

## 🔒 兼容性与已知限制（全文）

首页那四条是这一节的摘要；这里是逐项原文。

| 方面 | 状态 |
|---|---|
| harness | 0.1.7-rc.2（peerDependencies 声明 `^0.1.7-rc.2`，devDependencies 与 CI 锁在同一版；0.1.2 起客户端节点引擎并入 `dsh-client-ui-conversation`/`dsh-client-ui-chat`，不再依赖 `dsh-client-runtime`）。插件在 host 平面；后台任务必须携带 `owner: agent`，因为 Web 组合禁用了 host 平面的 `tool-jobs`（在 0.1.7-rc.2 上依旧成立）。 |
| 会话事件 | 这条限制是在 0.1.5-rc.6 上实测到的：持久化读路径遇到「未知且未标 `ignorable`」的事件会拒绝整份日志，而 `Session.append` 不给插件事件写入 `ignorable` 的入口。0.1.7-rc.2 一侧读到了内置事件清单与 `ignorable` 保留逻辑，但本插件**没有真机验证过开启后的历史可加载性**，所以 `durableEvents` 继续默认 `false`；验证通过前请勿开启。 |
| 播放 | Windows：内置 `SoundPlayer`（已实测）。macOS：`afplay`。Linux：`aplay`（需安装 ALSA 工具）。`edge-tts` 只合成不播放——要听到声音请用本地 wav 后端。 |
| 录音 | 仅 macOS（原生 + ffmpeg）。Windows/Linux 的 `transcribe({record})` 会明确提示不可用。 |
| Shell 沙箱 | 本地引擎命令以显式 `danger-full-access` 策略运行——引擎二进制、GGUF 模型、音频目录跨越了受限沙箱模式无法覆盖的多个根。**部署前请评估此信任边界。** |
| 写接口 | 五个改状态的端点（`/voice/call/answer`、`/voice/provision/{prepare,adopt,cancel,cleanup}`）先查 `Sec-Fetch-Site`，跨站的直接 403；没有这个头时退回比对 `Origin` 与 `Host`。宿主 webserver 本身不带任何鉴权（只有 gzip 中间件），`host` 还可以配成 `0.0.0.0`，所以这道门是浏览器攻击面上唯一的屏障。本机进程（curl 等）不带这些头，仍然可调用——回环端口没有共享密钥可查，这是明说的残余风险。 |
| 来电卡片 | 走 webserver 路由缝隙（SSE `/voice/call/events` + `POST /voice/call/answer`，载荷即预留的 `VoiceAnswerPayload` 契约）；仅 web 组合可用，headless 自动回落弹窗/拒接。同源信任级别与音频路由一致。应答处理里插件抛出的异常被围栏在路由内（回 5xx 带原因），不会变成进程级未捕获异常——0.3.7 补的。 |
| 测试 | 284 个单元/路由测试在 Linux / Windows / macOS 上全绿（`pnpm test`，CI 三平台矩阵）；`pnpm typecheck` 同时检查 `src/`、`src/client/` 和 `test/`——测试代码此前从不在类型检查范围内。插件自己的配置 schema 也走一遍宿主的校验入口。 |