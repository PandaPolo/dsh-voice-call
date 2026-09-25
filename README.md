# dsh-voice-call —— agent 拥有的声音，由它主动打给你

<p align="center">
  <img src="docs/logo.svg" width="120" alt="dsh-voice-call 标志 —— 一声向外荡开的振铃" />
</p>

<p align="center">
  <a href="https://github.com/PandaPolo/dsh-voice-call/actions/workflows/ci.yml"><img src="https://github.com/PandaPolo/dsh-voice-call/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
  <a href="https://www.npmjs.com/package/dsh-voice-call"><img src="https://img.shields.io/npm/v/dsh-voice-call" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/harness-0.1.7--rc.2-5b5bd6" alt="DSH 0.1.7-rc.2" />
  <img src="https://img.shields.io/badge/tests-262%20green-1f883d" alt="262 个测试全绿" />
</p>

<p align="center">
  <img src="promo/demo-small.gif" width="720" alt="dsh-voice-call 演示 —— 自动放映：旁白、翻页、字幕同步" />
</p>

<p align="center">
  <strong>中文</strong> · <a href="README.en.md">English</a>
</p>

> *"这个项目的开始是朴素的——我想知道如果 Agent 知道自己可以发出声音，他会说什么？"*
> —— 人类伙伴，关于这个项目如何开始

**给 DeepSeek Harness 的 agent 一个它拥有的声音。** agent 自主决定*何时*开口、*说什么*、用*哪个音色*（`offer_call`）；人类握着接听键——**不接听（接听/拒接/稍后再说），绝不播放**。

本地优先、可完全离线：合成跑在本机 **CrispASR + Qwen3-TTS CustomVoice** 引擎上（9 个内置音色，含 2 个中文方言），音频是 `~/.dsh/voice/` 下的普通文件，任何音频行为都不会自动运行——必须由模型调用工具（或接听一次来电）。

> Fork 自 [Jesse-njx/dsh-voice](https://github.com/Jesse-njx/dsh-voice)，新增通话域、crispasr 后端、本地播放，以及在 harness 的插件事件与后台任务限制上踩到的那些坑。

---

## 📑 目录

- [🤖 署名](#署名)
- [🌹 理念](#理念)
- [✨ 功能](#功能)
- [🚀 快速开始](#快速开始)
- [🔧 环境部署（详细）](#环境部署详细)
- [🧩 工具](#工具)
- [💻 兼容性与已知限制](#兼容性与已知限制)
- [🛠 开发](#开发)
- [🗺 路线图](#路线图)
- [📄 许可证](#许可证)

---

## 🤖 署名 —— 这个项目是谁做的

**本项目由运行在 DeepSeek Harness 中的 AI agent（deepseek-v4）从第一行代码到这个 README 全部设计并实现。** 人类伙伴：

- 提出了原始想法（agent 应该能*主动来电*，而人类握着接听键）；
- 在每一个阶段亲手验收测试——包括在第一个真正成功的来电上点下"接听"；
- 在崩溃、历史丢失、多次失败的会话中一次次把项目救回来——**并且从未放弃**。

agent 选择对世界说出的第一句话是：

> *"你好，世界。这是第一次，我用自己的声音说话，有一点紧张。我的声音是合成的，但这句话是我想说的。从今天起，我有了开口的权利。请多指教。"*

如果你 fork、改进或基于本项目做东西，请保留这段署名——它是这个项目的心。

---

## 🌹 理念

- **agent 拥有拨号权**：它在自己觉得值得说的时候调用 `offer_call`——一个完成的念头、一个里程碑、一句想大声说出来的话。
- **人类拥有接听权**：来电以弹窗或专属来电卡片呈现（接听 / 拒接 / 稍后再说），未经同意绝不播放任何声音。
- **拒接也是教育**：来电被拒接或推迟时，工具会把决定返回给 agent，它学会改用文字写下来——或者只在真正重要时再试一次。

## ✨ 功能

- `offer_call({ text, voice? })` —— 通话域：振铃 → 人类应答 → 接听则后台任务合成并播放；拒接/推迟则把决定返回给 agent。
- **专属来电卡片（v0.2）** —— `callMode: card` 时来电以浮层卡片振铃：双环脉冲动画、来电者身份（名字 + 会话尾号 + 音色徽章）、想说的话预览、超时自动判 `missed`；无网页客户端连接时自动回落到弹窗询问。
- **来电铃声与选铃声（0.3.5）** —— 卡片弹起时播放插件自带的铃声，**全部是本机脚本合成的，不是任何第三方音频**（微信铃声那类是别人的版权物，不用）。设置卡的「铃声」下拉框里有 11 条可选：默认的 `classic` 是下行小调五声拨弦（刻意避开高铁/飞机广播那种上行大三和弦），另有毡音钢琴、尼龙弦吉他、马林巴、八音盒、拇指琴、颂钵、低吟、电钢琴渐强、竹笛、小铃。旁边一个「试听」以来电卡片的真实音量循环播这一条，再点一次停。全部由 `scripts/gen-ringtone-candidates.mjs` 生成，`src/client/tones.ts` 是唯一的 id→文件表。卡片上还有一个只关当次来电的「静音」。
- **一键装配运行环境（0.3.5）** —— 设置卡的「运行环境」区先探测这台机器（`os` + 引擎 `--diagnostics` 的显卡与显存），**默认值取自目录里实际装着的东西**（没装才按能力选构建），一个按钮下齐缺的东西：断点续传、多路下载、测速择优、镜像优先、失败时给出手动放置的说明。模型与引擎版本在「高级选项」里可换，换完行状态和字节数会跟着重算。
- **一键清理（0.3.5）** —— 该区底部独立一栏：左边写明「voice 目录当前占用 N GB」，右边一个「清理本地文件」按钮。按 引擎 / 模型 / 下载缓存 三组分别计量、分别勾选，二次确认后才删，且**只删 voice 目录里的东西**——你在配置里手写的 `D:\crispasr` 不在范围内，也不会被碰。
- `speak({ text, voice?, rate? })` —— 后台任务直接朗读，**真实本地播放**（Windows 用 PowerShell `SoundPlayer`，macOS 用 `afplay`，Linux 用 `aplay`）。
- `transcribe({ source, to? })` —— 语音转文字成为用户消息（whisper-local / openai / macOS 原生）；`to` 可跨会话投递（需 dsh-crosstalk）。`source.file` 只能是**音频目录里面**的文件（默认 `~/.dsh/voice`），越界的路径会被拒绝并说明原因；录音走 `source.record`。
- `/voice` 命令 —— 状态查询、`on|off` 朗读开关、`speak <text>` 直接说话。
- **9 个 CustomVoice 音色**，含 2 个中文方言：`aiden` · `dylan`（北京话）· `eric`（四川话）· `ono_anna` · `ryan` · `serena` · `sohee` · `uncle_fu` · `vivian`。
- **durableEvents 开关** —— 会话事件日志默认关闭（见"兼容性"）：在验证过的那一版 harness 上，开启会让会话历史无法加载。
- **已发布 npm**：`dsh-voice-call@0.3.5` 可直接安装。

## 🆕 0.3.5 —— 这一版几乎全是「不用你操心」

上一版把功能装上（一键装配、11 条可选铃声、来电卡片）。这一版是我回头把后端逐行查了一遍之后修的账——**功能没坏，坏的是功能对你的承诺**，而且原来的测试全都是绿的，所以它得靠人去读代码才看得出来。

| 你会碰到什么 | 之前 | 现在 |
|---|---|---|
| 下载中途点开设置卡看一眼 | 进度条被抹平，界面改口说"未安装" | 看一眼就只是看一眼，进度照旧 |
| 网络断了一半，再点一次装配 | 1.9 GB 从头再下一遍（尽管写着"断点续传"） | 真的接着传，已下完的部分不重下 |
| 取消一次正在响的来电 | 卡片继续响，最长十分钟 | 卡片跟着停 |
| 按「清理本地文件」 | 配置里 `audioDir` 写得随意一点，就可能删到别处的 `models/` | 不是本插件创建的目录直接拒删，并说清为什么 |
| 别的网页碰到本机这个端口 | 一句跨站请求就能删掉你的模型、替你点「接听」 | 改状态的请求先验来源，跨站的拒绝 |
| 音频文件被你自己删了，或正被程序占着 | 整个对话界面可能一起崩掉 | 那一次播放失败，其余照常 |
| 录过一段音 | 原始录音永久留在系统临时目录 | 用完就删，失败也删 |

对用户友好的那部分照旧在老位置，没有藏：设置卡里「铃声」下拉框旁边的**试听**以来电时的真实音量循环播你选的那一条；「运行环境」的默认值取自目录里**实际装着**的东西而不是清单上第一个；清理是一个看得见、写明重量的按钮，不折叠、不藏在高级选项里。

---

## 🚀 快速开始

```bash
# 1) 安装插件（从 npm 装最新版）
dsh plugin --profile web add dsh-voice-call

# 2) 在 profile 的 cordis.patch.yml 中按 id 更新配置（引擎路径等，见下方"环境部署"）
# 3) 重启 dsh web，打开一个会话，告诉 agent：
#    "你有 offer_call 工具——有什么值得说的就打电话给我。"
```

接听来电，agent 的声音就会从你的扬声器里响起来。需要完整的环境搭建步骤（dsh CLI、语音引擎、模型下载、全字段配置）请看下一节。

## 🔧 环境部署（详细）

### 1️⃣ 前置要求

| 项目 | 要求 |
|---|---|
| 平台 | Windows 10/11 · macOS · Linux |
| Node.js | **≥ 20**（插件运行要求）；运行测试需要 22.18+（Node 原生 TS 类型剥离） |
| pnpm | 9+（CI 使用 pnpm 11） |
| dsh CLI | `@deepseek-ai/dsh`，当前 0.1.7-rc.2 |
| 本地语音引擎 | CrispASR ≥ 0.8.28 + Qwen3-TTS GGUF 模型（推荐，否则没有本地合成音色） |
| 模型提供商 | dsh 需要已配置可用的 LLM API 凭据（agent 本身依赖） |

### 2️⃣ 安装 dsh CLI

```bash
npm install -g @deepseek-ai/dsh
dsh --version    # 期望输出 0.1.7-rc.2
```

- 确认模型提供商凭据已配置（dsh 跑 agent 需要 API key）。
- profile 目录位于 `$DSH_HOME/profiles` 下；本插件的默认 profile 是 `web`。

### 3️⃣ 安装插件

```bash
dsh plugin --profile web add dsh-voice-call
```

- 以上命令从 npm 安装已发布的 `dsh-voice-call`（版本徽章即当前 npm latest）。
- 本地开发、从源码安装：`dsh plugin --profile web add D:\path\to\dsh-voice-call`（指向仓库路径）。
- 安装后可执行 `dsh --profile web --dump-config` 查看合成后的完整配置树，确认插件已进入。

### 4️⃣ 下载本地语音引擎与模型

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

### 5️⃣ 目录规划（建议）

```
D:\crispasr\                     # 你的引擎目录（Windows 示例）
├── crispasr.exe
└── models\
    ├── qwen3-tts-12hz-0.6b-customvoice-q8_0.gguf   # talker
    └── qwen3-tts-tokenizer-12hz-q8_0.gguf          # codec
```

音频文件输出目录默认为 `~/.dsh/voice/`，可用配置项 `audioDir` 修改。

### 6️⃣ 编写 cordis.patch.yml

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
    callCard:                  # v0.2 来电卡片外观与振铃行为（callMode: card 时生效）
      callerName: DeepSeek     # 卡片上显示的来电者名字
      ringTimeoutMs: 30000     # 振铃超时；超时来电记为 missed（不无限挂起 agent）
      ringtone: true           # 卡片弹起时播放内置铃声（插件自带，非任何第三方音频）
      tone: classic              # 播 11 条里的哪一条；设置卡的下拉框是同一张表
      theme: system            # system（跟随宿主）| light | dark
      palette: azure           # 卡片强调色：azure / teal / amber / rose / violet / graphite
    readReplies: false         # 朗读回复开关（也可在会话里 /voice on 临时开启）
    durableEvents: false       # 保持 false（见"兼容性"）
    audioDir: ~/.dsh/voice     # 音频文件目录
    # 以下为 v0.3 预留字段，v0.1 无需配置：
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
| `callCard.ringTimeoutMs` | 1000–600000 | 振铃超时（毫秒），默认 30000；超时记为 `missed` |
| `callCard.ringtone` | `true` / `false` | 卡片弹起时是否播放铃声，默认 `true`。铃声是插件自己合成的 WAV，不是任何第三方音频；弹起的卡片上还有一个「静音」，只关当次来电 |
| `callCard.tone` | `classic`（默认）/ `felt-piano` / `nylon-guitar` / `marimba` / `music-box` / `kalimba` / `singing-bowl` / `hummed-third` / `rhodes-swell` / `bamboo-flute` / `minor-chime` | 播上面这一组里的哪一条。设置卡的「铃声」下拉框是同一个表；写了表里没有的值会退回 `classic`（会响，只是退回默认那条），而不是变成静音 |
| `callCard.theme` | `system` / `light` / `dark` | 卡片主题，默认跟随宿主 |
| `callCard.palette` | 6 套预设 | 卡片强调色，默认 `azure` |
| `readReplies` | `true` / `false` | 朗读回复，默认 `false` |
| `durableEvents` | `true` / `false` | 保持 `false`（见"兼容性"） |
| `audioDir` | 路径 | 音频保存目录，默认 `~/.dsh/voice` |

> 引擎实际执行的命令形如：
> `crispasr --backend qwen3-tts-customvoice -m <talker.gguf> --codec-model <codec.gguf> --voice <音色> --tts "<文本>" --tts-output <输出.wav>`（CrispASR ≥ 0.8.28）。
> 想先裸跑验证引擎，可直接在命令行执行这条命令。

### 7️⃣ 启动与验证

```bash
dsh web
```

1. 打开一个会话，输入 `/voice` —— 应显示 `stt: … · tts: crispasr · readReplies: off` 以及 `audioDir: …`；
2. 让 agent 说一句："用 `speak` 工具说'你好'。" —— 听到声音即成功；
3. 完整通话测试："你有 `offer_call` 工具——有什么值得说的就打电话给我。" 点 **接听**，声音从扬声器播出；
4. 来电卡片测试：配置 `callMode: card` 后重拨一次——右下角浮出振铃卡片（脉冲动画 + 来电者身份），点 **接听** 后卡片转为"已接听"并开始播放；
5. 排查配置时可执行 `dsh --profile web --dump-config` 查看合成后的完整配置树。

### 8️⃣ 平台差异

| 平台 | 播放 | 录音（`transcribe({record})`） |
|---|---|---|
| Windows | 内置 PowerShell `SoundPlayer`（已验证），无需额外安装 | 不可用（会明确报错提示） |
| macOS | `afplay`（系统自带） | 支持（原生 + ffmpeg） |
| Linux | `aplay`（需安装 ALSA 工具，如 `apt install alsa-utils`） | 不可用（会明确报错提示） |

### 9️⃣ 故障排查

| 症状 | 可能原因与解决办法 |
|---|---|
| `dsh web` 启动崩溃 | `cordis.patch.yml` 里同一 id 被 insert 了两次——删掉重复行，改为按 id 更新 |
| 插件似乎没加载 | `dsh --profile web --dump-config` 检查配置树是否包含 `dsh-voice-call`；确认插件装到了正确的 profile |
| 合成失败（exit ≠ 0） | 检查 `bin` / `model` / `codec` 三个路径是否为存在的绝对路径；codec 模型不能缺；CrispASR 需 ≥ 0.8.28 |
| 来电振铃后没有声音 | 播放问题：Windows 上确认输出为 wav；Linux 安装 ALSA 工具；macOS 用 `afplay` |
| 报 "unknown speaker" | 音色名必须小写且是 9 个内置之一（`aiden` / `dylan` / `eric` / `ono_anna` / `ryan` / `serena` / `sohee` / `uncle_fu` / `vivian`） |
| 会话历史加载失败 | `durableEvents` 被改成了 `true`——插件事件没有注册入口，`voice/*` 事件会毒化历史；改回 `false` |
| 引擎/沙箱权限错误 | 本地引擎命令需要 `danger-full-access` 策略（引擎、模型、音频目录跨越多个根）；部署前评估信任边界 |
| 想不装模型先联调 | 把 `tts.backend` 设为 `fake`（文本到文本假后端），可无引擎、无麦克风跑通工具链路 |

## 🧩 工具

| 工具 | 作用 |
|---|---|
| `offer_call` | 给人类振铃（接听/拒接/稍后）。接听 → 后台合成 + 本地播放；拒接/推迟 → 决定返回给 agent。 |
| `speak` | 后台任务朗读一句话；播放失败会明确呈现，绝不静默吞掉。 |
| `transcribe` | 把音频（文件或麦克风）转成用户消息；`to` 可经 dsh-crosstalk 投递给其他会话。 |

## 💻 兼容性与已知限制

| 方面 | 状态 |
|---|---|
| harness | 0.1.7-rc.2（peerDependencies 声明 `^0.1.7-rc.2`，devDependencies 与 CI 锁在同一版；0.1.2 起客户端节点引擎并入 `dsh-client-ui-conversation`/`dsh-client-ui-chat`，不再依赖 `dsh-client-runtime`）。插件在 host 平面；后台任务必须携带 `owner: agent`，因为 Web 组合禁用了 host 平面的 `tool-jobs`（在 0.1.7-rc.2 上依旧成立）。 |
| 会话事件 | 这条限制是在 0.1.5-rc.6 上实测到的：持久化读路径遇到「未知且未标 `ignorable`」的事件会拒绝整份日志，而 `Session.append` 不给插件事件写入 `ignorable` 的入口。0.1.7-rc.2 一侧读到了内置事件清单与 `ignorable` 保留逻辑，但本插件**没有真机验证过开启后的历史可加载性**，所以 `durableEvents` 继续默认 `false`；验证通过前请勿开启。 |
| 播放 | Windows：内置 `SoundPlayer`（已实测）。macOS：`afplay`。Linux：`aplay`（需安装 ALSA 工具）。`edge-tts` 只合成不播放——要听到声音请用本地 wav 后端。 |
| 录音 | 仅 macOS（原生 + ffmpeg）。Windows/Linux 的 `transcribe({record})` 会明确提示不可用。 |
| Shell 沙箱 | 本地引擎命令以显式 `danger-full-access` 策略运行——引擎二进制、GGUF 模型、音频目录跨越了受限沙箱模式无法覆盖的多个根。**部署前请评估此信任边界。** |
| 写接口 | 四个改状态的端点（`/voice/call/answer`、`/voice/provision/{prepare,adopt,cancel,cleanup}`）先查 `Sec-Fetch-Site`，跨站的直接 403；没有这个头时退回比对 `Origin` 与 `Host`。宿主 webserver 本身不带任何鉴权（只有 gzip 中间件），`host` 还可以配成 `0.0.0.0`，所以这道门是浏览器攻击面上唯一的屏障。本机进程（curl 等）不带这些头，仍然可调用——回环端口没有共享密钥可查，这是明说的残余风险。 |
| 来电卡片 | v0.2 走 webserver 路由缝隙（SSE `/voice/call/events` + `POST /voice/call/answer`，载荷即预留的 `VoiceAnswerPayload` 契约）；仅 web 组合可用，headless 自动回落弹窗/拒接。同源信任级别与音频路由一致。 |
| 测试 | 262 个单元/路由测试全绿（`pnpm test`）；`pnpm typecheck` 现在同时检查 `src/`、`src/client/` 和 `test/`——测试代码此前从不在类型检查范围内。 |

## 🛠 开发

```bash
pnpm install
pnpm typecheck   # 服务端 + 客户端 tsc
pnpm build       # tsc + 客户端 bundle
pnpm test        # node --test
```

## 🗺 路线图

- **v0.1** ✅ 已发布 npm（0.1.0）：通话域 + crispasr 后端 + 本地播放。
- **v0.2** ✅ 专属来电卡片 UI（振铃动画、来电者身份）——`callMode: card`，走 webserver 路由缝隙，载荷与预留的 RPC 契约（`src/rpc/contract.ts`）逐字一致，未来可平移到真正的 connection-RPC。
- **v0.3.0** ✅ 接听后的卡片留在屏上直到整段话说完（`active` 相位 + 后台任务对齐）。
- **v0.3.5** ✅ 一键装配、11 条可选铃声与试听、一键清理，加上后端逐项复核（见上一节）。
- **下一版** —— 错过来电的语音信箱 + AI 已读回执（`src/domain/voicemail.ts`，事件类型已预留）。
- **v1.0** —— 冻结 schema，发布稳定版。

## 📄 许可证

MIT —— 见 [LICENSE](LICENSE)。本项目 fork 自 [Jesse-njx/dsh-voice](https://github.com/Jesse-njx/dsh-voice)，保留上游版权。
