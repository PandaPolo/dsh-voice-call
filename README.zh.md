# dsh-voice

**语音输入，语音输出。** 口述音频变成用户消息，让智能体把回复读出来。DSH 的免手终端。

`dsh-voice` 是一个 DeepSeek Harness 插件包（bundle）。两个工具、一个持久化事件、一个开关：

- **`transcribe({ source })`** —— 语音转文字。传 `{ file }`（已有音频文件）或 `{ record }`（用麦克风录几秒）。转写结果会成为**用户消息**（而不是工具输出），聊天里会渲染一张紧凑的**音频卡片**：播放/暂停、时长、后端徽标和转写文字。
- **`speak({ text, voice?, rate? })`** —— 后台任务上的文字转语音。工具立刻返回 `{ jobId, audioRef }`，绝不阻塞回合；播放异步进行，失败以注入通知呈现。`speak` 同时充当**长任务旁白**（"构建完成，0 失败"）。
- **`readReplies` + `/voice`** —— 会话级开关，自动朗读智能体的回复。默认关闭；用 `/voice on` 实时开启。

设计核心是**本地优先**：音频就是 `~/.dsh/voice/` 下的普通文件（可检查、可 `rm`），除非你显式配置云端后端，否则数据不出本机；任何音频行为都不会自动运行——必须由模型调用工具。

## 为什么这样设计

终端智能体有两个日常痛点：你不在键盘前想留下指令（口述），以及任务中途不想读一屏输出（旁白）。dsh-voice 只是 DSH 已有能力（`ctx.shell`、`ctx.jobs`、`ctx.settings`、`ctx.attachments`、`ctx.conversationEvents`）之上的薄层，不自己持有音频管线。音频是**普通文件**，会话日志只保存**引用 + 转写文本**（attachment/image-ref 模式），回放时不重读音频即可还原音频卡片。

## 安装

```sh
dsh plugin --profile web add @dsh-voice/bundle
```

安装后会注册 `dsh-voice` 条目（工具、`/voice` 命令、网页音频卡片）。在模型调用工具之前，一切都不会运行。

## 配置

所有字段都可选（profile patch 或 `cordis.patch.yml`）：

```yaml
plugins:
  dsh-voice:
    stt:
      backend: whisper-local | openai | macos | fake   # 缺省 = 自动（whisper-local → macos）
      model: whisper-1                                  # STT 模型
      whisperLocal: { bin: whisper-cli, model: tiny }   # whisper.cpp 二进制与模型
      openai: { baseUrl: https://api.openai.com/v1, apiKeyEnv: OPENAI_API_KEY }
    tts:
      backend: say | piper | edge-tts | fake            # 缺省 = 自动（say → piper）
      voice: Samantha                                   # 默认音色
      rate: 180                                         # say 语速（词/分钟）
      piper: { bin: piper, model: /path/to/model.onnx }
      edgeTts: { voice: en-US-GuyNeural }
    readReplies: false                                  # 开启后朗读回复
    audioDir: ~/.dsh/voice                              # 音频文件目录
```

默认值：`stt.backend` 自动选择离线后端（whisper-local → macos）、`tts.backend: say`、`readReplies: false`、`audioDir: ~/.dsh/voice`。**云端后端永远不会被自动选择**——只有显式配置 `openai` / `edge-tts` 才会启用。`openai` 后端通过标准凭据通道读取密钥（`OPENAI_API_KEY`，与 polyglot preset 相同的约定），并回退到启动环境变量。

## 工具

### `transcribe({ source, to? })`

`source` 必须是**二选一**：

- `{ file: <path> }` —— 转写已有音频文件。
- `{ record: { seconds? } }` —— 用麦克风录音（默认 5 秒），仅在存在录音路径（macOS 的 ffmpeg 或内置 swift shim）时可用。

转写结果**作为用户消息插入**，而非工具输出：`voice/note` 会话事件把音频卡片渲染成用户回合，文本作为用户输入投递给智能体。规范返回值是紧凑句柄——`{ transcript, audioRef, backend, durationMs }`——供 Code Mode 拿到结构化数据。

如果安装了 **dsh-crosstalk**，`transcribe({ source, to: <peer> })` 会把语音便签作为带标签的 peer 消息投递到另一台本地会话（附音频路径）；crosstalk 负责来源框架；未安装时该选项不会提供。

### `speak({ text, voice?, rate? })`

在**后台任务**（`ctx.jobs`，kind 为 `voice-speak`）上合成并播放，立刻返回 `{ jobId, audioRef }`。每个后端都先在 `audioDir` 下写入持久化文件（可单测的接缝），再作为独立尽力步骤播放。任务失败以通知注入，绝不抛入回合。

因为它是 `ctx.jobs` 之上的普通工具，routines 和 headless 运行都可以调用——**旁白就是 job 上下文里调用 speak**，没有新增面。

## 聊天里的语音便签

音频从不进入会话日志。文件落在 `audioDir`；日志只保存一个持久化事件：

| 事件 | 角色 | 必需持久化字段 |
|---|---|---|
| `voice/note` | 唯一开始 | `noteId`、turn/step 坐标、`audioRef`（path + mime + durationMs）、`transcript`、`direction: 'in' \| 'out'`、`backend` |

v0.1 为单事件业务——`noteId` 是稳定 id，无更新事件。Web 客户端渲染 `voice-note` 卡片：入站便签（STT）显示为用户回合，出站（`speak`）显示为智能体侧卡片。文件缺失或删除时降级为纯转写卡片——你随时可以 `rm` 音频。

## `/voice`

```sh
/voice on            # 开始朗读智能体的回复
/voice off           # 停止
/voice status        # 当前状态 + 后端 + audioDir
/voice speak <text>  # 直接在输入框朗读一行
```

`readReplies` 默认跟随配置；开关为会话级、实时生效。

## 后端

语音转文字（`dsh-voice-backends` 模块负责选择与 fake）：

- **`whisper-local`** —— PATH 上的 whisper.cpp 二进制（或配置路径），经 `ctx.shell` 调用。完全离线。
- **`openai`** —— 经标准凭据通道访问 OpenAI 兼容 `whisper-1` 端点。唯一会把音频送出机器的 STT 路径；仅当配置时启用。
- **`macos`** —— 通过内置的轻量 swift shim 使用系统 `SFSpeechRecognizer`，经 `ctx.shell` 调用。无需安装、无需网络配置。
- **`fake`** —— 文本到文本的固定映射（内容为 `{"transcript": "…"}` 的文件——或名为 `fixture-<text>.m4a` 的文件——转写为该文本）。无需麦克风与网络即可跑通整条工具链路；CI 默认。

文字转语音：

- **`say`**（默认）—— macOS `say -o <file> --file-format=m4af --data-format=aac`，然后 `afplay`。零安装；产出 Chrome/Safari 可播放的 m4a。
- **`piper`** —— 本地 Piper 二进制，离线神经 TTS。
- **`edge-tts`** —— 云端；仅显式配置时启用。
- **`fake`** —— 写入 `{"transcript": "<text>"}`，使 speak 输出能精确经过 fake STT 往返。

选择逻辑是纯函数且经过单测：配置的后端永远优先；否则按离线回退顺序（`whisper-local → macos`、`say → piper`）；云端永不自动选择；无离线后端时给出明确报错告诉你该配什么。

## 安全 / 隐私默认值

- **本地优先** —— 除非显式设置 `stt.backend: openai` 或 `tts.backend: edge-tts`，音频不出本机。
- **普通文件** —— 每个产物都是 `audioDir` 下可检查、可 `rm` 的文件；会话日志只保存引用与转写文本。
- **不自动运行** —— 录音与播放只在显式工具调用时发生。`readReplies` 只朗读已有回复；它从不录音，且默认关闭。

## 非目标（v0.1）

实时流式对话；外向合成语音电话；群聊微信场景的音频；说话人分离；音乐/音效；在会话日志中存储原始音频；唤醒词 / 常驻监听。

## 测试

```sh
pnpm install
pnpm typecheck   # host + client 两个 tsconfig
pnpm test        # node --test（46 个用例）
pnpm build       # tsc 编译 host + client 声明 + web 客户端 bundle
pnpm pack        # 可发布的 tarball
```

测试覆盖规范要求：参数 schema 单元测试（`{file|record}` 精确一选一联合、`speak` 的可选 `voice`/`rate`）、带假探针的后端选择、fake 文本到文本后端贯穿两条工具链路、`voice-note` 渲染器（从日志事件构建预期 `node.data`、缺文件降级为纯转写、回放纯函数性），以及 macOS `say` 集成测试（在 audioDir 下合成非空 m4a）。

客户端 bundle（`lib/client.js`）由 `scripts/build-client.mjs` 构建为 web 客户端的 lazy-CJS 移交格式，安装到 web profile 后经 `/plugins/@dsh-voice/bundle/client.js` 提供。

## 开发

仓库布局与兄弟插件一致：`src/backends/` 是 `dsh-voice-backends` 模块（接口、纯选择逻辑、探针、fake 及每个具体后端）；`src/tools/` 承载 `transcribe`/`speak` 管线（依赖注入，便于用 fake 测试）；`src/client/` 是 Web 半区（纯 Definition + React 音频卡片）；`shims/` 是 macOS STT 与录音的捆绑 swift 脚本。

## License

MIT
