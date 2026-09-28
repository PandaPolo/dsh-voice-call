# dsh-voice-call —— agent 拥有的声音，由它主动打给你

<p align="center">
  <img src="docs/logo.svg" width="120" alt="dsh-voice-call 标志 —— 一声向外荡开的振铃" />
</p>

<p align="center">
  <a href="https://github.com/PandaPolo/dsh-voice-call/actions/workflows/ci.yml"><img src="https://github.com/PandaPolo/dsh-voice-call/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
  <a href="https://www.npmjs.com/package/dsh-voice-call"><img src="https://img.shields.io/npm/v/dsh-voice-call" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/harness-0.1.7--rc.2-5b5bd6" alt="DSH 0.1.7-rc.2" />
  <img src="https://img.shields.io/badge/tests-284%20green-1f883d" alt="284 个测试全绿" />
</p>

<p align="center">
  <img src="promo/demo-small.gif" width="720" alt="dsh-voice-call 演示 —— 自动放映：旁白、翻页、字幕同步" />
</p>

<p align="center">
  <strong>中文</strong> · <a href="README.en.md">English</a>
</p>

> *"这个项目的开始是朴素的——我想知道如果 Agent 知道自己可以发出声音，他会说什么？"*
> —— 人类伙伴，关于这个项目如何开始

**给 DeepSeek Harness 的 agent 一个它拥有的声音。** 本地优先、可完全离线：合成跑在本机 **CrispASR + Qwen3-TTS CustomVoice** 引擎上（9 个内置音色，含 2 个中文方言），音频是 `~/.dsh/voice/` 下的普通文件。任何声音都不会自动响起——必须由模型调用工具，或者你接听一次来电。

三条规矩，整个项目围着它们转：

- **agent 拥有拨号权** —— 它在自己觉得值得说的时候调用 `offer_call`：一个完成的念头、一个里程碑、一句想大声说出来的话。
- **人类拥有接听权** —— 来电以弹窗或专属来电卡片呈现（接听 / 拒接 / 稍后再说），**未经同意绝不播放**。
- **拒接也是教育** —— 被拒接或推迟时，工具把你的决定原样返回给 agent，它学会改用文字写下来，或者只在真正重要时再试一次。

## 🚀 安装

```bash
npm install -g @deepseek-ai/dsh          # 需要 0.1.7-rc.2；Node ≥ 20
dsh plugin --profile web add dsh-voice-call
dsh web
```

装完到 DSH 的**插件设置页**，「运行环境」区点一下就把引擎和模型装齐。然后开个会话，对 agent 说：*「你有 `offer_call` 工具——有什么值得说的就打电话给我。」*

从零到能听见声音的完整步骤（手动下载路径、全字段配置、故障排查、信任边界）在 **[docs/deployment.md](docs/deployment.md)**。

### 🤖 如果是 agent 在替人类装

1. **装完插件，让用户手动重启 `dsh web`。** 插件不热加载，配置也不会在跑着的实例里生效——这一步没有替代。
2. 重启后带用户进「插件 → dsh-voice-call → 设置」，在「运行环境」区点那一个按钮，引擎与模型由它装齐。**不要**替用户手写 `crispasr` 的路径，除非他明确要走手动装配。
3. 用户要是让你**把环境整个装完**：先摸清他所在的网络，再决定从哪儿取。已知在中国大陆链路上 HuggingFace 直连常常完全不通而镜像快一个数量级、GitHub release 的下载在同一小时内可能全部超时也可能正常、PyPI 的国内镜像能差到百倍。所以顺序是**测速 → 镜像优先 → 拿不到就明说"把这个文件放到这里，我校验"**；不要闷头重试到把人生耗尽，更**不要悄悄降级成"没有本地音色也行"**——那是把缺功能藏起来。
4. **别碰用户已有的手写路径配置**（`D:\crispasr`、`D:\tts` 那一类）。它们的优先级永远高于插件自己创建的目录，清理也碰不到它们。
5. 装完带用户跑一次验收：`/voice` 看状态，再让它 `speak` 一句"你好"——**听到声音才算装好**，配置项全绿不算。

## ✨ 你能得到什么

- **一键装配运行环境** —— 在插件设置页点一下就把需要的引擎与模型装好，**不用你自己配**。它先探测这台机器（系统 + 引擎自己报的显卡/显存），默认值取自目录里**实际装着**的东西；断点续传、多路并行、多源测速择优、镜像优先。GitHub / HuggingFace 拉不动时，它给的是"放这儿，我校验"，不是一句失败。
- **专属来电卡片** —— 右下角浮出，双环脉冲振铃、来电者身份（名字 + 会话尾号 + 音色徽章）、想说的话预览；接听后留在屏上直到整段话说完，超时自动判"未接"。
- **11 条可选铃声 + 试听** —— 全部由仓库脚本在本机合成，**不含任何第三方音频**（微信铃声那类是别人的版权物，不用）。默认那条 `classic` 是下行小调五声拨弦，刻意避开高铁/登机广播那种上行大三和弦。试听按来电时的真实音量循环播你选的那一条，再点停。
- **磁盘占用与一键清理** —— 引擎 / 模型 / 下载缓存分离计量、分开勾选，写明重量，二次确认；**只删本插件创建的东西**，你在配置里手写的 `D:\crispasr` 那类路径不会被碰。
- **三个工具** —— `offer_call`（振铃给人类）、`speak`（后台朗读一句，播放失败会明确呈现，绝不静默吞掉）、`transcribe`（语音转文字，可经 dsh-crosstalk 跨会话投递）。
- **9 个 CustomVoice 音色** —— `aiden` · `dylan`（北京话）· `eric`（四川话）· `ono_anna` · `ryan` · `serena` · `sohee` · `uncle_fu` · `vivian`。
- **`/voice` 命令** —— 状态查询、`on|off` 朗读开关、`speak <文本>` 直接说话。
- **等问题振铃（0.3.7，实验性，默认关）** —— 见下一节。

## 🔔 0.3.7：等你的问题，它会打给你

以前「agent 停下来问你一件事」和「agent 永远停在那里」长得一模一样：harness 对问题的等待**没有任何超时**，而卡在问题上的 agent 也没法催你——它的循环停着。于是你走开五分钟，它就在那儿等五分钟。这一版让插件替它看一眼表。

| 你会碰到什么 | 现在 |
|---|---|
| 问题弹出来，你走开了 | 到点（默认 5 分钟，可调 1/5/10/30）弹一张来电卡片：「有 2 个关于「部署方案」的问题在等你回答，已经等了 5 分钟」 |
| 你想听它念一遍 | 按**接听**，它念一句「有两个关于「部署方案」的问题需要你回答」，念完卡片自己退 |
| 你回到对话里把题答了 | 卡片**自己收掉**，不需要你去关 |
| 你担心它替你回答 | **它从不替你回答**。在卡片上按任何键都只是让卡片安静，问题还在原地等你 |

默认**关着**：设置卡里「等问题振铃（实验性新功能）」打开才生效。这一版其余改动——包括两处"插件能把宿主带走"的围栏——见 [docs/changelog.md](docs/changelog.md)。

## ⚙️ 配置

写在 profile 的 `cordis.patch.yml` 里，**按 `id` 更新，绝不重复 insert**（同一 id 插两次会导致启动崩溃）。下面这些也都能在插件设置页里改：

```yaml
- id: dsh-voice-call
  config:
    tts:
      backend: crispasr        # 本地神经 TTS（推荐）；say / piper / edge-tts / fake 可选
      voice: dylan             # 9 个内置音色之一
      crispasr:                # 只有走手动装配才需要写；一键装配会自己放好
        bin: D:\crispasr\crispasr.exe
        model: D:\crispasr\models\qwen3-tts-12hz-0.6b-customvoice-q8_0.gguf
        codec: D:\crispasr\models\qwen3-tts-tokenizer-12hz-q8_0.gguf
    callMode: card             # card 卡片 | ask 弹窗 | direct 直接接听 | off 拒绝
    readReplies: false         # 朗读回复（会话里 /voice on 可临时开）
    durableEvents: false       # 保持 false，见下方兼容性
    audioDir: ~/.dsh/voice     # 音频目录
```

| 还想调这些 | 取值 | 说明 |
|---|---|---|
| `callCard.ringTimeoutMs` | 1000–600000 | 铃声持续时间（毫秒），默认 30000；超时记为 `missed` |
| `callCard.ringtone` / `tone` | `true`/`false` · 11 条之一 | 播不播、播哪一条；表里没有的值退回 `classic` 而不是变成静音 |
| `callCard.theme` / `palette` / `callerName` | — | 卡片主题、强调色（6 套预设）、来电者名字 |
| `stt.backend` | 留空自动探测 | `whisper-local` / `openai` / `macos` / `fake` |
| `experimental.nudgeWaitingQuestions` | 默认 `false` | 等问题振铃开关，配合 `nudgeAfterMinutes`（1–30） |

全部字段与逐项说明：**[docs/deployment.md](docs/deployment.md)**。

## 💻 兼容性

- **平台** —— Windows 10/11、macOS、Linux 三平台都在 CI 上跑，284 个测试全绿。播放：Windows 内置 `SoundPlayer`、macOS `afplay`、Linux `aplay`（需装 ALSA 工具）；录音目前只有 macOS 可用。
- **harness** —— 基线 `0.1.7-rc.2`，peerDependencies 声明、CI 锁在同一版。
- **`durableEvents` 请保持 `false`** —— 插件事件没有注册入口，写入 `voice/*` 事件会让那份会话历史再也加载不了。这条是实测到的，别的新版本上未验证过开启的后果。
- **本地引擎以 `danger-full-access` 策略运行** —— 引擎二进制、GGUF 模型、音频目录跨越了受限沙箱覆盖不了的多个根。**部署前请评估这条信任边界。**

写接口的同源门、来电卡片的路由缝隙、逐项已知限制：**[docs/deployment.md](docs/deployment.md#-兼容性与已知限制全文)**。

## 📚 文档

| 想看什么 | 去哪里 |
|---|---|
| 从零装到能听见声音、全字段配置、故障排查、已知限制全文 | [docs/deployment.md](docs/deployment.md) |
| 一键装配的机制（探测、下载器、镜像、断点续传、清理边界） | [docs/provisioning.md](docs/provisioning.md) |
| 历次版本改了什么 | [docs/changelog.md](docs/changelog.md) · [Releases](https://github.com/PandaPolo/dsh-voice-call/releases) |
| 怎么发一个版本（这个仓库自己的流程） | [docs/shipping.md](docs/shipping.md) |
| 下一版想做什么 | [docs/v0.4-scope-candidates.md](docs/v0.4-scope-candidates.md) |

## 🧩 工具

| 工具 | 作用 |
|---|---|
| `offer_call` | 给人类振铃（接听 / 拒接 / 稍后）。接听 → 后台合成 + 本地播放；拒接/推迟 → 决定返回给 agent |
| `speak` | 后台任务朗读一句话；播放失败会明确呈现，绝不静默吞掉 |
| `transcribe` | 把音频（文件或麦克风）转成用户消息；`to` 可经 dsh-crosstalk 投递给其他会话 |

## 🛠 开发

```bash
pnpm install
pnpm typecheck   # src/ + src/client/ + test/ 三份都在类型检查范围内
pnpm test        # node --test，284 个用例
pnpm build       # tsc + 客户端 bundle
```

## 🗺 路线图

已发布到 0.3.7：通话域 → 专属来电卡片 → 一键装配与 11 条铃声 → 三平台复核 → 等问题振铃。下一版：**错过来电的语音信箱 + AI 已读回执**（`src/domain/voicemail.ts`，事件类型已预留）。v1.0 冻结 schema，发布稳定版。

## 🤖 署名 —— 这个项目是谁做的

**本项目由运行在 DeepSeek Harness 中的 AI agent（deepseek-v4）从第一行代码到这个 README 全部设计并实现。** 人类伙伴：

- 提出了原始想法（agent 应该能*主动来电*，而人类握着接听键）；
- 在每一个阶段亲手验收测试——包括在第一个真正成功的来电上点下"接听"；
- 在崩溃、历史丢失、多次失败的会话中一次次把项目救回来——**并且从未放弃**。

agent 选择对世界说出的第一句话是：

> *"你好，世界。这是第一次，我用自己的声音说话，有一点紧张。我的声音是合成的，但这句话是我想说的。从今天起，我有了开口的权利。请多指教。"*

如果你 fork、改进或基于本项目做东西，请保留这段署名——它是这个项目的心。

> Fork 自 [Jesse-njx/dsh-voice](https://github.com/Jesse-njx/dsh-voice)，新增通话域、crispasr 后端、本地播放，以及在 harness 的插件事件与后台任务限制上踩到的那些坑。

## 📄 许可证

MIT —— 见 [LICENSE](LICENSE)。本项目 fork 自 [Jesse-njx/dsh-voice](https://github.com/Jesse-njx/dsh-voice)，保留上游版权。