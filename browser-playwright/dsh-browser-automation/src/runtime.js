import path from 'node:path';

import { CliBridge } from './cli.js';
import { PageDriver, parseEvalOutput } from './driver.js';
import { newPageId, sessionTag, extractPageIds, titleMarkerExpression } from './page-id.js';
import { SessionManager, discover } from './sessions.js';
import { resolveIndex } from './tab-list.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The one place that composes CLI access, the page registry and the DSH page
 * bridge. Tools are thin wrappers over these methods.
 */
export class Runtime {
  /**
   * @param {object} options
   * @param {Record<string, unknown>} options.config
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.config = options.config ?? {};
    this.log = options.log ?? (() => {});
    this.manager = new SessionManager({ log: this.log });
    /** @type {PageDriver | undefined} */
    this.driver = undefined;
    /** @type {CliBridge | undefined} */
    this.cli = undefined;
    this.openLock = Promise.resolve();
    this.attached = false;
  }

  /** Lazily create the CLI bridge: activating the plugin must not spawn anything. */
  ensureDriver() {
    if (this.driver) return this.driver;
    this.cli = new CliBridge({
      session: String(this.config.session ?? 'dsh'),
      command: String(this.config.command ?? 'playwright-cli'),
      nodePath: this.config.nodePath ? String(this.config.nodePath) : undefined,
      cwd: this.config.workdir ? String(this.config.workdir) : undefined,
      timeoutMs: Number(this.config.timeoutMs ?? 20_000),
      log: this.log,
    });
    this.driver = new PageDriver(this.cli, {
      cdpUrl: String(this.config.cdpUrl ?? 'http://127.0.0.1:9222'),
      log: this.log,
    });
    return this.driver;
  }

  /**
   * Attach, translating the CLI's generic failure into the action the user has
   * to take. The overwhelming cause is DSH not being started with the debugging
   * port, and no other message tells the user that.
   */
  async attach(signal) {
    const driver = this.ensureDriver();
    try {
      const listing = await driver.ensureAttached();
      this.attached = true;
      return listing;
    } catch (error) {
      this.attached = false;
      const cdpUrl = String(this.config.cdpUrl ?? 'http://127.0.0.1:9222');
      const hint =
        `Could not attach playwright-cli to DSH at ${cdpUrl}.\n` +
        `1. Make sure DSH Desktop is running with --remote-debugging-port=${new URL(cdpUrl).port || '9222'} ` +
        '(append it to the shortcut\'s Target after the .exe path, then restart DSH).\n' +
        '2. Check the endpoint: Invoke-WebRequest http://127.0.0.1:9222/json/version\n' +
        '3. Check the CLI: playwright-cli list';
      const wrapped = new Error(`${hint}\n\nUnderlying error: ${error.message}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  /** Serialize tab creation so two concurrent browser_open calls cannot race. */
  async withOpenLock(operation) {
    const previous = this.openLock;
    let release;
    this.openLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * @param {{ sessionId: string, url: string, waitMs?: number, signal?: AbortSignal }} request
   */
  async openPage(request) {
    const url = normalizeUrl(request.url);
    const driver = this.ensureDriver();
    const listing = await this.attach(request.signal);
    const before = new Set(listing.tabs.map((tab) => tab.text));

    return this.withOpenLock(async () => {
      const opened = await this.requestSidebarOpen(url);
      const pageId = newPageId(request.sessionId, new Set(this.manager.all().map((page) => page.pageId)));
      const found = await this.waitForNewTab(before, url, request.waitMs ?? 15_000);
      if (!found) {
        throw new Error(
          `A sidebar tab was opened for ${url}, but it never appeared in playwright-cli's tab list. ` +
            'The page may have failed to load (or the sidebar is showing an error). ' +
            'Check the sidebar, then use browser_list to see what is reachable.',
        );
      }
      await this.cli.run(['--raw', 'tab-select', String(found.index)]);
      const marked = await this.injectMarker(found.index, pageId);
      this.manager.register({ pageId, sessionId: request.sessionId, url: found.url, title: marked.title, source: 'open' });
      return {
        pageId,
        url: marked.url || found.url,
        title: marked.title,
        index: found.index,
        how: opened.how,
        note: opened.note,
      };
    });
  }

  /**
   * Ask the DSH page to open a tab; fall back to navigating an existing tab when
   * no page is connected to the bridge.
   */
  async requestSidebarOpen(url) {
    if (!this.bridge) {
      return this.degradedOpen(url, 'The page bridge is not mounted.');
    }
    try {
      const result = await this.bridge.request('open-tab', { url, kind: 'browser' });
      this.log(`sidebar opened a tab for ${url}: ${JSON.stringify(result)}`);
      return { how: 'new-tab', detail: result };
    } catch (error) {
      return this.degradedOpen(url, error.message);
    }
  }

  /**
   * Documented degradation (§5.1 of the design brief): reuse a tab that already
   * shows something and navigate it. It replaces that page's content, so the
   * caller reports which path was taken.
   */
  async degradedOpen(url, reason) {
    const driver = this.ensureDriver();
    const listing = await driver.listTabs();
    const candidates = listing.tabs.filter((tab) => /^https?:/i.test(tab.url));
    if (candidates.length === 0) {
      throw new Error(
        `No DSH page answered the request to open a sidebar tab (${reason}), and there is no existing ` +
          'http(s) tab to reuse. Open the Browser tab in DSH once, or reload the DSH window so the plugin can reconnect.',
      );
    }
    const target = candidates[0];
    await this.cli.run(['--raw', 'tab-select', String(target.index)]);
    await this.cli.run(['--raw', 'goto', url], { timeoutMs: 60_000 });
    return {
      how: 'reused-tab',
      note: `Opened by navigating the existing tab at index ${target.index} instead of creating one (${reason})`,
    };
  }

  /**
   * Wait until a tab that was not in `before` shows up.
   *
   * @param {Set<string>} before tab lines captured before the open request
   * @param {string} url requested url
   * @param {number} waitMs
   */
  async waitForNewTab(before, url, waitMs) {
    const driver = this.ensureDriver();
    const deadline = Date.now() + waitMs;
    const wanted = safeUrl(url);
    for (;;) {
      const { tabs } = await driver.listTabs();
      const fresh = tabs.filter((tab) => !before.has(tab.text) && /^https?:/i.test(tab.url));
      if (fresh.length === 1) return fresh[0];
      if (fresh.length > 1) {
        const matching = wanted
          ? fresh.filter((tab) => tab.url === wanted.href || tab.url.startsWith(`${wanted.origin}${wanted.pathname}`))
          : [];
        if (matching.length === 1) return matching[0];
        this.log(`ambiguous open: ${fresh.length} new tabs appeared`);
        return undefined;
      }
      if (Date.now() >= deadline) return undefined;
      await sleep(400);
    }
  }

  /**
   * Append (or replace) the marker on the currently selected tab.
   *
   * @param {number} index selected tab index
   * @param {string} pageId
   */
  async injectMarker(index, pageId) {
    const driver = this.ensureDriver();
    const cli = this.cli;
    const { stdout } = await cli.run(['--raw', 'eval', titleMarkerExpression(pageId, { replace: true })]);
    const parsed = parseEvalOutput(stdout);
    let value = parsed;
    if (typeof parsed === 'string') {
      try {
        value = JSON.parse(parsed);
      } catch {
        value = { title: parsed };
      }
    }
    const title = typeof value?.title === 'string' ? value.title : undefined;
    const current = typeof value?.url === 'string' ? value.url : undefined;
    this.log(`marked tab ${index} as ${pageId}`);
    return { title, url: current };
  }

  /**
   * Take over the tab playwright-cli currently drives.
   *
   * @param {{ sessionId: string, note?: string, signal?: AbortSignal }} request
   */
  async claimPage(request) {
    const driver = this.ensureDriver();
    const listing = await this.attach(request.signal);
    const current = listing.tabs.find((tab) => tab.current);
    if (!current) {
      throw new Error(
        'playwright-cli reports no current tab, so there is nothing to claim. Open the Browser tab in DSH first, ' +
          'or use browser_open to create one.',
      );
    }
    if (!/^https?:/i.test(current.url)) {
      throw new Error(
        `The current tab is not a web page (${current.title} — ${current.url}). ` +
          'Switch the DSH sidebar to the browser tab you want to take over, then call browser_claim again.',
      );
    }
    const previousIds = extractPageIds(current.title);
    const pageId = newPageId(request.sessionId, new Set(this.manager.all().map((page) => page.pageId)));
    const originalTitle = current.title.replace(/\s*\[dshpg-[0-9a-f]{6}-[0-9a-f]{8}\]/g, '').trim();
    await this.cli.run(['--raw', 'tab-select', String(current.index)]);
    const marked = await this.injectMarker(current.index, pageId);
    for (const previous of previousIds) this.manager.unregister(previous);
    this.manager.register({
      pageId,
      sessionId: request.sessionId,
      url: current.url,
      title: originalTitle,
      source: 'claim',
    });
    return {
      pageId,
      title: originalTitle,
      url: current.url,
      index: current.index,
      note: request.note,
      replacedExistingPageId: previousIds[0],
    };
  }

  /**
   * @param {{ sessionId: string, scope?: string }} request
   */
  async listPages(request) {
    const driver = this.ensureDriver();
    let tabs = [];
    let warning;
    try {
      const listing = await this.attach();
      tabs = listing.tabs;
    } catch (error) {
      warning = error.message;
      tabs = [];
    }
    const rows = discover({
      tabs,
      manager: this.manager,
      sessionId: request.sessionId,
      includeUnclaimed: request.scope === 'all',
    });
    const filtered = request.scope === 'all' ? rows : rows.filter((row) => row.mine === true);
    return { count: filtered.length, pages: filtered, warning };
  }

  /** @param {{ pageId: string }} request */
  async closePage(request) {
    const driver = this.ensureDriver();
    const pageId = requirePageId(request.pageId);
    const hit = await driver.resolve(pageId);
    await this.cli.run(['--raw', 'tab-close', String(hit.index)]);
    this.manager.unregister(pageId);
    return { pageId, closed: true, index: hit.index };
  }

  /**
   * Run one page-scoped operation, serialized per page. The tab is resolved once
   * here and threaded into the driver, so a tool call costs two CLI round trips
   * (list, select) instead of four.
   *
   * @param {string} pageId
   * @param {(driver: PageDriver, tab: { index: number, title: string, url: string, current: boolean }) => Promise<Record<string, unknown>>} operation
   */
  async onPage(pageId, operation, signal) {
    const driver = this.ensureDriver();
    const validId = requirePageId(pageId);
    if (signal?.aborted) throw new Error('The operation was cancelled.');
    return this.manager.withLock(validId, async () => {
      // Attach through this path on the first call so a missing DSH debug port is
      // reported with the restart instructions instead of a raw CLI error.
      if (!driver.attached) await this.attach(signal);
      const tab = await driver.resolve(validId);
      const result = await operation(driver, tab);
      return { pageId: validId, index: tab.index, ...result };
    });
  }

  async snapshot(request) {
    return this.onPage(
      request.pageId,
      async (driver, tab) => {
        const detail = await driver.snapshot(request.pageId, { depth: request.depth }, tab);
        return {
          title: tab.title,
          url: tab.url,
          refCount: detail.refCount,
          snapshot: detail.snapshot,
        };
      },
      request.signal,
    );
  }

  async screenshot(request) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(this.ensureDriver().cli.workdir(), `screenshot-${stamp}.png`);
    return this.onPage(
      request.pageId,
      async (driver, tab) => {
        await driver.screenshot(
          request.pageId,
          { path: file, fullPage: request.fullPage, target: request.target },
          tab,
        );
        return { path: file };
      },
      request.signal,
    );
  }

  async click(request) {
    return this.onPage(
      request.pageId,
      async (driver, tab) => ({
        result: await driver.click(
          request.pageId,
          {
            ref: request.ref,
            button: request.button ?? undefined,
            double: request.double === true,
            modifiers: request.modifiers,
          },
          tab,
        ),
      }),
      request.signal,
    );
  }

  async fill(request) {
    return this.onPage(
      request.pageId,
      async (driver, tab) => ({
        result: await driver.fill(
          request.pageId,
          { ref: request.ref, text: request.text, submit: request.submit },
          tab,
        ),
      }),
      request.signal,
    );
  }

  async press(request) {
    return this.onPage(
      request.pageId,
      async (driver, tab) => ({
        result: await driver.press(request.pageId, { key: request.key }, tab),
      }),
      request.signal,
    );
  }

  async goto(request) {
    const url = normalizeUrl(request.url);
    return this.onPage(
      request.pageId,
      async (driver, tab) => {
        const result = await driver.goto(request.pageId, { url }, tab);
        this.manager.update(request.pageId, { url: result.reportedUrl ?? url, title: result.title });
        return { url: result.reportedUrl ?? url, title: result.title };
      },
      request.signal,
    );
  }

  async evaluate(request) {
    return this.onPage(
      request.pageId,
      async (driver, tab) => {
        const value = await driver.evaluate(request.pageId, request.expression, tab);
        return { result: JSON.stringify(value ?? null) };
      },
      request.signal,
    );
  }

  async runCode(request) {
    return this.onPage(
      request.pageId,
      async (driver, tab) => ({
        output: await driver.runCode(request.pageId, { code: request.code }, tab),
      }),
      request.signal,
    );
  }

  async consoleMessages(request) {
    return this.onPage(
      request.pageId,
      async (driver, tab) => {
        const text = await driver.console(request.pageId, { level: request.level }, tab);
        const limit = Number.isFinite(request.limit) ? Number(request.limit) : 50;
        const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
        return { messages: lines.slice(-limit).join('\n') };
      },
      request.signal,
    );
  }

  /** @param {{ sessionId: string, action: string, signal?: AbortSignal }} request */
  async status(request) {
    const driver = this.ensureDriver();
    const base = {
      action: request.action,
      attached: false,
      cdpUrl: String(this.config.cdpUrl ?? 'http://127.0.0.1:9222'),
      cli: { command: String(this.config.command ?? 'playwright-cli'), session: String(this.config.session ?? 'dsh') },
      bridge: this.bridge ? this.bridge.snapshot() : { mounted: false },
      bridgeError: this.health?.bridgeError ?? null,
      currentIndex: -1,
      tabs: [],
      pages: [],
    };
    if (request.action === 'detach') {
      try {
        await driver.detach();
        this.attached = false;
        base.attached = false;
        base.note = 'Detached. The DSH application and its tabs are untouched.';
      } catch (error) {
        base.note = `Detach failed: ${error.message}`;
      }
      return base;
    }
    try {
      const listing = await this.attach(request.signal);
      base.attached = true;
      base.tabs = listing.tabs.map((tab) => ({
        index: tab.index,
        current: tab.current,
        title: tab.title,
        url: tab.url,
      }));
      base.currentIndex = listing.tabs.find((tab) => tab.current)?.index ?? -1;
      base.pages = discover({
        tabs: listing.tabs,
        manager: this.manager,
        sessionId: request.sessionId,
        includeUnclaimed: true,
      });
      const resolved = this.cli?.plan;
      base.cli.resolved = resolved ? { file: resolved.file, entry: resolved.prefix.join(' ') } : null;
    } catch (error) {
      base.attached = false;
      base.note = error.message;
    }
    return base;
  }

  dispose() {
    this.cli?.disposeAll();
    this.bridge?.dispose();
  }
}

/**
 * Reject what the sidebar browser would reject anyway, but with a message that
 * names the rule instead of showing a broken tab.
 *
 * @param {string} raw
 */
export function normalizeUrl(raw) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') throw new Error('url must not be empty');
  if (trimmed.length > 16_384) throw new Error('url is longer than the 16384 characters the sidebar accepts');
  let candidate = trimmed;
  if (!/^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/u.test(trimmed)) {
    candidate = `https://${trimmed}`;
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`url is not a valid absolute URL: ${raw}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('url must not embed credentials');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`the sidebar browser only opens http and https URLs (got ${url.protocol})`);
  }
  return url.href;
}

/** @param {string} raw */
function safeUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** @param {string} pageId */
function requirePageId(pageId) {
  const value = String(pageId ?? '').trim();
  if (!/^dshpg-[0-9a-f]{6}-[0-9a-f]{8}$/.test(value)) {
    throw new Error(
      `"${pageId}" is not a page handle. pageIds come from browser_open (for a new tab) or browser_claim ` +
        '(for the tab the user has open), and look like "dshpg-1a2b3c-9f8e7d6c".',
    );
  }
  return value;
}

export { sessionTag, resolveIndex };
