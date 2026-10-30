# 开发文档 · 全局 CLI 锁（已实现）

> 状态：**已实现**（2026-10-31）。实现位置：`src/driver.js` 的 `withCli()`；
> 测试：`test/concurrency.test.js`；本次同时删掉了 `runtime` 里两处"锁外 tab-select"。
> 旧版本本文引用的 `withPage` / `driver.resolve` / `validId` 均已不存在，请以本文为准。

---

## 1. 问题

`playwright-cli` 的"当前 tab"是 **daemon 里的一个全局指针**，不是命令参数：

- 选页只能用 `tab-select <index>`；
- 之后所有页面命令（`snapshot` / `click` / `fill` / `press` / `goto` / `eval` / `screenshot` …）
  都作用在这个指针上；
- 本插件的所有 DSH 会话共用**同一个 CLI 会话**（`-s=dsh`，见 `cordis.patch.yml`）。

所以"选页 + 命令"是一个**必须原子的临界区**。没有互斥时：

```
会话 A（pageId PA，index 1）        会话 B（pageId PB，index 2）
tab-select 1
                                    tab-select 2
snapshot  ← 实际拍的是 index 2 ✗     snapshot
click     ← 实际点在 index 2 ✗       click
```

**后果**：读操作返回错的页；写操作（`click`/`fill`/`press`/`goto`）落到**别人的页面上**，
而工具返回"成功"。对"批量点赞/提交表单"这种场景，这是最坏的一类错误。

### 触发条件（实测可达）

- 同一个 DSH 窗口里有**两个以上会话**同时调用 `browser_*`（各自 Agent 并行跑）；
- `browser_open` 的选页与另一个操作并发（`withOpenLock` 只互斥两次 open）；
- 用户点"断开 CLI"（`browser_status action=detach`）时正好有命令在飞——
  实测会以 `Session closed` 打断那条命令；
- `attach`（新建 CDP 会话）插在在飞命令中间，会让那条命令的 tab 失效。

不触发：同一个 pageId 的并发（`SessionManager.withLock` 已串行）；同一个 Agent 内的连续工具调用
（本插件工具没有声明 `isConcurrencySafe`，Harness 串行调度）。

---

## 2. 实现

一把 **driver 级互斥**（不是按 pageId —— 冲突恰恰发生在不同 pageId 之间），用 promise 链排队：

```js
// src/driver.js
async withCli(operation) {
  if (this.cliHolder.getStore() === this) return operation();   // 同一异步上下文重入
  const previous = this.cliQueue;
  let release;
  this.cliQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await this.cliHolder.run(this, operation);
  } finally {
    release();
  }
}
```

`AsyncLocalStorage` 提供**按异步上下文的重入**：`executeOnResolvedTab` 内部会调
`resolvePage` → `ensureAttached` → `attachWithRetry`，这几层都要能进入锁而不死锁；
而另一个调用方的上下文里没有标记，会被正常排队。

### 临界区（三处，全部进锁）

| 位置 | 为什么 |
|---|---|
| `executeOnResolvedTab` 的整个循环体 | `tab-select` + 命令 + 失败重解析；**唯一**的选页点 |
| `attachWithRetry` | `attach` 会新建 CDP 会话，插在在飞命令中间会让它失效 |
| `detach` | 在飞命令会被 `Session closed` 打断（实测） |

同时**删掉**了 `runtime` 里两处独立的 `tab-select`（`browser_open` / `browser_claim`）：
它们原本在锁外选页，然后调用 `installMarker`，而 `installMarker` 会在锁内再选一次。
现在只把 tab 交给 `installMarker`，由它在锁内完成选页——既正确又少一次 CLI 调用。

守卫测试（`test/concurrency.test.js`）会扫描 `src/*.js`：`'tab-select'` 只能出现在
`driver.js` 的 `executeOnResolvedTab` 里，任何其它位置出现即失败。

### 与"每页锁"的关系

两层锁，职责不同，都保留：

```
SessionManager.withLock(pageId)   同一页的动作串行（不同页可并行）
PageDriver.withCli(fn)            跨页共享的全局指针互斥（所有页共用）
```

---

## 3. 测试

| 用例 | 断言 |
|---|---|
| 两个页面并发操作 | 记录序列必须是 `select:1, op:1, op:1:end, select:2, …` 的**分段**形式，不允许 `select:1, select:2, op:1` |
| 重入 | `withCli(() => withCli(...))` 不死锁；两个独立上下文仍排队 |
| detach 排队 | `cli:detach` 出现在 `op:end` 之后 |
| 选页位置守卫 | `tab-select` 只在 `driver.js::executeOnResolvedTab`，`runtime.js` 里没有 |

这些用例在加锁前是失败的（第一个用例会看到 `select:1, select:2, …`）。

---

## 4. 已知边界 / 未做

- **跨会话操作已被拒绝**（2026-10-31 补上）：`onPage` 在加锁前调用 `requireOwnership`，
  归属取登记表的完整 `sessionId`，没有登记则退回 pageId 里的 6 位 tag；不匹配即 `PAGE_FOREIGN_SESSION` 且不执行任何动作。
  `browser_claim` 是唯一的接管途径。测试见 `test/ownership.test.js`。
- **锁的粒度是 driver**：如果将来把页面动作迁到单次 `run-code`（见
  `run-code-migration-plan.md` 阶段 D），`run-code` 本身不依赖全局指针，临界区可以变窄；
  但 `tab-select` 相关的路径（open/claim/旧工具）仍需这把锁。
- **AsyncLocalStorage 的边界**：锁持有者内部派生的"游离 promise"会继承持有标记，
  若在锁释放后再调用 `withCli` 会直接通过。当前所有调用都在 `await` 链上，不存在这种用法。

