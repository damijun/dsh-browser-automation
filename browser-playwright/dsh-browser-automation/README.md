# dsh-browser-automation

让 **DSH 桌面端右侧边栏浏览器**（`@deepseek-ai/dsh-client-ui-sidebar-browser`）变成模型可稳定驱动的自动化目标：
每个标签页有一个稳定的 `pageId`，模型只传 `pageId`，插件内部每次重新解析 playwright-cli 的标签索引。

> **仅适用于 DSH 桌面端。** Web 版（浏览器里的 DSH）没有可附加的 CDP 端点，所有 `browser_*` 工具都驱动不了它的标签页，
> 也没有侧边栏 `webview` 可分帧。插件本身不判断平台：它连的是 `cdpPort`，连不上就报错。
>
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

> **已知待修（已写规格）**：CLI 的"当前页"是 daemon 全局状态，而当前互斥是按 pageId 分的，
> 所以两个 DSH 会话同时操作**不同**页面时可能互相踩到对方页上。修法与验收见
> [`docs/concurrency-fix.md`](docs/concurrency-fix.md)（尚未实现）。

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
| `browser_open {url}` | 通过 DSH UI **新建**侧边栏标签页 → 注入标记 → 返回 `pageId`。只在真的需要多一个 tab 时用（见下方"少开 tab"）。桥不可用即报错，**不会**复用现有标签页。**后台会话**走内部的 `openTabIn`，结果带 `background: true`（不聚焦、不可截图），见 §7.3 |
| `browser_claim {note?}` | 接管用户眼前那一页（侧边栏可见的浏览器页），返回注入前的标题；替换旧标记，换新 `pageId` |
| `browser_list {scope}` | `session`（默认，本会话控制的页）/ `all`（含其他会话与未标记页），带实时索引。**开页前先看这里** |
| `browser_close {pageId}` | **移除 DSH 侧边栏标签页本身**（`ctx.sidebarRight.close(tabId)`）并注销登记；不是 CLI 的 `tab-close`。用完的页顺手关掉 |
| `browser_snapshot {pageId, depth?}` | 可访问性快照（含 `[ref=…]`），内容原样返回，不做二次压缩 |
| `browser_screenshot {pageId, fullPage?, target?}` | 截图存盘，返回绝对路径（不内联字节） |
| `browser_click {pageId, ref, button?, double?, modifiers?}` | 点击 |
| `browser_fill {pageId, ref, text, submit?}` | 覆盖式填充 |
| `browser_press {pageId, key}` | 单键（Enter / Tab / Escape …） |
| `browser_goto {pageId, url}` | 让该 tab 进入这个 URL（**换地址的默认方式**：不新增 tab、`pageId` 不变）；**先把 tab 切到前台**，用户能看见；标记由 init script 自动续上并复核 |
| `browser_reload {pageId}` | 重新加载该页 —— 实现为 **`goto` 同一个 URL**，同样先切到前台。**绝不用 `playwright-cli reload`**：实测它会刷新整个 DSH 页面（无论当前选中哪个 tab），侧边栏页面全丢 |
| `browser_run_code {pageId, code}` | `playwright-cli run-code`；跑完会补一次标记（`setContent` 会抹掉它），并把新 `title/url` 回写登记表。**读值也走这里**：`return await page.evaluate(() => document.title)` / `return await page.locator('a').allTextContents()`。历史导航 `page.goBack()` / `page.goForward()` 同样在这里用，不做单独工具 |
| `browser_console {pageId, level?, limit?}` | 控制台日志，默认最后 50 行 |
| `browser_status {action}` | `status` / `attach` / `detach` / `panel`；连接出问题先看它，`panel` 打开状态面板 |

**少开一个 tab 的判据**：侧栏同一时刻只显示一个 tab，每个 tab 都是一张活页面，用户还得自己关。
所以"要去另一个地址"本身**不是**开新 tab 的理由——只要当前这页的状态不重要，`browser_goto` 就是更便宜的做法：
不新增 tab、`pageId` 不变、标记自动续上。只有下面这些情况才用 `browser_open`：

- 两页要**同时存在**（对照、反复来回、跨页取信息）；
- 当前页的状态（登录、表单、滚动位置、进行中的操作）**不能丢**；
- 这个会话还没有任何自己的页。

`browser_open` 从不接管已有 tab（那会毁掉用户正在做的事）；要接管用户眼前那页用 `browser_claim`。

**可见性约定**：`browser_goto`、`browser_reload`、`browser_click`、`browser_fill`、`browser_press` 都会**先把目标 tab 切到前台**（必要时展开收起的侧边栏）再执行，这样用户能看到插件在做什么。聚焦是尽力而为：定位不到 tab 时操作照常进行，失败时报真实原因。

**副作用（工具描述里已声明）**：每个操作都会 `tab-select`，即改变 playwright-cli 的 current tab，并把它停在目标页上。
`browser_claim` 会替换页面标记，原来那个 `pageId` 立即失效。

**`browser_claim` 找的是"用户眼前那一页"**，不是 playwright 的 current tab —— 后者是 CLI 自己的记账，
re-attach 后会回到应用页，也不跟随侧边栏切换。所以 claim 会先问页面半边：
它报告当前可见 `<webview>` 的 URL（隐藏的载体 box 尺寸为 0，被跳过），再用这个 URL 去 `tab-list` 里匹配。

### 状态面板（`browser_status action=panel`）

给**人**看的一面：只读，除两个全局动作（断开 / 重新连接）外不提供任何操作。
它在右侧边栏开一个**会话级**标签页（`browser-automation` 类型），显示：

- 连接：CDP 是否附着、桥的 `state` 与客户端数、挂起轮询数、`bridgeError`
- CLI 解释器：实际用的 node（文件名）、命令、`-s=` 会话名
- 启动模式：`新开标签页` / `接管可见页` 当前是否可用
- 本会话的页面：`pageId`、来源（`open` / `claim`）、标题、URL、是否 current
- 两个按钮：`断开 CLI`（= `detach`，提示里写明会让已有 `pageId` 失效）、`重新连接`

为什么是会话级标签页而不是左栏的全局页面：全局页面会替换主栏的对话，而侧边栏浏览器的挂载点依赖
"会话在屏"（`mounted = sessions.onScreen`），面板开着时 `browser_open` / `browser_claim` 会直接不可用 ——
一个报告状态的面板不该把它报告的东西关掉。面板标题在打开时捕获，所以改语言后重开即可。

### `browser_status` 返回什么

这份 JSON 是**三条独立链路**的体检报告，混在一个对象里。一条断了不影响另一条（CLI 可能连着但没有任何页面客户端，反之亦然）。

| 字段 | 说明 |
|---|---|
| `attached` | **这次调用是否读到了 tab-list**。`status` 会在没连上时顺手 attach，所以 `true` = "现在能看见应用里的页面"；`false` 时看 `note` |
| `cdpUrl` | 插件连的调试端点，由 `cdpPort` 与固定主机 `127.0.0.1` 拼出来（`cdpPort` 必须等于桌面端的 `--remote-debugging-port`） |
| `currentIndex` | playwright-cli **自己的**"当前页"指针。daemon 全局状态，任何 `browser_*` 都会改它；re-attach 后回到应用页 |
| `cli.command` / `cli.session` | 配置的命令名、`-s=` 会话名（所有 DSH 会话共用一个 daemon） |
| `cli.resolved.node` | 实际跑 CLI 的 **node 解释器**（Host 是 Electron，`process.execPath` 不是 node） |
| `cli.resolved.entry` | shim 指向的 JS 入口；`command` 本身就是可执行文件时为空串 |
| `bridge.state` | `live` = 60s 内有页面真的挂着 poll（唯一能收命令的状态）；`stale` = 曾挂过但最近没动静；`never` = 从来没有（客户端半身没跑起来） |
| `bridge.pendingRequests` | 宿主发出、正在等页面回答的请求数（例如 `browser_open` 等回执） |
| `bridge.queuedCommands` | 已产生但还没交到任何 poll 手里的命令数（4s 未送达会重投） |
| `bridge.heldPolls` | 页面正挂着的长轮询数。空闲正常态是 1；刚被消费掉时会是 0 |
| `bridge.clients[]` | 每个加载了插件客户端的**应用页**一条（不是侧边栏里的网页） |
| `clients[].clientId` | `sessionStorage` 里随机 UUID 的前 8 位：刷新不变、新 tab 会变。投递命令靠它，也用来对日志 |
| `clients[].seenAgoMs` / `polled` | 距上次被看见多久 / 是否**曾经**挂过 poll（只有挂过才可能收命令） |
| `clients[].carrier` | `desktop`（`dsh-app:` 自定义协议）或 `web`。**只有 desktop 能用** |
| `clients[].hasSidebarRight` | 页面里有没有 `ctx.sidebarRight`。它是"open 为什么失败"的唯一解释，正常恒为 true |
| `clients[].mounted` | `sessions.onScreen`：当前填满主栏的**DSH 会话 id**（`session-<uuid>`）；`null` = 主栏被全局页面（插件/技能/自动化任务/上下文洞察）占了、在 hero 屏，或会话视图还没挂载。**为 null 时不能开页** |
| `clients[].activeTabId` | 右侧边栏**当前聚焦的标签页** id（`tabN`，内部 UI id，会重新铸造，不是 pageId） |
| `clients[].visibleUrl` | 用户**真正看得见**的那个侧边栏网页 URL；`null` = 没聚焦浏览器页（可能在面板/文件标签上，或侧边栏收起） |
| `modes.open` | 桥 `live` —— `ctx.sidebarRight.openTab` 能被执行 |
| `modes.claim` | 桥 `live` **且** `visibleUrl` 非空（为此外发一次 `ping`，几毫秒）。真正的 claim 还会复核侧边栏是否收起、URL 能否在 tab-list 里匹配 |
| `pages[]` | **唯一的标签页列表**：每个 CDP target 一行，含 `pageId`/`session`/`mine`/`source`。已不再单独返回原始 `tabs`（它是 `pages` 的子集） |
| `pages[].pageId` | 标题里标记解析出的稳定句柄；没有标记时 `null` |
| `pages[].session` | 归属的 DSH 会话；`dsh-app://…` 标成 `application`，有标记但未登记标成 `session-tag:<tag>` |
| `pages[].mine` | 是否属于**调用这个工具的会话**（只有带标记的行才有） |
| `pages[].source` | `open` / `claim` / `discovered`（标记是我的但登记表没记录，通常是重新加载后） |
| `bridgeError` | 桥路由挂载失败时才有值（端口冲突等），正常 `null` |

`pages` 与"原始 tab-list"的关系：`tabs[].index` 是唯一能喂给 `tab-select` 的寻址方式，`pages` 原样保留了 `index`/`current`/`title`/`url`，所以不再重复输出一份。

---

### 单步 vs `run_code`

判据不是"页面结构是否已知"，而是**下一步做什么是否取决于上一步看到了什么**：

- 边走边看、路径依赖上一步返回值 → `snapshot` + 单步工具；
- 路径可预先写成代码（回归、批量抓取）、需要原子性抓瞬时状态 → `run_code`；
- 一次性读取（`page.evaluate` / `locator(...)`）→ 也走 `run_code`，**没有单独的 evaluate 工具**；
- 脚本失败 → 回到 `snapshot` 重新探索，不要盲目重试。

### 为什么只有一个 `run_code`，没有 `evaluate`

`evaluate` 是 `run_code` 的子能力：`return await page.evaluate(() => …)` 与旧的 `playwright-cli eval` 等价，
而 `run_code` 还能用 locator、键盘、导航、等待。两个工具并存只会让模型多一次「该用哪个」的选择，
并且两套超时/错误/返回形状要各自维护。所以只保留 `browser_run_code`：

- 读值：`return await page.evaluate(() => document.title)`
- 读元素：`return await page.locator('a').allTextContents()`
- 要结构化返回就自己 `JSON.stringify`（返回的是字符串，原样回传）

代价：`run_code` 每次多一次 CLI 调用（跑完补标记），只读操作也一样。

### 工具结果里没有 tab index

模型只按 `pageId` 寻址，所以**普通工具的结果里不含 tab index**（`browser_open`/`claim` 的提示文案里也没有，
`browser_list` 的行首也不再带 `[index]`），index 属于 driver 层内部细节。目前只有诊断工具
`browser_status` 还保留 `currentIndex` 与 `pages[].index`：它是给**人**对照 `playwright-cli tab-list` 用的，
调用频率低。如果以后要彻底去掉，用行内的 `current: true` 替代即可。

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

于是 `playwright-cli tab-list` 的输出里就带着这个标记：

```
- 0: [dsh 侧边栏浏览器 — DeepSeek Harness](dsh-app://app/)
- 1: [哔哩哔哩 (゜-゜)つロ 干杯~-bilibili [dshpg-1a2b3c-9f8e7d6c]](https://www.bilibili.com/)
```

**但从 2026-10-30 起，标记不再是寻址的唯一依据。** 同一段 init script 还把身份写进页面内部：

```js
window.__dshBrowserAutomation = { pageId, dispose }   // pageId 才是寻址真相
```

## 4.1 双向映射（一次 `run-code` 各一次）

```text
resolveTabIndex(pageId)   pageId         -> tab-list index
resolvePageId(tabIndex)   tab-list index -> pageId
```

两者都基于 `src/page-catalog.js`：**一次** `page.context().pages()`，对每个页面读
`window.__dshBrowserAutomation.pageId` / `document.title` / `location.href`（每页一次 `evaluate`，
单页 3 秒超时，单页失败不影响其余页面）。

- **顺序契约**：`context.pages()[index]` 与 `tab-list` 的 index 一致。本环境（Electron webview、
  5 个 tab、应用页在 0）逐项实测一致；`current` 由 `candidate === page` 推导，不需要额外 CLI 调用。
- **不缓存**：index 只在本次调用内有效（用户随时可能关标签页）。
- **首次匹配即返回**（迁移计划 §4.6）：不收集、不产生 `AMBIGUOUS_PAGE`。
- **标题 marker 是"会报告的兜底"**：页面内身份取不到时（旧版本打开的页、init script 被拒），
  才会按标题 marker 匹配，并在日志里写明 `using the title marker at index N`；返回值的
  `addressedBy` 字段是 `'page'` 或 `'title'`，调用方能看见走了哪条路。
- 找不到时 `PAGE_NOT_FOUND` 会**附带当前打开页的清单**（`0: dsh-app://app/ (unmarked); 1: https://… (dshpg-…)`），
  并提示"重开/重新 claim"。

## 4.2 分层与职责

**分层规则**：runtime 层只认 `pageId`（AI 传进来的就是它）；解析一次之后，driver 层只认 `tab`
（内含 `index` / `current` / `pageId`）。driver 里只有三个解析函数"说 pageId"，其余动作全部收 `tab`。

```text
runtime.browser_xxx({ pageId, … })
  -> requirePageId(pageId)             格式检查（validPageId）
  -> SessionManager.withLock(pageId)   同一个 pageId 串行，不同 pageId 并行
  -> driver.resolvePage(pageId)        一次 catalog -> tab { index, current, title, url, pageId }
  -> operation(driver, tab)            工具体
       -> driver.click(tab, options)   driver 层：只用 tab.index 选页
            -> executeOnResolvedTab(tab, () => CLI 动作)
                 tab-select（仅当 !current）+ 执行 + 失败时用 tab.pageId 重新解析一次
```

- `executeOnResolvedTab(tab, operation)` **只收 tab**：重新解析需要的 pageId 就在 tab 上。
- **没有 `withPage`、也没有 `driver.resolve` 别名**：解析只发生在 `resolvePage`，执行只发生在
  `executeOnResolvedTab`，同一页在一次调用里只解析一次。
- `browser_open` / `browser_claim` 是唯一"先有 pageId 再补 tab"的方向：把 mint 出来的 pageId 合进 tab
  （`{ ...found, pageId }`）后交给 `installMarker(tab)`，所以标记函数也只收 tab。

## 4.3 attach 是"先探活"

`ensureAttached()` **总是先 `tab-list` 探活，失败才 `attach`**，包括进程内 driver 还是全新实例的时候。

原因不是省一次调用：`attach` 会开一个新的 CDP 会话，而 playwright-cli 只收养 attach 之后创建的侧边栏页面 ——
对活着的会话再 attach 一次，**用户已经开着的页面会全部失联**（实测：界面 4 个 tab，`tab-list` 只剩应用页）。
`force: true` 仍然强制重新 attach（诊断用）。

标记带会话摘要，所以**即使插件重启、登记表丢失**，`browser_list` 仍能按标记把标签页归回原会话。
登记表只是缓存，标记本身才是真相。

## 4.4 页面动作只对"本会话的页面"开放

页面动作（`snapshot`/`screenshot`/`click`/`fill`/`press`/`goto`/`reload`/`run_code`/`console`）
要求页面的归属等于调用方会话，否则报 `PAGE_FOREIGN_SESSION` 并且**不执行任何动作**：

- 归属来源：登记表里的完整 `sessionId`；登记表没有记录（插件重启）时，用 pageId 里的 6 位会话 tag 比对；
- `browser_list scope="all"` 仍然**列出**别的会话的页面（诊断用），但列出 ≠ 可操作；
- 想接管别人的页面，用 `browser_claim`（它会把页面重新标记并登记到当前会话）——这是唯一被认可的途径；
- 没有会话上下文的内部调用（诊断脚本）不校验。

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

两条都依赖页面桥，但**已经登记的 `pageId` 不受影响**：`snapshot/click/fill/goto/run_code/console/screenshot/close/list` 全部只走 CDP，
桥断了照样能用。`browser_status` 的 `modes: {open, claim}` 直接告诉你当前哪些模式可用。

> 侧边栏收起时页面不会被销毁（DSH 的 `keepMounted`），但它的 carrier 没有盒子尺寸，
> 页面半边因此报"看不见哪一页" —— 这就是 claim 要求"先展开侧边栏"的物理原因。

---

## 6. 配置

有两种改法，落点是**同一处**：profile 的 `cordis.patch.yml`。

### 6.1 设置卡片（推荐）

左侧「插件」→ 搜「侧边栏浏览器自动化」→ 点进去，页面里有「浏览器自动化配置」卡片：

- 卡片可折叠（点标题行），每项下面一行说明；
- 只有几个确定取值的项用**分段按钮**：`Node 路径` = 自动 / PATH / 自定义路径（选自定义才出现输入框）、`调试日志` = 关闭 / 开启；其余是文本框 / 数字框；
- 改过的项会显示「已覆盖」徽标和「恢复默认」；右下角「保存」把所有改动一次写入；
- 保存走宿主 `ctx.configEditor.edit()`，也就是**只写 override 层**，`config` 里只出现你真正改过的键。
- ⚠️ **保存本身不会重载运行中的这一行**（实测：写完 patch 后实例仍跑旧值，`config-set` 返回 200 但 `effective` 未变）。
  要生效：**重启 DSH**。
- **刻意不做热生效**：配置在 `apply()` 里一次性快照，之后不再读。Schemastery 的 volatile 字段本质是
  "Loader 会 commit 进去的稳定引用"（`createVolatile` / `updateVolatile`），理论上可以做成热更新，
  但那会让行为在运行中途变化（超时、CLI 会话名、命令路径都会换），排查成本远大于收益。
  **改配置 = 重启，行为可预测。**

写到 patch 里的形状永远是三段：

```yaml
- id: browser-automation
  name: '@local/dsh-browser-automation'
  config:
    debug: true
```

清空所有覆盖后是 `config: {}`，这一行可以整段删掉（删掉等于全部用默认值）。
宿主若没有 `configEditor`，卡片会退化成只读并说明原因。

### 「正在与智能体共享」标记（showSharedBadge，默认开）

被插件接管/打开的页面，右上角会出现一个悬浮标记：绿点 + 「正在与智能体共享」。

- **为什么画在页面里**：侧边栏每个标签页的标题槽位只对插件自己注册的面板型标签页开放（按 pane id 键控），
  DSH 自有的浏览器标签页没有对外装饰接口。页面是本插件完全掌管的表面，且注释脚本（init script）会在
  **每次导航后自动补回**标记。
- **不干扰页面**：position:fixed + z-index:2147483647 + **pointer-events:none**（永远不会吃掉点击），
  内部用 shadow root + ll:initial，页面的 CSS 既改不动它也污染不到页面。
- **什么时候出现**：rowser_open / rowser_claim 成功之后立即出现；goto、
eload 后自动补回。
- **什么时候消失**：关闭该标签页；或下一次导航后（插件已卸载/停用、注释脚本不再安装）；showSharedBadge: false 则从不出现。
- 它是**页面内的 DOM 节点**（id="__dsh-ba-shared__"），页面自己的脚本理论上能删掉它 —— 这不影响功能，只是标记会没。
- **已知替代方案（未实现）**：把标记移到 DSH 界面层（`shell.overlay`，叠在 URL 栏右侧），完全不进截图、也不碰页面 DOM。
  实现规格见 [docs/shared-badge-overlay.md](docs/shared-badge-overlay.md)（含实测锚点、定位启发式、追踪策略、风险与回退）。

### 6.2 直接改 YAML

```yaml
- id: browser-automation
  name: '@local/dsh-browser-automation'
  config:
    session: dsh                 # playwright-cli -s=；所有 DSH 会话共用一个
    cdpPort: 9222                # 见下：必须和启动参数一致
    showSharedBadge: true        # 页面右上角「正在与智能体共享」标记（见 6.1）
    command: playwright-cli      # 或绝对路径
    nodePath: auto               # 见下：哪个 node 去跑 CLI 的 .js 入口
    timeoutMs: 20000             # 单次 CLI 调用超时；超时重试一次然后报错
    requestTimeoutMs: 20000      # 等页面桥回答的时间
    attachTimeoutMs: 60000       # CLI 附着的最长等待（Windows 上偶发卡住，超时重试一次）
    screenshotTimeoutMs: 25000   # 单次截图抓取的截止时间
    screenshotSettleMs: 1200     # 截图前把隐藏页切到前台后，等首帧的时间
    debug: false                 # true 时用 console.debug 打印桥与 CLI 诊断
```

> ⚠️ **`cdpPort` 只是"告诉插件去哪里找"，不会改变 DSH 监听哪个端口。**
> 这个端口由 **DSH 桌面端的启动参数**决定（快捷方式 → 目标后面加 `--remote-debugging-port=9222`）。
> 所以换端口要做**两件事**：改启动参数、把这里改成同一个数字。只改这里，插件会连到一个没人监听的端口。
>
> 为什么只有端口：Electron 的调试端口**只绑回环地址**（`127.0.0.1`），主机名是固定的，不需要也不能配。
>
> 旧版本的 patch 里如果写的是 `cdpUrl: http://127.0.0.1:9222`，仍然会被识别（从中解析端口），
> 但设置卡片不显示它；确认新值后可以把那行删掉。

### `autoAttach`：开机自动 attach（默认开）

**为什么需要**：`playwright-cli` 只收养 **attach 之后新建**的侧边栏页面。attach 发生在用户开页之后，那页就永远进不了
`tab-list`（`browser_claim` 也拿不到，只能重开）。所以插件在**激活时**（DSH 启动后约 0.5s）就 attach 一次，
把边界移到用户第一张页之前。失败会退避重试（0.5s 起、约 8 秒内共 10 次）；全程不抛错、不阻塞启动。

- **可见性**：结果在 `browser_status.cli.autoAttach`（`{ok, at, error, attempts}`）与状态面板「开机自动连接」一行；
  失败显示红字原因，不会被静默吞掉。
- **代价**：DSH 运行期间常驻一个 `playwright-cli` daemon（含 playwright-core，约 60–150MB RSS），即使用户不用插件。
- **只支持一个 DSH 实例**：daemon 以 `-s=dsh` 命名，两个实例会抢同一个 daemon（各自指向不同 CDP 端口时必然冲突）。
- **关掉也能用**：`autoAttach: false` 时退回"第一次工具调用才 attach"——那时**已开着的页**属于"已存在"，要重开才能驱动。
- **它不解决**：本次 attach 之前就开着的页；以及任何中途 `detach` / daemon 被杀之后的旧页（重新 attach 等于新会话）。
  
**如果不想开机自动attach:** 在打开网页之前先打开浏览器自动化监控面板,这会attach一次,之后再打开网页就能被 `playwright-cli` 看到了

### `nodePath`：用哪个 Node 跑 CLI

Host 进程是 Electron，`process.execPath` 是 `DeepSeek Harness.exe` 而不是 node，所以跑
`playwright-cli.js` 必须显式挑一个真正的 node。三种取值：

| 值 | 顺序 | 适合 |
|---|---|---|
| `auto`（默认） | **DSH 自带 node**（`$DSH_HOME/dsh-runtimes/*/dependencies/node/bin/node.exe`）→ PATH → `ELECTRON_RUN_AS_NODE` 兜底 | 推荐。自带的那份一定存在、版本由 DSH 锁定，**不依赖桌面快捷方式继承的 PATH**（装完 Node 不重新登录就不在 PATH 里，这是最容易踩的坑） |
| `path` | 只用 PATH 上的 node；完全忽略自带那份 | 想跟全局 npm 安装环境严格一致时 |
| 绝对路径 | 就用这个文件；不存在直接报错 | 多版本共存、要固定某个 node 时 |

解析结果会出现在 `browser_status` 的 `cli.resolved.node`（哪个 node）与 `entry`（哪个 JS 入口）。
"这个 node 是哪来的"（`dsh-runtime` / `path` / `process` / `config` / `electron-run-as-node`）只写进宿主日志：
它只在跑不起来时有用，不占工具返回值。

截图和 playwright-cli 的快照文件落在 `%TEMP%\dsh-browser-automation\`，不污染工作区。

---

## 7. 已知限制（首版明确不做）

- **只在 DSH Desktop 可用，Web profile 不支持。** 两条独立原因：
  ① Web 版跑在普通浏览器里，**没有 CDP 端点**（没有 `--remote-debugging-port=9222`），`playwright-cli attach` 无处可附；
  ② 侧边栏浏览器在 Web 里不是 Electron `<webview>`，`tab-list` 里永远只有应用页本身。
  表现是 `browser_open` 报"连不到页面桥"或 `tab-list` 看不到新页 —— 这不是 bug，是载体不同。
  同一份 `client.js` 在 Web 里仍会挂载并连接桥（它按文档相对 URL 解析），但没有任何页可驱动。
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
- **CLI 只收养"attach 之后新建"的侧边栏页面**。Electron 通过 CDP 暴露了所有侧边栏页面（`/json/list` 里是 `webview` 类型），
  但 `playwright-cli tab-list` 只跟踪 attach 之后创建的 target：**用户手动打开的页、以及应用重启后重建的页都看不见**
  （实测：重新 detach→attach 也无效）。
  **默认开启的 `autoAttach` 把 attach 提前到 DSH 启动时**，所以日常只要"只用一个 DSH 实例、不中途 detach"就不会再遇到；
  在此之前已经开着的页仍需重开一次。`browser_claim` 对这类页会失败，并提示"关掉该 tab、重开同一 URL"——
  重开会产生新 target，就能接管。`browser_list` 在"侧边栏明明有页、CLI 却一个网页都没有"时会带一条 `warning` 说明原因。
  这也解释了偶发的"刚开的页几秒后从 tab-list 消失"：那是应用重启把 webview 重建成了"已存在"（auto-attach 之后重启也会重新建立边界）。
- **`detach` 结束自动化会话**：DSH 与它的标签页毫发无损，但之后再操作会以全新的 attach 视图开始 ——
  已有的 `pageId` 不再解析（实测：detach 后重新 attach，`tab-list` 里看不到原来的 webview 目标），
  需要重新 `browser_open` / `browser_claim`。
- **页面自己改标题**后标记会在 ~60ms 内补回；若某个页面在标记补回前被 `tab-list` 读到，会得到
  `PAGE_NOT_FOUND`，重试一次即可。
- `browser_run_code` 的 `code` 是**函数体源码**（`async page => { … }`），不是表达式；读值用 `return await page.evaluate(...)`，返回值原样当文本回传。
- **插件不额外限制 scheme**（只拒 `dsh-app:`），但**平台是有约束的**：DSH 侧边栏浏览器自己的地址解析器只接受 `http`/`https`（含 loopback），
  拒绝 `file:`/`data:`/`blob:`、内嵌凭据和应用同源地址，本地文件归**文档预览**（依据 `dsh-client-ui-sidebar-browser` README 的 Protocol policy）。
  要测本地页面：在该目录起一个 loopback 服务（`python -m http.server 8000`）再打开 `http://127.0.0.1:8000/<file>` —— `browser_open` 失败时会把这句提示带上。
- 唯一被拦的是**应用自己的 scheme**（`dsh-app:`）和带凭据的 URL；插件在 Host 侧提前拦截并给出原因。
- `playwright-cli attach` 在 Windows 偶发卡住/守护进程竞争：超时 60s + 一次重试；仍失败建议
  `playwright-cli list` / `playwright-cli -s=dsh detach` 后重试。
- 侧边栏最多两个水平 pane，窄窗口下开页会进入全屏浮层——这是 DSH 的行为，插件不改。

### 7.1 窗口可见性矩阵（最小化时还能做什么）

实测环境：DSH 窗口**最小化**（Win32 `IsIconic` 为真，前后各验证一次），页面自述 `document.hidden: true`，
应用视口仍是 1920×1032、侧边栏 webview 仍是 533×916（**布局不变**，所以"盒子在视口内"这类判据全部为真）。

| 能力 | 最小化时 | 说明 |
|---|---|---|
| 页面桥 / 命令下发 | ✅ | 客户端持续轮询，`browser_open`/`close` 都能送达 |
| `browser_snapshot` / `evaluate` / `console` | ✅ | 纯 DOM / JS 计算，不需要绘制 |
| `browser_click` / `fill` / `press` / `goto` / `reload` | ✅ | DOM 级派发；实测 `setTimeout(1000)` 实际 1010ms、两帧 rAF 8ms，**没有节流** |
| `browser_claim` | ✅（但用户看不见） | 判据看布局盒子，最小化不改变它；语义上没问题，因为 user 是"先看到页面才会要求 claim" |
| **`browser_screenshot`** | ❌ **立即报错** | 隐藏窗口不产生任何帧：CLI 截图 5s 超时、`page.screenshot` 8s 超时、raw CDP `Page.captureScreenshot` **无限挂起**；`page.bringToFront()` **不能**还原最小化窗口 |

因此插件在截图前会先读页面侧上报的 `document.hidden`：为真就**毫秒级**拒绝并说明原因，
而不是白等 5–25 秒。**"无人值守 + 关键处截图"必须让窗口保持可见**（可以不聚焦，但不要最小化）。

### 7.2 侧栏几何归 shell 所有（约定，不做检测）

侧栏多大，截图就只能多大：截图截的是侧栏当前的画布，插件**不会**为了一张图去改侧栏或改页面视口。

由此有一条约定写进 browser_run_code / browser_screenshot 的工具描述（提示词层面）：

> 不要在 snippet 里改页面几何：page.setViewportSize() 与 body 的 zoom 都属于侧栏，由 DSH 决定。
> 页面布局比侧栏宽时，Chromium 会用已有帧**平铺填充**超出部分，产出一张"同一页面左右两份"的图，
> 所以保持视口不动，截图才是干净的。

插件**不做检测、也不强制还原**（这一版的决定）：越界是模型该守的约定，不是插件该纠正的状态。
真要更大画布，让人把侧栏拉宽即可。

### 7.3 前台会话 vs 后台会话

DSH 的侧栏是"每个会话一份"，但**只有当前显示的那个会话有渲染表面**。插件据此分成两种行为：

| | 前台会话（窗口里正显示的那个） | 后台会话（其它） |
|---|---|---|
| 可见操作（`goto`/`reload`/`click`/`fill`/`press`） | **先切到目标 tab 再执行**，用户能看见 | 照常执行，**不聚焦**（也不该聚焦——它不在屏幕上） |
| `browser_screenshot` | ✅（窗口需可见，见 7.1） | ❌ **无法截图**：没有可见表面 → Chromium 不产帧 |
| `browser_open` | 走 `ctx.sidebarRight.openTab` | 走内部的 `openTabIn`；需要时会**短暂切到该会话**（闪一下）再切回，见下 |
| `browser_claim` | ✅（接管眼前那页） | ❌ 拒绝（`PAGE_FOREIGN_SESSION`） |

**后台关闭**同理：`closeIn(sessionId, tabId)` 在会话没有 adopted store 时**静默 no-op**，而 `close(tabId)` 只作用于屏幕上的那条 strip。
所以关页也走"短暂点亮"：切到该会话 → `close(tabId)` → 切回；最后用 **DOM 里 chip 是否消失**校验结果（不靠"没有抛异常"）。

**后台开页**（`openTabIn`）依赖一件确定的运行时事实：**该会话的侧栏必须可见（lay out）**。
可见时 tab 写进 store 后 webview 会被创建、页面真的加载；仅仅是"挂载但隐藏"不够——
被 keep-alive 淘汰时，tab 只写进 store，没有 webview，页面要等 seat 重新挂载才加载（实测约 2 分钟，时机不可控）。

所以后台开页走"**短暂点亮**"流程（你选定的 B 方向）：

1. 量一下该会话侧栏是否**真的可见**（`[data-sidebar-right-session]` 元素有非零盒子）；挂载但隐藏不算；
2. 不可见 → `ctx.get("uiWorkspace").openSession(sessionId)` **临时切到该会话**，等它可见（≤3s）；
3. `openTabIn` 建 tab，等 `tabsIn` 增量 **且**该子树出现新的 `<webview>`（≤6s）——webview 才是"页面真的在加载"的证据；
4. **立刻 `openSession(原会话)` 切回**（`finally`，失败时也切回）；
5. 失败回滚：`closeIn(sessionId, tabId)` 删掉 tab 再报错；宿主的 `waitForNewTab` 若仍失败，会用 `close-tab` 再兜底一次。

代价与表现：**窗口会短暂切到该会话再切回**（约 1–2 秒）。结果里会带 `flashed: true`，正文也会说明"窗口曾短暂切到本会话以挂载侧栏"。

**后台截图仍然不行**：这类页面没有可见表面，Chromium 不产帧（实测 25s 超时）。错误信息会直接说清楚并建议改用 `browser_snapshot` / `browser_run_code`；要看图就切到那个会话再截。

---

## 8. 自测

```powershell
cd dsh-browser-automation
node --test
```

104 个用例，覆盖：

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
- **重载 = goto 同 URL**：断言 driver 收到的是"该页自己的 URL"而不是 `reload` 命令；无 URL 时明确报错；`dsh-app:` 目标仍拒；
  **可见操作先聚焦**：goto/reload 的调用顺序是 `prepare-capture`（切前台）→ 导航；
- **配置读写**：Config 的 8 个字段必须全部 `.volatile()`（否则表单看不到），默认值与 README 一致，profile 覆盖经引用读取；
  写入只落 override 层（对照组：行内 `current` 已含 bundle 默认值，合并它会冻结默认值），`include:` 前缀的行 id 要能匹配，
  白名单用 `hasOwn`（`__proto__` 不能绕过），数字/布尔/空串校验；切片的 `configuration()` 被伪造时退回 `current`；
- **配置卡片首帧**：用 harness 的 React stub 直接渲染一次 —— 卡片在首帧抛错会让整个插件页白屏，而且不报错；
- **状态面板的三次注册**：tab 类型（`id` + `kind`）、body（`sidebar.right.pane.tab` + 用类型 `id` 作 key）、
  locale 文案，缺任何一个的表现都是"用户看到一个没有内容的标签页"而且不报错；外加 `guide` 条目
  （`id`/`title`/`icon`）—— 没有它，面板只能靠 chip 或工具调用才找得到，右侧"开始"页里不会出现；
- 工具定义（自实现一遍 `assertSupportedJsonSchema` 子集，避免"装上才发现 schema 非法"）、渲染器、命名、无 `index`/`tab-new`/`targetId`；
  以及"运行时加的字段必须在 output schema 里声明"（这条抓到过两次真 bug）；
- CliBridge（shim → JS 入口解析、**Electron 里必须换用 PATH 的 node**、argv 不被引号破坏、非零退出、超时、取消、失败信息去掉 Node 栈）；
- 桥协议（长轮询、LIFO 投递、4s 未应答重投、结果落地、超时、页面失败、卸载、`clientState` 三态、
  **每次 poll 刷新能力快照**：`mounted`/`visible` 会随"打开面板/切会话"变化，只在 `hello` 采集就会长期说谎）；
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
| `nodePath: auto` 真机 | ✅ 日志显示 `node from dsh-runtime`；`browser_status.cli.resolved.node` = `~/.dsh/dsh-runtimes/dsh-primary-runtime/.../node.exe`（v24.21.0）；新起的 CLI daemon 进程确实来自该路径，开页/列页正常 |

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

### 改完 `client.js` 之后怎么办

**不要只刷新页面，要重启应用。** 实测（4 次）：只要 `client.js` 在**本次应用会话里被改过**，
再 `reload` 页面就会 `web boot: … import failed`；而同一份代码**重启应用后一切正常**。
等多久都没用（有一次改完 5 分钟才 reload，照样崩），所以这不是"构建没写完"的时序问题。

- 宿主侧改动（`index.js`/`src/*`）：`plugin_manager` disable → enable 即可生效，不用重启。
- 客户端改动（`client.js`）：disable → enable → **重启应用**。
- 崩溃后：点「重启」即可；改好的代码会被重新构建并加载。

---

## 10. 开发与发布

### 依赖：`@deepseek-ai/schemastery`

`src/config.js` 用 Schemastery 声明 Config schema（字段必须 `.volatile()` 才能进设置表单），
所以它是**普通运行时依赖**：

```json
"dependencies": { "@deepseek-ai/schemastery": "~3.18.4" }
```

- **发布安装**（`dsh plugin add` / 插件市场）：pnpm 把它装进 profile 的 `node_modules`，`import` 正常解析，用户无感。
- **本地开发**（本仓库的插件目录以 junction 链进 profile）：Node 解析裸包名是从**文件的真实路径**往上找
  `node_modules`，而真实路径在 dev 仓库里，那里没有这份依赖 —— 所以本地建了一个
  `dsh-browser-automation/node_modules/@deepseek-ai/schemastery` 的 junction 指向 profile 里的副本。
  它只服务本地开发，已被 `.gitignore`（`node_modules/`）排除，**不进仓库、也不进 npm 包**。
  换机器后重建一次即可（或直接在插件目录 `pnpm install`）：

  ```powershell
  New-Item -ItemType Junction -Path .\node_modules\@deepseek-ai\schemastery `
    -Target "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai\schemastery"
  ```

### 发布清单

- `private: true` 发布前去掉；`name` 改成你的 scope（现在是 `@local/dsh-browser-automation`）；
  `version` 建议随功能升到 `0.2.0`。
- 补 `repository` / `homepage` / `bugs`（插件市场会读）。
- `files` 只含运行时文件；`docs/` 会一起发出去（`docs/concurrency-fix.md` 是待办规格，可留可去）。
- 发布前跑 `npm test`（99 用例）。
- 标题/描述/图标来自 `locale/{en,zh}.json` 与 `icon.svg`（矢量，插件页当封面用）。








