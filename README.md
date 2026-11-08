# dsh-browser-automation

让 **Windows 版 DSH 桌面端右侧边栏浏览器**（`@deepseek-ai/dsh-client-ui-sidebar-browser`）变成模型可稳定驱动的自动化目标：
每个标签页有一个稳定的 `pageId`，模型只传 `pageId`，插件内部每次重新解析 playwright-cli 的标签索引。

> **仅支持 Windows 版 DSH 桌面端。** 插件依赖 Electron 的 CDP 端点、`%APPDATA%` 下的
> `DevToolsActivePort` 记录和 `playwright-cli.cmd` shim；Web 版没有可附加的 CDP 端点，
> macOS/Linux 桌面端未验证。连不上时插件按 `diagnosis` 报出具体原因。
>
> 版本与变更记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## 1. 结构

```
工具层  browser_*（12 个模型工具，只认 pageId）
   │
会话层  SessionManager：pageId 登记 / 会话归属 / 每页互斥锁
   │
连接层  CliBridge → playwright-cli -s=dsh …；PageDriver 负责 tab-select / eval / click …
   │
桥     ctx.connection.rpc  ←→  client.js（页面里的 ctx.sidebarRight.openTab）
```

三条不变量：

1. **索引是易失的中间产物，`pageId` 是稳定契约。** 每个工具调用都重新读页面目录（一次 `run-code`）解析索引，绝不缓存。
2. **开页必须走 DSH 自己的 UI。** Electron 的 CDP 不支持 `Target.createTarget`，所以 `tab-new` 不能用；
   playwright-cli 也没有 `targetId` 参数。`browser_open` 由页面半边调用 `ctx.sidebarRight.openTab` 完成。
3. **收尾只 `detach`，绝不 `close`。** 导航（`browser_navigate`）只换页/刷新/前后退，不碰 DSH 进程；自动化结束用 `browser_status {action:"detach"}`。

> **并发语义（已实现）**：playwright-cli 的"当前页"是 daemon 的全局状态。`PageDriver.withCli()`
> 用一把**全局 CLI 互斥**把"选页 + 命令"整段串行化，所以两个 DSH 会话同时操作**不同**页面也不会
> 互相踩；`SessionManager` 的 per-page 锁只负责同一页的登记与调用顺序。见
> `src/driver.js` 的 `withCli()` 与 `executeOnResolvedTab()`。

---

## 2. 安装与前置条件（Windows）

**安装（发布版）**：

- DSH 桌面端：**Settings → Plugins**，搜索并安装 `dsh-browser-automation`；
- 或 CLI：`dsh plugin add dsh-browser-automation`；
- npm：[`dsh-browser-automation`](https://www.npmjs.com/package/dsh-browser-automation)。

**本地开发**：插件目录以 junction 装进 `desktop` profile（row `browser-automation`）。
重新安装用 Plugin Manager 的 `install_bundle`，`target` 指向本目录；不要手改 profile 的 `package.json`。

装完还差两步；缺哪一步，面板里都会出现同样的引导（§2.4）。

### 2.1 给 DSH 加远程调试端口（必做）

1. **完全退出 DSH**：窗口关掉后，托盘图标也要退出——残留实例会占着旧端口。
2. 右键 DSH 快捷方式 → **属性** → **目标**，在 `.exe` 路径后面追加：
   ` --remote-debugging-port=0`
3. 确定后重新启动 DSH。

`--remote-debugging-port=0` 让 Chromium 每次启动自己挑一个空闲端口，写进
`%APPDATA%\@deepseek-ai\dsh-desktop\DevToolsActivePort`；插件读这个文件拿真实端口，
所以**没有端口设置项**。固定端口（如 `9222`）也能用，但会被上一代 DSH 的残留端点占住，
新实例静默 bind 失败，现象是 `ECONNREFUSED`（见 §9）。

### 2.2 安装 playwright-cli（必做）

```powershell
npm install -g @playwright/cli@latest
playwright-cli --version
```

插件用 `%PATH%` 里的 `playwright-cli.cmd` 找到它指向的 JS 入口，再用当前 Node 直接执行，
**不经过 shell**——所以带引号、方括号、`$` 的 ref 和表达式不会被任何引号规则破坏。
插件只 attach 到 DSH 的 CDP 端点，不需要另外下载浏览器。

### 2.3 验证

1. 侧栏打开「浏览器自动化」面板：CDP 一行显示已连接；
2. 让模型调用 `browser_status`，`cdp.diagnosis` 应为 `serving`，`cli.resolved` 有值；
3. `Invoke-WebRequest <cdp.url>/json/version` 返回 JSON。

### 2.4 面板里的引导

只要 CDP 连不上或 `playwright-cli` 不在 PATH，面板顶部会出现「一次性设置」卡片，
把上面的命令原样列出来，并带「复制」按钮——不用回来翻 README。

---

## 3. 工具

**启动方式只有两种**：`browser_open`（自己开新页）或 `browser_claim`（接管用户眼前那一页）。
其余工具都是在已登记的 `pageId` 上操作。除 `open` / `claim` / `list` / `status` 外，所有工具的第一个参数都是 `pageId`。

| 工具 | 作用 |
|---|---|
| `browser_open {url}` | 通过 DSH UI **新建**侧边栏标签页 → 安装页面身份 → 返回 `pageId`。只在真的需要多一个 tab 时用（见下方"少开 tab"）。桥不可用即报错，**不会**复用现有标签页。**后台会话**走内部的 `openTabIn`，结果带 `background: true`（不聚焦、不可截图），见 §7.3 |
| `browser_claim` | 接管用户眼前那一页（侧边栏可见的浏览器页），返回该页自己的标题；从页面目录读出旧身份并换成新 `pageId`。无参数 |
| `browser_list {scope}` | `session`（默认，本会话控制的页）/ `all`（含其他会话与未标记页）。同一 DSH 会话内 `pageId` 稳定：优先复用上下文里的 `pageId`，只在没有可用 `pageId` 时才列 |
| `browser_navigate {pageId, type?, url?}` | 导航：`type` 默认 `url`（此时必须给 `url`）/ `reload` / `back` / `forward`。不新增 tab、`pageId` 不变；**先把 tab 切到前台**；`reload` 实现为 goto 当前 URL（**绝不用 `playwright-cli reload`**：实测它会刷新整个 DSH 页面）；`back`/`forward` 走页面自己的历史栈 |
| `browser_snapshot {pageId, depth?}` | 可访问性快照（含 `[ref=…]`），内容原样返回，不做二次压缩 |
| `browser_screenshot {pageId, fullPage?, target?}` | 截图存盘，返回绝对路径（不内联字节） |
| `browser_click {pageId, ref, button?, double?, modifiers?}` | 点击 |
| `browser_fill {pageId, ref, text, submit?}` | 覆盖式填充 |
| `browser_press {pageId, key}` | 单键（Enter / Tab / Escape …） |
| `browser_run_code {pageId, code}` | `playwright-cli run-code`；跑完会补一次身份（snippet 可能导航或替换文档），并把新 `title/url` 回写登记表。**读值也走这里**：`return await page.evaluate(() => document.title)` / `return await page.locator('a').allTextContents()`。**不要在 snippet 里 `page.reload()` / `location.reload()`**（会刷新 DSH 外壳）；导航优先用 `browser_navigate`，但 `page.goto()` / `goBack()` / `goForward()` 不禁止 |
| `browser_console {pageId, level?, limit?}` | 控制台日志，默认最后 50 行 |
| `browser_status {action}` | `status` / `attach` / `detach`；连接出问题先看它。状态面板由用户自己从侧栏打开，工具不代开 |

**少开一个 tab 的判据**：侧栏同一时刻只显示一个 tab，每个 tab 都是一张活页面，用户还得自己关。
所以"要去另一个地址"本身**不是**开新 tab 的理由——只要当前这页的状态不重要，`browser_navigate`（`type: "url"`）就是更便宜的做法：
不新增 tab、`pageId` 不变、身份自动续上。只有下面这些情况才用 `browser_open`：

- 两页要**同时存在**（对照、反复来回、跨页取信息）；
- 当前页的状态（登录、表单、滚动位置、进行中的操作）**不能丢**；
- 这个会话还没有任何自己的页。

`browser_open` 从不接管已有 tab（那会毁掉用户正在做的事）；要接管用户眼前那页用 `browser_claim`。

**可见性约定**：`browser_navigate`、`browser_click`、`browser_fill`、`browser_press` 都会**先把目标 tab 切到前台**（必要时展开收起的侧边栏）再执行，这样用户能看到插件在做什么。聚焦是尽力而为：定位不到 tab 时操作照常进行，失败时报真实原因。

**副作用（写在本文档，不占工具描述）**：每个操作都会 `tab-select`，即改变 playwright-cli 的 current tab，并把它停在目标页上。
`browser_claim` 会替换页面身份，原来那个 `pageId` 立即失效。

**工具开关**：12 个工具默认全部注册。想让模型只看到核心集合，可在配置里写 `disabledTools`
（逗号分隔，注册时过滤，schema 完全不进上下文），取舍建议见 §6.3。

**`browser_claim` 找的是"用户眼前那一页"**，不是 playwright 的 current tab —— 后者是 CLI 自己的记账，
re-attach 后会回到应用页，也不跟随侧边栏切换。所以 claim 会先问页面半边：
它报告当前可见 `<webview>` 的 URL（隐藏的载体 box 尺寸为 0，被跳过），再用这个 URL 去 `tab-list` 里匹配；
匹配到之后从页面目录读出这一页原来的身份，注销它并安装新身份。

### 状态面板（侧栏「浏览器自动化」）

给**人**看的一面：只读，除两个全局动作（断开 / 重新连接）外不提供任何操作。
它是右侧边栏里一个**会话级**标签页（`browser-automation` 类型），由用户从侧栏起始页的引导卡片
自己打开——插件不替用户开面板（`browser_status` 也没有 `panel` 动作）。它显示：

- 连接：CDP 是否附着、桥的 `state` 与客户端数、挂起轮询数、`bridgeError`
- CLI 解释器：实际用的 node（文件名）、命令、`-s=` 会话名
- 启动模式：`新开标签页` / `接管可见页` 当前是否可用
- 本会话的页面：`pageId`、来源（`open` / `claim`）、标题、URL、是否 current；
  `browser_status.pages` 是全局列表（还带别的会话的页），面板只取 `mine` 为真的行
- 两个按钮：`断开 CLI`（= `detach`，提示里写明会让已有 `pageId` 失效）、`重新连接`

为什么是会话级标签页而不是左栏的全局页面：全局页面会替换主栏的对话，而侧边栏浏览器的挂载点依赖
"会话在屏"（`mounted = sessions.onScreen`），面板开着时 `browser_open` / `browser_claim` 会直接不可用 ——
一个报告状态的面板不该把它报告的东西关掉。面板标题在打开时捕获，所以改语言后重开即可。

### `browser_status` 返回什么

这份 JSON 是**三条独立链路**的体检报告，混在一个对象里。一条断了不影响另一条（CLI 可能连着但没有任何页面客户端，反之亦然）。

| 字段 | 说明 |
|---|---|
| `attached` | **这次调用是否读到了 tab-list**。`status` 会在没连上时顺手 attach，所以 `true` = "现在能看见应用里的页面"；`false` 时看 `note` |
| `cdpUrl` | **这次实际连的**调试端点 = `DevToolsActivePort` 记录的端口。连不上时是插件去看的那个端口；还没解析出来时为 `null` |
| `cdp` | 端点判定：`{url, port, diagnosis, file}`。`diagnosis`：`serving` 正常、`absent` 记录里的端口空着且无人应答（DSH 没启动，或没带参数、记录是旧的）、`stale` 端口被占但不应答（残留端点）、`no-record` 找不到记录文件 |
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
| `pages[].pageId` | 页面内部字段里的稳定句柄；页面没有安装身份时 `null` |
| `pages[].session` | 归属的 DSH 会话；`dsh-app://…` 标成 `application`，有身份但未登记标成 `session-tag:<tag>` |
| `pages[].mine` | 是否属于**调用这个工具的会话**（只有带页面身份的行才有） |
| `pages[].source` | `open` / `claim` / `discovered`（页面的会话摘要属于本会话、但登记表没记录，通常是 Host 重新加载后） |
| `bridgeError` | 桥路由挂载失败时才有值（端口冲突等），正常 `null` |

`pages` 与"原始 tab-list"的关系：`tabs[].index` 是唯一能喂给 `tab-select` 的寻址方式，`pages` 原样保留了 `index`/`current`/`title`/`url`，所以不再重复输出一份。`pages` 的行来自页面目录（逐页读取页面内部字段），不是从 `tab-list` 的标题里解析的。

---

### 单步 vs `run_code`

判据不是"页面结构是否已知"，而是**下一步做什么是否取决于上一步看到了什么**：

- 边走边看、路径依赖上一步返回值 → `snapshot` + 单步工具；
- 路径可预先写成代码（回归、批量抓取）、需要原子性抓瞬时状态 → `run_code`；
- 一次性读取（`page.evaluate` / `locator(...)`）→ 也走 `run_code`，**没有单独的 evaluate 工具**；
- 脚本失败 → 回到 `snapshot` 重新探索，不要盲目重试。

### 为什么只有一个 `run_code`，没有 `evaluate`

`evaluate` 是 `run_code` 的子能力：`return await page.evaluate(() => …)` 与旧的 `playwright-cli eval` 等价，
而 `run_code` 还能用 locator、键盘、等待（导航改走 `browser_navigate`）。两个工具并存只会让模型多一次「该用哪个」的选择，
并且两套超时/错误/返回形状要各自维护。所以只保留 `browser_run_code`：

- 读值：`return await page.evaluate(() => document.title)`
- 读元素：`return await page.locator('a').allTextContents()`
- 要结构化返回就自己 `JSON.stringify`（返回的是字符串，原样回传）

代价：`run_code` 每次多一次 CLI 调用（跑完补身份），只读操作也一样。

### 工具结果里没有 tab index

模型只按 `pageId` 寻址，所以**普通工具的结果里不含 tab index**（`browser_open`/`claim` 的提示文案里也没有，
`browser_list` 的行首也不再带 `[index]`），index 属于 driver 层内部细节。目前只有诊断工具
`browser_status` 还保留 `currentIndex` 与 `pages[].index`：它是给**人**对照 `playwright-cli tab-list` 用的，
调用频率低。如果以后要彻底去掉，用行内的 `current: true` 替代即可。

---

## 4. pageId 与页面身份

```
pageId = dshpg-<sha256(sessionId) 前 6 位>-<8 位随机>
```

打开/接管时，插件做两件事：

1. **装一个 init script**（`page.addInitScript`，走 `run-code`）：每次新文档加载都会先跑一遍，
   把身份写到页面自己的 `window` 上：

   ```js
   window.__dshBrowserAutomation = { pageId }
   ```

   这是身份能在**跨域导航后存活**的原因 —— 普通注入在导航时随页面一起被销毁，点一个链接就没了。
   实测 `addInitScript` 跨 CLI 调用、跨导航、跨 origin 都保留。
2. **对当前文档立刻应用一次**（`eval` 同一段脚本）：init script 只对"下一次"加载生效。

**页面标题不再携带任何东西**：`document.title`、侧栏标签标题、`playwright-cli tab-list` 输出的
都是网页自己的标题。没有标题后缀、没有 `MutationObserver`、没有追 `<title>` 的定时器。

## 4.1 双向映射（一次 `run-code` 各一次）

```text
resolveTabIndex(pageId)   pageId         -> tab-list index
resolvePageId(tabIndex)   tab-list index -> pageId
```

两者都基于 `src/page-catalog.js`：**一次** `page.context().pages()`，对每个页面读
`window.__dshBrowserAutomation.pageId` / `document.title` / `location.href`（每页一次 `evaluate`，
单页 3 秒超时，单页失败不影响其余页面）。标题只用来显示，不参与寻址。

- **顺序契约**：`context.pages()[index]` 与 `tab-list` 的 index 一致。本环境（Electron webview、
  5 个 tab、应用页在 0）逐项实测一致；`current` 由 `candidate === page` 推导，不需要额外 CLI 调用。
- **不缓存**：index 只在本次调用内有效（用户随时可能关标签页）。
- **首次匹配即返回**（迁移计划 §4.6）：不收集、不产生 `AMBIGUOUS_PAGE`。
- **唯一身份来源**：页面内字段。没有它就从 `tab-list` 里找不到这一页（不再有"按标题兜底"）。
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
  （`{ ...found, pageId }`）后交给 `installMarker(tab)`，所以身份安装函数也只收 tab。

### 4.2.1 页面标识与侧栏标签的对照

宿主端要页面标识（`pageId`），界面端要侧栏标签编号（`tabId`，例如 `tab7`）。这条对照关系现在这样建立：

- `browser_open` 打开标签页时，界面端把新标签页的 `tabId` 回给宿主端，宿主端记进登记表；
- `browser_claim` 接管可见页时，宿主端通过 `ping` 拿到界面端的 `activeTabId`，同样记进登记表；
- 截图、可见操作时，宿主端把 `tabId`（和网址）随命令传给界面端；
  界面端按 `[data-sidebar-right-tab="tabN"]` 精确定位，只有登记的标签编号为空（例如宿主端重启后
  从页面目录里"发现"的页）才退回按网址匹配，网址重复时报错而不是猜；
- 徽标（“正在与智能体共享”）不再读标题：它把可见标签页的 `tabId`（和网址）发给宿主端一个内存查询
  `shared-state`，宿主端在登记表里回答“是不是本窗口控制的页”。

**页面身份带会话摘要**，所以**即使插件重启、登记表丢失**，`browser_list` 仍能按页面内部字段把标签页
归回原会话。登记表只是缓存，页面内部字段才是真相。

## 4.3 attach 是"先探活"

`ensureAttached()` **总是先 `tab-list` 探活，失败才 `attach`**，包括进程内 driver 还是全新实例的时候。

原因不是省一次调用：`attach` 会开一个新的 CDP 会话，而 playwright-cli 只收养 attach 之后创建的侧边栏页面 ——
对活着的会话再 attach 一次，**用户已经开着的页面会全部失联**（实测：界面 4 个 tab，`tab-list` 只剩应用页）。
`force: true` 仍然强制重新 attach（诊断用）。

## 4.4 页面动作只对"本会话的页面"开放

页面动作（`snapshot`/`screenshot`/`click`/`fill`/`press`/`goto`/`reload`/`run_code`/`console`）
要求页面的归属等于调用方会话，否则报 `PAGE_FOREIGN_SESSION` 并且**不执行任何动作**：

- 归属来源：登记表里的完整 `sessionId`；登记表没有记录（插件重启）时，用 pageId 里的 6 位会话 tag 比对；
- `browser_list scope="all"` 仍然**列出**别的会话的页面（诊断用），但列出 ≠ 可操作；
- 想接管别人的页面，用 `browser_claim`（它会重新安装页面身份并登记到当前会话）——这是唯一被认可的途径；
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
`status`（状态面板读快照）、`shared-state`（徽标查询某个标签页是不是本窗口控制的）、
`config` / `config-set` / `config-reset`（设置卡片）。

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
  name: 'dsh-browser-automation'
  config:
    debug: true
```

清空所有覆盖后是 `config: {}`，这一行可以整段删掉（删掉等于全部用默认值）。
宿主若没有 `configEditor`，卡片会退化成只读并说明原因。

### 「正在与智能体共享」标记（showSharedBadge，默认开）

当**正在看的浏览器页**由本插件控制时，**地址栏右端贴壁**显示一个蓝色的 `● 正在与智能体共享` 胶囊（给「在系统浏览器中打开」按钮留出位置）：
`pointer-events: none`，**不接收任何点击**，也不遮挡地址栏以外的任何控件。

- **不碰页面**：徽标挂在 DSH 界面层的 `shell.overlay`（`id: browser-automation:shared`，order 30），
  **页面 DOM 里没有任何节点**——截图截的是页面，所以浮标不会进截图；页面脚本也删不掉它。
- **判据**：把那个可见浏览器 tab 的 `tabId`（侧栏自己的编号）和网址发给宿主端的内存查询
  `shared-state`，宿主端在登记表里回答"是不是本窗口控制的页"。标题和页面 DOM 都不参与判断；
  非浏览器 tab、侧栏收起时都不显示。
- **为什么不在标签芯片上**（实测结论）：`sidebar.right.pane.tab.title` 是 keyed 插槽，但 key 是**页面类型 id**
  （`@deepseek-ai/dsh-client-ui-sidebar-browser`），同一 priority 注册会被拒绝、只能换 priority 去 shadow；
  而官方芯片的标题来自**浏览器类型自己的 store**（插件读不到），`tab.title` 对浏览器页是空的、chip 挂载时
  `<webview>` 还不存在——替换后芯片会只剩图标、没有标题。
- **为什么浮标不压在页面区域**：Electron 的 `<webview>` 会盖住同区域的普通 HTML（用克隆体实测：
  放到工具栏上方可见、放进页面区就看不见），所以浮标锚在**浏览器工具栏**这一行。
- **几何**：锚定地址输入框的右边缘（`right = 窗口宽 − 输入框右缘 + 6px`，垂直居中），
  因此它永远贴着地址栏右端、宽度变化不影响布局，也不会盖住右边的「在系统浏览器中打开」按钮。
- **样式**：蓝色渐变胶囊（`#5b9bff → #2f6fed`）+ 白字 + 白色小圆点 + 浅阴影。
- **刷新节奏**：只有"切 tab"改成了事件驱动，其余与之前一致。
  - 切 tab：`ResizeObserver` 观察每个 pane —— 切走时旧 pane 变 0×0、切入时新 pane 恢复实际盒子，两边都会回调；
    切到"从未渲染过的 tab"时 pane 是新建的，由 `MutationObserver`（只看 `[data-sidebar-right-session]` 子树）
    捕获并重新挂载观察者；
  - 拖侧栏/缩放窗口：沿用原来的 `window.resize` 监听；
  - **安全网**：2 秒一次（只读尺寸与 tab id），兜住观察者可能漏掉的变化；
  - 旧实现是 250ms 轮询（实测 0.3ms/s ≈ 0.03% 主线程），现在切 tab 不再靠轮询。
- **关闭方式**：`showSharedBadge: false`（配置卡片里叫"共享页面标记"）。

### 6.2 直接改 YAML

```yaml
- id: browser-automation
  name: 'dsh-browser-automation'
  config:
    session: dsh                 # playwright-cli -s=；所有 DSH 会话共用一个
    cdpPortFile: auto            # DevToolsActivePort 的位置；auto = %APPDATA%\@deepseek-ai\dsh-desktop\
    showSharedBadge: true        # 地址栏右端的「正在与智能体共享」浮标（见 6.1；不写进页面）
    command: playwright-cli      # 或绝对路径
    nodePath: auto               # 见下：哪个 node 去跑 CLI 的 .js 入口
    timeoutMs: 20000             # 单次 CLI 调用超时；超时重试一次然后报错
    requestTimeoutMs: 20000      # 等页面桥回答的时间
    attachTimeoutMs: 60000       # CLI 附着的最长等待（Windows 上偶发卡住，超时重试一次）
    screenshotTimeoutMs: 25000   # 单次截图抓取的截止时间
    screenshotSettleMs: 1200     # 截图前把隐藏页切到前台后，等首帧的时间
    debug: false                 # true 时用 console.debug 打印桥与 CLI 诊断
```

> ⚠️ **没有端口设置项，这是故意的。**
>
> 端口只有一个来源：DSH 的启动参数。`--remote-debugging-port=0` 让 Chromium 每次挑一个空闲端口，
> `--remote-debugging-port=N` 固定 N，不带参数则**根本不启动 DevTools 服务**。插件在宿主进程里运行，
> 既不能创建也不能搬动这个服务；它能做的只有读 `DevToolsActivePort`（Chromium 写下的两行文件）找到它。
>
> 所以任何"插件端口设置"都只有两种结局：和启动参数一致时是多余的，不一致时是错的。这里把它删掉了，
> 只保留 `cdpPortFile`（隐藏项）用来应对用户数据目录不在默认位置的情况。
>
> 端口的另一个事实：Electron 的调试端口**只绑回环地址**（`127.0.0.1`），主机名固定，不需要也不能配。
>
> 固定端口的坑在 Windows 上真实发生过：上一代 DSH 的监听套接字被一个活得更久的子进程继承下来，
> 端口一直"被占但没人应答"，新实例**静默 bind 失败**，插件只能拿到 `ECONNREFUSED`；这种情况下重启 DSH 也没用。
> `browser_status.cdp.diagnosis` 会把失败分成 `stale`（被占但不应答）、`absent`（记录里的端口空着且无人应答）、
> `no-record`（压根没有记录文件）。

### 6.3 工具开关（disabledTools，默认空）

12 个工具默认全部注册。`disabledTools` 用逗号分隔要**不注册**的工具名，例如：

```yaml
- id: browser-automation
  name: 'dsh-browser-automation'
  config:
    disabledTools: browser_console, browser_press
```

- 只认完整工具名（大小写敏感）；拼错的名字会在宿主 debug 日志里提示，不会影响其他工具。
- 过滤发生在 **`ctx.tools.register()` 之前**：被禁用的工具，schema 根本不进入模型上下文，不是"调用了才拒绝"。
- 改完要**重新启用插件/重启 DSH** 才生效（配置只在 `apply()` 时快照一次）。

按"单页 Web 应用测试"的典型用法，可这样取舍：

| 工具 | 作用 | 建议 |
|---|---|---|
| `browser_open` / `browser_claim` | 两种开始方式：新开页 / 接管可见页 | 核心 |
| `browser_list` | 找 `pageId`、确认有没有别的页 | 核心 |
| `browser_navigate` | 同一 tab 导航：`url` / `reload` / `back` / `forward` | 核心 |
| `browser_snapshot` | 读页面结构（`[ref=…]`） | 核心 |
| `browser_click` / `browser_fill` | 点击 / 填表 | 核心 |
| `browser_run_code` | 跑 Playwright 片段，也是读值入口 | 核心（权限最大，可单独关） |
| `browser_press` | 单键 | 可选：Enter 可用 `fill` 的 `submit`，其余键可用 `run_code` |
| `browser_screenshot` | 截图判断布局 | 可选：只在看视觉时用 |
| `browser_console` | 控制台日志 | 可选：排障时开 |

一个"单页测试"的最小配置：

```yaml
config:
  disabledTools: browser_console, browser_press, browser_screenshot
```

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

- **只在 Windows 版 DSH Desktop 可用，Web profile 与 macOS/Linux 不支持（未验证）。** 三条原因：
  ① Web 版跑在普通浏览器里，**没有 CDP 端点**（没有 `--remote-debugging-port=0`），`playwright-cli attach` 无处可附；
  ② 侧边栏浏览器在 Web 里不是 Electron `<webview>`，`tab-list` 里永远只有应用页本身；
  ③ 端口发现读的是 `%APPDATA%\@deepseek-ai\dsh-desktop\DevToolsActivePort`，CLI 走 `.cmd` shim——都是 Windows 路径。
  表现是 `browser_open` 报"连不到页面桥"或 `tab-list` 看不到新页 —— 这不是 bug，是载体不同。
  同一份 `client.js` 在 Web 里仍会挂载并连接桥（它按文档相对 URL 解析），但没有任何页可驱动。
- **跨窗口多会话**：`ctx.sidebarRight.openTab` 没有 session 参数，永远作用于"当前屏幕上的会话"。
  同一个窗口里的多个 DSH 会话没问题（靠页面身份里的会话摘要区分，已实测）；两个 DSH 窗口各自开页时，桥只能打开请求时在屏的那个会话的标签页。
- **`browser_screenshot` 只返回路径**，不内联图片字节（工具返回值必须是 lossless JSON；内联图片需要 attachments 服务）。
- **截图会把目标标签页切到前台**。Chromium 只给"被布局且在视口里"的 widget 出帧，而没被选中的侧边栏标签页
  所在的 cell 是 `display:none`（0×0），侧边栏收起时整列还被平移到视口外（实测 x=959、窗口宽 958）。
  所以 `browser_screenshot` 分两条路：
  - 目标页已经可见 → 直接用 `playwright-cli screenshot`（快，无副作用）；
  - 否则 → 页面侧先用登记表里的 `tabId` 找容器（没有登记时才按网址兜底，网址重复就报错）
    → 需要时先展开侧边栏 → `focus(tabId)` → 等 `screenshotSettleMs`（默认 1.2s）
    让首帧出来 → 用 Playwright API `page.screenshot({ timeout: 25000 })` 落盘。**截完不切回**，侧边栏停在被截的那页。
  图片尺寸 = 该标签页在侧边栏里的实际尺寸（例如 430×915），不是固定视口。
  只是读内容时用 `browser_snapshot`，它不依赖合成，永远可用。
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
- **页面改自己的标题不再影响身份**：身份在 `window.__dshBrowserAutomation.pageId` 上，标题、SPA 路由、
  未读角标都碰不到它。只有页面主动删掉这个字段才会失去身份（常规网页不会这么做）；真丢了就重新 claim。
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
所以关页也走"短暂点亮"：切到该会话 → `close(tabId)` → 切回；最后用**侧栏控制器的标签页列表里这个
`tabId` 是否消失**校验结果（不靠"没有抛异常"，也不靠芯片文字）。

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

181 个用例，覆盖：

- `tab-list` 解析（真实三标签样本、含 `[]()` 的标题、含 `)` 的 URL、CRLF、`current`/字段集）；
- 页面身份脚本（写入 `window`、标题保持不变、幂等、初始化脚本嵌入）——用 `node:vm` + 假页面真跑；
- **页面目录与列表**：`discover` 按页面内身份归属会话、跳过已关闭页、`browser_list` 用目录取 pageId；
- **两种启动模式的约束**：桥不在/从未连上/掉线三种状态都必须报错且**不碰 CLI**（断言没有任何
  `tab-select`/`goto`，也没登记 pageId）；claim 在"看不见页面"、"页面还没进 tab-list"、"可见 URL 带尾斜杠或 hash"
  各种情况下的行为；claim 从页面目录读出旧身份后必须注销旧 pageId；
- **截图的两条路径**：可见页走 CLI 命令、隐藏页走"补 tabId→focus→长超时"；`fullPage` 透传；
  `target`（元素截图）必须留在 CLI 路径上；拿不到 tabId 时老实走普通路径；桥断了仍能走普通路径；
- **client 半边的 harness**：把真实的 `client.js` 按页面的方式载入，用假 `__ModuleLoader__` + 假
  `ctx.sidebarRight`/`ctx.layout` 跑 `apply()`。断言 `hello` 用文档相对 URL、`open-tab` 只调一次
  `openTab`、`prepare-capture` 在"已可见/隐藏/collapsed/没有匹配标签页/toggle 抛错"五种情况下的动作序列、
  **collapsed 时坐标在视口外**（x=959、窗宽 958）必须判为不可见、
  失败只报一次、空轮询不空转。这一层就是"页面里才炸"的那类 bug 的护栏；
- **徽标不再读标题**：单测断言它调用宿主端的 `shared-state` 查询、源码里没有 `getTitle`/`dshpg`；
  `sharedTab` 优先按 `tabId`、只对没有 tabId 的记录按网址兜底；
- **导航 = `browser_navigate`**：`url` 走 goto、`reload` 重进当前 URL 而不是 CLI 的 `reload` 命令、`back`/`forward` 走页面历史；
  `back`/`forward` 以导航后的 URL/title 判定是否真的移动（SPA 里 `page.goBack()` 可能返回 null，但 URL 已经变了）；
  无 URL 时明确报错；`dsh-app:` 目标仍拒；**可见操作先聚焦**：`prepare-capture`（切前台）→ 导航；
- **配置读写**：12 个可编辑字段必须全部 `.volatile()`（另有隐藏的 `cdpPortFile`，不进表单），默认值与 README 一致，profile 覆盖经引用读取；
  写入只落 override 层（对照组：行内 `current` 已含 bundle 默认值，合并它会冻结默认值），`include:` 前缀的行 id 要能匹配，
  白名单用 `hasOwn`（`__proto__` 不能绕过），数字/布尔/空串校验；切片的 `configuration()` 被伪造时退回 `current`；
- **配置卡片首帧**：用 harness 的 React stub 直接渲染一次 —— 卡片在首帧抛错会让整个插件页白屏，而且不报错；
- **状态面板的三次注册**：tab 类型（`id` + `kind`）、body（`sidebar.right.pane.tab` + 用类型 `id` 作 key）、
  locale 文案，缺任何一个的表现都是"用户看到一个没有内容的标签页"而且不报错；外加 `guide` 条目
  （`id`/`title`/`icon`）—— 没有它，面板只能靠已有的 chip 才找得到，右侧"开始"页里不会出现；
- 工具定义（自实现一遍 `assertSupportedJsonSchema` 子集，避免"装上才发现 schema 非法"）、渲染器、命名、无 `index`/`tab-new`/`targetId`；
  以及"运行时加的字段必须在 output schema 里声明"（这条抓到过两次真 bug）；
- CliBridge（shim → JS 入口解析、**Electron 里必须换用 PATH 的 node**、argv 不被引号破坏、非零退出、超时、取消、失败信息去掉 Node 栈）；
- 桥协议（长轮询、LIFO 投递、4s 未应答重投、结果落地、超时、页面失败、卸载、`clientState` 三态、
  **每次 poll 刷新能力快照**：`mounted`/`visible` 会随"打开面板/切会话"变化，只在 `hello` 采集就会长期说谎）；
- `SessionManager` 互斥、`discover` 的会话归属、`normalizeUrl` 规则、`samePage`、`sanitize` 的 JSON 安全。

### 验收记录（2026-10-28，真机）

> 以下记录来自**标题标记时代**，保留作为历史。页面身份后来改为只写 `window`（见 §4），
> 其中"标题带标记"的描述已不代表现在的行为。

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
| `browser_navigate` 真机 | ✅ `url` / `reload` / `back` / `forward` 都只作用于该 `pageId` 解析到的 tab；`reload` 不会刷新 DSH 页面，侧边栏其他页保持不动 |
| `nodePath: auto` 真机 | ✅ 日志显示 `node from dsh-runtime`；`browser_status.cli.resolved.node` = `~/.dsh/dsh-runtimes/dsh-primary-runtime/.../node.exe`（v24.21.0）；新起的 CLI daemon 进程确实来自该路径，开页/列页正常 |

---

## 9. 排障

| 现象 | 先做什么 |
|---|---|
| `Could not attach … Port N is held but nothing answers on it`（`cdp.diagnosis: stale`） | **端口被上一代残留端点占着**，不是缺参数：先彻底退出 DSH，再结束真正持有该端口的助手进程（`Get-NetTCPConnection -LocalPort N` 显示的 PID 往往已经不存在，真正持有者是活过 DSH 的 `node.exe`），然后重启 DSH。根治：启动参数改成 `--remote-debugging-port=0` |
| `… names port N, but nothing answers there and the port is free`（`cdp.diagnosis: absent`） | DSH 没启动，或没带 `--remote-debugging-port` 启动（记录是上一次的）：带参数重启，推荐 `--remote-debugging-port=0` |
| `Could not find the DSH DevTools endpoint`（`cdp.diagnosis: no-record`） | 找不到 `DevToolsActivePort`：DSH 没带调试参数启动，或用户数据目录不在默认位置；按提示用 `--remote-debugging-port=0` 重启，或把隐藏项 `cdpPortFile` 指向真实位置 |
| `browser_open` / `browser_claim` 报 `needs the DSH page` | 页面半边没连上（`bridge.state` 为 `never`/`stale`）：刷新 DSH 窗口，1 秒内会自己重连；仍不行看 `bridgeError` |
| `browser_claim` 报 `Could not see a browser page` | 侧边栏没展开，或没选中浏览器标签页；展开并选中后重试 |
| `browser_claim` 报 `not in playwright-cli's tab list yet` | 页面还在加载：等一秒重试，或 `browser_list` 看 CLI 能看到什么 |
| `browser_status` 里 `bridge.clients` 为空 | 同上：页面还没加载 client.js，刷新窗口 |
| `bridgeError: cannot get property "webServer" without inject` | 插件 generation 过期：重启 DSH 让新代码生效 |
| `browser_screenshot` 报截图超时 | 那个标签页不在前台、没有渲染面；先切到前台（或改用 `browser_snapshot`） |
| `PAGE_NOT_FOUND` | 页面被用户关掉了、页面内部身份字段丢失、或 CLI 被 detach 过；`browser_list` 看现状，再 `browser_open` / `browser_claim` |
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
  `node_modules/@deepseek-ai/schemastery` 的 junction 指向 profile 里的副本。
  它只服务本地开发，已被 `.gitignore`（`node_modules/`）排除，**不进仓库、也不进 npm 包**。
  换机器后重建一次即可（或直接在插件目录 `pnpm install`）：

  ```powershell
  New-Item -ItemType Junction -Path .\node_modules\@deepseek-ai\schemastery `
    -Target "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai\schemastery"
  ```

### 发布

包名 `dsh-browser-automation`，当前版本 `0.2.0`；`LICENSE`、`repository`/`homepage`/`bugs`、
`engines.dsh`、`CHANGELOG.md` 已补齐。

发布步骤（手动）见仓库根目录
[`RELEASE.md`](https://github.com/damijun/browser-playwright/blob/main/RELEASE.md)：
`npm publish` → 在干净 profile 安装验证 → `git tag v0.2.0` → 向 awesome-dsh-plugin 提一条 entry 的 PR。

发布前 `npm test`（181 用例）与 `npm pack --dry-run` 已由 `prepublishOnly` / CI 覆盖。

标题/描述/图标来自 `locale/{en,zh}.json` 与 `icon.svg`（矢量，插件页当封面用）。








