# 语音信箱 + 已读回执：可行性调研（2026-09-19）

调研时的基线：**DSH `0.1.5-rc.2`**，插件 `dsh-voice-call 0.3.0`。
这是一份冷存笔记——只有在真正动手做 v0.3 路线图里那项「错过来电的语音信箱 + AI 已读回执」时才需要读。**结论里的每条宿主 API 都是当时在 `node_modules/@deepseek-ai/` 的 `.d.ts` 上核对过的，隔了几个 harness 版本之后必须重新验证，不要当现状用。**

本文件不在 npm `files` 列表里，不随包发布。

---

## 一句话结论

能做，而且比路线图当初假设的条件好：**回执推给 agent 的口子已经开了**，不需要等 harness 更新。
但唯一一条「需要等」的路——把回执写成 durable session 事件——在这个版本上依然是死的，而且**不是等版本能解决的，得改设计**。

---

## 1. 已解锁：回执推给 agent（服务端、插件可调用）

live `Agent` 暴露四个入口，全部是公开方法（`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts`）：

| 方法 | 行 | 语义 |
|---|---|---|
| `send(message, target, wakeup)` | :186 | 路由到 inbox 边界，可选唤醒 driver |
| `followup(message)` | :192 | 排一轮普通后续 turn 并唤醒 |
| `steer(message)` | :200 | 下个 step 边界消费；driver 空闲时直接开一轮 |
| `inject(message)` | :209 | 只喂模型上下文，**不唤醒** |

从根 scope 就能拿到目标 agent：`ctx.agents.get(sessionId)`（`dsh-agent/lib/types/index.d.ts:341`，另有 `list():355` / `roots()`）。
消息署名原生支持插件：`MessageSourceMap.plugin = { kind: 'plugin', plugin }`（`dsh-llm/lib/types/message.d.ts:98-101`），用 `createUserMessage`（同文件 :180）构造。

**本仓库已有的地基**：`src/tools/offer-call.ts:224` 就持有 `exec.agent`；`src/callcard/board.ts:36` 已在条目里记 `sessionId`；v0.3 的 `RingChannel.leg(callId)` → `playing()` / `settle(status, reason)` 本身就是一条现成的回执源。

> 待验证的小风险：`followup/steer/inject` 从非 agent scope 的 HTTP 回调里调用是否有任何限制（`ctx.userQuestions` 那边是有 `CALLER_NOT_LIVE` / `DELEGATED_CALLER` 约束的）。动手前先用一次 spike 试。

## 2. 仍然堵死：plugin 自己的 session 事件

`src/events/call.ts` 预留的 `voice/call.read` / `voice/call.voicemail` **不能按原样落地**：

- `Session.append(type, data, ...opts)` 的第三个参数只 spread `sourceEventSeqs` / `surfaceOp`，**写不进信封上的 `ignorable?: true`**（`dsh-session/lib/types/index.js:555-579`）。
- 读路径 fail-closed：`dsh-session-persistence/lib/index.js` 对不认识又没标 ignorable 的事件直接拒绝解释日志（`SessionEvent.ignorable` 的语义见 `dsh-session/lib/types/types.d.ts:468-478`）。
- `dsh-session/lib/types/known-event-types.d.ts:8-19` 说得很明白：仓库外的插件事件**按构造**就在这个集合之外，`ignorable` 标记是唯一的兼容机制，而**事件名注册方案已被官方否决**。

⇒ 一条插件事件写进日志，就会永久毒化这个 session 的历史。`durableEvents` 继续默认 `false`。
⇒ **回执的正确载体是 `agent.inject/followup` 注入的 plugin 署名消息，或者干脆让 agent 用工具自己拉，不是 session 事件。**
⇒ 顺手把 `src/events/call.ts` 和 `src/domain/voicemail.ts` 里「事件类型已预留」的注释改成「此路不通，走注入或拉取」，否则下次重新踩。

## 3. 存储：DIY 文件仍然是对的选择

- `ctx.storage` / `dsh-storage-domain`（KvTable 那套）**只躺在 `.pnpm` 里**：不是 peerDependency，也没装任何 `StorageBackend`，别把方案建在它上面。
- `dsh-home-paths` 只是路径 helper（`dshHomePath(...segments)`），**没有**插件数据目录服务。
- 配置面用现成的 `ctx.settings.register(ns, schema, …)`（`dsh-settings/lib/types/index.d.ts:216`）。

⇒ `src/domain/voicemail.ts` 里写的 `~/.dsh/voice/calls/<callId>.wav` + `voicemail.json` 索引布局保持不变即可，`VoicemailStore` 四个方法不需要因为宿主而改。

## 4. UI：常驻留言箱是被支持的

- `conversation.view` 是真 slot：`{ kind: 'list', scope: 'session' }`，投影成页签（`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:157`，`ViewTab` / `openView` / `ConversationStoreState.view` 见同目录 `views.d.ts`）。注册入口是 `ctx.uiConversation.events.register` + `SlotCore.register`。
- 音频回放**完全不用新面**：现有 audio route（`src/web.ts`，`AUDIO_ROUTE` 前缀）直接服务 wav，浏览器播完 `POST` 回执即可。

⇒ 也就是说 A 档可以完全不碰 slot，沿用已经跑通的外挂卡片。

## 5. 麦克风：宿主零采集 seam

21 个包加整个 `.pnpm` 全库搜 `getUserMedia|MediaRecorder|mediaDevices|AudioContext|AudioWorklet|input device`，只命中 TypeScript 自己的 `lib.dom.d.ts`。宿主的消息内容类型也没有音频：`PromptContentPart = text|image|file`（`dsh-api-session-controller/lib/types/types.d.ts:64-76`）。

⇒ 「用户用语音回复留言」这件事只能在自己的 client bundle 里裸写采集，再喂给现有 crispasr 后端。是整块里最贵、最容易撞上浏览器权限和自动播放策略的部分。

## 6. 顺带记着的既有陷阱（本仓库特定）

- esbuild 把 CJK 全转义成 `\uXXXX`：**别用中文串去 grep 构建产物**判断改动有没有生效，改成 `diff -rq lib` 对仓库产物。
- pnpm `nodeLinker: hoisted` 下重新打包覆盖同名 tarball，`pnpm install`（甚至 `--force`）会报 "Already up to date" 并留下旧文件：先 `rm -rf node_modules/dsh-voice-call` 再装。
- 不要自己起 `dsh web` 去验证——会和他正在跑的实例抢 `127.0.0.1:3080`。

---

## 三档成本

| 档 | 内容 | 成本 | 新增宿主面 |
|---|---|---|---|
| **A 最小闭环** | missed 照样合成并存成留言 → 卡片/浮层列表回放 → 播完 `POST` 回执 → `agent.followup()` 注入 plugin 署名消息 | 小；约等于 `VoicemailStore` 落地 + 2 个 route + 卡片列表 + 测试 | **无** |
| **B** | A + `conversation.view` 常驻留言页签 + 未读计数 | 中，要学 slot 的 owner props 和 session scope | 1 个 slot |
| **C** | B + 用户语音回复（getUserMedia + ASR 上传） | 大 | 1 个 slot + 自采音频 |

## 动手前必须拍的一个问题：推 vs 拉

`followup` 意味着插件能凭一条「他听完了」自己把用户的对话叫醒——体验最像已读回执，但属于侵入式，而且会打断人。
保守替代：给 agent 一个 `voicemail_list` / `voice_status` 工具，让它在后续轮次自己查 `readAt`。同样零新宿主面、永不打断，代价是"已读"什么时候被模型知道取决于它下次什么时候想起去查。

这一条决定 A 档的最终形态，开工前先问用户。
