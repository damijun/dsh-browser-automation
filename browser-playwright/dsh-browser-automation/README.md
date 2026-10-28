# dsh-browser-automation

让 **DSH 桌面端右侧边栏浏览器**（`@deepseek-ai/dsh-client-ui-sidebar-browser`）变成模型可稳定驱动的自动化目标：
每个标签页有一个稳定的 `pageId`，模型只传 `pageId`，插件内部每次重新解析 playwright-cli 的标签索引。

> 开发依据：`../vibe-coding-doc/attach.md`（机制与限制）、`../vibe-coding-doc/tool.md`（工具清单与契约）。

---

## 1. 结构

```
工具层  browser_*（14 个模型工具，只认 pageId）
   │
会话层  SessionManager：pageId 登记 / 会话归属 / 每页互斥锁
   │
连接层  CliBridge → playwright-cli -s=dsh …；PageDriver 负责 tab-select / eval / click …
   │
桥     ctx.connection.rpc  ←→  client.js（页面里的 ctx.sidebarRight.openTab）
```

三条不变量：

1. **索引是易失的中间产物，`pageId` 是稳定契约。** 每个工具调用都重新 `tab-list` 解析索引，绝不缓存。
2. **开页必须走 DSH 自己的 UI。** Electron 的 CDP 不支持 `Target.createTarget`，所以 `tab-new` 不能用；
   playwright-cli 也没有 `targetId` 参数。`browser_open` 由页面半边调用 `ctx.sidebarRight.openTab` 完成。
3. **收尾只 `detach`，绝不 `close`。** `browser_close` 只关一个标签页，不碰 DSH 进程。

---

## 2. 安装与前置条件

插件已经装进 `desktop` profile（bundle `@local/dsh-browser-automation`，row `browser-automation`）。
重新安装用 Plugin Manager 的 `install_bundle`，`target` 指向本目录；不要手改 profile 的 `package.json`。

**DSH 桌面端必须以远程调试端口启动**，否则 playwright-cli 无法附加：

- 快捷方式 → 属性 → 目标，在 exe 路径后面追加 `--remote-debugging-port=9222`，然后**完全退出并重启 DSH**。
- 验证：`Invoke-WebRequest http://127.0.0.1:9222/json/version` 能返回 JSON。

playwright-cli 默认假定已全局安装（`npm i -g @playwright/cli`）。插件用
`%PATH%` 里的 `playwright-cli.cmd` 找到它指向的 JS 入口，再用当前 Node 直接执行，
**不经过 shell**——所以带引号、方括号、`$` 的 ref 和表达式不会被任何引号规则破坏。

---

## 3. 工具

**启动方式只有两种**：`browser_open`（自己开新页）或 `browser_claim`（接管用户眼前那一页）。
其余工具都是在已登记的 `pageId` 上操作。除 `open` / `claim` / `list` / `status` 外，所有工具的第一个参数都是 `pageId`。

| 工具 | 作用 |
|---|---|
| `browser_open {url}` | 通过 DSH UI 新建侧边栏标签页 → 注入标记 → 返回 `pageId`。桥不可用即报错，**不会**复用现有标签页 |
| `browser_claim {note?}` | 接管用户眼前那一页（侧边栏可见的浏览器页），返回注入前的标题；替换旧标记，换新 `pageId` |
| `browser_list {scope}` | `session`（默认，本会话控制的页）/ `all`（含其他会话与未标记页），带实时索引 |
| `browser_close {pageId}` | **移除 DSH 侧边栏标签页本身**（`ctx.sidebarRight.close(tabId)`）并注销登记；不是 CLI 的 `tab-close` |
| `browser_snapshot {pageId, depth?}` | 可访问性快照（含 `[ref=…]`），内容原样返回，不做二次压缩 |
| `browser_screenshot {pageId, fullPage?, target?}` | 截图存盘，返回绝对路径（不内联字节） |
| `browser_click {pageId, ref, button?, double?, modifiers?}` | 点击 |
| `browser_fill {pageId, ref, text, submit?}` | 覆盖式填充 |
| `browser_press {pageId, key}` | 单键（Enter / Tab / Escape …） |
| `browser_goto {pageId, url}` | 导航；标记由 init script 自动续上，并再应用一次确认 |
| `browser_evaluate {pageId, expression}` | 求值，结果是 `JSON.stringify`（表达式必须是单表达式或 IIFE） |
| `browser_run_code {pageId, code}` | `playwright-cli run-code`；跑完会补一次标记（`setContent` 会抹掉它） |
| `browser_console {pageId, level?, limit?}` | 控制台日志，默认最后 50 行 |
| `browser_status {action}` | `status` / `attach` / `detach`；连接出问题先看它 |

**副作用（工具描述里已声明）**：每个操作都会 `tab-select`，即改变 playwright-cli 的 current tab，并把它停在目标页上。
`browser_claim` 会替换页面标记，原来那个 `pageId` 立即失效。

**`browser_claim` 找的是"用户眼前那一页"**，不是 playwright 的 current tab —— 后者是 CLI 自己的记账，
re-attach 后会回到应用页，也不跟随侧边栏切换。所以 claim 会先问页面半边：
它报告当前可见 `<webview>` 的 URL（隐藏的载体 box 尺寸为 0，被跳过），再用这个 URL 去 `tab-list` 里匹配。

### 单步 vs `run_code`

判据不是"页面结构是否已知"，而是**下一步做什么是否取决于上一步看到了什么**：

- 边走边看、路径依赖上一步返回值 → `snapshot` + 单步工具；
- 路径可预先写成代码（回归、批量抓取）、需要原子性抓瞬时状态 → `run_code`；
- 一次性静态提取 → `browser_evaluate`；
- 脚本失败 → 回到 `snapshot` 重新探索，不要盲目重试。

---

## 4. pageId 与标记机制

```
pageId = dshpg-<sha256(sessionId) 前 6 位>-<8 位随机>
```

打开/接管时，插件做两件事：

1. **装一个 init script**（`page.addInitScript`，走 `run-code`）：每次新文档加载都会先跑一遍，
   把 `[dshpg-…]` 追加到 `document.title`。这是标记能在**跨域导航后存活**的原因 ——
   普通注入在导航时随页面一起被销毁，点一个链接标记就没了。实测 `addInitScript` 跨 CLI 调用、
   跨导航、跨 origin 都保留。
2. **对当前文档立刻应用一次**（`eval` 同一段脚本）：init script 只对"下一次"加载生效。

同一段脚本里还做两件事：

- 先剥掉旧标记（claim 接管别的会话的页时不会留下两个标记）；
- 装 `MutationObserver` 监听 `<head>`，页面自己改标题（B 站、SPA 路由、未读角标）后**自动补回**，
  带 60ms 防抖，`title.includes(id)` 保证幂等、不会累积方括号；文档还没有 `<title>` 时用
  `setInterval` 追 4 秒。

于是 `playwright-cli tab-list` 的输出里就带着这个标记，`resolveIndex` 用**纯子串匹配**找它：

```
- 0: [dsh 侧边栏浏览器 — DeepSeek Harness](dsh-app://app/)
- 1: [哔哩哔哩 (゜-゜)つロ 干杯~-bilibili [dshpg-1a2b3c-9f8e7d6c]](https://www.bilibili.com/)
```

解析器处理了标题里含 `[` `]` `(` `)`、URL 里含 `)`、`(current)` 前缀、CRLF、索引漂移，
以及"零命中 → `PAGE_NOT_FOUND`（附带当前 tab-list 快照）/ 多命中 → `AMBIGUOUS_PAGE`（不自动选第一个）"。
单元测试见 `test/tab-list.test.js`。

标记带会话摘要，所以**即使插件重启、登记表丢失**，`browser_list` 仍能按标记把标签页归回原会话。
登记表只是缓存，标记本身才是真相。

---

## 5. 页面桥（为什么需要它）

`ctx.sidebarRight.openTab` 只存在于页面里，而 DSH 这一版没有给第三方 bundle 的
Host → Client 调用通道（`@deepseek-ai/dsh-api-remotes` 的转发事件是构建期白名单；
`ctx.connection.rpc.handle` 在本版本里会用调用方 context 去 `webServer.register` 而被 guard 拦掉，
实测不可用）。所以两个半边通过 Host 自己挂的一条 loopback 路由会合：

- Host：`ctx.webServer.register({ kind: 'prefix', path: '/dsh-browser-automation/bridge', … })`（`index.js`）
- 页面：`fetch(new URL('dsh-browser-automation/bridge/<action>', document.baseURI))`（`client.js`）

端点：`hello`（页面自报能力）、`poll`（长轮询取一条命令，15s 挂起）、`result`（回结果）、
`focus-tab`（截图前把标签页切到前台）。

用**文档相对 URL** 是关键：Web 上它解析到应用自己的 origin；Desktop 上 `dsh-app://app/<path>`
会被转发到 `http://127.0.0.1:<port>/<path>` 并注入 shell 的 cookie —— 页面完全不需要猜 origin，
也不用依赖 `__DSH_TRANSPORT__`。路由只接受 loopback socket、只收 POST、拒绝 `sec-fetch-site: cross-site`。

**注册前缀时必须去掉尾部斜杠**：`WebServer.match` 的规则是
`pathname === prefix || pathname.startsWith(prefix + '/')`，注册成 `/x/bridge/` 只能匹配 `/x/bridge//…`，
请求会静默落到 SPA fallback（GET 404 / POST 405）。

### 长轮询的两个坑（都已处理）

- **僵尸轮询**：页面刷新后，旧页面的那条 poll 还挂在 Host 里，socket 已死但 waiter 未清。
  命令投给它是白等 —— 所以取 waiter 用 **LIFO（最新优先）**，并且投递后 4s 内没有 `result` 就**重新入队**给下一个 poll。
- **空轮询热循环**：正常时 poll 被挂起 15s；若中间层不挂起而立刻返回空，客户端会空转 —— 加 120ms 下限。

### 开页只有一条路径

页面桥不可用（页面没连上、插件刚装还没刷新）时，`browser_open` **直接报错**，不会退化成"复用一个现有标签页"。

原因不是实现偷懒，而是正确性：

- 创建侧边栏标签页**只能**在页面里调 `ctx.sidebarRight.openTab`，Electron 的 CDP 不支持 `Target.createTarget`；
- 拿一个现有标签页去 `goto`，等于**猜测用户意图**，而且会覆盖那一页原来的内容 —— 用户可能正在里面填表；
- 桥不通是"插件/窗口状态"问题，修复动作很明确（刷新窗口），静默绕过只会让故障藏起来。

所以这个插件的**启动方式只有两种**，没有第三种：

| 模式 | 工具 | 需要什么 | 失败时 |
|---|---|---|---|
| 自己开新页 | `browser_open` | 页面桥（+ CDP） | 报错并给修复动作，**不动任何现有标签页** |
| 接管用户的页 | `browser_claim` | 页面桥（+ CDP）+ **侧边栏已展开且有可见的浏览器页** | 报错说明是"侧边栏没开"还是"页面还在加载" |

两条都依赖页面桥，但**已经登记的 `pageId` 不受影响**：`snapshot/click/fill/goto/evaluate/run_code/console/screenshot/close/list` 全部只走 CDP，
桥断了照样能用。`browser_status` 的 `modes: {open, claim}` 直接告诉你当前哪些模式可用。

> 侧边栏收起时页面不会被销毁（DSH 的 `keepMounted`），但它的 carrier 没有盒子尺寸，
> 页面半边因此报"看不见哪一页" —— 这就是 claim 要求"先展开侧边栏"的物理原因。

---

## 6. 配置

写在 `cordis.patch.yml` 里（本 bundle 自带一份默认值，用户层可覆盖）：

```yaml
- id: browser-automation
  name: '@local/dsh-browser-automation'
  config:
    session: dsh                 # playwright-cli -s=；所有 DSH 会话共用一个
    cdpUrl: http://127.0.0.1:9222
    command: playwright-cli      # 或绝对路径
    nodePath: auto               # 见下：哪个 node 去跑 CLI 的 .js 入口
    timeoutMs: 20000             # 单次 CLI 调用超时；超时重试一次然后报错
    requestTimeoutMs: 20000      # 等页面桥回答的时间
    screenshotSettleMs: 1200     # 截图前把隐藏页切到前台后，等首帧的时间
    debug: false                 # true 时用 console.debug 打印桥与 CLI 诊断
```

### `nodePath`：用哪个 Node 跑 CLI

Host 进程是 Electron，`process.execPath` 是 `DeepSeek Harness.exe` 而不是 node，所以跑
`playwright-cli.js` 必须显式挑一个真正的 node。三种取值：

| 值 | 顺序 | 适合 |
|---|---|---|
| `auto`（默认） | **DSH 自带 node**（`$DSH_HOME/dsh-runtimes/*/dependencies/node/bin/node.exe`）→ PATH → `ELECTRON_RUN_AS_NODE` 兜底 | 推荐。自带的那份一定存在、版本由 DSH 锁定，**不依赖桌面快捷方式继承的 PATH**（装完 Node 不重新登录就不在 PATH 里，这是最容易踩的坑） |
| `path` | 只用 PATH 上的 node；完全忽略自带那份 | 想跟全局 npm 安装环境严格一致时 |
| 绝对路径 | 就用这个文件；不存在直接报错 | 多版本共存、要固定某个 node 时 |

解析结果会出现在 `browser_status` 的 `cli.resolved` 里，带 `source`
（`dsh-runtime` / `path` / `process` / `config` / `electron-run-as-node`），一眼能看出这次用的是哪个。

截图和 playwright-cli 的快照文件落在 `%TEMP%\dsh-browser-automation\`，不污染工作区。

---

## 7. 已知限制（首版明确不做）

- **跨窗口多会话**：`ctx.sidebarRight.openTab` 没有 session 参数，永远作用于"当前屏幕上的会话"。
  同一个窗口里的多个 DSH 会话没问题（靠标记区分，已实测）；两个 DSH 窗口各自开页时，桥只能打开请求时在屏的那个会话的标签页。
- **`browser_screenshot` 只返回路径**，不内联图片字节（工具返回值必须是 lossless JSON；内联图片需要 attachments 服务）。
- **截图会把目标标签页切到前台**。Chromium 只给"被布局且在视口里"的 widget 出帧，而没被选中的侧边栏标签页
  所在的 cell 是 `display:none`（0×0），侧边栏收起时整列还被平移到视口外（实测 x=959、窗口宽 958）。
  所以 `browser_screenshot` 分两条路：
  - 目标页已经可见 → 直接用 `playwright-cli screenshot`（快，无副作用）；
  - 否则 → 页面侧按 chip 文本找到 `tabId` → 需要时先展开侧边栏 → `focus(tabId)` → 等 `screenshotSettleMs`（默认 1.2s）
    让首帧出来 → 用 Playwright API `page.screenshot({ timeout: 25000 })` 落盘。**截完不切回**，侧边栏停在被截的那页。
  图片尺寸 = 该标签页在侧边栏里的实际尺寸（例如 430×915），不是固定视口。
  只是读内容时用 `browser_snapshot`，它不依赖合成，永远可用。
- **关闭标签页必须走 DSH，不能走 CLI**。`playwright-cli tab-close <index>` 只销毁 CDP target，
  DSH 侧边栏的标签页会留下来变成空壳（显示"页面加载失败；请刷新重试或在系统浏览器中打开。"），
  而且仍然保持聚焦。只有 `ctx.sidebarRight.close(tabId)` 能真正移除它，所以 `browser_close` 是
  **UI 动作**（走页面桥），完全不用 CLI；桥不可用时它直接报错，不会退化成 `tab-close`。
  （旧版本留下的空壳页没有标记，`pageId` 也指不到它，需要手动点标签上的 × 关掉。）
- **`detach` 结束自动化会话**：DSH 与它的标签页毫发无损，但之后再操作会以全新的 attach 视图开始 ——
  已有的 `pageId` 不再解析（实测：detach 后重新 attach，`tab-list` 里看不到原来的 webview 目标），
  需要重新 `browser_open` / `browser_claim`。
- **页面自己改标题**后标记会在 ~60ms 内补回；若某个页面在标记补回前被 `tab-list` 读到，会得到
  `PAGE_NOT_FOUND`，重试一次即可。
- `browser_evaluate` 的表达式被 CLI 包成 `() => (expr)`，**语句列表会语法错误**，要用 IIFE。
- 侧边栏浏览器本身拒绝 `file:` / `data:` / 带凭据的 URL、以及和 DSH 应用同源的地址；插件在 Host 侧提前拦截并给出原因。
- `playwright-cli attach` 在 Windows 偶发卡住/守护进程竞争：超时 60s + 一次重试；仍失败建议
  `playwright-cli list` / `playwright-cli -s=dsh detach` 后重试。
- 侧边栏最多两个水平 pane，窄窗口下开页会进入全屏浮层——这是 DSH 的行为，插件不改。

---

## 8. 自测

```powershell
cd dsh-browser-automation
node --test
```

82 个用例，覆盖：

- `tab-list` 解析（真实三标签样本、含 `[]()` 的标题、含 `)` 的 URL、CRLF、零命中/多命中、索引漂移）；
- 标记脚本（追加、幂等、剥旧标记、页面改标题后补回、更新 `<title>` 的场景）——用 `node:vm` + 假 DOM 真跑；
- **两种启动模式的约束**：桥不在/从未连上/掉线三种状态都必须报错且**不碰 CLI**（断言没有任何
  `tab-select`/`goto`，也没登记 pageId）；claim 在"看不见页面"、"页面还没进 tab-list"、"可见 URL 带尾斜杠或 hash"
  各种情况下的行为；claim 换标记后旧 pageId 必须注销；
- **关闭必须是 UI 动作**：断言 `browser_close` 全程**零 CLI 调用**；页面侧找不到 chip 时报原因且不注销登记；
  桥不可用时直接报错（不退化成 `tab-close`）；非法 pageId 先被拒；
- **截图的两条路径**：可见页走 CLI 命令、隐藏页走"补 tabId→focus→长超时"；`fullPage` 透传；
  `target`（元素截图）必须留在 CLI 路径上；拿不到 tabId 时老实走普通路径；桥断了仍能走普通路径；
- **client 半边的 harness**：把真实的 `client.js` 按页面的方式载入，用假 `__ModuleLoader__` + 假
  `ctx.sidebarRight`/`ctx.layout` 跑 `apply()`。断言 `hello` 用文档相对 URL、`open-tab` 只调一次
  `openTab`、`prepare-capture` 在"已可见/隐藏/collapsed/找不到 chip/toggle 抛错"五种情况下的动作序列、
  `close-page` 真的调 `close(tabId)`、**collapsed 时坐标在视口外**（x=959、窗宽 958）必须判为不可见、
  失败只报一次、空轮询不空转。这一层就是"页面里才炸"的那类 bug 的护栏；
- 工具定义（自实现一遍 `assertSupportedJsonSchema` 子集，避免"装上才发现 schema 非法"）、渲染器、命名、无 `index`/`tab-new`/`targetId`；
  以及"运行时加的字段必须在 output schema 里声明"（这条抓到过两次真 bug）；
- CliBridge（shim → JS 入口解析、**Electron 里必须换用 PATH 的 node**、argv 不被引号破坏、非零退出、超时、取消、失败信息去掉 Node 栈）；
- 桥协议（长轮询、LIFO 投递、4s 未应答重投、结果落地、超时、页面失败、卸载、`clientState` 三态）；
- `SessionManager` 互斥、`discover` 的会话归属、`normalizeUrl` 规则、`samePage`、`sanitize` 的 JSON 安全。

### 验收记录（2026-10-28，真机）

| 用例 | 结果 |
|---|---|
| T1 `browser_open` 开真标签页、title 带 `[dshpg-…]` | ✅ 桥不可用时**报错且不动任何标签页**（已单测断言零 CLI 调用）；桥正常时新建标签页 |
| T2 双会话隔离 | ✅ 子会话拿到 `dshpg-82ae30-…`；我这边 `scope=session` 看不到它，`scope=all` 能看到 |
| T3 只传 pageId、内部解析索引 | ✅ 全程未手输索引 |
| T4 `snapshot → click → fill/press → goto` | ✅ 点击跨域跳转到 iana.org 后标记仍在；`run_code`+`setContent` 后标记被补回 |
| T4 `screenshot` | ✅ 可见标签页走 CLI 命令；隐藏标签页与收起侧边栏都能拍（见 §7） |
| T5 索引漂移 | ✅ 关掉 index 1 后，原 index 2 的 pageId 仍能解析 |
| T6 不依赖 `tab-new` / `targetId` | ✅ 单测断言源码中不出现 |
| T7 `detach` 不杀 DSH | ✅ 应用存活；重新 attach 后需重新 open/claim（见 §7） |
| T8 `browser_claim` | ✅ 接管"用户眼前那一页"：忽略 playwright 的 current tab，凭页面报告的可视 `<webview>` URL 找到它，返回原标题并换新 pageId；旧 pageId 立即失效，**其他标签页分毫未动** |
| T9 关闭后 `PAGE_NOT_FOUND` | ✅ 错误信息带当前 tab 列表摘要与下一步建议 |
| T10 解析单测 | ✅ 含 `[]()` 标题、`(current)`、多命中 |
| `browser_status.modes` | ✅ 实测 `{open:true, claim:false}`（无可见浏览器页时 claim 明确不可用），claim 随之给出"先展开侧边栏"的报错 |
| `browser_close` 真机 | ✅ 关掉后侧边栏 chip 真的少一个（tab48 消失）、webview 从 2 个变 1 个、CLI 视图同步变 2 行，**没有留下"页面加载失败"空壳**；被关的 pageId 立刻 `PAGE_NOT_FOUND`，另一页照常工作 |
| `nodePath: auto` 真机 | ✅ `browser_status.cli.resolved.source = dsh-runtime`，用的是 `~/.dsh/dsh-runtimes/dsh-primary-runtime/.../node.exe`（v24.21.0）；新起的 CLI daemon 进程确实来自该路径，开页/列页正常 |

---

## 9. 排障

| 现象 | 先做什么 |
|---|---|
| `Could not attach playwright-cli to DSH at http://127.0.0.1:9222` | DSH 没带 `--remote-debugging-port=9222` 启动；改快捷方式并重启 |
| `browser_open` / `browser_claim` 报 `needs the DSH page` | 页面半边没连上（`bridge.state` 为 `never`/`stale`）：刷新 DSH 窗口，1 秒内会自己重连；仍不行看 `bridgeError` |
| `browser_claim` 报 `Could not see a browser page` | 侧边栏没展开，或没选中浏览器标签页；展开并选中后重试 |
| `browser_claim` 报 `not in playwright-cli's tab list yet` | 页面还在加载：等一秒重试，或 `browser_list` 看 CLI 能看到什么 |
| `browser_status` 里 `bridge.clients` 为空 | 同上：页面还没加载 client.js，刷新窗口 |
| `bridgeError: cannot get property "webServer" without inject` | 插件 generation 过期：重启 DSH 让新代码生效 |
| `browser_screenshot` 报截图超时 | 那个标签页不在前台、没有渲染面；先切到前台（或改用 `browser_snapshot`） |
| `PAGE_NOT_FOUND` | 页面被用户关掉了、标记还没补回、或 CLI 被 detach 过；`browser_list` 看现状，再 `browser_open` / `browser_claim` |
| `AMBIGUOUS_PAGE` | 同一标题出现两个相同 `pageId`（几乎不可能是 bug 之外的原因）；`browser_list scope=all` 看全量 |
| CLI 超时 | `playwright-cli list`（看守护进程），必要时 `playwright-cli -s=dsh detach` |
| 启动即崩溃：`web boot: 1 entry did not activate / … import failed` | client bundle 的 revision 与内容不同步（改完 client.js 立刻刷新页面时出现）。**先把本行 disable**（`set_plugin enabled=false`）再启动，进应用后 enable，最后刷新一次页面 |
| `detach` 之后第一次操作很慢 | 正常：下一次操作会重新 `attach`（含一次重试） |

### 关于"启动即崩"

DSH 在 **boot 阶段**把"任一行激活失败"当致命错误，所以一个坏掉的插件会让整个界面起不来；
运行期 reload 失败只会让那一行不激活（有诊断、不崩）。这两个行为不一样，排障先分清。

改完 `client.js` 后不要立刻刷新页面，等 `plugin_manager` 那步完成。正确顺序：
改文件 → disable → enable（宿主侧生效）→ 刷新页面（客户端侧生效）。
| CLI 超时 | `playwright-cli list`（看守护进程），必要时 `playwright-cli -s=dsh detach` |
