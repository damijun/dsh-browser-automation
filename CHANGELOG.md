# Changelog

## Unreleased

### Changed

- `browser_run_code` now takes the function **body** only and wraps it as
  `async page => { … }`; a body that still carries the wrapper is rejected before
  anything runs.
- `browser_run_code` rejects a return that uses `JSON.stringify(...)` before the
  snippet runs. playwright-cli already serializes the return value once, so a JSON
  string would be encoded twice. Returned strings now render as plain text, and
  returned objects/arrays as indented JSON.
- `browser_list` renders a JSON object (`count`, `pages[]` with `pageId`/`title`/`url`,
  optional `warning`) instead of one text line per page.

## 0.2.0 — 2026-11-09

First public release (Windows DSH Desktop only).

### Added

- 12 `browser_*` tools for the right-sidebar browser: `browser_open`, `browser_claim`,
  `browser_list`, `browser_navigate`, `browser_snapshot`, `browser_screenshot`,
  `browser_click`, `browser_fill`, `browser_press`, `browser_run_code`,
  `browser_console`, `browser_status`.
- `browser_navigate` with `type: url | reload | back | forward`; reload is implemented as
  "navigate to the current URL", never with `playwright-cli reload` (which reloads the
  whole DSH window).
- Status panel and start-page guide entry, with a one-time setup card for
  `--remote-debugging-port=0` and `playwright-cli` when either is missing.
- Per-session `pageId` identity and a global CLI mutex, so two DSH sessions cannot swap
  the daemon's current tab under each other.
- `disabledTools` config: comma-separated tool names that are not registered at all
  (their schemas never reach the model).
- English and Chinese locale files (`locale/en.json`, `locale/zh.json`) as the single
  source for panel and settings copy.
- "Shared with the agent" overlay badge above the sidebar.

### Changed

- Tool descriptions follow the VS Code style: one to three sentences for purpose, when to
  use, and key constraints; parameter usage lives in the parameter descriptions.
- `browser_open` no longer takes `waitMs`; the plugin uses its internal default.
- `browser_list` is documented as a fallback: reuse a `pageId` from context or an earlier
  tool result, and list only when no usable `pageId` exists.
- Settings reset now falls back to schema defaults instead of the values the running
  instance booted with, so "reset" actually clears an override.
- The plugin explicitly documents Windows-only support (`%APPDATA%` port record,
  `playwright-cli.cmd`).

### Removed

- `browser_close` (closing sidebar tabs stays a user action).
- `browser_goto` and `browser_reload` (merged into `browser_navigate`).
