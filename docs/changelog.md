# 更新记录

> 从 [README](../README.md) 搬出来的发版账本。首页只留"最新版一句话"，这里按版本倒序保留全文。
> 每个版本的发布说明在 [GitHub Releases](https://github.com/PandaPolo/dsh-voice-call/releases) 也有一份。

## 0.3.13 —— 基线跟上 0.2.1-rc.3；消费侧模拟重新做得起来了，顺带发现宿主换了插件 bundle 的取法

**这一版没有任何代码变化**：发出去的 `lib/index.js`（19781 字节）与 `lib/client.js`（70144 字节）和 0.3.12 那两份**字节相同**。变的只有声明的基线、devDependencies、一条测试的强度，以及文档里被重新测过的那些事实。

桌面版和 npm 这次**同时**动了：asar 里 `dsh/desktop-runtime.json → release.version` 是 **0.2.1-rc.3**（npm `next` 同号，`latest` 留在 0.2.1-rc.2；rc.3 发布于 2026-10-23T07:54Z）。规矩照旧——**以桌面版为准**。

| 项目 | 改动 |
|---|---|
| devDependencies / CI | 22 个 `@deepseek-ai/dsh-*` pin 从 0.2.1-rc.2 抬到 **0.2.1-rc.3**。cordis 继续 `~4.0.5`、schemastery 继续 `^3.18.4`——这两位在 rc.3 那批里根本没动（桌面版带的仍是 cordis 4.0.5 / schemastery 3.18.5 / cosmokit 1.8.6）。`pnpm-workspace.yaml` 里 71 条 `minimumReleaseAgeExclude` 各加上 `\|\| 0.2.1-rc.3`，阈值本身没动 |
| peerDependencies | **还是一个字没改**：`^0.1.7-rc.2 \|\| ^0.2.0-rc.1` 用宿主那个 `includePrerelease` 的 `satisfies()` 实测就含 0.2.1-rc.3（也含 0.2.2，拒绝 0.3.0-rc.1）。`schemastery` 的下界继续停在 3.18.4，因为桌面版 profile 里真实存在的那一份就是 3.18.4 |
| 判定函数这次没动 | `evaluatePluginCompatibility` 所在的 `@deepseek-ai/dsh-app-boot/lib/index.js`，在 rc.2 与 rc.3 两份桌面 asar 里**字节相同**（203572 字节）——`requirements` 这个字段名、以及"清单写了 `engines.dsh` 就只看它"这两条语义原样保留，不需要再迁就 |
| 声称的基线 | `SUPPORTED` = 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-rc.2 / **0.2.1-rc.3**。两份依赖树各跑一遍：rc.3 一份，0.1.7-rc.2 一份（后者仍只把 `dsh-app-boot` 抬到 rc.3，因为加载判定是 0.2.0-rc.1 才有的东西） |
| 测试 | **302 条，一条没加**——改的是那条 `engines.dsh` 守卫的力度：以前只证"写了 engines.dsh 会走另一支"，现在把"它会**沉默**"也钉上：把 `@deepseek-ai/dsh-tools` 冻回 `^0.1.7-rc.2`，没有 `engines.dsh` 时宿主就按这条 peer 拒绝，而同一份清单只要加上 `engines.dsh` 就被放行。这条负控说的正是"为什么我们故意不写 engines.dsh"。CI 三平台实跑（run 40090266940，全绿）：Linux 302、Windows 302、macOS 304——多出的两条仍是只在有 `say` 的系统上才执行的集成用例；本地两份依赖树各跑一遍也都是 302 全绿 |
| 源码 | 一行没动。三份 `tsc` 在两份树上都过，`pnpm build` 干净 |

**rc.2 → rc.3 到底改了什么**（npm 侧逐包 diff，我们摸的 21 个包）：除了版本号，只有一处真代码——`@deepseek-ai/dsh-client-ui-conversation` 的**客户端**那一侧（`lib/client.js` 重构建、8 个 `.d.ts` 有改动、新增一个 `view-pins.d.ts`），而且全是**加导出**（`ConversationViewActionEntry`、`ConversationViewActionsOwnerProps`），删掉的东西为零。`@deepseek-ai/dsh-api-session-controller` 只动了一个 `.d.ts`。其余 19 个包连文件列表都没变。我们 import 的三个符号（`ConversationLocation` / `ConversationNodeContext` / `ConversationNodeDefinition`）不在差异里，三份 `tsc` 在 rc.3 上一遍过——所以这次不是"迁移"，是"确认没东西要迁"。

**逐文件哈希又走了一遍**（桌面版这次的索引是 17141 条 `path → sha256`，比上一版少 120 条）。拿它比一份 `npm install @deepseek-ai/dsh@0.2.1-rc.3`：

- 我们声明的 24 个包里，**292 个文件字节相同**；服务端 JS 依旧两边一字不差。
- 桌面版剥掉的 355 个 npm 文件里，349 个是 `.d.ts`、4 个是文档，只有 2 个是真运行时文件——而那两个都属于 `@deepseek-ai/dsh-client-ui-slots`：**这个包桌面版运行时里整个不存在**（rc.2 那版也不存在）。它是我们的 devDependency 而不是 peer，`src/` 一行都没 import，所以宿主不会因此跳过我们；但它说明 devDeps 里可以放宿主根本不发的包，别把它当成运行时依赖看。
- 6 处内容不同：4 份 `package.json`（被删掉 `scripts`）加 `dsh-client-ui-chat` / `dsh-client-ui-conversation` 两份 `lib/client.js`（另一次构建，字节数差 159 与 54）。碰不到我们——理由和上一版相同：客户端只用相对路径和自己的类名，注入目标 `dsh-client-ui-settings` 的 `client.js` 两边字节相同。
- **0.3.12 记下的第四类差异消失了**：那一版桌面版若干包多带一份 `lib/types/invariant.js`，rc.3 的打包不再带它，两份发行物在这一点上对齐了。
- 桌面版独有 9 个文件：`dsh-host-webserver` 里嵌了一整棵 `node_modules/negotiator/`，npm 那份靠 hoist 解析。
- **桌面 profile 那份"同进程两个 schemastery"依旧成立**：profile 树里还是 `schemastery@3.18.4` + `cosmokit@1.8.5`，宿主跑 asar 里的 3.18.5 / 1.8.6。所以 peer 下界 `^3.18.4` 仍然不能抬。
- 20 条 peer 在桌面版那 305 个共享包里**全部存在且区间全部放行**（逐条 `satisfies()` 核过）。

**消费侧模拟恢复了完整形态，而且比上一版走得更深。** 这台机器仍然没有全局 CLI，但 harness home 可以用 `$DSH_HOME` 整个挪进临时目录——于是一轮真的做完了：`npm i @deepseek-ai/dsh@0.2.1-rc.3` → `dsh plugin --profile web add <tarball>` → boot。看到的依次是：

- **没有** `skipping profile bundle "dsh-voice-call"` 那一行——rc.3 的判定把我们放进来了。
- `--dump-config` 里我们的条目带着 `callMode: card`、`durableEvents: false`、`audioDir: ~/.dsh/voice`——bundle 的 patch 层确实排在 `.default()` 之上。
- 只读端点全 200：`/voice/call/state` 回了 `{"calls":[],"appearance":{…,"tone":"classic"}}`，`/voice/provision/state` 回了 `phase: unprepared` / `variantId: win-cpu`（都是这份 scratch profile 自己的值，没碰 `~/.dsh`）；同端口 `GET /` 仍是 401；headless profile 只停在 `MISSING_CREDENTIAL`。
- **一条新事实，值得单独记**：rc.3 的宿主把插件 bundle 的取法改成**必须带 `&rev=`**。boot manifest 广告的是 `plugins/??dsh-voice-call/client.js&rev=ece8910da42d`，按它取 → **200、70215 字节、`text/javascript`**，内容里能看到我们的类名与全部 `/voice/*` 路径；不带 rev 直接打 `plugins/??dsh-voice-call/client.js` → **404**。原因在 `@deepseek-ai/dsh-client-modules` 的 `bundleResource()`：它拿 `pathname + search` 去精确查一张预生成的表。我们自己的清单从不写死这个 URL（组合由宿主负责），所以插件不受影响——但文档里"打一次就是 200"那句从此不再成立，已经改掉。
- 桌面版这一版还换了 runtime 目录：node 现在在 `resources/runtime/bin/node`，pnpm 在 `resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`，旁边多一份 `runtime.json` 写着 `desktopVersion: 0.2.1-rc.3` 和自带 python 工具链。`versions.json` 说 pnpm 是 11.28.5，但在一个 PATH 上有全局 pnpm 11.23.0 的 shell 里直接跑那份 `pnpm.mjs --version` 会报 11.23.0——把 PATH 收干净后同一份文件报 **11.28.5**，而在 profile 里真正完成一次安装的也是 11.28.5。所以这不是 app 虚报，是"用外部 shell 调它自带的 CLI"这个动作会被 PATH 骗。

**这轮仍然没测到的**：桌面版此刻没在运行（进程列表里没有 `DeepSeek Harness.exe`），所以 0.2.1-rc.3 上的桌面 live probe 没做；设置卡渲染、铃声响起、接听后播完整句、装配进度条流式这四件事，还是得在真界面点一次才算数。更完版本记得重载插件或重启桌面版——插件不热加载。**本机 `desktop` profile 已经装到 0.3.13**（用 app 自带的 node 24.21.0 + pnpm 11.28.5 装，`package.json` 与 `pnpm-lock.yaml` 各留一份 `.pre-0.3.13.bak`；`node_modules/dsh-voice-call` 里 `client.js` 70144 字节，其余七个插件依赖原样没动），但 app 没启动，所以那份 0.3.13 还在盘上、没进内存——你下次打开桌面版加载的才是它。

**已经装着的用户**：0.3.12 在 0.2.1-rc.3 上本来就加载得进来（peer 一个字没改），所以这版更不更都不影响能不能用。真要更，拿到的字节和 0.3.12 完全一样——这是一次纯基线声明的更新。

## 0.3.12 —— 基线跟上 0.2.1-rc.2，并把"桌面版那份"和"npm 那份"逐文件对过

**这次要回答的不是"我们的代码在新版本上跑不跑"，而是"桌面版和 npm 装的同一个版本号，是不是同一份东西"。** 桌面版又一次跑在了 npm 前面：它的 `release.version` 已经是 **0.2.1-rc.2**，而 npm 的 `latest` 还停在 0.2.0-rc.2（`next` 才指到 0.2.1-rc.2）。绝大多数用户是在桌面版上装插件的，所以按这一版定下的规矩：**以桌面版为准**。

| 项目 | 改动 |
|---|---|
| devDependencies / CI | 锁到 0.2.1-rc.2（cordis `~4.0.5`、schemastery 解析到 3.18.5、`dsh-app-boot` 0.2.1-rc.2）。`pnpm-workspace.yaml` 里那份 `minimumReleaseAgeExclude` 随安装重生成，每个 `@deepseek-ai/*` 条目加上 `\|\| 0.2.1-rc.2`——这是这个仓库一贯的基线更版动作，阈值本身没动 |
| peerDependencies | **一个字没改**：`^0.1.7-rc.2 \|\| ^0.2.0-rc.1` 本来就含 0.2.1-rc.2。`@deepseek-ai/schemastery` 继续写 `^3.18.4`——桌面版 profile 里真实存在的那一份就是 3.18.4，把它抬到 3.18.5 等于把"我们实际跑的这份"排除在声明之外 |
| 判定函数自己变了形 | `evaluatePluginCompatibility` 返回结构里 `peers` 改名 `requirements`（测试跟着改）；更大的那条是新增的 `engines.dsh`：**清单里一旦有它，宿主只看它**，`peerDependencies` 完全不参与判定。我们故意不写——20 条 peer 全部生效，"代码摸到的每个 harness 包都被声明过"这条守卫才真的有力。写与不写两种走法现在都由用例钉着 |
| 声称的基线 | `SUPPORTED` = 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2 / 0.2.1-rc.2，两份依赖树各跑一遍：0.2.1-rc.2 一份，0.1.7-rc.2 一份（后者只把 `dsh-app-boot` 抬到 0.2.1-rc.2，因为加载判定本身是 0.2.0-rc.1 才存在的东西） |
| 源码 | 一行没动。三份 `tsc` 全过，客户端 bundle 仍是 70144 字节 |
| 测试 | 301 → **302**（新增那条 `engines.dsh` 正反两用）。CI 三平台实跑（run 39024760650，全绿）：Linux 302、Windows 302、macOS 304——多出的两条仍是只在有 `say` 的系统上才执行的集成用例；本地两份依赖树各跑一遍也都是 302 全绿 |

**逐文件哈希的做法**：桌面版自己把答案带在身上——`dsh/desktop-runtime.json` 里有 17261 条 `path → sha256`。先抽一份 asar 里的文件回算哈希核对（`dsh-app-boot/lib/index.js`，203572 字节，一字不差），确认这份索引可信，再拿它去比 `npm install @deepseek-ai/dsh@0.2.1-rc.2` 装出来的那棵树：

- 我们 `src/` 真的 import 的 18 个 `@deepseek-ai/dsh-*`，加上 cordis / schemastery / cosmokit，**服务端 JS 全部字节相同**。"同一个版本号在两种发行物里是同一份代码"这件事，第一次是被证明的，不是被假设的。
- 差异只有四类，都不改变行为：① `package.json` 里的 `scripts` 被删掉；② `.d.ts` 与 `.d.ts.map` 被剥光（所以桌面版那份树没法拿来编译——本仓库一直用 npm 那份，无影响）；③ 若干包多带一份 `lib/types/invariant.js`，而整棵运行时树里**没有任何一处 import 它**，`exports` 里也没有对应子路径，导不进来；④ `dsh-client-ui-chat` / `dsh-client-ui-conversation` 的 `lib/client.js` 是**另一次构建**——CSS module 的类名盐不同，注释里写着 `D:\develop\dsh-harness-windows-x64`，npm 那份是 GitHub runner 的 `/home/runner/work/deepseek-harness/…`。
- ④ 碰不到我们：客户端只用相对路径和自己的类名（`dsh-voice-call-overlay` 那一套），从不引用宿主的 module 类名；而注入目标 `dsh-client-ui-settings` 的 `client.js` 两边**字节相同**。
- **桌面版才有的那一条**：`desktop` profile 是 app 自己初始化的（`nodeLinker: hoisted` + `autoInstallPeers: false` 是它写死的模板，bundles 取 `web` 那份），profile 树里除插件外只有 `@deepseek-ai/schemastery@3.18.4` 与 `cosmokit@1.8.5`——pnpm 把我们（和另外三个插件）注入到这两份上，而宿主自己跑的是 asar 里的 3.18.5 / 1.8.6。**同一个进程里两份 schemastery**。插件不受影响，因为我们交给宿主的 schema 走 plain 对象桥接、不做 `instanceof`。
- profile 那份 `minimumReleaseAgeExclude` 是 `dshmarket` 在维护，不是宿主写的；实测过一次——刚发布、还在 pnpm 发布龄期里的版本会撞 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，profile 里留下的是旧版本。阈值不在 profile 那份文件里，`app.asar` 与两份 pnpm 发行物里也没找到写入点，这条如实留着。**实践结论：发完就让用户在桌面版上装，不成立。**
- **本轮实测**（2026-10-17，桌面版正在运行时）：宿主端口 `127.0.0.1:62998` 上 `/voice/call/state`、`/voice/provision/state`、`/voice/provision/disk` 三个只读端点全部 200，值取自 `desktop` profile（`tone: marimba`、`phase: ready`、`variantId: win-vulkan`、引擎 v0.8.36）；同端口 `GET /` 仍是 401。跑的是 0.2.1-rc.2 运行时 + profile 里的 `dsh-voice-call@0.3.11`。

**和 0.3.7 / 0.3.8 / 0.3.10 / 0.3.11 比，这一版没有 bug 可修**：缝隙都还在原处（`webServer.register` 依旧返回 disposer、判定函数的两种走法都有人看着）。它补的是认知上的一块空白——以前只知道桌面版"带的运行时是几号"，现在知道它和 npm 那一份**逐字节差在哪、那些差碰不碰得到我们**。

**已经装着的用户**：0.3.11 在 0.2.1-rc.2 上本来就加载得进来（peer 范围没变），所以这一版更不更都不影响能不能用；要更的话照旧——插件不热加载，重载或重启桌面版才算。设置卡渲染、铃声响起、接听后播完整句、进度条流式这四件事仍要在真界面点一次，我们没法替。


## 0.3.11 —— 重载之后，卡片照样来电

**三条路由活得比拥有它们的插件实例更久。** 0.3.10 里，路由是在 `ctx.inject(['webServer'], …)` 的回调里**直接调用 installer** 挂上去的：`mountRoute()` 只留了 `/voice/audio` 那一份返回值，`installCallCardRoutes` 与 `installProvisionRoutes` 交回来的 disposer 被当场丢掉。宿主的 webserver 把 handler 放进一张按 path 索引的表，而 `register()` 返回的那个 disposer 是**唯一的回收通道**——它不挂在任何 fiber 上，宿主不会替你保管。

于是插件一重载（插件页开关、市场里的 toggle、`patchReload: live` —— 这台机器就是 live），旧 handler 仍留在表里，而新实例的挂载在第一句就撞上 `webserver: duplicate prefix route "/voice/audio"`。异常发生在 `ctx.inject` 回调中段：后面两条 installer 从此不再执行，而表里应答的仍是**旧实例的 `CallBoard`**。

这一点比"报个错"更要紧：`/voice/call/events` 由没人振铃的那个 board 应答，新实例的 `CallCardRingChannel` 永远等不到订阅者，于是按设计退回 `ask` 弹窗。用户看到的是"卡片不灵了"，日志里只有一行 duplicate——**静默降级，不是崩溃**。

| 项目 | 改动 |
|---|---|
| 修法 | 新增 `src/web-mount.ts`：`mountWebRoutes(ctx, mounts)` 把三条 installer 各自包进 `ctx.effect(() => …, label)`；`src/index.ts` 把整份 mount 交给 `ctx.inject(['webServer'], (scoped) => …)` 的 **scoped ctx** |
| 为什么挂在 scoped ctx 上 | `ctx.inject(deps, cb)` 就是 `ctx.plugin({ inject, apply: cb })`：依赖变化或 fiber 卸载时，cordis 先释放这个子 fiber 上登记的 effect，再（必要时）重跑回调。挂在根 ctx 上就只能靠手工 `dispose()`——0.3.10 正是把那条手工线走断了 |
| 顺带 | 三条路由的挂载现在写在同一处（`src/web-mount.ts`），带标签（`voice-call: /voice/audio` 等），卸载时一起回卷；不再有"某个 installer 的返回值到底被谁接住了"这种问题 |
| 新增 `test/web-mount.test.ts` | 7 条用例，跑在**真 cordis `Context`** 上，配一个复刻宿主语义的假 webserver（撞 path 时抛同一句话，disposer 删表）：三条前缀一起挂 / 没配引擎时只挂两条 / 没有 webserver 时一条都不挂 / **fiber 卸载后路由表清空** / webserver 服务先卸载再提供后重新挂载（audio 前缀恰好尝试两次）/ 同一 fiber 重载后再激活不撞车 |
| 它第一次跑就咬到的东西 | 最后一条用例把 0.3.10 的挂载形状原样复刻（`let disposeRoute` + `mountRoute()` + 丢掉 `installCallCardRoutes` 的返回值）：断言"卸载后表里还留着两条路由"，并要求第二次激活抛 `duplicate prefix route "/voice/audio"`——这条负控就是这次修复的失败条件 |
| 测试 | 294 → **301**（新增 7 条）。三份 `tsc` 全过，`pnpm build` 干净，客户端 bundle 70144 字节不变（这次只动服务端）。三平台 CI 实跑：Linux 与 Windows 各 301 全绿，macOS 303——多出的两条仍是只在有 `say` 的系统上才执行的集成用例。Windows 的第一次跑红了一条时序用例（`test/provision-download.test.ts` 里「传输中途停了」那条），重跑即绿：同一个 run 38685211607 的第二次 attempt，三平台全绿 |

**和 0.3.7 / 0.3.8 / 0.3.10 不是同一个病，但根上仍是"没走宿主自己的入口"。** 那三次是"同一件事写了两处、测试只读了一处"；这次是**宿主把释放权交回你手里，而它被丢掉了**。所以新增的守卫不是比对两个常量，而是让插件在真 cordis 上**被卸载一次**，再看路由表是不是空的——那条负控同时证明：哪天有人再把 `ctx.effect` 摘掉，它会红。

**已经装着的用户**：只有"重载过插件"的会话受这一版影响；没重载过的 0.3.10 与 0.3.11 行为一致。更新后重载插件即可（客户端这次一个字没动）。

## 0.3.10 —— 第一次装好，浮出来的就是卡片

**这个插件的默认来电方式同时写在一个仓库的四处，而唯一对用户生效的那一处，从 v0.2 交付卡片那天起就没跟着动过。** `callMode` 分别写在：随包发布的 `cordis.patch.yml`、`Config` schema 的 `.default()`、`resolveConfig` 的 `??`、设置卡的显示回落 `FALLBACK`。0.3.9 时这四处**彼此一致**，都写着 `ask`——所以这不是"某个文件里打错了一个字"。

要紧的是优先级：`cordis.patch.yml` 是 `package.json` 里声明的 `dsh.bundle.patch`，也在 `files` 里，所以它是装插件时**真正写进 profile 的那一行**。那一行有值，schema 的 `.default()` 就永远轮不到。于是"默认是弹窗"这条事实被另外三处一致的样子掩护得很好，而**新用户实际拿到的从来只由第一处决定**。

作者自己的机器看不见这件事——他的 profile 早就照 README 的示例显式写了 `callMode: card`，用户那一行盖住 bundle 层。第一次交到别人手上（"我设法说服我弟弟装了一下"）就现形了：第一通电话是弹窗，不是那张花了整个 v0.2 做出来的卡片。

| 项目 | 改动 |
|---|---|
| 默认来电方式 | 四处一起翻成 `card`：`cordis.patch.yml`、`Config.default()`、`resolveConfig`、设置卡 `FALLBACK` |
| 为什么这个默认是安全的 | `card` 不等于"没卡片就拒接"。`CallCardRingChannel` 在没有 SSE 订阅者时退回 `ask` 弹窗，headless 组合照样有一条能接的路；这条回落关系现在由 `test/bundle-config.test.ts` 钉住 |
| 已有配置 | 显式写了 `callMode: ask` 的 profile **一个字都不受影响**——用户自己那行永远优先。这一版只改变"从没写过这个字段的人得到什么" |
| 新增 `test/bundle-config.test.ts` | 逐行读随包那份 `cordis.patch.yml`，把它钉的**每一个字段**和 `resolveConfig` 与 schema 的默认值对齐；`audioDir` 单独按"`~/.dsh/voice` 展开之后等不等于 `defaultAudioDir()`"比；并要求这些字段一个都不许悄悄消失（删一行就让守卫变红是这条测试的失败条件之一） |
| 它第一次跑就咬到的东西 | `Config['~standard'].validate({})` 对 `.volatile()` 字段返回的是 cosmokit 引用，不是字面值。直接拿它跟 patch 比，测试会"以错误的理由通过"；改成用仓库自己的 `plainConfig()` 拆开再比 |
| 为什么不用 YAML 库 | `yaml` 在这台机器上只是 `.pnpm/` 里的传递依赖，不是本插件声明的依赖。点名一个宿主不保证的东西，正是 `src/plain.ts:12-17` 为同一件事立的规矩——所以解析是手写的行解析 |
| 注释纠偏 | `src/channels/ring.ts` 的头注释还写着"v0.1 ships ONE channel"，并把来电卡片与 `direct` 列为 FUTURE——那两条通道 0.3.x 之前就都交付了。现在写成"四条通道，`callMode` 选一条，默认那条是卡片" |
| 测试 | 289 → **294**（守卫 5 条）。`pnpm typecheck` 三份（服务端 / 客户端 / 测试）全过，`pnpm build` 干净，客户端 bundle 70143 → 70144 字节。三平台 CI 实跑：Linux / Windows 各 294 全绿，macOS 296——多出的两条是只在有 `say` 的系统上才真的执行的集成用例（0.3.9 那次的分布是 289 / 289 / 291，同一对）。首页与部署文档按这个仓库的老规矩写**各平台共有的基数** |

**和 0.3.7、0.3.8 是同一个病。** 三次都是"声明有两处真相，测试只看了一处"：0.3.7 是插件自己的配置 schema 从没走过宿主的校验入口（一个 `volatile` 套 `volatile` 就能让插件完全不激活，而 270 个测试全绿）；0.3.8 是兼容性声明从没走过宿主的加载判定（0.2.0-rc.1 直接把整个 bundle 跳过，284 个测试全绿）；这次是"默认来电方式"从没被任何测试跟随包那一份对过。修法也一样，不是把值改对就收工，是把两处真相请进同一条断言——`pnpm pack` 出来的 tarball 里那三处产物（`cordis.patch.yml`、`lib/index.js`、`lib/client.js`）现在也是逐字段核过的。

**给已经装过的人：不用等这一版。** `callMode` 是 `.volatile()` 字段，打开「插件 → dsh-voice-call → 设置」，把「来电方式」选成**来电卡片**，下一次振铃就生效，不用重载插件也不用重启。（README 里"插件不热加载"说的是换版本那件事，不是这个字段。）

## 0.3.9 —— 基线 0.2.0-rc.2，并把桌面版查了一遍

dsh 的 `latest` 和 `next` 现在都指到 **0.2.0-rc.2**，同时 DeepSeek Harness 出了**桌面版**（`@deepseek-ai/dsh-desktop`，Electron 44，自带 node 24.18.1 与 pnpm 11.7.0）。这一版做两件事：把基线跟到 rc.2，以及把插件依赖的每条缝隙在桌面版实际装出来的那份运行时里逐条对过。

| 项目 | 改动 |
|---|---|
| devDependencies / CI | 锁到 0.2.0-rc.2（cordis 4.0.4、schemastery 3.18.4 未变） |
| peerDependencies | **一个字没改**：`^0.1.7-rc.2 \|\| ^0.2.0-rc.1` 本来就覆盖 0.2.0-rc.2，宿主的判定用 `includePrerelease` 跑，npm/pnpm 的默认语义也跑得过——这两条现在都由 `test/harness-compat.test.ts` 里新增的第三个基线验证 |
| 声称的基线 | `SUPPORTED` 现在是 0.1.7-rc.2 / 0.2.0-rc.1 / 0.2.0-rc.2。桌面版跑的就是 0.2.0-rc.2 这个运行时版本，所以这条清单同时也是桌面版的判定依据 |
| 源码 | 一行没动。客户端 bundle 字节数和上一版一致（70143） |

**桌面版查下来的事实**（都来自这台机器上装好的 `app.asar` 与它带的 `desktop-runtime.json`，不是猜的）：

- 桌面版**共用同一个 DSH home**（`~/.dsh`），profile 叫 `desktop`，和 `web` 各一份 `cordis.patch.yml`、各一份 `node_modules`。插件照常从 npm 装进这个 profile。
- 它带一个 per-version 的运行时清单：287 个共享包，我们声明的 **20 条 peer 全在里面**，版本一律 0.2.0-rc.2（cordis 4.0.4 / schemastery 3.18.4）。
- 界面跑在自定义 scheme **`dsh-app://app`** 上，页面对 `/voice/...`、`/plugins/...` 的请求由主进程 `forwardWebRequest` 转发到本机 `http://127.0.0.1:<随机端口>`。转发的目的是鉴权：它会把 `origin`、`sec-fetch-site`、`host`、`cookie` **统统删掉**，换上桌面版自己的 host cookie，非 `dsh-app://app` 的来源直接被主进程 403。
- 对我们的**写接口同源门**这意味着防线的**位置**变了，不是失效：桌面版里我们的路由既看不到 `Sec-Fetch-Site` 也看不到 `Origin`，于是走的是「非浏览器进程」那一支放行；真正拦跨站请求的是上面那道主进程门，而且比网页版更硬（端口带私有 cookie）。这一条现在写在部署文档里，免得以后有人以为我们的门还在第一线上。
- 我们自己的客户端只用**相对路径**（`fetch('/voice/…')`、`new EventSource('/voice/call/events')`），所以在 `dsh-app://app` 下天然解析到同一棵转发链，没有硬编码 `127.0.0.1` 的地方。scheme 注册时带了 `stream` 与 `supportFetchAPI`，转发函数也写明保留流与取消，所以两条 SSE（来电事件、装配进度）在这条链上是按设计工作的。
- 沙箱词表没变：`read-only / workspace-write / danger-full-access` 三种，本地引擎那条照旧能跑。
- **真正的桌面版特有风险**是版本耦合方式变了：npm 上 `latest` 和桌面版 feeds（`download.deepseek.com/dsh-desk/feeds/...`，channel 是 `nightly`）**各走各的**，桌面版可能带一个比 npm `latest` 更新、甚至不在我们声称范围内的运行时版本——那时宿主的判定会**静默跳过整个插件**，表现是"设置卡里突然没有 dsh-voice-call 这一项"。所以更该做的不是把范围写宽，而是别声称没跑过的版本，并让每次基线更版都真跑一遍。

验证：三份 `tsc` + 289 个用例在 0.2.0-rc.2 上全绿；0.1.7-rc.2 那套依赖树用的是同一份源码（0.3.8 时测过，本版源码未动）。桌面版本身的验收是**在你机器上点一次**——见 README 的桌面版一节。

## 0.3.8 —— dsh 0.2.0-rc.1 不再把插件整个跳过

**宿主把 peer 范围变成了加载判定。** 0.2.0-rc.1 的 `@deepseek-ai/dsh-app-boot` 里有一个 `evaluatePluginCompatibility`：它遍历插件清单的 `peerDependencies`，只看 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 这几条，拿正在运行的版本按 semver（`includePrerelease: true`）逐个套。只要有一条不含它，宿主就**不加载这个 bundle**——工具、路由、客户端节点一起消失，启动时只留一行：

```
dsh: skipping profile bundle "dsh-voice-call": Error: Plugin dsh-voice-call@0.3.7
is incompatible with dsh 0.2.0-rc.1: peerDependencies {…}. … grant the
exact-version exemption with `dsh plugin allow-version`, then retry …
```

`^0.1.7-rc.2` 的意思从来不是"0.1.7 之后都行"，它严格等于 `>=0.1.7-rc.2 <0.2.0`。以前它只换来一句警告，所以大家都写得随手；现在它决定插件在不在。而 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 那两条宿主不看——它只认 `dsh` 系列。

**这一版改了清单，没改行为：**

| 项目 | 改动 |
|---|---|
| peerDependencies | 每条 `@deepseek-ai/dsh-*` 写成 `^0.1.7-rc.2 \|\| ^0.2.0-rc.1`——两个基线都声称支持，0.3.0 不声称（没跑过就不写） |
| devDependencies 与 CI | 锁到 0.2.0-rc.1，cordis 跟着宿主升到 4.0.4 |
| 漏声明的缝隙 | `dsh-client-ui-chat`、`dsh-client-ui-conversation`、`dsh-client-ui-settings`、`dsh-api-session-controller`、`dsh-host-webserver` 补进 peer。`src/` 真的在 import 它们，而清单不写宿主就看不见这条缝隙，也就不会替你把住 |
| 源码 | 一行没动（只把一处注释里的版本号补上新基线）。三条赖以工作的缝隙在新树上原样存在，连行号都一样：`tools/execute` 在 `dsh-tools/lib/index.js:3331`，`user-questions/request` 在 `dsh-user-questions/lib/index.js:69`，`webServer.register(route): () => void` 在 `dsh-host-webserver/lib/types/index.d.ts:90`。客户端 bundle 在浏览器里唯一还要宿主给的东西仍然只有 `react` |
| 测试 | 284 → **289**，全部在 0.2.0-rc.1 上跑过。同一份源码另外在两套依赖树下各跑一遍：`tsc` 三份（服务端 / 客户端 / 测试）全过，289 个用例全绿——0.2.0-rc.1 一遍，0.1.7-rc.2 一遍 |

**新增 `test/harness-compat.test.ts`——把宿主自己的判定函数请进测试。** 它跑真清单，声称支持的每一个基线都要过；并且钉住三件事：devDependencies 锁的那个版本必须在声称的基线里；`src/` import 到的 `@deepseek-ai/dsh*` 包必须都声明成 peer；而 0.3.0（没跑过的大版本）必须**不过**——一条永远不会红的守卫不是守卫。

这个测试是 0.3.7 那条教训的同类项：那次是"配置 schema 没有一条测试走过宿主的校验入口"，这次是"兼容性声明没有一条测试走过宿主的加载判定"。它写完第一次跑就抓到了东西——上面那五个漏声明的包就是这么找出来的。

**给已经在 0.2.0-rc.1 上的人**：更到 0.3.8 插件就回来了。`dsh plugin allow-version` 能为"某个插件版本 + 某个运行时版本"发一张精确豁免状，那是明知未验证仍要跑，不是把未验证变成已验证。想自己确认加载状态：`dsh --profile web --dump-config` 的头几行就是宿主的判定输出。

## 0.3.7 —— 它会给你打电话，提醒你有问题在等你

以前「agent 停下来问你一件事」和「agent 永远停在那里」长得一模一样：harness 对问题的等待**没有任何超时**（`dsh-user-questions` 整条链上一个计时器都没有），而卡在问题上的 agent 也没法催你——它的循环停着。于是你走开五分钟，它就在那儿等五分钟。

这一版让插件替它看一眼表：

| 你会碰到什么 | 现在 |
|---|---|
| 问题弹出来，你走开了 | 到点（默认 5 分钟，可调 1/5/10/30）弹一张来电卡片：「有 2 个关于「部署方案」的问题在等你回答，已经等了 5 分钟」 |
| 你想听它念一遍 | 按**接听**，它念一句「有两个关于「部署方案」的问题需要你回答，请回到对话里选择」，念完卡片自己退 |
| 你回到对话里把题答了 | 卡片**自己收掉**，不需要你去关 |
| 你在卡片上按了拒接/稍后再说 | 只是把卡片弄没。**它从不替你回答**，问题还在原地等你 |
| 一批里有两道不相关的题 | 只报数量（「有 2 个问题」），不拿第一道题的标题给整批贴标签 |
| 卡片弹出来了但没有声音 | 卡片会写明原因：「浏览器拦住了铃声 —— 点一下这个页面就会响」。浏览器拒绝自动播放时本来就点一下就恢复，以前它只是不告诉你 |

它默认**关着**——设置卡里「等问题振铃（实验性新功能）」打开才生效，等多久在同一张卡上选。

这一版还修了两处「插件能把宿主带走」的地方，都是由这个实验功能暴露出来的：卡片应答的处理是跑在网页路由的请求处理里的，插件在那里抛出的任何异常以前会变成进程级的未捕获异常，把整个 `dsh web` 打死（现在围栏住，回一个带原因的响应）；以及插件自己的配置 schema 以前**没有任何测试**真的走一遍宿主的校验——一个 `volatile` 套 `volatile` 就能让插件完全不激活，而 270 个测试全绿。现在这两类都有测试拦着。

顺带一句：设置卡里「振铃超时（秒）」这一行改名叫「**铃声持续时间**」，功能一个字节没动，只是原来那个名字让人以为它在管别的事。

## 0.3.6 —— 同一套标准推到三个平台

CI 现在同时跑 Linux、Windows、macOS。加上之后它当场抓出四处只在别的系统上才存在的问题——Linux 上的清理根判定（原先手工读 `TMP/TEMP/TMPDIR`，那些变量在 Linux 上根本没设，于是 `/tmp` 不会被拒绝；现在改问 `os.tmpdir()`）、装配 fixture 里假的引擎文件缺了可执行位、两条按 Windows 想事情写的用例，以及 macOS 集成测试里一个模仿错了本体的假 harness 替身（生产代码一直是对的）。262 个测试在三个系统上全绿，macOS 那两条确认是**真跑了 `say` 并产出可读的音频文件**，不是被跳过去凑绿。

## 0.3.5 —— 这一版几乎全是「不用你操心」

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

## 更早的版本

| 版本 | 一句话 |
|---|---|
| 0.3.0 | 接听后的卡片留在屏上直到整段话说完（`active` 相位 + 后台任务对齐） |
| 0.2.0 | 专属来电卡片 UI（振铃动画、来电者身份），走 webserver 路由缝隙，载荷与预留的 RPC 契约逐字一致 |
| 0.1.x | 通话域 + crispasr 后端 + 本地播放，首次发布 npm |