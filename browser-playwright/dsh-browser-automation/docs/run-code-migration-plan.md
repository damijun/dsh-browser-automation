# 页面身份映射与单次 `run-code` 工具改造方案

## 1. 目标与边界

当前阶段的目标不是立即把所有工具改成单次 `run-code`，而是先建立可靠、清晰的
pageId 双向映射，并为后续页面操作迁移保留方案：

```text
pageId -> tab-list index
tab-list index -> pageId
```

已通过实际 Edge 多 tab 测试确认：在当前 `playwright-cli` attach 模式下，
`page.context().pages()` 的数组顺序与 `tab-list` 输出的 tab index 一致。因此，
后续可以在一次 `run-code` 中按 pageId 找到 `pages[index]`，并将该 index 作为
已经验证的 `tab-list` index 使用。本契约仍然只在当前调用内使用，不缓存 index。

未来适合单次 `run-code` 的页面工具可以采用：

```text
一次 CLI client
  -> 一次 run-code
    -> context.pages()
    -> 通过页面内 pageId 找到目标 Page
    -> 直接对目标 Page 执行动作
    -> 返回结构化结果
```

本方案当前只更新设计，不修改实现。当前实施范围是：

- 保留现有 CLI/daemon 连接管理；
- 使用新的页面内身份字段作为 pageId 寻址基础；
- 暂时保留标题 marker，保障现有发现、兼容和诊断能力；
- 先设计并实现清晰的 `pageId -> tab-list index` 与反向映射；
- 暂不把页面工具改成单次 `run-code`。

保留在 CLI/daemon 层的职责：

- 启动和解析 `playwright-cli`；
- 创建、复用和销毁 session daemon；
- CDP attach/detach；
- 连接状态、超时、取消和子进程清理；
- CLI 可独立复现和诊断；
- DSH 页面桥接（打开/接管/聚焦/关闭侧边栏标签）。

后续可迁移到单次 `run-code` 的职责：

- 从 `context.pages()` 获取页面集合；
- 通过页面内的 `window.__dshBrowserAutomation.pageId` 找目标 Page；
- 对目标 Page 执行导航、DOM 操作、截图或评估；
- 在同一次调用中读取结果并返回。

## 2. 当前实现与目标实现

### 2.1 当前页面操作链路

当前 `PageDriver` 的页面操作大致是：

```text
runtime.onPage(pageId)
  -> driver.resolveTabIndex(pageId)
    -> tab-list
    -> 从 title/URL 解析 pageId -> tab index
  -> tab-select index
  -> CLI action（goto/click/fill/...）
  -> 必要时再 eval 读取或恢复 marker
```

这条链路的主要成本是每次 `cli.run()` 都会启动一个 CLI client，并通过 session daemon
发送一次命令。当前 pageId 到 tab index 主要依赖 `document.title` marker；新的页面内
pageId 字段将作为后续双向映射的直接依据，但当前工具暂不切换到该执行路径。

### 2.2 当前阶段的映射链路

目标链路是：

```text
pageId
  -> resolveTabIndex(pageId)
    -> 一次 run-code 枚举 context.pages()
    -> 读取页面内 pageId，并使用 pages[index] = tab-list index
    -> 返回 tab-list index
  -> 现有 withPage / CLI 操作
```

同时提供反向查询：

```text
tab-list index
  -> resolvePageId(index)
    -> 一次 run-code 读取 pages[index] 的页面内 pageId
  -> 返回 pageId
```

`context.pages()[index]` 与 `tab-list` index 的一致性已验证，因此一次
`run-code` 可以完成双向映射。当前阶段只把这段能力用于“pageId ↔ tab index”
寻址；工具选中 tab 后仍沿用现有 CLI 操作，不把 Playwright Page 对象或数组下标
跨调用保存。

## 3. 页面身份方案

### 3.1 新的页面内身份字段

继续使用稳定的业务 `pageId`，但把它作为页面初始化脚本中的页面内状态：

```js
window.__dshBrowserAutomation = {
  pageId,
  dispose
};
```

建议将页面身份字段与 UI badge、标题 marker 解耦：

```js
window.__dshBrowserAutomation.pageId
```

是寻址所需的最小状态；标题 marker 和 badge 是可选的可视化/兼容能力。

### 3.2 初始化和当前 document

`page.addInitScript()` 只保证后续 document 会执行脚本，因此：

- `browser_open` / `browser_claim` 首次接管当前页面时，仍需在当前 document 执行一次初始化；
- 每次导航后，`addInitScript` 会在新 document 中恢复 pageId；
- 如果页面通过 `setContent()` 替换 document/head，初始化脚本不会因为“非导航替换”重新执行，需要由该操作显式恢复状态，或在操作后验证。

### 3.3 迁移阶段的兼容策略

建议分两个阶段：

1. **双写阶段**：继续写 `window.__dshBrowserAutomation.pageId`，暂时保留标题 marker，便于旧工具和诊断工具工作；映射优先读取页面内 pageId。
2. **渐进切换阶段**：先让 pageId ↔ tab index 使用页面内身份；工具仍可通过现有 CLI 执行。确认恢复、重启和并发测试通过后，再逐个把页面动作改成目标 Page 的 `run-code`。
3. **移除阶段**：所有需要的工具完成迁移后，再评估移除 `document.title` marker。

不要在单个工具中同时使用两种寻址方式作为“静默 fallback”。如果新的寻址失败，应明确报告
`pageId` 不存在、页面已关闭或当前 daemon 未暴露目标页面，避免无提示地操作错误 tab。

## 4. 建议新增的连接层能力

### 4.1 页面身份与输入校验命名

页面 ID 合法性检测的结果建议统一命名为 `validPageId`，而不是含义模糊的
`validId`。它表达的是：

```js
const validPageId = requirePageId(pageId);
```

`validPageId` 只表示输入符合 pageId 格式，不表示页面当前仍然存在；页面是否能在
tab 列表或页面集合中找到，应由后续映射函数报告。

### 4.2 `pageId -> tab-list index` 映射

原有 `resolve` 命名过于宽泛，建议改成明确表达方向的函数名：

```js
resolveTabIndex(pageId)
```

职责是：

1. 接收一个已通过格式检查的 `validPageId`；
2. 在一次 `run-code` 中获取 `context.pages()`；
3. 读取每个页面的 `window.__dshBrowserAutomation.pageId`；
4. 使用 `pages[index] = tab-list index` 得到目标 index；
5. 标题 marker 作为暂时保留的兼容/诊断信息；
6. 返回 `tab-list index`、title、URL 和 current 状态；
7. 不缓存 index。

未来使用页面集合时，映射代码可以在一次 `run-code` 中利用已验证的顺序契约：

```js
const pages = page.context().pages();
const index = pages.findIndex(/* 页面内 pageId 匹配 */);
// 当前 attach 模式下，index 等于 tab-list index
```

### 4.3 `tab-list index -> pageId` 映射

新增方向明确的反向函数：

```js
resolvePageId(tabIndex)
```

职责是：

1. 校验 tab index；
2. 在一次 `run-code` 中获取 `context.pages()`；
3. 读取 `pages[tabIndex]` 的页面内 `window.__dshBrowserAutomation.pageId`；
4. 页面内身份不可读时，暂时可使用标题 marker 作为兼容/诊断来源；
5. 返回 `pageId` 及必要的 title、URL 信息。

这两个函数建立明确的双向边界：

```text
resolveTabIndex: pageId -> tab-list index
resolvePageId:   tab-list index -> pageId
```

### 4.4 页面查找与执行职责拆分

当前 `runtime.onPage()` 已经先解析 tab，随后 `PageDriver.withPage()` 又承担解析、
选择和重试，语义上存在重复。若继续重构，最合理的方向不是简单删除 `withPage`，
而是拆成两个明确职责：

```text
resolvePage:
    pageId -> tab

executeOnResolvedTab:
    tab -> tab-select -> CLI 操作 -> 失败重定位
```

建议的概念性接口：

```js
resolvePage(pageId) -> {
  index,
  current,
  title,
  url
}

executeOnResolvedTab(tab, operation) -> result
```

迁移时需要决定由哪一层负责一次性的重定位：

- `runtime.onPage()` 负责首次 `resolvePage`、每页锁和把 tab 传入操作；
- `executeOnResolvedTab()` 负责 `tab-select`、执行 CLI 操作以及 index 失效后的再次
  `resolvePage`；
- 不要让 `onPage` 和 `withPage` 各自独立解析同一个 pageId。

页面级 `SessionManager.withLock(pageId, ...)` 必须保留。它保证同一 pageId 的操作
串行，不同 pageId 仍可并行；映射函数的重命名和职责拆分不改变这个并发边界。

### 4.5 后续 `run-code` 页面执行器

只有在上述映射和职责拆分稳定后，才考虑增加：

```js
runOnPage(pageId, operation, options)
```

其未来职责：

1. 校验 `validPageId`；
2. 在 daemon 当前 Page 上执行一次 `run-code`；
3. 通过 `context.pages()` 获取页面集合；
4. 对每个 Page 读取 `window.__dshBrowserAutomation?.pageId`；
5. 找到目标 Page；
6. 调用传入的页面操作；
7. 将结果转换为 JSON-safe 数据。

### 4.6 页面查找规则

当前阶段和未来 `run-code` 阶段都采用“首次匹配立即返回”的规则。查找 pageId
时永远忽略 `AMBIGUOUS_PAGE`，不收集全部匹配项，也不因为重复匹配而失败：

```js
const pages = page.context().pages();

for (const candidate of pages) {
  if (candidate.isClosed()) continue;
  const found = await candidate.evaluate(() => {
    return window.__dshBrowserAutomation?.pageId ?? null;
  });
  if (found === requestedPageId) return candidate;
}
```

结果规则：

- 0 个：抛出 `PAGE_NOT_FOUND`；
- 首个匹配：立即返回对应页面或 tab-list index；
- 后续页面：不再检查，永远不抛出或使用 `AMBIGUOUS_PAGE`；
- evaluate 单页失败：继续检查其他页面；如果最终没有找到，再报告目标不存在及诊断信息。

pageId 由插件生成，网页没有合理途径把它改成另一个合法 pageId；重复合法 pageId
的概率极低。因此，映射函数的核心行为必须是“先到先得”，不能为了理论上的重复而
引入 `AMBIGUOUS_PAGE` 分支或阻断正常操作。

### 4.7 结果与错误协议

单次 `run-code` 返回的数据应只包含 JSON-safe 值：

```js
{
  pageId,
  url,
  title,
  result
}
```

不要把 `Page`、`BrowserContext`、DOM 节点或 Playwright Error 对象直接返回。

错误至少区分：

- `PAGE_NOT_FOUND`：当前 context 中没有目标 pageId；
- `PAGE_CLOSED`：找到后页面在操作前关闭；
- `PAGE_EVALUATE_FAILED`：读取页面身份失败；
- `PAGE_ACTION_FAILED`：目标动作失败；
- `CLI_TIMEOUT`：整个 run-code 超时；
- `CLI_ABORTED`：调用被取消。

## 5. 工具逐项改造方向

### 5.1 启动、发现和生命周期工具

| 工具 | 方向 | 是否改成单次 run-code | 原因 |
|---|---|---:|---|
| `browser_open` | 保留 DSH bridge 打开侧边栏；接入后在当前 Page 初始化 pageId | 否，保留 CLI/bridge 混合流程 | 打开侧边栏必须调用 DSH UI；需要等待新 tab 出现并登记 `tabId` |
| `browser_claim` | 保留 bridge 获取用户眼前页面，再通过 CLI/页面集合完成接管 | 暂不改 | “用户眼前”是 DSH UI 状态，不是 Playwright Page 集合可直接推断的状态 |
| `browser_list` | 保留 `tab-list`/现有 discover；可增加 page 内状态校验作为诊断 | 否 | 这是列出全局/未标记 tab 的发现工具，不能只依赖已注入 pageId 的页面 |
| `browser_close` | 保留 bridge `close-page`，随后清理 registry | 否 | 关闭侧边栏 tab 是 DSH UI 操作；`tab-close` 会留下空壳 |
| `browser_status` | 保留 CLI/bridge 状态采集 | 否 | 目标是诊断连接、daemon、桥和 UI，不是页面动作 |

#### `browser_open`

建议流程：

```text
bridge.openTab(url)
  -> CLI 等待新页面被 daemon 采纳
  -> 单次 run-code 或当前页面操作注入 pageId
  -> manager.register()
```

打开流程可以在已有 CLI 命令和一次页面代码之间优化，但不能把 DSH UI 打开动作放进
`run-code`，因为 `run-code` 不能替代 `ctx.sidebarRight.openTab()`。

#### `browser_claim`

claim 仍需先从 bridge 获得“用户当前可见的 sidebar page URL”。之后可以用一次
`run-code` 按 URL 找到对应 Page，再写入新的 pageId；但必须保留 URL 到 Page 的唯一性检查，
并在替换旧 pageId 时原子更新 registry。

### 5.2 读取和视觉工具

以下内容是后续候选方向，不是当前实施项。当前阶段只改造 pageId 与 tab index
的映射链路，工具仍通过现有 `onPage`/CLI 路径执行。

| 工具 | 方向 | 预期收益 | 主要风险 |
|---|---|---:|---|
| `browser_snapshot` | 当前保留 CLI snapshot；后续可改成目标 Page 上的可访问性实现 | 中 | CLI snapshot 的 ref 格式是现有 click/fill 契约的一部分 |
| `browser_screenshot` | 当前保留现有路径；后续整页截图可使用一次 run-code 的 `targetPage.screenshot()` | 高（整页） | 隐藏侧边栏页面没有 frame；截图前仍需 bridge 聚焦和等待 |
| `browser_console` | 当前保留 CLI；后续再评估目标 Page 的 console 缓冲 | 低/不确定 | 直接 Playwright Page 未必能读取历史 console；没有缓冲就保留 CLI |

#### `browser_snapshot`

不要直接假设 `page.accessibility.snapshot()` 可替代当前 CLI 输出。当前工具对模型暴露的是：

- CLI 生成的 `[ref=...]`；
- 后续 `browser_click`/`browser_fill` 使用这些 ref；
- snapshot 文本原样返回。

因此有两条可选路线：

1. **第一阶段保留 CLI snapshot**：只优化 pageId 定位；如果仍需 `tab-select`，收益有限但风险最低。
2. **第二阶段统一 Playwright snapshot**：自己生成稳定的 element ref 映射，并让 click/fill 使用映射，而不是把 CLI ref
   直接传给 Playwright。

在 ref 映射方案完成前，不应只改 snapshot 的寻址方式，否则会破坏工具契约。

#### `browser_screenshot`

建议拆分：

- `fullPage` 且无 `target`：一次 `run-code` 直接执行 `targetPage.screenshot({path, fullPage, timeout})`；
- `target` 是 CSS selector：一次 `run-code` 使用 `targetPage.locator(selector).screenshot()`；
- `target` 是 CLI snapshot ref：暂保留 CLI 路径，或先建立 ref 映射。

截图仍需要 `runtime.reveal()` / `prepare-capture`，因为这是 Chromium 是否产生像素帧的 UI 条件，
不是 Playwright 页面寻址问题。bridge 聚焦和 run-code 页面操作应保持分离。

### 5.3 交互和导航工具（当前暂不迁移）

以下保留每个工具未来迁移到单次 `run-code` 的收益和原因，便于后续按优先级继续改造；
当前不改变这些工具的执行方式。

| 工具 | 方向 | 优先级 | 备注 |
|---|---|---:|---|
| `browser_goto` | 当前继续 `resolveTabIndex` + `tab-select` + CLI `goto`；后续可一次 run-code 直接 `targetPage.goto()` | P0 | 最适合未来验证新架构；当前先稳定映射链路 |
| `browser_reload` | 当前继续使用安全的 CLI `goto` 当前 URL；后续可用目标 Page 执行等价操作 | P0 | 继续避免当前已知的 CLI `reload` 会影响 DSH shell 问题 |
| `browser_evaluate` | 当前继续 CLI `eval`；后续一次 run-code 找目标 Page 再执行表达式 | P0 | 保持表达式/IIFE 契约和 JSON.stringify 结果 |
| `browser_click` | 当前继续 CLI click；后续一次 run-code 找目标 Page，再执行 locator/ref click | P1 | 需要解决 CLI snapshot ref 与 Playwright locator 的兼容 |
| `browser_fill` | 当前继续 CLI fill；后续一次 run-code 找目标 Page，再执行 locator/ref fill | P1 | 同 click，需要处理 ref 映射 |
| `browser_press` | 当前继续 CLI press；后续一次 run-code 找目标 Page，再执行 keyboard press | P1 | 不依赖 snapshot ref，迁移相对简单 |
| `browser_run_code` | 当前继续按 pageId 选择 tab 后执行用户代码；后续再包装为目标 Page 执行 | P1 | 需要保持用户代码签名、隔离和结果协议 |

#### `browser_goto`

推荐作为第一批改造对象：

```text
runtime.goto()
  -> reveal(pageId)
  -> manager.withLock(pageId)
  -> 一次 run-code
     -> 找目标 Page
     -> await targetPage.goto(url, { timeout })
     -> 读取 targetPage.url()/title()
     -> 确认 window.__dshBrowserAutomation.pageId
  -> manager.update()
```

导航后不应再依赖标题 marker 才能找回页面。需要确认 init script 已在 daemon 的 Page 对象上注册，
并在结果中报告实际 URL（包括重定向后的 URL）。

#### `browser_reload`

当前使用“goto 当前 URL”是为了避免 CLI `reload` 误刷新整个 DSH shell。改造后可以继续使用：

```js
await targetPage.goto(targetPage.url(), { ... });
```

或者在确认 CDP attach 场景下 `targetPage.reload()` 不会影响 shell 后再切换。默认应保持
当前安全行为，不因迁移而恢复已知风险命令。

#### `browser_evaluate`

这是迁移收益最高且风险较低的工具之一：

```js
const value = await targetPage.evaluate(() => (expression));
return JSON.stringify(value);
```

实际实现需要安全地把用户提供的表达式放入 CLI 的 run-code 字符串，不能依赖 shell 拼接。
应继续使用现有 `CliBridge` 的 argv 数组传参，并限制结果为 JSON-safe 数据。

#### `browser_click` / `browser_fill`

短期建议：

1. 先完成一次 run-code 的 pageId 寻址；
2. 保留 CLI snapshot ref 的行为；
3. 增加 selector 路径时直接使用 `targetPage.locator(selector)`；
4. 后续再设计 snapshot ref registry。

不能把 `e12` 直接当 CSS selector。CLI ref 是 CLI daemon 在某次 snapshot 中维护的句柄，
而 Playwright Page 本身不认识它。

#### `browser_press`

可以直接迁移，因为它不依赖 snapshot ref：

```js
await targetPage.keyboard.press(key);
```

需要继续保持：

- 每页锁；
- 取消和超时；
- 目标页面关闭时的明确错误；
- 返回现有工具期望的 `pageId`、索引兼容字段或新的结果字段。

#### `browser_run_code`

建议将用户传入的代码规范为：

```js
async page => {
  // page 是目标 Page，而不是 daemon 当前的任意 Page
}
```

外层包装器负责：

```text
context.pages()
  -> 读取 pageId
  -> 找 targetPage
  -> await userCode(targetPage)
  -> 返回结果
```

不要让模型传入的代码自己遍历并选择任意页面，否则 `pageId` 隔离和每页锁会失效。
如果需要提供跨 tab 批处理，应另建明确的 session 级工具，而不是扩大普通 `browser_run_code` 的权限。

## 6. 并发、锁和可见性

### 6.1 每页锁必须保留

`SessionManager.withLock(pageId, ...)` 仍然需要。改成直接操作 Page 不等于可以并发操作同一页面：

- click 和 goto 可能互相覆盖；
- snapshot ref 可能在页面变化后失效；
- 同时导航会使返回的 URL/title 不可预测；
- 页面关闭与操作可能发生竞态。

### 6.2 daemon 全局 current tab 的影响

当前普通页面动作仍然依赖 `tab-select`，所以不同 pageId 的并发操作仍可能互相改写
daemon current tab；这也是后续将页面定位和动作合并到一次 `run-code` 的主要收益之一。
当前阶段不改变这一行为，只通过更清晰的映射和执行职责降低误用风险。

未来普通页面动作改成直接操作目标 Page 后，才可以避免这些调用之间互相改写 daemon
current tab。这不影响仍然需要 CLI current tab 的流程：

但是以下流程仍可能改变 current tab 或依赖 UI 当前页：

- `browser_open` 的等待和首次注入；
- `browser_claim`；
- `browser_list` 的 CLI 发现；
- 当前 CLI snapshot/ref 路径；
- 需要把 sidebar tab 带到前台的 screenshot/reveal。

这些操作应继续使用现有锁或显式的 session/UI 锁，不要假设所有调用都已完全无状态。

### 6.3 UI 可见性与页面寻址分离

`reveal(pageId)` 的目标是让用户看到操作，不是寻找 Playwright Page。

因此：

```text
bridge.prepare-capture / reveal
    负责 UI 聚焦和可见性

当前：tab-list + tab-select + CLI action
    负责页面寻址和动作

未来：run-code + context.pages()
    负责 daemon 内页面寻址和直接动作
```

两者可以先后执行，但不能用“UI 当前可见页”替代 pageId 校验。

## 7. 迁移优先级

### 当前阶段：映射和职责重构

1. 在 init script 中写入并持续恢复 `window.__dshBrowserAutomation.pageId`；
2. 增加/明确 `resolveTabIndex(pageId)`；
3. 增加/明确 `resolvePageId(tabIndex)`；
4. 将 pageId 格式检测结果命名为 `validPageId`；
5. 评估把 `resolvePage` 与 `executeOnResolvedTab` 从现有 `onPage`/`withPage` 中拆开；
6. 保留 `SessionManager.withLock(pageId, ...)`；
7. 暂时保留标题 marker 和所有工具的现有 CLI 执行路径。

### 后续 P0：低风险、高收益

1. `browser_goto`
2. `browser_reload`
3. `browser_evaluate`
4. `browser_press`
5. `browser_screenshot` 的整页/selector 路径

这些工具的 Playwright API 结果直接，且不依赖 snapshot ref。

### 后续 P1：需要兼容现有输出

1. `browser_run_code`
2. `browser_click`
3. `browser_fill`
4. `browser_snapshot`

它们涉及用户代码契约或 CLI snapshot ref，应该在 P0 的寻址 helper 稳定后再做。

### 保留 CLI/bridge

1. `browser_open`
2. `browser_claim`
3. `browser_list`
4. `browser_close`
5. `browser_console`（除非确认 daemon 有可靠的 Page console 缓冲）
6. `browser_status`

这些工具承担生命周期、发现、UI 或诊断职责，改成普通页面 run-code 的收益不大。

## 8. 建议的实现阶段

### 阶段 A：建立 page 内身份

- 在 init script 中确保每个受控页面都有 `window.__dshBrowserAutomation.pageId`；
- 当前 document 立即执行一次；
- 保留标题 marker；
- 添加单元测试验证跨导航、跨 origin 和页面关闭行为。

### 阶段 B：建立双向映射和执行职责

- 实现 `resolveTabIndex(pageId)`；
- 实现 `resolvePageId(tabIndex)`；
- 使用已验证的 `pages[index] === tab-list index` 关系；
- 把 pageId 格式检查结果命名为 `validPageId`；
- 拆分 `resolvePage` 与 `executeOnResolvedTab`；
- 保留 `SessionManager.withLock`。

### 阶段 C：验证当前 CLI 工具链

- 验证 pageId 到 tab-list index 的定位；
- 验证 tab-list index 到 pageId 的反向读取；
- 验证页面导航、重启、attach/detach 和页面关闭；
- 对比重构前后的 CLI 调用次数、耗时、返回结果和错误；
- 工具暂不切换到单次 `run-code`。

### 阶段 D：迁移候选工具

- 按后续 P0/P1 顺序迁移工具；
- 先处理不依赖 snapshot ref 的 `browser_evaluate`、`browser_press`、`browser_goto`；
- 再处理截图、snapshot、click、fill 和用户代码；
- 对每个工具分别测量收益，不做一次性全量切换。

### 阶段 E：切换 marker 策略

- 运行重启、attach/detach、跨 origin、导航和并发测试；
- 确认所有页面工具均使用 page 内 pageId；
- 将标题 marker 降级为诊断信息或兼容开关；
- 再决定是否移除 `document.title` 修改逻辑。

## 9. 当前阶段验收指标

当前映射和重构至少验证：

### 性能与调用链

- 目标工具的 CLI client 调用次数；
- pageId 定位耗时；
- 总耗时 P50/P95；
- 1、5、20 个 tab 的对比；
- 当前页是目标页和不是目标页两种情况。
- `context.pages()[index]` 与 `tab-list` index 在目标环境中保持一致；
- 映射不缓存易失的 index；
- `resolvePage` 和 `executeOnResolvedTab` 不重复解析同一个 pageId。

### 正确性

- 多 tab 中只操作指定 pageId；
- 页面 title 不包含 marker 时仍能定位；
- 页面导航后 pageId 保持不变；
- 重定向后返回真实 URL；
- 页面关闭时不操作其他 tab；
- 同 page 并发调用按顺序执行；
- 不同 page 并发调用不互相 `tab-select`。

### 生命周期

- CLI daemon 首次 attach；
- detach 后旧 pageId 的明确失败；
- DSH 重启后的重新 open/claim；
- 页面被用户关闭后 registry 和 live pages 一致；
- DSH 窗口隐藏时截图仍给出明确原因。

### 兼容性

- `browser_snapshot` 的输出格式；
- click/fill 使用的 ref；
- `browser_run_code` 的用户代码签名；
- 工具返回中的 `pageId`、`index`、`url`、`title`；
- 错误消息仍然能指导模型下一步行动。

## 10. 当前推荐架构

```text
工具层 browser_*
  |
  +-- 生命周期/发现/状态
  |     -> bridge + CLI/daemon
  |
  +-- 当前普通单页动作
  |     -> runtime.onPage + SessionManager.withLock
  |     -> resolvePage / executeOnResolvedTab
  |     -> tab-select + 现有 CLI action
  |
  +-- 后续候选普通单页动作
        -> 一次 CLI run-code
             -> context.pages()
             -> window.__dshBrowserAutomation.pageId
             -> targetPage 直接操作
  |
  +-- UI 可见性
        -> bridge.prepare-capture / reveal

CliBridge
  -> 继续负责 Node 子进程、session、attach、超时、取消和错误

playwright-cli daemon
  -> 继续持有 BrowserContext 和 CDP 连接
```

当前不建议把所有工具机械地改成 `run-code`。正确的渐进边界是：

> 先由 CLI/daemon 负责连接和生命周期，使用页面内 pageId 建立明确的双向 tab 映射；
> 当前工具继续使用现有 CLI 原生命令；后续再由 `run-code` 在一次调用中完成需要跨 tab
> 寻址的页面动作。DSH bridge 继续负责侧边栏 UI，CLI 原生命令继续保留在无法安全等价
> 替换的工具上。
