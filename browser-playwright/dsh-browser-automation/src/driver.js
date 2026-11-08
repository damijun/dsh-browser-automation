import { AsyncLocalStorage } from 'node:async_hooks';

import { CliError } from './cli.js';
import { parseTabList, currentIndex, describeTabs } from './tab-list.js';
import { pageMarkerExpression, probeMarkerExpression, installMarkerCode } from './page-id.js';
import { PAGE_CATALOG_CODE, parsePageCatalog, describeCatalog } from './page-catalog.js';

/**
 * Parse the JSON value playwright-cli prints for `eval --raw`.
 *
 * The CLI prints the evaluated value as JSON (`"Example Domain"`, `42`, `null`)
 * and prints `undefined` literally, so a failed parse means "plain text".
 *
 * @param {string} stdout
 */
export function parseEvalOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (text === '') return undefined;
  if (text === 'undefined') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The marker script returns a JSON *string*, so it arrives double-encoded.
 *
 * @param {string} stdout
 */
export function parseMarkerOutput(stdout) {
  const parsed = parseEvalOutput(stdout);
  if (typeof parsed !== 'string') return parsed;
  try {
    return JSON.parse(parsed);
  } catch {
    return { title: parsed };
  }
}

/**
 * Trim the bookkeeping playwright-cli appends to every action result
 * (`- [Snapshot](.playwright-cli/page-….yml)`), which is noise in a tool result.
 *
 * @param {string} stdout
 */
export function actionOutput(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*[-*]\s*\[Snapshot\]/.test(line))
    .join('\n')
    .trim();
}

/**
 * A page resolved to a playwright-cli tab.
 *
 * `title`/`url` come from the page itself (one `evaluate` in the catalog), not from
 * tab-list, so they survive a stale tab chip and reflect redirects. `pageId` is what
 * relocation needs; `addressedBy` says which identity found it.
 *
 * @typedef {object} ResolvedTab
 * @property {number} index     tab-list index, valid for this call only
 * @property {boolean} current  the daemon's current tab (`candidate === page`)
 * @property {string} title     document.title, exactly as the page sets it
 * @property {string} url       location.href, post-redirect
 * @property {string} [pageId]  the in-page identity, when the tab came from a resolve
 * @property {'page' | null} [addressedBy] whether the in-page identity found it
 */

/**
 * The single place that knows playwright-cli's command surface.
 *
 * Everything above this class deals in `pageId`; indices are resolved here, on
 * every call, and never returned to callers that could cache them.
 *
 * A resolved tab can be threaded in as `target` by a caller that already listed
 * tabs for the same call — that turns a snapshot from four CLI round trips
 * (list, select, …) into two.
 */
export class PageDriver {
  /**
   * @param {import('./cli.js').CliBridge} cli
   * @param {object} options
   * @param {string} [options.cdpUrl] endpoint to attach to; set before any attach runs
   * @param {(message: string) => void} [options.log]
   */
  constructor(cli, options) {
    this.cli = cli;
    this.cdpUrl = options.cdpUrl;
    // Both are config fields: attach hangs on slow machines, and a capture is the
    // most environment-sensitive operation this plugin performs.
    this.attachTimeoutMs = Number(options.attachTimeoutMs ?? 60_000);
    this.screenshotTimeoutMs = Number(options.screenshotTimeoutMs ?? 25_000);
    this.log = options.log ?? (() => {});
    this.attached = false;
    // The daemon has one global "current tab"; every select+command pair must be
    // serialized against every other one. See withCli().
    this.cliQueue = Promise.resolve();
    this.cliHolder = new AsyncLocalStorage();
  }

  /** Raw tab list. */
  async listTabs() {
    const { stdout } = await this.cli.run(['--raw', 'tab-list']);
    return parseTabList(stdout);
  }

  /**
   * Make sure a `playwright-cli` session is attached to the DSH browser.
   *
   * The probe is always `tab-list` first, and only a failing probe attaches — for a
   * fresh driver just as much as for a live one.
   *
   * Why this is not just an optimization: `attach` opens a **new CDP session**, and
   * playwright-cli only adopts sidebar pages created while it is attached, so
   * re-attaching over a live session strands every page the user already has open
   * (measured: after a redundant attach, `tab-list` showed just the application page
   * while four sidebar tabs were still on screen). That is the real reason pages went
   * missing after a plugin reload or a DSH restart. A never-attached session and a
   * session whose DSH has exited both fail `tab-list`, which is exactly when attaching
   * is correct.
   *
   * Known limitation: a daemon attached to a *different* CDP endpoint would also pass
   * the probe, and this plugin documents that only one DSH instance is supported
   * (README §6, `autoAttach`).
   *
   * @param {{ force?: boolean }} [options] `force` always attaches (diagnostics)
   */
  async ensureAttached(options = {}) {
    if (!options.force) {
      try {
        const tabs = await this.listTabs();
        if (!this.attached) this.log('adopted an existing attach instead of opening a new CDP session');
        this.attached = true;
        return tabs;
      } catch (error) {
        this.log(`no attached browser yet (${error.message}); attaching`);
        this.attached = false;
      }
    }
    const { stdout, stderr } = await this.attachWithRetry();
    this.attached = true;
    this.log(`attached to ${this.cdpUrl}`);
    const tabs = await this.listTabs();
    return { ...tabs, attachOutput: `${stdout}${stderr}`.trim() };
  }

  /**
   * `playwright-cli attach` starts a per-session daemon, and two clients racing
   * for the same freshly-started daemon can fail with an argv error from the
   * daemon process. One retry after a short pause settles that race, and it is
   * also the documented remedy for a stuck attach on Windows.
   */
  async attachWithRetry() {
    // Serialized too: `attach` opens a new CDP session, and doing that while another
    // command is in flight kills that command (or strands its tab).
    return this.withCli(async () => {
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await this.cli.run(['--raw', 'attach', `--cdp=${this.cdpUrl}`], { timeoutMs: this.attachTimeoutMs });
        } catch (error) {
          lastError = error;
          this.log(`attach attempt ${attempt + 1} failed: ${error.message}`);
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
        }
      }
      throw lastError;
    });
  }

  /**
   * Detach without closing the DSH application.
   *
   * Queued behind in-flight work: detaching mid-command rejects that command with
   * "Session closed" (measured), so it waits instead of cutting in.
   */
  async detach() {
    return this.withCli(async () => {
      const result = await this.cli.run(['--raw', 'detach'], { retries: 0 });
      this.attached = false;
      return result;
    });
  }

  /**
   * One `run-code`: every page in the daemon's context, with its in-page identity.
   *
   * `context.pages()` order equals `tab-list` order in this environment (verified on
   * Electron webviews; docs/run-code-migration-plan.md records the same contract from
   * Edge), so an index from here is a valid `tab-select` index for this call only.
   *
   * @returns {Promise<import('./page-catalog.js').PageCatalogEntry[]>}
   */
  async catalog() {
    const { stdout } = await this.cli.run(['--raw', 'run-code', PAGE_CATALOG_CODE], { timeoutMs: 30_000 });
    return parsePageCatalog(stdout);
  }

  /**
   * pageId -> tab-list index, in one `run-code`.
   *
   * The in-page identity (`window.__dshBrowserAutomation.pageId`) is the only
   * source: nothing is written into the title or any other rendered field, so
   * there is no second place to look.
   *
   * Per §4.6 of the migration plan the first match wins: no collecting, no
   * AMBIGUOUS_PAGE, no failing on a theoretical duplicate.
   *
   * @param {string} pageId
   * @returns {Promise<ResolvedTab & { pageId: string, addressedBy: 'page' }>}
   */
  async resolveTabIndex(pageId) {
    const catalog = await this.catalog();
    const hit = catalog.find((entry) => !entry.closed && entry.pageId === pageId);
    if (hit) {
      return {
        index: hit.index,
        current: hit.current,
        title: hit.title ?? '',
        url: hit.url ?? '',
        pageId,
        addressedBy: 'page',
      };
    }
    throw new CliError(
      `PAGE_NOT_FOUND: no open page carries ${pageId}. Open pages: ${describeCatalog(catalog)}.\n` +
        'If the tab is still visible, the page may have been reloaded without the plugin identity: ' +
        'run browser_list, then browser_claim it again.',
      { code: 'PAGE_NOT_FOUND' },
    );
  }

  /**
   * tab-list index -> pageId, in one `run-code` (the reverse of {@link resolveTabIndex}).
   *
   * @param {number} tabIndex
   * @returns {Promise<{ pageId: string | null, index: number, title: string, url: string, addressedBy: 'page' | null }>}
   */
  async resolvePageId(tabIndex) {
    if (!Number.isInteger(tabIndex) || tabIndex < 0) {
      throw new CliError(`PAGE_NOT_FOUND: ${String(tabIndex)} is not a tab index.`, { code: 'PAGE_NOT_FOUND' });
    }
    const catalog = await this.catalog();
    const entry = catalog.find((item) => item.index === tabIndex);
    if (!entry) {
      throw new CliError(
        `PAGE_NOT_FOUND: no tab at index ${tabIndex}. Open pages: ${describeCatalog(catalog)}.`,
        { code: 'PAGE_NOT_FOUND' },
      );
    }
    if (entry.closed) {
      throw new CliError(`PAGE_CLOSED: tab ${tabIndex} (${entry.url ?? '?'}) was closed.`, { code: 'PAGE_CLOSED' });
    }
    return {
      pageId: entry.pageId ?? null,
      index: tabIndex,
      title: entry.title ?? '',
      url: entry.url ?? '',
      addressedBy: entry.pageId ? 'page' : null,
    };
  }

  /**
   * pageId -> tab. Attaches first so a dead debug port reports the restart steps
   * instead of a raw CLI error.
   *
   * @param {string} pageId
   */
  async resolvePage(pageId) {
    await this.ensureAttached();
    return this.resolveTabIndex(pageId);
  }

  /**
   * Run `operation` against an already-resolved tab: select it, execute, and re-resolve
   * once if the index went stale between resolving and selecting (the user can close a
   * tab at any moment).
   *
   * This is the only place that selects and retries, and it takes nothing but the tab:
   * the tab carries its own `pageId`, which is what a re-resolution needs. The runtime
   * layer addresses pages by pageId, resolves once, and from here down everything is a
   * tab index.
   *
   * @template T
   * @param {ResolvedTab & { pageId?: string }} tab
   * @param {(tab: ResolvedTab) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  /**
   * Serialize one "select then act" critical section across **all** pages.
   *
   * playwright-cli acts on a single global "current tab" pointer, so two callers that
   * select different tabs and then run a command can interleave: caller B's
   * `tab-select` lands between caller A's select and A's command, and A's command runs
   * on B's page. Read operations then return the wrong page; writes (click, fill, press,
   * goto) land on the wrong page *and* report success.
   *
   * The per-page lock in SessionManager cannot help: the conflict is precisely between
   * *different* pageIds. So this is one mutex for the whole driver — the unit that owns
   * the shared pointer.
   *
   * Re-entrant by async context (AsyncLocalStorage): `executeOnResolvedTab` calls
   * `resolvePage`, and an attach/resolve may call back into the lock. A caller that
   * already holds it passes straight through; a caller from a different async context
   * queues, which is what keeps the pointer stable.
   *
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async withCli(operation) {
    if (this.cliHolder.getStore() === this) return operation();
    const previous = this.cliQueue;
    let release;
    this.cliQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.cliHolder.run(this, operation);
    } finally {
      release();
    }
  }

  /**
   * Run `operation` against an already-resolved tab: select it, execute, and re-resolve
   * once if the index went stale between resolving and selecting (the user can close a
   * tab at any moment).
   *
   * This is the only place that selects and retries, and it takes nothing but the tab:
   * the tab carries its own `pageId`, which is what a re-resolution needs. The runtime
   * layer addresses pages by pageId, resolves once, and from here down everything is a
   * tab index.
   *
   * The whole select+command section runs under {@link withCli}, so two pages can never
   * swap the daemon's current tab under each other.
   *
   * @template T
   * @param {ResolvedTab & { pageId?: string }} tab
   * @param {(tab: ResolvedTab) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async executeOnResolvedTab(tab, operation) {
    return this.withCli(async () => {
      let lastError;
      let known = tab;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let hit = known;
        known = undefined;
        if (!hit) {
          // Only a tab that knows its pageId can be relocated.
          if (!tab.pageId) break;
          hit = await this.resolvePage(tab.pageId);
        }
        try {
          if (hit.current !== true) await this.cli.run(['--raw', 'tab-select', String(hit.index)]);
          return await operation(hit);
        } catch (error) {
          lastError = error;
          this.log(`tab ${hit.index} failed, re-resolving: ${error.message}`);
        }
      }
      throw lastError ?? new CliError(`Could not select the tab for ${tab.pageId ?? tab.index}.`, { code: 'PAGE_NOT_FOUND' });
    });
  }

  /**
   * Install the page identity in the current document.
   *
   * Replaces any identity installed by a previous claim. The marker is written
   * for `tab.pageId`, so the tab has to carry one (the resolve functions set it;
   * `browser_open`/`browser_claim` hand one in after minting).
   *
   * @param {ResolvedTab & { pageId: string }} tab
   * @returns {Promise<{ title?: string, url?: string } | undefined>}
   */
  async mark(tab) {
    return this.executeOnResolvedTab(tab, async () => {
      const { stdout } = await this.cli.run(['--raw', 'eval', pageMarkerExpression(tab.pageId)]);
      return parseMarkerOutput(stdout);
    });
  }

  /**
   * Install the identity durably and apply it to the current document.
   *
   * The init script makes the identity survive every later navigation; the eval
   * covers the document that is already loaded (an init script only runs on the
   * next one). Two CLI calls, paid once per open/claim.
   *
   * @param {ResolvedTab & { pageId: string }} tab
   * @returns {Promise<{ title?: string, url?: string } | undefined>}
   */
  async installMarker(tab) {
    return this.executeOnResolvedTab(tab, async () => {
      await this.cli.run(['--raw', 'run-code', installMarkerCode(tab.pageId)], { timeoutMs: 60_000 });
      const { stdout } = await this.cli.run(['--raw', 'eval', pageMarkerExpression(tab.pageId)]);
      return parseMarkerOutput(stdout);
    });
  }

  /**
   * Read back the marker state of the current tab (diagnostics).
   *
   * @param {ResolvedTab} tab
   */
  async probe(tab) {
    return this.executeOnResolvedTab(tab, async () => {
      const { stdout } = await this.cli.run(['--raw', 'eval', probeMarkerExpression]);
      return parseMarkerOutput(stdout);
    });
  }

  /**
   * @param {ResolvedTab} tab
   * @param {{ depth?: number }} [options]
   */
  async snapshot(tab, options = {}) {
    return this.executeOnResolvedTab(tab, async () => {
      const args = ['--raw', 'snapshot'];
      if (options.depth) args.push(`--depth=${options.depth}`);
      const { stdout } = await this.cli.run(args);
      const text = stdout.trim();
      const refs = [...text.matchAll(/\[ref=([^\]]+)\]/g)].map((match) => match[1]);
      return { snapshot: text, refCount: refs.length };
    });
  }

  /**
   * The CLI's own screenshot command. It understands snapshot refs, but uses
   * Playwright's default 5s capture deadline, which a tab that was just brought
   * to the front can exceed. Prefer {@link screenshotToFile} for those.
   *
   * @param {ResolvedTab} tab
   * @param {{ path: string, fullPage?: boolean, target?: string }} options
   */
  async screenshot(tab, options) {
    return this.executeOnResolvedTab(tab, async () => {
      const args = ['--raw', 'screenshot', `--filename=${options.path}`];
      if (options.fullPage) args.push('--full-page');
      if (options.target) args.push(options.target);
      const { stdout, stderr } = await this.cli.run(args, { timeoutMs: 60_000 });
      return { path: options.path, output: `${stdout}${stderr}`.trim() };
    });
  }

  /**
   * Capture through Playwright's own API with a deadline we choose.
   *
   * `playwright-cli screenshot` hard-codes Playwright's 5s default, and a sidebar
   * tab that was hidden a moment ago needs longer than that to produce its first
   * frame. `run-code` runs in the CLI daemon (a Node process), so
   * `page.screenshot({ path })` writes the file there directly — no bytes travel
   * through the command output.
   *
   * @param {ResolvedTab} tab
   * @param {{ path: string, fullPage?: boolean, timeoutMs?: number }} options
   */
  async screenshotToFile(tab, options) {
    const settings = [
      `path: ${JSON.stringify(options.path)}`,
      `timeout: ${Number(options.timeoutMs ?? this.screenshotTimeoutMs)}`,
      ...(options.fullPage ? ['fullPage: true'] : []),
    ].join(', ');
    const code = `async page => { await page.screenshot({ ${settings} }); return "saved"; }`;
    return this.executeOnResolvedTab(tab, async () => {
      await this.cli.run(['--raw', 'run-code', code], { timeoutMs: 60_000 });
      return { path: options.path };
    });
  }

  /**
   * @param {ResolvedTab} tab
   * @param {{ ref: string, button?: string, modifiers?: string[], double?: boolean }} options
   */
  async click(tab, options) {
    return this.executeOnResolvedTab(tab, async () => {
      const args = ['--raw', options.double ? 'dblclick' : 'click', options.ref];
      if (options.button) args.push(options.button);
      for (const modifier of options.modifiers ?? []) args.push(`--modifiers=${modifier}`);
      const { stdout } = await this.cli.run(args);
      return actionOutput(stdout);
    });
  }

  /**
   * @param {ResolvedTab} tab
   * @param {{ ref: string, text: string, submit?: boolean }} options
   */
  async fill(tab, options) {
    return this.executeOnResolvedTab(tab, async () => {
      const args = ['--raw', 'fill', options.ref, options.text];
      if (options.submit) args.push('--submit');
      const { stdout } = await this.cli.run(args);
      return actionOutput(stdout);
    });
  }

  /**
   * @param {ResolvedTab} tab
   * @param {{ key: string }} options
   */
  async press(tab, options) {
    return this.executeOnResolvedTab(tab, async () => {
      const { stdout } = await this.cli.run(['--raw', 'press', options.key]);
      return actionOutput(stdout);
    });
  }

  /**
   * Navigate a resolved tab, then re-install and report the identity.
   *
   * A navigation creates a new document; the init script re-installs the field
   * there, and this one eval also reports the resulting title and URL (and covers
   * the case where the init script was rejected and the marker had to be applied
   * one-shot).
   *
   * @param {ResolvedTab & { pageId?: string }} tab
   * @param {{ url: string }} options
   */
  async goto(tab, options) {
    return this.executeOnResolvedTab(tab, async () => {
      await this.cli.run(['--raw', 'goto', options.url], { timeoutMs: 60_000 });
      const { stdout } = await this.cli.run(['--raw', 'eval', pageMarkerExpression(tab.pageId)], {
        retries: 1,
      });
      const parsed = parseEvalOutput(stdout);
      let marked = parsed;
      if (typeof parsed === 'string') {
        try {
          marked = JSON.parse(parsed);
        } catch {
          marked = { title: parsed };
        }
      }
      return { url: options.url, title: marked?.title, reportedUrl: marked?.url };
    });
  }

  /**
   * Reload a resolved tab, implemented as "navigate to the same URL".
   *
   * `playwright-cli reload` is never used: measured on a real window, it reloads the
   * whole DSH page no matter which tab is current, and every sidebar browser page is
   * lost with it. `goto <current url>` reaches only the tab this id resolved to, so a
   * reload can never touch the shell.
   *
   * @param {ResolvedTab} tab
   * @param {{ url: string }} options
   */
  async reload(tab, options) {
    return this.goto(tab, { url: options.url });
  }

  /**
   * Step the page's own history back or forward.
   *
   * playwright-cli has no `back`/`forward` verb; `run-code` is the only entry that
   * can call `page.goBack()` / `page.goForward()` on the resolved tab.
   *
   * The return value of goBack()/goForward() is **not** a reliable "did it move"
   * signal: for a same-document history step it is null even though the URL did
   * change (observed on a SPA page). So the step is judged by the identity the
   * post-run marker read-back reports: if URL or title changed, it moved.
   *
   * @param {ResolvedTab & { pageId?: string }} tab
   * @param {'back' | 'forward'} direction
   */
  async history(tab, direction) {
    const method = direction === 'forward' ? 'goForward' : 'goBack';
    const before = { url: tab.url, title: tab.title };
    const result = await this.runCode(tab, {
      code: `async page => { await page.${method}(); return "done"; }`,
    });
    const url = typeof result.url === 'string' && result.url !== '' ? result.url : before.url;
    const title = typeof result.title === 'string' ? result.title : before.title;
    return {
      moved: url !== before.url || title !== before.title,
      url,
      title,
    };
  }

  /**
   * @param {ResolvedTab} tab
   * @param {{ level?: string }} [options]
   */
  async console(tab, options = {}) {
    return this.executeOnResolvedTab(tab, async () => {
      const args = ['--raw', 'console'];
      if (options.level) args.push(options.level);
      const { stdout } = await this.cli.run(args);
      return stdout.trim();
    });
  }

  /**
   * Run a Playwright snippet against a resolved tab.
   *
   * The snippet may navigate or replace the document, so the identity is
   * re-installed afterwards; the same eval reports the resulting title and URL.
   *
   * @param {ResolvedTab & { pageId?: string }} tab
   * @param {{ code: string }} options
   */
  async runCode(tab, options) {
    return this.executeOnResolvedTab(tab, async () => {
      const { stdout } = await this.cli.run(['--raw', 'run-code', options.code], { timeoutMs: 120_000 });
      const output = stdout.trim();
      const { stdout: marked } = await this.cli.run(['--raw', 'eval', pageMarkerExpression(tab.pageId)]);
      const marker = parseMarkerOutput(marked);
      return { output, title: marker?.title, url: marker?.url };
    });
  }

  /** Current tab index, or -1 when nothing is attached. */
  async listCurrent() {
    const { stdout } = await this.cli.run(['--raw', 'tab-list']);
    return { index: currentIndex(stdout) ?? -1, tabs: describeTabs(parseTabList(stdout).tabs) };
  }
}






