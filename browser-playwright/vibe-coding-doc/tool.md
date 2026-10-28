# DSH 侧边栏浏览器控制插件 — 工具设计文档

> 交付对象：DSH 创造模式
> 上游依据：《DSH 侧边栏浏览器自动化测试工具 — 开发简报》+ 本次会话关于"单步工具 vs run-code"的讨论
> 目标：产出可直接实现的工具清单、调用契约与工作流规范

---

## 1. 架构总览

插件分三层，工具层只依赖会话层，会话层只依赖连接层。**连接层与会话层是一份共享基础设施，工具层是若干薄封装。**

```
┌─────────────────────────────────────────────┐
│ 工具层  browser_* （面向模型的工具）          │
│   ├─ 会话/标签页: open / claim / list / close │
│   ├─ 观察:        snapshot / screenshot       │
│   ├─ 交互:        click / fill / press / goto │
│   └─ 执行/调试:   evaluate / run_code / console│
├─────────────────────────────────────────────┤
│ 会话层  SessionManager                        │
│   · pageId ↔ 会话 ↔ 标签页标记 的映射         │
│   · 每次操作前重新解析索引（不缓存索引）       │
│   · 串行化同一 pageId 的操作（互斥锁）         │
├─────────────────────────────────────────────┤
│ 连接层  CliBridge                             │
│   · 子进程调用 playwright-cli -s=dsh ...      │
│   · 超时 / 重试 / 输出解析                    │
│   · attach 生命周期（detach 而非 close）       │
└─────────────────────────────────────────────┘
```

**核心约束（来自简报，工具层必须遵守）：**

| 约束 | 工具层应对 |
|---|---|
| Electron 不支持 `Target.createTarget` | 不用 `tab-new`；开页一律走 `ctx.sidebarRight.openTab` |
| Playwright CLI 无 `targetId` 参数 | 工具参数一律用 `pageId`，内部解析成索引 |
| 索引随标签页增删动态变化 | **每次操作前重新 `tab-list` 解析，索引不缓存** |
| 多 DSH 会话共用一个 `playwright-cli -s=dsh` | 靠页面注入标记 `pageId-<sessionId>-<uuid>` 区分 |
| 操作结束不能杀 DSH | 收尾用 `detach`，绝不用 `close` |

---

## 2. 核心机制：pageId 与索引解析

这是整个插件的地基，工具层所有方法都建立在它之上。

### 2.1 pageId 的生成与注入

```
pageId = `pageId-${sessionId}-${uuidv4().slice(0,8)}`
```

- `sessionId`：DSH 会话 ID（参考 `dsh-header-masq` 的 `GenerateOptions.sessionId`）。
- 注入方式：页面加载完成后执行 `document.title = document.title + ' [' + pageId + ']'`。
- 注入时机：`ctx.sidebarRight.openTab` 返回后，等 `webview` 的 `did-finish-load` 或轮询 `document.readyState === 'complete'`。
- 兜底：若注入失败，回退到 URL 追加 hash（`#pageId-...`），但优先级低于 title，因为 title 不影响页面路由。

### 2.2 索引解析（`resolveIndex(pageId)`）

**每次工具调用都执行一次，不缓存结果。**

```js
async function resolveIndex(pageId) {
  const out = await cli.run(['tab-list']);        // playwright-cli -s=dsh tab-list
  // 逐行匹配 /^-\s+(\d+):\s+(?:\(current\)\s+)?\[(.*?)\]\((.*?)\)/s
  // 在 title 或 url 中查找 pageId（含方括号包裹形式）
  // 命中且唯一 → 返回索引；命中多个 → 抛 AmbiguousPageError；未命中 → 抛 PageNotFoundError
}
```

**解析必须兼容：**
- `(current)` 前缀；
- 标题中含 `[` `]` `(` `)` 等字符（用 pageId 精确子串匹配，不做贪婪正则）；
- 标题中的空格、转义。

**建议：** 把 `resolveIndex` 作为独立模块并配单元测试，输入是真实 `tab-list` 文本样本 + pageId，输出是索引或异常。

### 2.3 操作模板（所有工具的统一执行骨架）

```js
async function withPage(pageId, fn) {
  return sessionLock(pageId, async () => {        // 同一 pageId 串行
    const idx = await resolveIndex(pageId);       // 每次重新解析
    await cli.run(['tab-select', String(idx)]);
    return fn(idx);                               // 执行具体命令
  });
}
```

所有交互类工具内部都走这个模板，业务代码里**看不到索引**。

---

## 3. 工具清单

分四组。**除 `open` / `claim` / `list` 外，所有工具的第一个参数都是 `pageId`**——多会话场景下禁止依赖 current tab 隐式定位。

### A. 会话与标签页

| 工具 | 参数 | 行为 | 返回 |
|---|---|---|---|
| `browser_open` | `url` | 走 `ctx.sidebarRight.openTab('browser',{params:{url}})` 开页 → 生成 pageId → 注入 title → 登记到 SessionManager | `{ pageId, url }` |
| `browser_claim` | `note?` | 接管用户当前手动打开的标签页：解析 current tab 索引 → 在该页注入 pageId → 登记 | `{ pageId, title, url }` |
| `browser_list` | `scope: 'session'\|'all'` | 返回已登记 pageId 列表，附带**实时解析出的索引**、title、url、是否 current | `PageInfo[]` |
| `browser_close` | `pageId` | `tab-close <idx>` 并注销登记（**不代表 detach**） | `{ ok }` |

**`browser_claim` 的交互规范（对应简报 §5.2）：**
调用前，工具的描述文本必须明确告知模型"此操作会接管用户当前正在浏览的页面，可能打断用户操作"，由模型决定是否向用户确认。claim 成功后返回的 `title` 是注入前的原标题，便于模型向用户复述"接管的是哪个页面"。

### B. 观察

| 工具 | 参数 | 行为 | 返回 |
|---|---|---|---|
| `browser_snapshot` | `pageId` | `tab-select` 后执行 `snapshot` | 结构化文本：`[ref] <role> "name"` 列表 + 页面摘要 |
| `browser_screenshot` | `pageId`, `fullPage?` | 截图写入临时文件 | `{ path }`（**图片以附件形式返回，不内联字节**） |

`snapshot` 的返回格式直接采用 playwright-cli 的默认结构，工具层**不做二次压缩**——压缩会破坏 ref 的稳定性。

### C. 交互

| 工具 | 参数 | 行为 |
|---|---|---|
| `browser_click` | `pageId`, `ref`, `button?`, `clickCount?` | `click <ref>` |
| `browser_fill` | `pageId`, `ref`, `text` | `fill <ref> <text>`（覆盖式填充） |
| `browser_press` | `pageId`, `key` | `press <key>`（Enter/Tab/Escape 等） |
| `browser_goto` | `pageId`, `url` | `goto <url>`（**保留 pageId，重新注入 title 标记**） |

`browser_goto` 要特别处理：导航后 `document.title` 被替换，原 pageId 标记丢失。实现上导航完成后**重新注入标记**，并校验 `resolveIndex(pageId)` 仍能命中；若不命中则重新登记。

### D. 执行与调试

| 工具 | 参数 | 行为 | 说明 |
|---|---|---|---|
| `browser_evaluate` | `pageId`, `expression` | `evaluate "<expr>"` | 返回 JS 求值结果（字符串化） |
| `browser_run_code` | `pageId`, `code` | 调 playwright-cli 的 `run-code`（如当前版本支持） | **可选工具，见 §6 待验证** |
| `browser_console` | `pageId`, `level?`, `limit?` | 拉取控制台日志 | 调试用，默认 limit=50 |

**`browser_evaluate` 的契约：** `expression` 必须是**单个表达式或 IIFE**，工具层不负责拼接 `async` 包装；返回值为 `JSON.stringify` 后的字符串，避免多行对象污染上下文。

---

## 4. 单步工具 vs `run_code` 的选型规范

这一节是给**模型**看的工具描述片段，应写入每个工具的描述里，引导模型正确选型。判据不是"页面结构是否已知"，而是：

> **下一步做什么，是否取决于上一步看到了什么。**

| 情形 | 选型 | 典型工具 |
|---|---|---|
| 首次接触页面，需边走边看 | 单步 | snapshot → click/fill → snapshot |
| 路径依赖上一步返回值（"若结果<10 条则搜 B"） | 单步 | 同上 |
| 路径可预先写成代码（回归测试、批量爬取） | `run_code` | browser_run_code |
| 只需一次性静态提取（列出所有链接） | `browser_evaluate` | 单条 evaluate |
| 需要原子性抓瞬时状态（loading、toast） | `run_code` | 内部轮询 + 返回 |

**推荐给模型的工作流：**

1. **探索阶段**：`browser_open` → `snapshot` → 单步操作，逐步建立页面心智模型；
2. **固化阶段**：探索成功后，模型可把有效路径写成 `browser_run_code` 脚本，登记为后续快速通道；
3. **失败回退**：脚本失败时，回到单步 `snapshot` 重新探索，不要盲目重试脚本。

**注意：** `browser_run_code` 不是必选工具。若 `playwright-cli attach` 模式下 `run-code` 对 Electron 支持不完整（见 §6），**降级为不提供该工具**，由模型用 `browser_evaluate` + 多次单步组合替代。宁可少一个工具，不要提供一个半残的工具。

---

## 5. 错误处理与边界

| 场景 | 工具层行为 |
|---|---|
| `resolveIndex` 未命中 pageId | 抛 `PageNotFoundError`，附带当前 `tab-list` 快照，提示模型"页面可能已被用户关闭，可重新 open" |
| `resolveIndex` 命中多个 | 抛 `AmbiguousPageError`，附带命中的全部索引，**不自动选第一个** |
| `attach` 卡住（简报 §7.6） | CliBridge 统一超时 15s，超时后 kill 子进程并重试 1 次，仍失败抛 `CliTimeoutError` |
| DSH 重启 / CDP 端口断开 | 检测到 `connect ECONNREFUSED` 时，清除 SessionManager 全部登记，提示模型重新 attach |
| 用户手动关闭了被接管的标签页 | 下次操作抛 `PageNotFoundError`，由模型决定是否重新 claim/open |
| 并发操作同一 pageId | 互斥锁串行；不同 pageId 可并行 |
| 操作收尾 | 只 `detach`，**禁止** `close`；`browser_close` 只关单个标签页 |

**副作用的显式声明：** 每次 `tab-select` 会改变 playwright-cli 的 current tab。工具描述需注明"本工具会切换 playwright-cli 的当前标签页，操作后 current 停留在目标页"。若后续要做"操作后恢复原 current"，作为可选增强，不在首版范围。

---

## 6. 待验证事项（实现前先做实验）

按优先级排列，每项给出验证方法：

1. **`ctx.sidebarRight.openTab` 可用性** — 在会话 A 调用，检查返回结构、页面何时真正加载完、是否有事件钩子。决定注入时机。
2. **`<webview>` 注入方式** — 若无公开注入 API，先只做 `document.title` 方案；若连 title 都无法从外部注入，退化为 `browser_goto` 后由模型手动 `evaluate` 注入（降级但可用）。
3. **`run-code` 在 attach 模式下的可用性** — 用 `playwright-cli -s=dsh run-code "async page => page.title()"` 试一次。成功则提供 `browser_run_code`，失败则从工具清单移除。
4. **多会话同 URL 的唯一性** — 会话 A、B 都开 `localhost:8080`，确认两个 title 标记可区分，`resolveIndex` 各自命中。
5. **页面自身改 title 的稳定性** — 找一个会动态改 title 的页面（如 B 站），确认标记是否被覆盖；若被覆盖，改用 `sessionStorage` + evaluate 读回的方案作为二次校验。
6. **`tab-list` 转义规则** — 构造标题含 `[]()` 的页面，验证正则解析不误判。

---

## 7. 验收测试用例（对应简报 §6）

| # | 用例 | 通过标准 |
|---|---|---|
| T1 | 会话 A `browser_open` | 返回 pageId；`tab-list` 中该页 title 含 pageId |
| T2 | 会话 A、B 各开一页 | `tab-list` 出现两个不同 pageId，各自 `browser_list` 只返回本会话条目 |
| T3 | 仅凭 sessionId 定位 | 模型只传 `pageId`，工具内部解析出正确索引，无需人工输入索引 |
| T4 | 基础操作链 | `snapshot → click → fill → goto` 全部成功 |
| T5 | 索引漂移 | 关闭一个无关标签页后，再次操作仍命中正确页面 |
| T6 | 不依赖 `tab-new` / `targetId` | 全局 grep 无这两个符号 |
| T7 | 收尾 | 调用链结束后执行 `detach`，DSH 进程存活 |
| T8 | `browser_claim` | 用户手动开页后 claim，返回原标题与 url，后续操作正常 |
| T9 | 异常路径 | 手动关掉被控页后调用 `browser_snapshot`，返回 `PageNotFoundError` 而非静默失败 |
| T10 | 解析单测 | `resolveIndex` 对含 `[]()` 的标题、`(current)` 前缀、多命中场景均有断言 |

---

## 8. 交付物清单（给创造模式）

1. `SessionManager` 模块：pageId 生成、登记、注销、`resolveIndex`、互斥锁；
2. `CliBridge` 模块：子进程封装、超时重试、`tab-list` 解析器；
3. 工具定义（按 §3 清单，含每个工具的描述文本——描述里必须包含 §4 的选型提示和 §5 的副作用声明）；
4. `resolveIndex` 单元测试（含 §7 T10 的样本）；
5. 一份 `README`，写明 attach 命令、`--remote-debugging-port` 启动方式、首版不支持项（如 `run-code` 若验证失败）。

**一句话原则：索引是易失的中间产物，pageId 是稳定契约；工具对外只暴露 pageId，索引解析永远在内部、永远重新做。**