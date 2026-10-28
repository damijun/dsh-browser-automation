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

除 `open` / `claim` / `list` / `status` 外，所有工具的第一个参数都是 `pageId`。

| 工具 | 作用 |
|---|---|
| `browser_open {url}` | 通过 DSH UI 新建侧边栏标签页 → 注入标记 → 返回 `pageId` |
| `browser_claim {note?}` | 接管用户当前所在标签页（playwright-cli 的 current tab），返回注入前的标题 |
| `browser_list {scope}` | `session`（默认，本会话控制的页）/ `all`（含其他会话与未标记页），带实时索引 |
| `browser_close {pageId}` | 关掉这一个标签页并注销登记 |
| `browser_snapshot {pageId, depth?}` | 可访问性快照（含 `[ref=…]`），内容原样返回，不做二次压缩 |
| `browser_screenshot {pageId, fullPage?, target?}` | 截图存盘，返回绝对路径（不内联字节） |
| `browser_click {pageId, ref, button?, double?, modifiers?}` | 点击 |
| `browser_fill {pageId, ref, text, submit?}` | 覆盖式填充 |
| `browser_press {pageId, key}` | 单键（Enter / Tab / Escape …） |
| `browser_goto {pageId, url}` | 导航并**重新注入标记**（导航会销毁注入的观察器） |
| `browser_evaluate {pageId, expression}` | 求值，结果是 `JSON.stringify`（表达式必须是单表达式或 IIFE） |
| `browser_run_code {pageId, code}` | `playwright-cli run-code`；验证过在当前版本可用 |
| `browser_console {pageId, level?, limit?}` | 控制台日志，默认最后 50 行 |
| `browser_status {action}` | `status` / `attach` / `detach`；连接出问题先看它 |

**副作用（工具描述里已声明）**：每个操作都会 `tab-select`，即改变 playwright-cli 的 current tab，并把它停在目标页上。
`browser_claim` 会替换页面标记，原来那个 `pageId` 立即失效。

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

打开/接管时，插件在页面里执行一段 IIFE：

- 把 `[dshpg-…]` 追加到 `document.title`；
- 先剥掉旧标记（claim 接管别的会话的页时不会留下两个标记）；
- 装一个 `MutationObserver` 监听 `<head>`，页面自己改标题（B 站、SPA 路由、未读角标）后**自动补回**标记。
  观察器带 60ms 防抖，且 `title.includes(id)` 保证幂等，不会累积方括号。

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
Host → Client 调用通道（`@deepseek-ai/dsh-api-remotes` 的转发事件是构建期白名单）。
所以两个半边通过应用自己的已认证 RPC 通道会合：

- Host：`ctx.connection.rpc.handle('/dsh-browser-automation', …)`（`index.js`）
- 页面：`ctx.connection.rpc.call('/dsh-browser-automation', …)`（`client.js`）

端点：`hello`（页面自报能力）、`poll`（长轮询取一条命令，15s 挂起）、`result`（回结果）。
这条通道在 Web 与 Desktop 上是同一条代码路径——Desktop 会把 `dsh-app://app/<path>` 转发到
`http://127.0.0.1:<port>/<path>` 并注入 shell 自己的 cookie，所以页面不需要猜 origin。

`rpc.handle` 内部会用**调用方 context** 注册路由（`owner.webServer.register`），
这就是 `inject` 里必须有 `webServer` 的原因——桥挂不上时 `browser_status` 的 `bridgeError` 会说明原因，
CLI 工具本身仍然可用。

### 降级路径

页面桥不可用（页面没连上、插件刚装还没刷新）时，`browser_open` **不硬失败**：
它会复用一个已存在的 http(s) 标签页并 `goto`，返回 `how: "reused-tab"` 与说明。
没有可复用的页时才报错，并告诉用户"先手动打开一次 Browser 标签页，或刷新 DSH 窗口"。

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
    timeoutMs: 20000             # 单次 CLI 调用超时；超时重试一次然后报错
    requestTimeoutMs: 20000      # 等页面桥回答的时间
    debug: false                 # true 时用 console.debug 打印桥与 CLI 诊断
```

截图和 playwright-cli 的快照文件落在 `%TEMP%\dsh-browser-automation\`，不污染工作区。

---

## 7. 已知限制（首版明确不做）

- **跨窗口多会话**：`ctx.sidebarRight.openTab` 没有 session 参数，永远作用于"当前屏幕上的会话"。
  同一个窗口里的多个 DSH 会话没问题（靠标记区分）；两个 DSH 窗口各自开页时，桥只能打开请求时在屏的那个会话的标签页。
- **`browser_screenshot` 只返回路径**，不内联图片字节（工具返回值必须是 lossless JSON；内联图片需要 attachments 服务）。
- **页面自己改标题**后标记会在 ~60ms 内补回；若某个页面在标记补回前被 `tab-list` 读到，会得到
  `PAGE_NOT_FOUND`，重试一次即可。
- `browser_eval` 的表达式被 CLI 包成 `() => (expr)`，**语句列表会语法错误**，要用 IIFE。
- 侧边栏浏览器本身拒绝 `file:` / `data:` / 带凭据的 URL、以及和 DSH 应用同源的地址；插件在 Host 侧提前拦截并给出原因。
- `playwright-cli attach` 在 Windows 偶发卡住/守护进程竞争：超时 60s + 一次重试；仍失败建议
  `playwright-cli list` / `playwright-cli detach` 后重试。
- 侧边栏最多两个水平 pane，窄窗口下开页会进入全屏浮层——这是 DSH 的行为，插件不改。

---

## 8. 自测

```powershell
cd dsh-browser-automation
node --test
```

41 个用例，覆盖：

- `tab-list` 解析（真实三标签样本、含 `[]()` 的标题、含 `)` 的 URL、CRLF、零命中/多命中、索引漂移）；
- 标记表达式（追加、幂等、剥旧标记、页面改标题后补回、上报自身状态）——用 `node:vm` + 假 DOM 真跑；
- 工具定义（自实现一遍 `assertSupportedJsonSchema` 子集，避免"装上才发现 schema 非法"）、渲染器、命名、无 `index`/`tab-new`/`targetId`；
- CliBridge（shim → JS 入口解析、argv 不被引号破坏、非零退出、超时、取消、失败信息去掉 Node 栈）；
- 桥协议（长轮询、结果落地、超时、页面失败、卸载）；
- `SessionManager` 互斥、`discover` 的会话归属、`normalizeUrl` 规则、`sanitize` 的 JSON 安全。

---

## 9. 排障

| 现象 | 先做什么 |
|---|---|
| `Could not attach playwright-cli to DSH at http://127.0.0.1:9222` | DSH 没带 `--remote-debugging-port=9222` 启动；改快捷方式并重启 |
| `browser_status` 里 `bridge.clients` 为空 | 页面还没加载 client.js：刷新 DSH 窗口（或重启） |
| `bridgeError: cannot get property "webServer" without inject` | 插件 generation 过期：重启 DSH 让新代码生效 |
| `browser_screenshot` 报截图超时 | 那个侧边栏标签页不在前台、没有渲染面；先切到前台（插件会自动 focus 已知 tabId 的页，claim 来的页可能拿不到） |
| CLI 超时 | `playwright-cli list`（看守护进程），必要时 `playwright-cli -s=dsh detach` |
| 启动即崩溃：`web boot: 1 entry did not activate / … import failed` | client bundle 的 revision 与内容不同步（改完 client.js 立刻刷新页面时出现）。**先把本行 disable**（`set_plugin enabled=false`）再启动，进应用后 enable，最后刷新一次页面 |
| `detach` 之后第一次操作很慢 | 正常：下一次操作会重新 `attach`（含一次重试） |

### 关于"启动即崩"

DSH 在 **boot 阶段**把"任一行激活失败"当致命错误，所以一个坏掉的插件会让整个界面起不来；
运行期 reload 失败只会让那一行不激活（有诊断、不崩）。这两个行为不一样，排障先分清。

改完 `client.js` 后不要立刻刷新页面，等 `plugin_manager` 那步完成。正确顺序：
改文件 → disable → enable（宿主侧生效）→ 刷新页面（客户端侧生效）。
| `PAGE_NOT_FOUND` | 页面被用户关掉了，或标记还没补回；`browser_list` 看现状，再 `browser_open` / `browser_claim` |
| `AMBIGUOUS_PAGE` | 同一标题出现两个相同 `pageId`（几乎不可能是 bug 之外的原因）；`browser_list scope=all` 看全量 |
| `browser_open` 返回 `how: "reused-tab"` | 页面桥没连上，走的是降级路径；刷新窗口后重试 |
| CLI 超时 | `playwright-cli list`（看守护进程），必要时 `playwright-cli -s=dsh detach` |
