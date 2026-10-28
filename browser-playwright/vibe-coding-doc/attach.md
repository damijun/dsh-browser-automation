# DSH 侧边栏浏览器自动化测试工具 — 开发简报

## 1. 目标

开发一个 DSH 插件/工具，使自动化测试可以稳定控制 **DSH 桌面端侧边栏浏览器**（`@deepseek-ai/dsh-client-ui-sidebar-browser`）中的页面，并能在**多个 DSH 会话同时打开侧边栏浏览器**时，准确区分每个标签页属于哪个会话。

工具不应依赖人工维护“索引→会话”映射，而应由插件自动完成标签页的创建、标记、索引解析和 Playwright CLI 操作衔接。

---

## 2. 背景与已确认事实

### 2.1 Playwright CLI 附加 DSH 的方式

在dsh快捷方式的"目标"里面改成""C:\Users\damijun\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" --remote-debugging-port=9222",也就是在后面添加--remote-debugging-port=9222

已成功通过 DSH 桌面端启动参数开启远程调试，并使用以下命令附加：

```powershell
playwright-cli attach --cdp=http://127.0.0.1:9222 -s=dsh
```

附加后，DSH 工作面板和侧边栏浏览器中的页面都会出现在同一个扁平标签列表中：

```powershell
playwright-cli -s=dsh tab-list
```

示例输出：

```text
- 0: [dsh 侧边栏浏览器是否支持 CDP 接口 — DeepSeek Harness](dsh-app://app/)
- 1: [哔哩哔哩 (゜-゜)つロ 干杯~-bilibili](https://www.bilibili.com/...)
- 2: (current) [搜索 - Microsoft 必应](https://cn.bing.com/)
```

### 2.2 关键限制

1. **`tab-new` 不可用**  
   DSH 基于 Electron，CDP 不支持 `Target.createTarget`。执行：
   ```powershell
   playwright-cli -s=dsh tab-new www.bilibili.com
   ```
   会报错：
   ```text
   Error: Protocol error (Target.createTarget): Not supported
   ```
   因此不能依靠 Playwright CLI 新建标签页。

2. **Playwright CLI 只有索引和“当前标签页”概念**  
   官方 `playwright-cli` 标签页管理命令为：
   - `tab-list`
   - `tab-new [url]`
   - `tab-close [index]`
   - `tab-select <index>`

   **不存在 `targetId` 参数**。标签页通过从 0 开始的数字索引区分；不带标签参数的命令作用于 `(current)` 标签页。索引会随标签页关闭而动态变化。

3. **`tab-list` 不携带 DSH 会话归属信息**  
   多个 DSH 会话打开的侧边栏浏览器标签页，在 `tab-list` 中表现为一个跨会话的扁平列表，无法直接看出某个标签属于哪个 DSH 会话。

4. **DSH 官方 `ui-sidebar-browser` 是纯 UI 插件**  
   其宿主半为空 `apply() {}`，不注册模型工具，也不主动暴露可附加的独立 CDP 端口。但它提供了客户端插件 API，可以由其他插件调用以打开侧边栏浏览器标签页。

---

## 3. 推荐总体方案

采用 **“DSH 插件打开并标记标签页 + Playwright CLI 按标记解析索引并操作”** 的架构。

### 3.1 打开新标签页：使用 DSH 原生能力，不用 `tab-new`

在插件中通过 DSH Client 插件 API 打开侧边栏浏览器标签页：

```javascript
ctx.sidebarRight.openTab('browser', { params: { url } })
```

也可以参考内部命令 `browser.new`（Windows 默认 `Ctrl+T`）的行为，但插件实现应优先调用 `ctx.sidebarRight.openTab`。

这样新标签页会纳入 DSH 的 UI 生命周期管理，并且绕开 Electron CDP 不支持 `Target.createTarget` 的问题。

### 3.2 为每个标签页注入唯一会话标记

插件在打开标签页时，生成一个由 **DSH 会话 ID + 随机数** 组成的唯一标记，例如：

```text
pageId-<sessionId>-<uuid>
```

然后通过注入能力将该标记写入页面。推荐一：

- 修改页面标题：
  ```javascript
  document.title = document.title + ' [pageId-...]'
  ```

写入后，`playwright-cli -s=dsh tab-list` 的输出中，该标签页的标题或 URL 就会包含这个标记。

### 3.3 操作前动态解析索引

插件在需要操作某个 DSH 会话的标签页时：

1. 执行 `playwright-cli -s=dsh tab-list` 并捕获输出。
2. 在输出中搜索该会话对应的唯一标记。
3. 解析标记所在行的行首索引，例如：
   ```text
   - 1: [哔哩哔哩 - [pageId-sessionA-abc123]](https://...)
   ```
   得到索引 `1`。
4. 使用该索引执行：
   ```powershell
   playwright-cli -s=dsh tab-select 1
   playwright-cli -s=dsh snapshot
   playwright-cli -s=dsh click <ref>
   ```

**注意**：索引只在单次 `tab-list` 生命周期内有效。每次关键操作前都应重新执行 `tab-list` 并重新解析，不能硬编码索引。

---

## 4. 插件实现要点

### 4.1 获取当前 DSH 会话 ID

可参考 `dsh-header-masq` 等插件的方式，通过 `GenerateOptions.sessionId` 或请求头获取持久化的 DSH Session ID。同一会话内该值应保持稳定。

### 4.2 调用侧边栏打开 API

使用官方 Client 插件 API：

```javascript
ctx.sidebarRight.openTab('browser', { params: { url } })
```

需要确认：
- 该 API 在目标 DSH 版本中可用；
- `params.url` 的校验规则与地址栏一致；
- 打开后如何获得该标签页的注入时机（页面加载完成事件或 `webview` 注入接口）。

### 4.3 页面注入标记

可参考 `dsh-live-browser` 等插件的注入思路，在不修改 DSH 文件的前提下，向侧边栏 `<webview>` 注入脚本写入标记。若注入能力受限，优先使用“修改 `document.title`”这种低侵入方式。

### 4.4 调用 Playwright CLI

插件内部可通过子进程执行：

```powershell
playwright-cli -s=dsh tab-list
playwright-cli -s=dsh tab-select <index>
playwright-cli -s=dsh snapshot
playwright-cli -s=dsh click <ref>
playwright-cli -s=dsh fill <ref> <text>
```

解析 `tab-list` 文本输出时，需要兼容：
- `(current)` 标记；
- 标题中可能包含方括号、括号等字符；
- 索引动态变化。

建议将“解析标记 → 得到索引”封装为独立函数，并加单元测试。

---

## 5. 备选与降级方案+一个需要做的功能

1. **复用现有标签页 + `goto`**  
   如果插件打开新标签页的 API 暂不可用，可退化为：选择一个现有标签页，执行：
   ```powershell
   playwright-cli -s=dsh tab-select <index>
   playwright-cli -s=dsh goto <url>
   ```
   该方式会替换当前页面内容，不适合需要保留原页面的场景。

2. **在 DSH UI 中手动打开标签页**->这也是一个需要做的功能!用户自己在侧边栏浏览器进行一些操作后,我的插件可以进行接管,大致做法可能是提醒用户会接管当前打开的浏览器页面(也就是playwright-cli 的current tab)  
   作为调试手段，可手动在目标会话侧边栏打开浏览器，然后由插件执行标记注入和索引解析。但这不应作为最终自动化路径。


---

## 6. 验收标准

工具完成后应满足：

1. 在 DSH 会话 A 中通过插件打开侧边栏浏览器页面，页面标题或 URL 包含唯一标记 `pageId-<sessionId>-<uuid>`。
2. 在 DSH 会话 B 中同样打开侧边栏浏览器，两个标签页在 `tab-list` 中均可看到，且标记不同。
3. 插件能仅凭会话 ID 自动在 `tab-list` 中找到对应标签页的当前索引，无需人工输入索引。
4. 插件能对该标签页执行 `snapshot`、`click`、`fill`、`goto` 等 Playwright CLI 操作。
5. 关闭或新增其他标签页导致索引变化后，插件下一次操作仍能通过重新解析标记找到正确索引。
6. 不依赖 Playwright CLI 的 `tab-new`，不依赖不存在的 `targetId` 参数。
7. 操作结束后使用 `detach` 而非 `close`，不关闭用户正在使用的 DSH 应用。

---

## 7. 待验证事项

1. `ctx.sidebarRight.openTab('browser', { params: { url } })` 在当前 DSH 版本中的实际可用性和返回信息。
2. 侧边栏 `<webview>` 的注入时机与可用注入 API。
3. `tab-list` 输出中标题和 URL 的转义规则，确保标记解析稳定。
4. 多个 DSH 会话同时打开相同 URL 时，标记是否仍能唯一区分。
5. 页面自身修改 `document.title` 是否会影响标记稳定性；必要时采用更持久的注入方式。
6. Windows 下 `playwright-cli attach` 偶发卡住的问题，插件调用 CLI 时需设置超时和重试策略。

---

## 8. 一句话总结

**用 DSH 插件原生 API 打开侧边栏标签页，并在页面中注入由 DSH 会话 ID 派生的唯一标记；Playwright CLI 侧只负责 `tab-list` 解析标记得到当前索引，再执行 `tab-select` 和页面操作。这样即可在 Electron CDP 限制下，实现多 DSH 会话侧边栏浏览器的自动区分与自动化测试。**