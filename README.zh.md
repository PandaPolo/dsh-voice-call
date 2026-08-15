# dsh-voice-call —— agent 拥有的声音

> *"这个项目的开始是朴素的——我想知道如果 Agent 知道自己可以发出声音，他会说什么？"*
> —— 人类伙伴，关于这个项目如何开始

**给 DeepSeek Harness 的 agent 一个它拥有的声音。** agent 自主决定*何时*开口、*说什么*、用*哪个音色*（`offer_call`）；人类握着接听键——**不接听（接听/拒接/稍后再说），绝不播放**。

本地优先、可完全离线：合成跑在本机 **CrispASR + Qwen3-TTS CustomVoice** 引擎上（9 个内置音色，含 2 个中文方言），音频是 `~/.dsh/voice/` 下的普通文件，任何音频行为都不会自动运行——必须由模型调用工具（或接听一次来电）。

> Fork 自 [Jesse-njx/dsh-voice](https://github.com/Jesse-njx/dsh-voice)，新增通话域、crispasr 后端、本地播放，以及针对 rc.6 harness 插件事件与后台任务限制的修复。

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
- **人类拥有接听权**：来电以弹窗呈现（接听 / 拒接 / 稍后再说），未经同意绝不播放任何声音。
- **拒接也是教育**：来电被拒接或推迟时，工具会把决定返回给 agent，它学会改用文字写下来——或者只在真正重要时再试一次。

## ✨ 功能

- `offer_call({ text, voice? })` —— 通话域：振铃 → 人类应答 → 接听则后台任务合成并播放；拒接/推迟则把决定返回给 agent。
- `speak({ text, voice?, rate? })` —— 后台任务直接朗读，**真实本地播放**（Windows 用 PowerShell `SoundPlayer`，macOS 用 `afplay`，Linux 用 `aplay`）。
- `transcribe({ source, to? })` —— 语音转文字成为用户消息（whisper-local / openai / macOS 原生）；`to` 可跨会话投递（需 dsh-crosstalk）。
- `/voice` 命令 —— 状态查询、`on|off` 朗读开关、`speak <text>` 直接说话。
- **9 个 CustomVoice 音色**，含 2 个中文方言：`aiden` · `dylan`（北京话）· `eric`（四川话）· `ono_anna` · `ryan` · `serena` · `sohee` · `uncle_fu` · `vivian`。
- **durableEvents 开关** —— 会话事件日志默认关闭（见"兼容性"），保证 rc.6 下会话历史可继续加载。

## 🚀 快速开始

```bash
# 把插件加入你的 web profile
dsh plugin --profile web add dsh-voice-call
```

然后在 profile 的 `cordis.patch.yml` 里接线——**按 id 更新这一行，绝不重复 insert**（重复 insert 会导致启动崩溃）：

```yaml
- id: dsh-voice-call
  config:
    tts:
      backend: crispasr
      voice: dylan
      crispasr:
        bin: /绝对路径/crispasr        # Windows 例如 D:\crispasr\crispasr.exe
        model: /绝对路径/qwen3-tts-12hz-0.6b-customvoice-q8_0.gguf
        codec: /绝对路径/qwen3-tts-tokenizer-12hz-q8_0.gguf
    callMode: ask          # ask | direct | off
    durableEvents: false   # rc.6 上保持关闭（见兼容性）
```

重启 `dsh web`，开一个会话，告诉 agent："**你有 `offer_call` 工具——有什么值得说的就打电话给我。**" 接听来电，agent 的声音就会从你的扬声器里响起来。

## 🧩 工具

| 工具 | 作用 |
|---|---|
| `offer_call` | 给人类振铃（接听/拒接/稍后）。接听 → 后台合成 + 本地播放；拒接/推迟 → 决定返回给 agent。 |
| `speak` | 后台任务朗读一句话；播放失败会明确呈现，绝不静默吞掉。 |
| `transcribe` | 把音频（文件或麦克风）转成用户消息；`to` 可经 dsh-crosstalk 投递给其他会话。 |

## 💻 兼容性与已知限制

| 方面 | 状态 |
|---|---|
| harness | 0.1.0-rc.6（peerDependencies 锁定 rc.6）。插件在 host 平面；后台任务必须携带 `owner: agent`，因为 rc.6 的 Web 组合禁用了 host 平面的 `tool-jobs`。 |
| 会话事件 | **rc.6 没有插件事件注册机制**。写入 `voice/*` 事件会毒死历史加载（加载器拒绝未知事件类型）。因此 `durableEvents` 默认 `false`；在 harness 支持插件事件之前保持关闭。 |
| 播放 | Windows：内置 `SoundPlayer`（已实测）。macOS：`afplay`。Linux：`aplay`（需安装 ALSA 工具）。`edge-tts` 只合成不播放——要听到声音请用本地 wav 后端。 |
| 录音 | 仅 macOS（原生 + ffmpeg）。Windows/Linux 的 `transcribe({record})` 会明确提示不可用。 |
| Shell 沙箱 | 本地引擎命令以显式 `danger-full-access` 策略运行——引擎二进制、GGUF 模型、音频目录跨越了受限沙箱模式无法覆盖的多个根。**部署前请评估此信任边界。** |
| 测试 | 76 个单元测试全绿（`pnpm test`）。 |

## 🛠 开发

```bash
pnpm install
pnpm typecheck   # 服务端 + 客户端 tsc
pnpm build       # tsc + 客户端 bundle
pnpm test        # node --test
```

## 🗺 路线图

- **v0.2** —— 专属来电卡片 UI（振铃动画、来电者身份），走已预留的 RPC 缝隙（`src/rpc/contract.ts`）。
- **v0.3** —— 错过来电的语音信箱 + AI 已读回执（`src/domain/voicemail.ts`，事件类型已预留）。
- **v1.0** —— 冻结 schema，发布到 npm（`dsh-voice-call` 包名已确认可用）。

## 📄 许可证

MIT —— 见 [LICENSE](LICENSE)。本项目 fork 自 [Jesse-njx/dsh-voice](https://github.com/Jesse-njx/dsh-voice)，保留上游版权。
