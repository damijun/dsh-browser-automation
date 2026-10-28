import path from 'node:path';

import { CliBridge } from './cli.js';
import { PageDriver } from './driver.js';
import { newPageId, sessionTag, extractPageIds } from './page-id.js';
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
   * Open a sidebar tab through the DSH UI, then take control of it.
   *
   * This is one of exactly two ways to start work with a page (the other is
   * browser_claim). There is no third, implicit path: if the page half is not
   * connected, opening fails loudly instead of reusing some tab the user might
   * be busy with, because nothing in this tool can prove which tab the user meant.
   *
   * @param {{ sessionId: string, url: string, waitMs?: number, signal?: AbortSignal }} request
   */
  async openPage(request) {
    const url = normalizeUrl(request.url);
    // Fail before touching the CLI or the sidebar: an unreachable page half is a
    // plugin/window problem, and no amount of CLI work can open a tab without it.
    requireBridge(this.bridge, 'browser_open');
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
      const marked = await this.injectMarker(found, pageId);
      this.manager.register({
        pageId,
        sessionId: request.sessionId,
        url: found.url,
        title: marked.title,
        source: 'open',
        // The sidebar tab id lets a later screenshot bring the tab to the front.
        tabId: opened?.tabId ?? null,
      });
      return {
        pageId,
        url: marked.url || found.url,
        title: marked.title,
        index: found.index,
      };
    });
  }

  /**
   * Ask the DSH page to create a sidebar tab. There is no fallback by design: the
   * only supported way to create a sidebar tab is `ctx.sidebarRight.openTab` inside
   * the page, and Electron's CDP cannot create targets. Reusing an existing tab
   * instead would be a guess about user intent, so it fails with an actionable error.
   */
  async requestSidebarOpen(url) {
    try {
      const result = await this.bridge.request('open-tab', { url });
      this.log(`sidebar opened a tab for ${url}: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      throw new Error(
        `The DSH page did not create a sidebar tab for ${url}: ${error.message}\n` +
          'This tool opens tabs only through the DSH page; it will not take over an arbitrary existing tab. ' +
          'Check the DSH sidebar and the bridge state (browser_status), then retry.',
      );
    }
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
   * Install (or replace) the marker on one tab: an init script so every later
   * navigation re-applies it, plus one eval for the document already loaded.
   *
   * @param {{ index: number, title?: string, url?: string, current?: boolean }} tab
   * @param {string} pageId
   */
  async injectMarker(tab, pageId) {
    const driver = this.ensureDriver();
    const marked = await driver.installMarker(pageId, tab).catch(async (error) => {
      // A page that refuses init scripts (CSP or a non-document target) still gets
      // the one-shot marker, which is better than failing the whole open.
      this.log(`init script failed (${error.message}); falling back to a one-shot marker`);
      return driver.mark(pageId, tab);
    });
    const title = typeof marked?.title === 'string' ? marked.title : undefined;
    const url = typeof marked?.url === 'string' ? marked.url : undefined;
    this.log(`marked tab ${tab.index} as ${pageId}`);
    return { title, url };
  }

  /**
   * Take over the page the user is looking at — the second of the two start modes.
   *
   * "Looking at" is decided by exactly one source: the page half reports the URL of
   * the sidebar's visible browser carrier. Playwright's own current tab is not used
   * as a fallback on purpose — it resets to the application page on every re-attach,
   * never follows a sidebar tab switch, and picking it would mean taking over a page
   * nobody asked for. If the page half cannot answer, claim fails and says why.
   *
   * @param {{ sessionId: string, note?: string, signal?: AbortSignal }} request
   */
  async claimPage(request) {
    const driver = this.ensureDriver();
    requireBridge(this.bridge, 'browser_claim');
    const listing = await this.attach(request.signal);
    const target = await this.requireVisibleTab(listing.tabs);
    const previousIds = extractPageIds(target.title);
    const pageId = newPageId(request.sessionId, new Set(this.manager.all().map((page) => page.pageId)));
    const originalTitle = target.title.replace(/\s*\[dshpg-[0-9a-f]{6}-[0-9a-f]{8}\]/g, '').trim();
    await this.cli.run(['--raw', 'tab-select', String(target.index)]);
    const marked = await this.injectMarker(target, pageId);
    for (const previous of previousIds) this.manager.unregister(previous);
    this.manager.register({
      pageId,
      sessionId: request.sessionId,
      url: target.url,
      title: originalTitle,
      source: 'claim',
      tabId: target.tabId ?? null,
    });
    return {
      pageId,
      title: originalTitle,
      url: target.url,
      index: target.index,
      note: request.note,
      replacedExistingPageId: previousIds[0],
    };
  }

  /**
   * The tab the user is looking at, or a failure that names the fix.
   *
   * A collapsed sidebar keeps the page alive but gives its carrier no box, and the
   * page half reports the visible carrier only — so "open the sidebar" is a real
   * requirement, not a workaround.
   *
   * @param {import('./tab-list.js').TabEntry[]} tabs
   * @returns {Promise<import('./tab-list.js').TabEntry & { tabId: string | null }>}
   */
  async requireVisibleTab(tabs) {
    let caps;
    try {
      caps = await this.bridge.request('ping', {}, { timeoutMs: 5_000 });
    } catch (error) {
      throw new Error(
        `browser_claim has to ask the DSH page which page you have open, and that request failed: ${error.message}\n` +
          'Reload the DSH window and retry, or use browser_open once the page half is back.',
      );
    }
    const visibleUrl = caps?.visible?.url;
    if (typeof visibleUrl !== 'string' || !/^https?:/i.test(visibleUrl)) {
      throw new Error(
        'Could not see a browser page in the DSH sidebar. The sidebar must be open with a browser tab ' +
          'selected: a collapsed sidebar keeps the page alive but leaves it no rendering surface, so the plugin ' +
          'cannot tell which page you are on. Open the sidebar, select the browser tab, then retry — ' +
          'or use browser_open to create a new tab.',
      );
    }
    const candidates = tabs.filter((tab) => /^https?:/i.test(tab.url));
    const match = candidates.find((tab) => tab.url === visibleUrl) ?? candidates.find((tab) => samePage(tab.url, visibleUrl));
    if (!match) {
      throw new Error(
        `The page you have open (${visibleUrl}) is not in playwright-cli's tab list yet ` +
          `(${tabs.length} tab(s) visible, ${candidates.length} of them web pages). It may still be loading; ` +
          'retry in a moment, or run browser_list to see what the CLI can reach.',
      );
    }
    return { ...match, tabId: caps?.activeTabId ?? null };
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
    // Chromium can only capture a surface it is compositing: a sidebar tab that is
    // hidden behind another tab in the same pane has none, and `page.screenshot()`
    // waits forever for it. Ask the page to bring the tab to the front first, then
    // give React one commit to actually swap the visible body. This is best-effort
    // — the tab id is unknown for a claimed page until the page reports it — so the
    // failure path below still tells the user what to do by hand.
    const record = this.manager.get(request.pageId);
    let focusRequested = false;
    if (record?.tabId && this.bridge?.hasClient()) {
      focusRequested = await this.bridge
        .request('focus-tab', { tabId: record.tabId }, { timeoutMs: 4_000 })
        .then(() => true)
        .catch((error) => {
          this.log(`could not focus ${record.tabId}: ${error.message}`);
          return false;
        });
      if (focusRequested) await sleep(350);
    }
    return this.onPage(
      request.pageId,
      async (driver, tab) => {
        try {
          await driver.screenshot(
            request.pageId,
            { path: file, fullPage: request.fullPage, target: request.target },
            tab,
          );
        } catch (error) {
          if (/Timeout/i.test(error.message)) {
            const tried = focusRequested ? ' The plugin already asked DSH to bring it to the front.' : '';
            throw new Error(
              `The browser could not capture this tab (${error.message}). Chromium only captures a surface it is ` +
                'compositing, and a sidebar tab hidden behind another tab in the same pane has none.' +
                `${tried} Switch the sidebar to this tab and retry. ` +
                'browser_snapshot reads the same page without capturing pixels and always works.',
            );
          }
          throw error;
        }
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
      // The two start modes, so the model never has to guess what is possible now.
      modes: { open: false, claim: false },
    };
    if (request.action === 'detach') {
      try {
        await driver.detach();
        this.attached = false;
        base.attached = false;
        base.note =
          'Detached. The DSH application and its tabs are untouched, but this ends the automation session: ' +
          'the existing pageIds stop resolving, and a later call re-attaches with a fresh view ' +
          '(open or claim a page again to continue).';
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
    // `open` needs a listening page; `claim` additionally needs that page to be
    // showing a browser tab. Asking is a 5s round trip, so only do it when the
    // bridge is live at all.
    if (this.bridge?.clientState() === 'live') {
      base.modes.open = true;
      const caps = await this.bridge.request('ping', {}, { timeoutMs: 5_000 }).catch(() => undefined);
      base.modes.claim = Boolean(caps?.visible?.url);
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

/**
 * Whether two URLs address the same document, ignoring a hash and the trailing
 * slash the two sides may disagree about.
 *
 * @param {string} a
 * @param {string} b
 */
export function samePage(a, b) {
  const left = safeUrl(a);
  const right = safeUrl(b);
  if (!left || !right) return false;
  const normalize = (url) => `${url.origin}${url.pathname.replace(/\/$/, '')}${url.search}`;
  return normalize(left) === normalize(right);
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

/**
 * Refuse to run a start mode without a listening page.
 *
 * Both start modes need the page half, and neither has a fallback: creating a tab
 * is only possible through `ctx.sidebarRight.openTab`, and "which page is the user
 * looking at" is only knowable from the page's own carrier. Guessing would mean
 * hijacking a page nobody asked for, so this fails with the fix instead.
 *
 * @param {import('./bridge.js').Bridge | undefined} bridge
 * @param {'browser_open' | 'browser_claim'} tool
 */
export function requireBridge(bridge, tool) {
  const state = bridge?.clientState?.() ?? 'off';
  if (state === 'live') return;
  const reason =
    state === 'off'
      ? 'the plugin has no page bridge mounted'
      : state === 'never'
        ? 'no DSH page has connected to the bridge since the plugin loaded'
        : 'the DSH page that was connected has gone quiet';
  throw new Error(
    `${tool} needs the DSH page and ${reason}. This is a plugin/window state, not a page error: ` +
      'without the page half there is no way to create a sidebar tab or to tell which page you are looking at.\n' +
      '1. Reload the DSH window, then retry — the page reconnects on its own within a second.\n' +
      '2. If it persists, run browser_status: bridge.state, bridge.clients and bridgeError say why.\n' +
      'Pages you already control keep working; browser_open and browser_claim do not.',
  );
}

export { sessionTag, resolveIndex };
