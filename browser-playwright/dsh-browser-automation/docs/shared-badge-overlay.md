# 开发文档 · 把「正在与智能体共享」标记移到 DSH 界面层（`shell.overlay`）

> 状态：**未实现**（本文是可执行规格，供以后动工时照做）
> 影响面：`client.js`（新组件 + 锚定逻辑）、`index.js`/`src/bridge.js`（下发 shared 列表）、`src/config.js`（模式枚举）、`test/`
> 预估：2–3 小时（含真机验证）；风险主要集中在"URL 栏 DOM 定位"，不在渲染本身

---

## 1. 目标与验收

现在徽标画在**页面里**（`#__dsh-ba-shared__`，见 `src/page-id.js`），代价是它会进入截图 —— 而我们自己截的正是 webview guest 的像素，所以"证据图"上永远带着它。

要做的是：**把徽标移到 DSH 的界面层**，叠在浏览器标签页的 URL 栏右侧。

验收标准：

1. `browser_screenshot` 产出的图里**没有**任何徽标（像素级：与关掉标记时的同一页面对比，差异只在页面内容）；
2. 用户在该标签页上**看得见**"共享中"（URL 栏右侧一颗圆点 + 文案，宽度不够时只留圆点）；
3. **完全不动页面 DOM**（页面自己的脚本无法感知/删除这个标记）；
4. 侧边栏折叠、分割成两个 pane、切换标签页、窗口缩放、浮动/全屏模式下都不跑位、不残留；
5. 拿不到 URL 栏时**静默不渲染**（绝不抛错、绝不影响其它功能）。

---

## 2. 现状：页面内徽标的实现

```js
// src/page-id.js
export const SHARED_BADGE_ID = '__dsh-ba-shared__';

titleMarkerExpression(pageId, { badge = true, text })   // 生成一段 IIFE
installMarkerCode(pageId, options)                      // page.addInitScript(<上面那段>)
```

- 通道 A：`browser_open`/`browser_claim` 时装 init script（每次导航自动重放）；
- 通道 B：紧随其后 `eval` 一次（当前文档立即生效 + 回报 title/url）；
- 徽标本体：`position:fixed; top:12px; right:12px; z-index:2147483647; pointer-events:none`，shadow root + `all:initial`；
- 开关：`showSharedBadge`（默认 `true`），经 `PageDriver.marker` 传进每次标记应用。

它的问题只有一条：**在页面绘制树里，所以进截图**。其余（不干扰点击、不被页面 CSS 影响）都成立。

---

## 3. 可用表面盘点（2026-10-30 实测）

| 表面 | 有对外钩子吗 | 结论 |
|---|---|---|
| 浏览器工具栏 / URL 栏 | ❌ | `sidebar.right` 下的槽位只有：pane 体、`pane.tab.title`、`guide`、`files.actions`、`document.*`、`tab.menu.item` |
| 标签页 chip 标题 | ✅ 间接 | chip 显示 `document.title`，现有 `[dshpg-…]` 就在这；再加字会与 pageId 抢位置 |
| 标签页右键菜单 | ✅ `sidebar.right.tab.menu.item` | 要点开才可见，不适合"常驻提示" |
| **框架级悬浮层** | ✅ **`shell.overlay`** | "Frame-wide floating layer, above every column and outside their scroll containers"，`scope: root`，注册字段 `id`/`order`/`label` |
| 面板型标签页 | ✅ | 我们自己的 `browser_status action=panel`，作为列表视图（已有） |

**`shell.overlay` 是唯一能"叠在 chrome 上、又不进 webview 截图"的官方坑位**。选择它的直接收益：页面像素完全干净。

---

## 4. 设计

### 4.1 组件放哪

```js
// client.js，与 panel / config card 同级注册
ctx.slots.register(
  { name: 'shell.overlay', id: 'shared-badge', order: 50 },
  makeSharedBadge(t),          // 纯展示组件，无副作用
);
```

注意它是 **`scope: root`**：没有会话时也会渲染，所以组件必须自己判断"现在该不该显示"，不能依赖 `props.sessionId`。

### 4.2 怎么判断"当前可见页被共享"

client 知道 `visibleUrl`（已有），host 知道 pageId 注册表（`SessionManager`）。最小改动：**poll 响应里带一份 shared 列表**。

```
POST bridge/poll  ← { commands: [] }
                  → { commands: [...], shared: [{ pageId, url, sessionId }, ...] }   // 最多 20 条
```

- host 侧：`runtime.manager.all()` → 取 `{pageId, url, sessionId}`；
- client 侧：`sharedVisible = shared.some(s => sameUrl(s.url, visibleUrl))`，`sameUrl` 只做"去尾斜杠 / 忽略 hash"级别的比较（host 端 `samePage()` 已有更完整的归一化，可复制其规则）；
- 页面侧每 15s 一次的 `hello` 不必带这个列表，poll 已经足够新。

> 备选（更省事、但语义弱）：只要"当前 pane 是浏览器且 URL 非空"就显示。不推荐 —— 会把用户自己开的页面也标成共享。

### 4.3 怎么锚定 URL 栏（本方案唯一的脆弱点）

实测数据（`browser_evaluate` 打在 `dsh-app://app/` 页上）：

```
URL 栏 input : class="qWvkEq_address"   rect=[1497, 83, 385, 28]
webview 祖先 : section._tabHost_… → div._paneBody_… → div._tabHostBody_… → div.OUqwTW_tabBody
              → div.qWvkEq_root → div.qWvkEq_content → div.qWvkEq_viewport → <webview>
```

**类名是哈希的，不能写死。** 选取用结构启发式：

```js
function pickAddressBar(doc = document) {
  const inputs = [...doc.querySelectorAll('input')];
  for (const el of inputs) {
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 18) continue;          // 排除隐藏/极窄
    if (!/^https?:\/\//i.test(el.value || '')) continue;   // 必须是 URL
    const pane = el.closest('section');
    if (pane && pane.querySelector('webview')) return el;  // 且同 pane 内有 webview
  }
  return null;
}
```

定位（`position: fixed`，overlay 这一层本身不在滚动容器里）：

```js
const r = bar.getBoundingClientRect();
const w = chipWidth, h = 20, inset = 8;
const left = Math.max(r.left + 60, r.right - inset - w);   // 至少留出 URL 文字起点
const top  = r.top + (r.height - h) / 2;
```

窄栏自适应：`r.width < 260` 时只渲染圆点（`aria-label` + `title` 给完整文案）。

追踪（三者任一变化都要重测）：

1. `window.addEventListener('resize')`；
2. `new ResizeObserver(() => schedule()).observe(document.body)`（分割成两个 pane、折叠侧边栏都会改变它的尺寸）；
3. 500ms `setInterval` 兜底（切换标签页、浮动/全屏切换不一定触发上面两者）；
4. `document.hidden` 时跳过（窗口最小化时别做无用功）。

`schedule()` 用 `requestAnimationFrame` 合并，且只在 `left/top` 真的变了才 setState —— 避免 2Hz 的 React 重渲染。

### 4.4 视觉与交互

- 一颗 7px 圆点（`#34d399`，外发光环）+ 文案「正在与智能体共享」；字体与面板一致（`font: 500 12px …`）；
- 背景用 `--dsw-alias-bg-layer-2` 之类的主题 token，圆角 999px，`box-shadow` 轻阴影，避免在浅色 URL 栏上看不清；
- **`pointer-events: none`**：纯装饰，绝不抢 URL 栏的点击/选中；
- `role="status"` + `aria-label`，读屏可读；
- 文案走 locale（`t('badge.shared')`），中英现有字典机制直接复用。

### 4.5 与现有开关的关系

把布尔 `showSharedBadge` 升级成模式枚举（更诚实，也能两种都开）：

| 值 | 页面内徽标 | 界面层 chip |
|---|---|---|
| `'page'`（**保持现状默认**） | ✅ | ❌ |
| `'chrome'` | ❌ | ✅ |
| `'both'` | ✅ | ✅ |
| `'off'` | ❌ | ❌ |

兼容：`showSharedBadge: false` 等价 `'off'`；`true` 等价 `'page'`（迁移时读一次旧键即可，键名可保留 `showSharedBadge` 以免破坏已有 patch）。

> 提醒：配置是**启动快照**（见 README §6），改模式要重启 —— 与其它键一致，不特殊处理。

---

## 5. 实现步骤

1. **host**：`src/bridge.js` 的 poll 响应加 `shared`；`src/runtime.js` 提供 `sharedPages()`（读 `manager.all()`，脱敏到 `{pageId, url, sessionId}`）。
2. **client**：poll 结果里保存 `shared`；`sameUrl()` 归一化；`makeSharedBadge(t)` 组件（含 `pickAddressBar` + `anchor()` + 追踪）。
3. **client**：`shell.overlay` 注册 + 只在 `mode` 允许时挂载。
4. **config**：`src/config.js` 枚举（`z.union([z.const('page'), …])`）+ `src/config-write.js` 白名单类型 + `client.js` 的 `CONFIG_FIELDS`（`kind: 'select'`，可复用现有分段控件）+ 中英文案（**否则 UI 守卫测试会失败**，见 `test/ui-coverage.test.js`）。
5. **page-id**：`titleMarkerExpression` 的 `badge` 选项改为读模式（`'page'`/`'both'` 才画）。
6. **docs**：README §6.1 改写为"两种挂载方式"，本文状态改为"已实现"。

---

## 6. 测试计划

单元：

- `anchor(rect, chip)`：右对齐、垂直居中、`left` 下限钳制、视口外时返回 null；
- `pickAddressBar(fakeDoc)`：挑中"窄的假 input"之外的那一个；没有 webview 的 pane 不算；多个 pane 时只取**可见**那个（`getBoundingClientRect().width > 0`）；
- 模式解析：`'page' | 'chrome' | 'both' | 'off'` 与旧布尔值的映射；
- `sharedPages()` 的脱敏与上限。

真机清单（窗口必须可见）：

1. 开页 → chip 出现在 URL 栏右侧；`browser_screenshot` 里**没有** chip；
2. 分割两个 pane、各开一页 → 只有被共享的那个 pane 显示；切到另一个 pane 不跑位；
3. 折叠/展开右侧边栏 → chip 跟随；窗口缩放 → 跟随；浮动/全屏 → 跟随；
4. 关闭标签页 → chip 消失；`detach` → 全部消失（不依赖页面）；
5. 窄宽度（URL 栏 < 260px）→ 只显示圆点；
6. 主题切浅色 → 对比度足够；语言切英文 → 文案变。

---

## 7. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| DSH 改版改掉 URL 栏 DOM | chip 消失 | 启发式 + 失败静默；同时保留页面内徽标（`'both'`）作为兜底 |
| `shell.overlay` 层级与粘性输入框/浮层冲突 | chip 被盖住 | 用 overlay 层自身定位；必要时提高 `order`，但不要动 z-index 到 2147483647（那是页面内徽标的做法） |
| 两个 pane 都有共享页 | 一个 chip 只能指一个 | 取"当前可见 pane"；不可见 pane 的共享状态在面板里看 |
| 每次轮询都重算 | CPU 抖动 | `document.hidden` 跳过 + rAF 合并 + 位置未变不 setState |
| 与 `pointer-events:none` 冲突的诉求（想点 chip 跳到面板） | — | 需要可点时改成 `pointer-events:auto`，但那会挡住 URL 栏右侧，需另定位置 |

回退策略：把 `showSharedBadge` 改回 `'page'` 即可（不需要回滚代码）。

---

## 8. 为什么不选其它方案

- **改标签页标题**（chip 内加 `· 共享`）：零成本、也不进截图，但会与 `[dshpg-…]` 抢位置，且页面自己改标题时依赖 observer 补回 —— 可作为 `'chrome'` 的**降级形态**保留。
- **截图前临时隐藏页面内徽标**：最简单、必然干净，但只是"截图时隐身"，用户看不到常驻提示；适合当作 `'page'` 模式下 `browser_screenshot` 的默认行为（约 20 行，建议**单独先做**）。
- **Electron 主进程 `BrowserWindow` 装饰**：插件没有 `BrowserWindow` 句柄，需要 DSH 侧开口子，超出插件边界。

---

## 9. 附录：本方案的实测锚点（2026-10-30）

```
URL 栏 input : class="qWvkEq_address"    value="https://www.bilibili.com/"
               rect=[1497, 83, 385, 28]
pane 祖先    : section._tabHost_6nhg2_162._pane_6nhg2_209
               → div._tabHostBody_6nhg2_181._paneBody_6nhg2_318
               → div.OUqwTW_tabBody
webview 链   : div.qWvkEq_root → div.qWvkEq_content → div.qWvkEq_viewport → <webview>
应用视口     : 1920×1032（窗口还原状态）
```

（哈希类名仅供本次核对，代码里不得引用。）
