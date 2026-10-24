# 环境部署（详细）

> 从 [README](../README.md) 搬出来的完整手册：首页只留三行安装，这里是从零装到能听见声音的全过程。
> 装配机制本身（探测、下载器、镜像与断点续传、清理）见 [provisioning.md](provisioning.md)。

## 1️⃣ 前置要求

| 项目 | 要求 |
|---|---|
| 平台 | Windows 10/11 · macOS · Linux |
| Node.js | **≥ 20**（插件运行要求）；运行测试需要 22.18+（Node 原生 TS 类型剥离） |
| pnpm | 9+（CI 使用 pnpm 11） |
| DSH（桌面版） | 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-rc.2 / 0.2.1-rc.3（桌面版当前带的就是 0.2.1-rc.3；npm 的 `latest` 是 0.2.1-rc.2，`next` 才是 0.2.1-rc.3） |
| 本地语音引擎 | CrispASR ≥ 0.8.28 + Qwen3-TTS GGUF 模型（推荐，否则没有本地合成音色） |
| 模型提供商 | dsh 需要已配置可用的 LLM API 凭据（agent 本身依赖） |

## 2️⃣ 安装（桌面版）

1. 打开 **DeepSeek Harness 桌面版** → 「插件」页面（设置里的插件管理）。
2. 在插件市场搜索 `dsh-voice-call` 并安装；装好后在同一页让它生效（本插件不热加载）。
3. 首次使用在插件自己的设置页里配置。

> 旧版的命令行安装（`npm install -g @deepseek-ai/dsh`，然后 `dsh plugin --profile web add <包名>`）随全局 CLI 一起退役了——本机已卸载全局 DSH，插件管理请走桌面版界面。

- 确认模型提供商凭据已配置（桌面版跑 agent 需要 API key）。
- 插件数据位于 `$DSH_HOME` 下（本机为 `C:\Users\Juser\.dsh`）。

## 3️⃣ 安装插件

在桌面版的**插件页面**里安装：

- 从插件市场搜索并安装已发布的 `dsh-voice-call`（版本徽章即当前 npm latest）。
- 本地开发、从源码安装：在插件页面里用本地路径 / GitHub spec 安装（指向仓库路径）。
- 装好后在插件页面里重载该插件，或重启桌面版，让它生效。

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
    callMode: card             # 默认 card（专属来电卡片）| ask（弹窗询问）| direct（直接接听）| off（拒绝来电）
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
| `callMode` | `card` / `ask` / `direct` / `off` | 来电方式，**默认 `card`**（专属卡片；无卡片客户端连着时自动退回弹窗询问） |
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

打开 **DeepSeek Harness 桌面版**，插件的功能就在它的界面里生效（来电卡片浮在右下角）。

1. 打开一个会话，输入 `/voice` —— 应显示 `stt: … · tts: crispasr · readReplies: off` 以及 `audioDir: …`；
2. 让 agent 说一句："用 `speak` 工具说'你好'。" —— 听到声音即成功；
3. 完整通话测试："你有 `offer_call` 工具——有什么值得说的就打电话给我。" 点 **接听**，声音从扬声器播出；
4. 来电卡片测试：**默认就是卡片**，第 3 步浮出的即右下角振铃卡片（脉冲动画 + 来电者身份）；想确认弹窗那条通路，把 `callMode` 设为 `ask` 再拨一次，设成 `card` 而此刻没有卡片客户端连着，则自动回落弹窗——不会把这通电话变成"没人能接"。
5. 排查配置时看 `~/.dsh/profiles/desktop/`（桌面版）或 `~/.dsh/profiles/web/`（CLI）里的 `package.json` 与 `cordis.patch.yml`；要合成后的完整配置树，可临时装一个全局 CLI 跑 `dsh --profile desktop --dump-config`。

## 8️⃣ 平台差异

| 平台 | 播放 | 录音（`transcribe({record})`） |
|---|---|---|
| Windows | 内置 PowerShell `SoundPlayer`（已验证），无需额外安装 | 不可用（会明确报错提示） |
| macOS | `afplay`（系统自带） | 支持（原生 + ffmpeg） |
| Linux | `aplay`（需安装 ALSA 工具，如 `apt install alsa-utils`） | 不可用（会明确报错提示） |

## 9️⃣ 故障排查

| 症状 | 可能原因与解决办法 |
|---|---|
| 桌面版启动崩溃 | `cordis.patch.yml` 里同一 id 被 insert 了两次——删掉重复行，改为按 id 更新 |
| 插件似乎没加载 | 先看桌面版「插件」页里 dsh-voice-call 有没有设置项——没有基本就是宿主跳过了它。再核对 `~/.dsh/profiles/desktop/package.json`：`dependencies` 里的版本对不对、`dsh.profile.bundles` 里有没有 `dsh-voice-call`。插件不热加载，改完要重载插件或重启桌面版 |
| 升级 dsh / 桌面版之后插件整个不见了（工具、设置卡、来电卡片一起没了） | 0.2.0-rc.1 起宿主按 `peerDependencies` 决定加载还是跳过，判定不通过就整块 bundle 不加载。桌面版是 GUI，那行 `skipping profile bundle "dsh-voice-call": … is incompatible with dsh <版本>` 不会弹给你看——症状就是插件凭空消失。先更到声明了该基线的插件版本（0.3.11 / 0.3.12 / 0.3.13 的 peer 声明一字未改，覆盖 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-rc.2 / 0.2.1-rc.3）；急用时插件管理页能给"某个插件版本 + 某个运行时版本"发一张精确豁免（对应 CLI 的 `dsh plugin allow-version`），但那是明知未验证仍要跑。想拿到那行原文，可以临时装一个全局 CLI：`dsh --profile desktop --dump-config` 的头几行就是宿主的判定输出。还有一类消失与版本无关：桌面版 profile 的 pnpm 发布龄期会把刚发出来的版本挡在门外（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`），这时 profile 里留下的还是旧版本——旧版本如果没声明新基线，就同时中了上面两条 |
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
| harness | 同时支持 **0.1.7-rc.2、0.2.0-rc.1、0.2.0-rc.2、0.2.1-rc.2、0.2.1-rc.3**：peerDependencies 声明 `^0.1.7-rc.2 \|\| ^0.2.0-rc.1`（后一条覆盖整段 0.2.x），devDependencies 与 CI 锁在 0.2.1-rc.3（cordis 4.0.5、schemastery 3.18.5）。0.1.2 起客户端节点引擎并入 `dsh-client-ui-conversation`/`dsh-client-ui-chat`，不再依赖 `dsh-client-runtime`。**从 0.2.0-rc.1 起这份声明是加载判定**：宿主用 `evaluatePluginCompatibility`（`@deepseek-ai/dsh-app-boot`，semver `includePrerelease`）逐个检查 `@deepseek-ai/dsh*` 的 peer 范围，只要有一个不含正在运行的版本，整个 bundle 被跳过——启动时打一行 `dsh: skipping profile bundle "<id>"`，工具、路由、客户端节点全都不在。0.3.7 就是这样在 0.2.0-rc.1 上消失的。**0.2.1-rc.2 改了两处**：返回结构里 `peers` 改名 `requirements`；清单若自带 `engines.dsh`，宿主**只看那一条**、`peerDependencies` 完全不参与。**0.2.1-rc.3 这一版没再动**——那份判定文件在 rc.2 与 rc.3 的桌面 asar 里字节相同（203572 字节）。我们故意不写 `engines.dsh`——20 条 peer 全部生效，才是"代码摸到的每个 harness 包都被声明过"这条守卫还有效的前提，两种走法都由 `test/harness-compat.test.ts` 钉着，连"`engines.dsh` 会把 peer 判定闭嘴"也有一条负控（把 `dsh-tools` 冻在旧区间：不写 engines.dsh 就被宿主拒绝，写上就放行）。插件在 host 平面；后台任务必须携带 `owner: agent`，因为 Web 组合禁用了 host 平面的 `tool-jobs`（各基线上都成立）。桌面版逐条核对见下面「桌面版兼容性（全文）」。 |
| 会话事件 | 这条限制是在 0.1.5-rc.6 上实测到的：持久化读路径遇到「未知且未标 `ignorable`」的事件会拒绝整份日志，而 `Session.append` 不给插件事件写入 `ignorable` 的入口。0.1.7-rc.2 一侧读到了内置事件清单与 `ignorable` 保留逻辑，但本插件**没有真机验证过开启后的历史可加载性**，所以 `durableEvents` 继续默认 `false`；验证通过前请勿开启。 |
| 播放 | Windows：内置 `SoundPlayer`（已实测）。macOS：`afplay`。Linux：`aplay`（需安装 ALSA 工具）。`edge-tts` 只合成不播放——要听到声音请用本地 wav 后端。 |
| 录音 | 仅 macOS（原生 + ffmpeg）。Windows/Linux 的 `transcribe({record})` 会明确提示不可用。 |
| Shell 沙箱 | 本地引擎命令以显式 `danger-full-access` 策略运行——引擎二进制、GGUF 模型、音频目录跨越了受限沙箱模式无法覆盖的多个根。**部署前请评估此信任边界。** |
| 写接口 | 五个改状态的端点（`/voice/call/answer`、`/voice/provision/{prepare,adopt,cancel,cleanup}`）先查 `Sec-Fetch-Site`，跨站的直接 403；没有这个头时退回比对 `Origin` 与 `Host`。宿主 webserver 本身不带任何鉴权（只有 gzip 中间件），`host` 还可以配成 `0.0.0.0`，所以在 CLI/浏览器部署里这道门是浏览器攻击面上唯一的屏障。本机进程（curl 等）不带这些头，仍然可调用——回环端口没有共享密钥可查，这是明说的残余风险。**桌面版下这条门不由我们把**：主进程转发时把 `Origin`/`Sec-Fetch-Site`/`Host`/`Cookie` 全删掉、换成它自己的 host cookie，非 `dsh-app://app` 的来源在主进程就被 403，于是我们的路由看到的是"没有任何来源头的本机请求"，走的是放行那一支。详见「桌面版兼容性（全文）」。 |
| 来电卡片 | 走 webserver 路由缝隙（SSE `/voice/call/events` + `POST /voice/call/answer`，载荷即预留的 `VoiceAnswerPayload` 契约）；仅 web 组合可用，headless 自动回落弹窗/拒接。同源信任级别与音频路由一致。应答处理里插件抛出的异常被围栏在路由内（回 5xx 带原因），不会变成进程级未捕获异常——0.3.7 补的。 |
| 测试 | 302 个单元/路由测试在 Linux / Windows 上全绿，macOS 上多两条——那两条 `say` 集成用例只在真有声音的系统上执行，别处 skip（首页声明的是三平台共有的那个基数）。CI 三平台矩阵（`pnpm test`）；`pnpm typecheck` 同时检查 `src/`、`src/client/` 和 `test/`——测试代码此前从不在类型检查范围内。插件自己的配置 schema 走一遍宿主的校验入口（`test/plugin-config.test.ts`），插件声明的 harness 兼容性走一遍宿主的判定函数（`test/harness-compat.test.ts`），后者同时钉住"devDependencies 锁的版本必须在声称的基线里"、"没跑过的大版本不许声称"、以及 `engines.dsh` 有和无两种走法。基线更版时两份依赖树各跑一遍：0.2.1-rc.3 一份、0.1.7-rc.2 一份（那一份只把 `dsh-app-boot` 抬到 0.2.1-rc.3，因为加载判定本身是 0.2.0-rc.1 才有的东西）——0.3.13 这一轮两边都是 302 全绿、三份 `tsc` 都过。随包发布的 `cordis.patch.yml` 里每个字段都逐个和插件自己的默认值对齐（`test/bundle-config.test.ts`）——那一行比 schema 的 `.default()` 优先，是新用户实际拿到什么的那一处。 |
## 🔒 桌面版兼容性（全文）

DeepSeek Harness 桌面版（`@deepseek-ai/dsh-desktop`）是把整套 harness 打包进 Electron 的独立发行物。下面每条都是从这台机器上装好的那份 `app.asar`、它带的 `dsh/desktop-runtime.json` 和 `resources/app.asar.unpacked/` 里读出来的，不是按 CLI 的行为推的。插件版本 0.3.13 对着它逐项核对；桌面版那份运行时与 `npm install @deepseek-ai/dsh@0.2.1-rc.3` 那份的**逐文件 sha256 比对**在 0.3.12 那一轮建立、这一轮用同一把尺子重跑（用的还是桌面版自己发布的那份哈希清单）。

| 方面 | 实测到的事实 | 对本插件意味着 |
|---|---|---|
| 发行与版本 | Electron 44.7.0，自带 node 24.21.0、pnpm 11.28.5（还带一份 python 3.12.14 与 office 用的包）；`app.asar` 里是一整套 `dsh/` 运行时。rc.3 这一版把 runtime 目录重排了：node 在 `resources/runtime/bin/node`，pnpm 在 `resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`，旁边多一份 `runtime.json` 写 `desktopVersion`。更新源 `https://download.deepseek.com/dsh-desk/feeds/win-x64/`，channel `nightly`，与 npm 的 `latest` **各走各的** | 桌面版可能带比 npm 更新（甚至不在声称范围内）的运行时版本，届时宿主会静默跳过插件。今天的情况是桌面版 0.2.1-rc.3，npm `latest` 0.2.1-rc.2、`next` 0.2.1-rc.3 |
| 运行时版本 | `desktop-runtime.json` 的 `release.version` = **0.2.1-rc.3**，`hostProtocolVersion` 4，`platform/arch` = win32/x64；`runtime.json` 里 `desktopVersion` 也是 0.2.1-rc.3 | 宿主的加载判定拿这个版本去套我们的 peer 范围；`^0.2.0-rc.1` 含它，由 `test/harness-compat.test.ts` 钉住 |
| 共享包 | `sharedPackages` 305 个（上一版 304），其中 297 个 `@deepseek-ai/dsh-*` 一律 0.2.1-rc.3（cordis 4.0.5、schemastery 3.18.5、cosmokit 1.8.6 都停在原位），`dsh/package.json` 把它们全部摊平成直接依赖 | 我们声明的 20 条 peer **全在里面且区间逐条放行**（逐个 `satisfies()` 核过）；运行时不需要 `@deepseek-ai/cordis`（只在类型层用），`@deepseek-ai/schemastery` 由 profile 里那份满足（见下面那行）。反例一条：`@deepseek-ai/dsh-client-ui-slots` 是 devDependency，桌面版运行时**根本不携带**（rc.2 那版也不带），`src/` 没 import 它所以无影响——但别把 devDependencies 当运行时依赖 |
| **同一版本，两份发行物** | 拿桌面版自带的 17141 条文件哈希，对 `npm install @deepseek-ai/dsh@0.2.1-rc.3` 装出来的树逐个比：我们声明的 24 个包里 **292 个文件字节相同**，服务端 JS 全部一字不差。差异三类：① `package.json` 少了 `scripts`（4 个包）；② `.d.ts` 与 `.d.ts.map` 全部剥掉（355 个被剥的文件里 349 个是类型、4 个是文档，只有 2 个真运行时文件，都属于上面说的那位宿主不携带的 `dsh-client-ui-slots`）；③ `dsh-client-ui-chat` / `dsh-client-ui-conversation` 的 `lib/client.js` 是另一次构建（分别差 159 与 54 字节）。**上一版记下的第四类消失了**：那一版若干包多带的 `lib/types/invariant.js`，rc.3 的打包不再携带，两份发行物在这一点上对齐。桌面版反过来独带 9 个文件：`dsh-host-webserver` 里嵌了一整棵 `node_modules/negotiator/`，npm 那份靠 hoist 解析 | 结论落定并再次复现：**同版本号在两种发行物里是同一份代码**，我们依赖的服务端缝隙不会因为"他装的是桌面版"而位移。③ 碰不到我们：客户端只用相对路径和自己的类名（`dsh-voice-call-overlay`），不碰宿主 module 类名；注入目标 `dsh-client-ui-settings` 的 `client.js` 两边字节相同。② 意味着**不能拿桌面版那份树来编译**，本仓库一直用 npm 那份，没影响 |
| 两份 schemastery 是真的 | `desktop` profile 由 app 初始化：`nodeLinker: hoisted` + `autoInstallPeers: false`（`WORKSPACE_SETTINGS` 那两行是 app 写死的模板），bundles 取 `web` 模板（`dsh-base` + `dsh-web-app`）。profile 的树里除插件外只有 `@deepseek-ai/schemastery@3.18.4` 与 `@deepseek-ai/cosmokit@1.8.5`，pnpm 把我们（和另外三个插件）注入到这两份上，而宿主自己跑 asar 里的 3.18.5 / 1.8.6。**0.2.1-rc.3 的 profile 重查过一次，仍是 3.18.4 / 1.8.5** | **同一个进程里两份 schemastery**。插件不受影响，因为我们交给宿主的 schema 走 plain 对象桥接、不做 `instanceof`。这条同时规定了 peer 的下限不能抬：`@deepseek-ai/schemastery` 的 `^3.18.4` 必须继续含 3.18.4，桌面版上那份真实存在 |
| DSH home | 与 CLI 共用 `~/.dsh`；profile 目录 `~/.dsh/profiles/desktop`，各一份 `package.json` / `cordis.patch.yml` / `node_modules` | 音频目录 `~/.dsh/voice`、装配目录、缓存都在同一个 home 下，两个 profile 各跑各的互不覆盖。别把桌面版的配置写进 `web` 那份，反之也一样 |
| 装插件 | 插件管理走桌面版 UI；安装用它自带的那份 node + pnpm（rc.3 这一版 runtime 目录重排：node 在 `resources/runtime/bin/node`，pnpm 在 `resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`；`versions.json` 声明 pnpm 11.28.5，而直接把那份 `pnpm.mjs --version` 跑出来打印 11.23.0——记下差异，未定论）。profile 的 `pnpm-workspace.yaml` 里维护着按**包名**豁免的 `minimumReleaseAgeExclude`——写它的是 market 插件 `dshmarket`，不是宿主 | 与 CLI 一致的结论：**`@deepseek-ai/*` 必须是 peer，不能是 dependencies**，否则会在 profile 里装出第二份 harness 打断工具派发。另外实测过一次：刚发布、还在 pnpm 发布龄期里的新插件版本会撞 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，装不进去；该阈值不在 profile 那份文件里，`dshplugin manager` 与 `command-manager.js` 里也没有写入点，而 `dshmarket` 的 `pnpm-compat.js` 明确记录了它会被 pnpm 11 拿去做**整份 lockfile 的复检**（触发后靠 `--config.minimum-release-age=0` 重试恢复）。所以"发完 just now 就让用户装"在桌面版上仍不稳妥，得等龄期或走它自己的插件页 |

| 界面与请求路径 | 渲染端跑在自定义 scheme **`dsh-app://app`**（注册为 `standard/secure/supportFetchAPI/corsEnabled/stream`）。主进程 `protocol.handle` 把 `dsh-app://app/*` 分三类：静态首页、`/plugins/**`（附带 `cache-control: no-store`）、其余转发到本机 `http://127.0.0.1:<随机端口>` | 主进程**为 `/plugins/` 单独写了规则**，插件客户端 bundle 在这条链上是被支持的路径（这是从 `app.asar` 代码里读出来的，不是打了一次 200 证明的）。**0.2.1-rc.3 补上了那一次真证**：宿现在只按 boot manifest 广告的那个 URL 发 bundle——`plugins/??dsh-voice-call/client.js&rev=ece8910da42d`，带上 host cookie 取它是 **200 / 70215 字节 / `text/javascript`**，里面能看到我们的类名与全部 `/voice/*` 路径；**不带 `&rev=` 直接取 `plugins/??dsh-voice-call/client.js` 是 404**（`@deepseek-ai/dsh-client-modules` 的 `bundleResource()` 拿 `pathname + search` 精确查一张预生成的表）。我们从不写死这个 URL，组合由宿主负责，所以插件不受影响；旧文档里"打一次就是 200"那句已按实测改掉。我们自己的组件只用相对路径（`fetch('/voice/…')`、`new EventSource('/voice/call/events')`），所以天然落进这条转发链，没有硬编码主机名要改 |
| 实测：服务端那一半是活的 | **桌面版**（2026-10-17，桌面版正在运行时）：直接 GET 本机正在跑的宿主端口（`127.0.0.1:62998`），三个只读端点全部 200——`/voice/call/state` 回了 `"tone":"marimba"`，`/voice/provision/state` 回了 `phase: ready`、`variantId: win-vulkan`、`引擎 v0.8.36`，`/voice/provision/disk` 回了目录计量，内容全部来自 `desktop` 那份 profile；同端口 `GET /` 返回 **401**。那一轮跑的是桌面版 0.2.1-rc.2 运行时 + profile 里的 `dsh-voice-call@0.3.11`。**npm 侧**（2026-10-24，0.3.13 打包后）：把整个 harness home 用 `$DSH_HOME` 挪进临时目录，`npm i @deepseek-ai/dsh@0.2.1-rc.3` + `dsh plugin --profile web add <tarball>`，boot 起来没有一行 `skipping profile bundle`，`/voice/call/state` 与 `/voice/provision/state` 都是 200（`tone: classic`、`phase: unprepared`、`variantId: win-cpu`——这份 scratch profile 自己的值），`GET /` 401，客户端 bundle 按广告 URL 取到 200 / 70215 字节；headless profile 只停在 `MISSING_CREDENTIAL` | 插件在 0.2.1-rc.2（桌面版）与 0.2.1-rc.3（npm）两种运行时里都确实激活了：路由、配置、装配状态、客户端 bundle 都在。**这一轮没有桌面版 live probe**——写这份文档时 `DeepSeek Harness.exe` 不在进程列表里，桌面版没在运行。另外那件 10-17 测出来的事仍然成立：**宿主自己的路径要 cookie，插件注册的路由不在那道门后面**（本机任何进程都读得到这几个只读端点，内容不含凭据，端口是回环加随机）。写接口那一支在桌面版走"放行"，真正的拦截来自主进程那两道（origin 检查 + host cookie） |
| 鉴权与同源门 | 转发函数删掉 `origin`、`sec-fetch-site`、`host`、`cookie`，换上桌面版自己的 host cookie；`origin` 若存在且不是 `dsh-app://app` 直接 403。WebSocket 那条 hook 更硬：`origin !== "dsh-app://app"` 就 cancel | 我们的 `Sec-Fetch-Site`/`Origin` 门在桌面版拿不到这两个头，于是走"本机进程"那一支放行——**浏览器攻击面由主进程那道门先挡住**，且比网页部署更严（端口私有 + 带 cookie）。这不等于我们的门失效：CLI/浏览器部署里它仍然是唯一屏障 |
| 流式 | scheme 带 `stream: true`，转发函数注释明写"preserving streaming and cancellation"，且 `redirect: manual`、body/signal 原样透传 | 两条 SSE（`/voice/call/events` 来电事件、`/voice/provision/events` 装配进度）按设计可用；验收表现是卡片实时跳动、进度条不走空 |
| 沙箱 | `dsh-sandbox-policy` 的词表仍是 `read-only / workspace-write / danger-full-access`，`danger-full-access` 语义不变（沙箱不限制文件改动） | 本地 CrispASR 引擎那条 `danger-full-access` 调用照旧成立，信任边界与 CLI 部署一样要自己评估 |
| 播放与录音 | 桌面版主进程没有设置 `--autoplay-policy` 覆盖；另有 `installMicrophonePermissions(...)` 给渲染端开麦 | 浏览器自动播放规则在 Electron 里同样适用——铃声被拦时卡片会写明原因、点一下就重试（0.3.7 加的）。录音仍只在 macOS 提供，Windows 桌面版走 `transcribe({record})` 会明确报不可用 |

**这一节里还没被真界面验收的部分**：设置卡在 Electron 里渲染、铃声实际响起、来电卡片接听后播完一整句、装配进度条流式更新。这些必须在桌面版里点一次才算数（插件不热加载，更完版本先重载插件或重启桌面版）。静态与依赖层面的结论已经落定；剩下的是观感与音频输出的现场确认。
