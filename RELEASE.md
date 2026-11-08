# 发布流程（手动）

这个文件是给自己用的发布清单。自动化能做的部分已经放进仓库；**npm 发布和 GitHub 操作需要你亲自执行**。

当前包元数据（仓库根目录的 `package.json`）：

- name: `dsh-browser-automation`（未 scoped；发布前可用 `npm view dsh-browser-automation` 再确认一次没被占用）
- version: `0.2.0`
- repository: `https://github.com/damijun/browser-playwright`（仓库根目录就是包根目录）
- engines: Node `>=22`，DSH `>=0.2.1-rc.2 <0.3.0-0`
- license: MIT（`LICENSE` 已在包内）

> 如果 GitHub 用户名不是 `damijun`，或仓库名不是 `browser-playwright`，先改 `package.json` 的
> `repository` / `homepage` / `bugs` / `author`，再发布。

## 0. 前置

- npm 账号已登录：`npm login`（当前机器还没登录）
- GitHub 仓库已创建并推送（`git remote add origin <url>`）
- 工作区干净：`git status`

## 1. 本地验证

```powershell
# 在仓库根目录
npm test                 # 181 项
npm pack --dry-run       # 检查包内容：README/LICENSE/locale/icon/src 等
```

`publish` 前会自动跑 `npm test`（`prepublishOnly`）。

## 2. 发布到 npm

```powershell
# 在仓库根目录
npm publish
```

未 scoped 的包不需要 `--access public`。发布后验证：

```powershell
npm view dsh-browser-automation version
```

> 如果以后改成 `@scope/...`，scoped 包必须加 `--access public`（或写 `publishConfig.access`）。

## 3. 在干净环境安装验证

- DSH 桌面端：**Settings → Plugins** 搜索/安装 `dsh-browser-automation`
- 或 CLI：`dsh plugin add dsh-browser-automation@0.2.0`
- 按插件 README §2 确认 `--remote-debugging-port=0` 和 `playwright-cli`，然后打开状态面板看 CDP/CLI，
  跑一次 `browser_open` / `browser_navigate` / `browser_snapshot`。

## 4. 打标签 / Release

```powershell
git tag v0.2.0
git push origin main --tags
```

在 GitHub 上按 `CHANGELOG.md` 写 Release notes。

## 5. 进社区插件市场（可选但建议）

向 [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
提 **一条 entry 的 PR**。通过后 awesome-dsh-plugin.com、dshmarket.com、DSH 里的 dshmarket 插件
以及 0.2.1 的 Discover（经 `dsh-plugin-catalog` index）会收录；dshmarket 只安装目录里收录的源。

## 6. GitHub Actions

仓库已带：

- `.github/workflows/ci.yml`：push/PR 时在 Windows + Node 22/24 跑测试和 `npm pack --dry-run`。
- `.github/workflows/publish.yml`：**手动触发**的发布工作流（需要仓库 secret `NPM_TOKEN`；
  `--provenance` 还要求仓库是 public）。

不用 Actions 也可以，第 2 步的本机 `npm publish` 就够了。

## 7. 改名 + 扁平化后的本机重装

包名从 `@local/dsh-browser-automation` 改成了 `dsh-browser-automation`，仓库也从
`browser-playwright/dsh-browser-automation` 扁平化到了仓库根目录。本机 profile 里那条 junction
仍然指向旧名字/旧路径，**重启 DSH 前需要在 Settings → Plugins 里移除旧行、从仓库根目录重新安装**，
否则旧行会加载失败。
