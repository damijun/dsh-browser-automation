# browser-playwright

Windows 版 DSH Desktop 的侧边栏浏览器自动化插件。

- 插件源码与 npm 包：[`dsh-browser-automation`](dsh-browser-automation)
- 包名：`dsh-browser-automation`（npm 公开包）
- 要求：Windows 版 DSH Desktop（0.2.1+）、`playwright-cli`，且 DSH 以
  `--remote-debugging-port=0` 启动
- 安装：DSH 的 **Settings → Plugins**，或 `dsh plugin add dsh-browser-automation`
- 用法、配置、排障：[插件 README](dsh-browser-automation/README.md)
- 发布流程：[RELEASE.md](RELEASE.md)

`icon-concepts/` 是图标设计过程稿（PNG/SVG/对比图），不随 npm 包发布。

## License

MIT，见 [LICENSE](LICENSE)。
