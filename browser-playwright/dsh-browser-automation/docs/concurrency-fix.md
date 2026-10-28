# 开发文档 · 跨页/跨会话竞态：给 CLI 操作加进程级串行锁

> 状态：**未实现**（本文是可执行的实现规格，供以后动工时直接照做）
> 影响面：`src/runtime.js`、`src/driver.js`、`test/` 新增用例
> 预估：30–40 分钟（含真机验证）

---

## 1. 问题

`playwright-cli` 的"当前页"是**daemon 里的一个全局指针**，不是命令参数：

- 选页只能用 `tab-select <index>`；
- 之后所有命令（`snapshot` / `click` / `fill` / `eval` / `screenshot` …）都作用在这个全局指针上；
- 本插件的所有 DSH 会话共用**同一个 CLI 会话**（`-s=dsh`，见 `cordis.patch.yml`）。

而当前的互斥是**按 pageId 分的**：

```js
// src/runtime.js —— onPage
return this.manager.withLock(validId, async () => {   // ← 只锁同一个 pageId
  const tab = await driver.resolve(validId);
  const result = await operation(driver, tab);
  ...
});
```

```js
// src/driver.js —— withPage
if (hit.current !== true) await this.cli.run(['--raw', 'tab-select', String(hit.index)]);
return await operation(hit);                            // ← select 与命令之间没有互斥保护
```

于是两个不同 pageId 的调用可以这样交错：

```
会话 A（pageId PA，index 1）      会话 B（pageId PB，index 2）
────────────────────────────      ────────────────────────────
resolve → index 1
tab-select 1
                                  resolve → index 2
                                  tab-select 2
snapshot  ← 实际跑在 index 2 上        snapshot  ← 也在 index 2
```

**后果**：读操作拍错页；写操作（`click` / `fill` / `press` / `goto`）**落在另一个会话的页上**，
而工具会返回"成功"。这比报错严重得多 —— 用户可能正在那个页里填表。

### 触发条件

- 同一个 DSH 窗口里有**两个以上会话**同时让模型调用 `browser_*`（各自的 Agent 并行跑）；
- 或者同一个会话里将来出现并行工具调度（目前不会：本插件的工具没有声明
  `isConcurrencySafe`，所以同一 Agent 内是串行的）；
- **任何用户发起的 `detach`**（状态面板的"断开 CLI"按钮、`browser_status action=detach`），
  如果此刻正好有一条 CLI 命令在飞，那条命令会被 `Session closed` 直接打断。
  实测：在面板里点"断开 CLI"时，我并发执行的一条 `eval` 就死在了
  `playwright-core/lib/tools/cli-client/session.js:254 callback.reject(new Error("Session closed"))`。
  `detach` 也必须在同一把锁里排队，而不是插队。

### 反例（不属于本问题）

- 同一个 pageId 的并发调用：已被 `SessionManager.withLock` 串行，安全。
- `browser_open` 的并发：已被 `Runtime.withOpenLock` 串行，安全。

---

## 2. 复现（先写这个，再改代码）

### 2.1 单元级（必须，进 `test/concurrency.test.js`）

用一个"慢 CLI"制造确定的交错窗口：

```js
const cli = {
  run: async (args) => {
    calls.push(args);
    await new Promise((r) => setTimeout(r, 30));   // 放大窗口
    return { stdout: '"-"', stderr: '', code: 0 };
  },
};
runtime.cli = cli;
runtime.driver = { cli, resolve: /* 按 pageId 返回 index 1 / 2 */ };
```

断言（当前应**失败**，修好后通过）：

```js
const [a, b] = await Promise.all([
  runtime.snapshot({ pageId: PA }),   // index 1
  runtime.snapshot({ pageId: PB }),   // index 2
]);
// 关键：任何一个 "snapshot" 之前，最近一次 tab-select 必须是它自己的 index
```

判定方式：记录 `(pageId → index)`，按 `calls` 顺序模拟"当前页"，断言每次 `snapshot`
出现时的当前页等于该调用自己的 index。

### 2.2 真机（必须）

```text
- 我（会话 A）循环 10 次 browser_snapshot(PA)，每次核对返回的 title 里有 PA 的标记；
- 子会话（会话 B）同时循环 10 次 browser_snapshot(PB)，核对 PB；
- 两个页故意用不同 URL（example.com / example.org）。
```

修改前预期能看到"某次返回的是对方页的 title"；修改后 20 次全部正确。
（`browser_snapshot` 的返回里带 `title`/`url`，所以核对不需要额外手段。）

---

## 3. 方案

### 3.1 采用：进程级 CLI 锁（`withCliLock`）

关键洞察：**全局状态（当前页）必须用全局锁；分片锁在这里不成立。**

```js
// src/runtime.js
constructor: this.cliLock = Promise.resolve();

/** Serialize one whole "select + command" critical section. */
async withCliLock(operation) {
  const previous = this.cliLock;
  let release;
  this.cliLock = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}
```

把它套在 `onPage` 的最外层（而不是 `withPage` 里，理由见 3.3）：

```js
async onPage(pageId, operation, signal) {
  const driver = this.ensureDriver();
  const validId = requirePageId(pageId);
  if (signal?.aborted) throw new Error('The operation was cancelled.');
  return this.withCliLock(async () =>
    this.manager.withLock(validId, async () => {
      if (!driver.attached) await this.attach(signal);
      const tab = await driver.resolve(validId);
      const result = await operation(driver, tab);
      return { pageId: validId, index: tab.index, ...result };
    }),
  );
}
```

`openPage` 的 `withOpenLock` 保持不动 —— 它已经覆盖了开页那条路径；
但**它内部会调用 CLI**，所以它也应该被 `withCliLock` 包住（或在 `withOpenLock` 回调最外层
再套一层 `withCliLock`），否则"开页"与"别的会话的点击"仍可交错。

### 3.2 代价（要接受）

- **不同 page 不再并行**。每个动作本来只有 2–3 次 CLI 往返（约 0.3–0.6s），串行化的损失可接受。
- **截图会占锁约 1.2s**：`browser_screenshot` 的慢路径里，`focus + 等待首帧` 也在临界区内
  （`screenshotSettleMs`）。如果觉得太久，可以把"等首帧"挪到锁外、只在真正 capture 时进锁，
  但那样必须保证 capture 前不会再被别人 `tab-select` —— 等价于还是要锁。**建议先接受。**

### 3.3 为什么不把锁放在 `driver.withPage`

`withPage` 只覆盖"select + 一条命令"，但一次工具调用的临界区还包括它前后的
`driver.resolve()`（又是一次 `tab-list`）以及 `runtime` 层可能追加的第二次命令
（例如 `run_code` 之后补标记的那次 `eval`、`goto` 之后的 `eval`）。
锁在 `withPage` 里会出现"锁内 select 完、锁外再 select"的空隙。**锁必须包住一次完整工具调用。**

### 3.4 备选方案（记录，不采用）

| 方案 | 结论 |
|---|---|
| 命令里带 target（`tab-select --target-id`） | ❌ CLI 没有这个参数，设计上就不可能 |
| select 后立刻 `tab-list` 校验当前页，不符就重试 | ⚠️ 只能缩小窗口，不能消除；而且每次都多一次往返 |
| 每个 DSH 会话用独立 CLI 会话名（`-s=dsh-<sessionId>`） | ✅ 能隔离会话，但**每个会话一个 daemon + 一条 CDP 连接**，`detach` 语义变成 per-session，诊断面翻倍；作为长期演进可考虑，见 §5 |
| 让工具声明 `isConcurrencySafe: true` 换取并行 | ❌ 本插件依赖全局当前页，**绝不能**声明并发安全 |

---

## 4. 验收标准

1. 新增单测：两个不同 pageId 的 `snapshot` 并发时，`calls` 顺序里每条命令都紧跟在自己
   的 `tab-select` 之后（无交错）；`Promise.all` 都成功。
2. 新增单测：临界区内抛错/超时后，锁仍会被释放（后续调用不被永久阻塞）。
3. 真机并发 20 次，两边的 `title` 全部正确。
4. 现有 86 个用例全绿（特别是 `screenshot.test.js` 与 `start-modes.test.js` 里的顺序断言）。
5. `browser_status` 新增诊断：`cliLock.waiting`（当前排队的调用数），便于观察"是不是被谁卡住了"。

---

## 5. 后续可选演进（不在本文范围）

- **per-session CLI 会话名**：真正隔离两个 DSH 会话的自动化（连 `detach` 也隔离）。
  代价是 daemon 与 CDP 连接数随会话数增长；需要重新定义 `browser_status`、`pageId` 的可见范围。
- **把"当前页"从全局状态里拿掉**：只有等 `playwright-cli` 支持按 target 指定命令，
  这个设计债才会彻底消失。

---

## 6. 改动清单

| 文件 | 改动 |
|---|---|
| `src/runtime.js` | 新增 `withCliLock` / `cliLock` 字段；`onPage` 与 `openPage` 套锁；`status` 输出 `cliLock.waiting` |
| `src/tools.js` | `browser_status` 的 schema 补 `cliLock` 字段（`additionalProperties: false` 会拒绝未声明字段） |
| `test/concurrency.test.js` | 新增：交错检测、异常后释放 |
| `test/screenshot.test.js` | 若锁改变了调用顺序，同步调整断言 |
| `README.md` | §1 不变量里加一句："当前页是全局状态，所以 CLI 操作必须全局串行" |
