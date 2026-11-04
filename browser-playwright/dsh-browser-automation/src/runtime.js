import path from 'node:path';

import { resolveCdpTarget } from './cdp-target.js';
import { CliBridge } from './cli.js';
import { PageDriver } from './driver.js';
import { newPageId, sessionTag } from './page-id.js';
import { SessionManager, discover } from './sessions.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The endpoint an attach attempt settled on, as resolved by `resolveCdp()`.
 *
 * There is one source by design: the port Chromium recorded. The launch argument
 * decides what DSH listens on, nothing in this plugin can change it, so a record is
 * the only honest answer to "where is it?".
 *
 * `diagnosis` only carries meaning when the probe failed:
 * - `serving`   — `/json/version` answered; `url` works right now.
 * - `absent`    — the recorded port is free and silent: DSH is down, or it was started
 *                 without `--remote-debugging-port` and the record is stale.
 * - `stale`     — the recorded port is held but nothing answers: a previous instance
 *                 left the listening socket behind, so DSH could not bind it.
 * - `no-record` — there is no `DevToolsActivePort` to follow at all.
 *
 * @typedef {object} CdpTarget
 * @property {string | undefined} url
 * @property {number | null} port
 * @property {string | undefined} file
 * @property {number | null} activePort
 * @property {'serving' | 'absent' | 'stale' | 'no-record'} diagnosis
 * @property {{ webSocketDebuggerUrl: string, Browser?: string } | undefined} [version]
 */

/**
 * The one place that composes CLI access, the page registry and the DSH page
 * bridge. Tools are thin wrappers over these methods.
 */
/**
 * Why a hidden window can never be captured, and what still works.
 *
 * Measured on a minimized window: Chromium keeps the layout (the sidebar tab's box was
 * 533x916 inside a 1920x1032 viewport, so every "is it visible" check said yes), but no
 * frame is ever produced. `playwright screenshot` times out, `page.screenshot` times out,
 * and raw CDP `Page.captureScreenshot` hangs forever instead of failing. Meanwhile
 * snapshot, evaluate, click, reload and the bridge itself all keep working, and page
 * timers are not throttled (setTimeout(1000) fired at 1010ms). So this is purely about
 * pixels, and pretending otherwise with a generic "open the sidebar" hint wastes 5-25s.
 */
export const WINDOW_HIDDEN_MESSAGE =
  'Nothing can be captured while the DSH window is minimized or otherwise off screen: Chromium produces no frames ' +
  'for a hidden window, so every capture path times out (the CDP one hangs outright). Restore the window, keep it ' +
  'visible for the duration of a screenshot run, and retry. Everything that does not need pixels still works — ' +
  'browser_snapshot, browser_run_code, browser_console and the click/fill/press tools.';

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
    /**
     * The endpoint the last attach resolved: `{ url, port, diagnosis, file }`.
     *
     * `diagnosis` is what to tell the user when nothing answered — see
     * {@link Runtime#attachHint}.
     *
     * @type {CdpTarget | undefined}
     */
    this.cdp = undefined;
    /**
     * Outcome of the startup attach, for `browser_status` and the panel.
     *
     * `ok: null` means "still trying", `ok: false` means it gave up (the reason is in
     * `error`), and `skipped` means `autoAttach: false`.
     *
     * @type {{ ok: boolean | null, at: number | null, error: string | null, attempts: number, skipped?: boolean }}
     */
    this.autoAttach = { ok: null, at: null, error: null, attempts: 0 };
    /** @type {(() => void) | undefined} */
    this.cancelAutoAttach = undefined;
  }

  /**
   * Attach once at startup, before the user opens any sidebar page.
   *
   * playwright-cli only adopts `webview` targets created after it attached, so a page
   * opened before that point is invisible to `tab-list` forever (re-attaching does not
   * help). Attaching during activation puts the boundary before the user's first page,
   * which is the whole reason this exists.
   *
   * Best effort by design: it never throws, it retries while Electron's debug endpoint
   * is still coming up, and it records the outcome instead of failing the row.
   *
   * @param {{ delayMs?: number, attempts?: number, backoffMs?: number }} [options]
   */
  scheduleAutoAttach(options = {}) {
    if (this.config.autoAttach === false) {
      this.autoAttach = { ok: null, at: null, error: null, attempts: 0, skipped: true };
      this.log('auto-attach disabled by config');
      return;
    }
    const delayMs = options.delayMs ?? 500;
    const maxAttempts = options.attempts ?? 10;
    const backoffMs = options.backoffMs ?? 800;
    let cancelled = false;
    this.cancelAutoAttach = () => {
      cancelled = true;
    };
    this.autoAttach = { ok: null, at: null, error: null, attempts: 0 };

    const run = async (attempt) => {
      if (cancelled) return;
      this.autoAttach.attempts = attempt;
      try {
        await this.attach();
        this.autoAttach.ok = true;
        this.autoAttach.at = Date.now();
        this.autoAttach.error = null;
        this.log(`auto-attach succeeded on attempt ${attempt}`);
      } catch (error) {
        this.autoAttach.error = error.message;
        this.autoAttach.ok = attempt >= maxAttempts ? false : null;
        this.log(`auto-attach attempt ${attempt} failed: ${error.message}`);
        if (cancelled || attempt >= maxAttempts) {
          if (!cancelled) this.log('auto-attach gave up; browser_open/browser_claim will re-attach on demand');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        await run(attempt + 1);
      }
    };
    setTimeout(() => {
      void run(1);
    }, delayMs);
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
      // Set for real by resolveCdp() before any attach: the port is not knowable
      // before Chromium's record is read.
      cdpUrl: undefined,
      attachTimeoutMs: Number(this.config.attachTimeoutMs ?? 60_000),
      screenshotTimeoutMs: Number(this.config.screenshotTimeoutMs ?? 25_000),
      log: this.log,
    });
    return this.driver;
  }

  /** Absolute path of the DevToolsActivePort record, or `undefined` for "auto". */
  cdpPortFile() {
    const value = this.config.cdpPortFile;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' || trimmed === 'auto' ? undefined : trimmed;
  }

  /**
   * Find the endpoint to attach to, and point the driver at it.
   *
   * There is no configured port to fall back to: the launch argument decides what DSH
   * listens on, `DevToolsActivePort` records it, and this plugin follows the record.
   * Re-resolved on every attach attempt because Chromium writes the file while DSH is
   * still starting, and the startup attach retries — so a record that appears between
   * two attempts has to be picked up by the attempt that follows it.
   */
  async resolveCdp() {
    const target = await resolveCdpTarget({
      portFile: this.cdpPortFile(),
      // Test seams: the unit tests drive discovery without a live browser.
      readPort: this.cdpReadPort,
      probe: this.cdpProbe,
      portFree: this.cdpPortFree,
      log: this.log,
    });
    this.cdp = target;
    if (this.driver) this.driver.cdpUrl = target.url;
    return target;
  }

  /**
   * Attach, translating the CLI's failure into the action the user has to take.
   *
   * Three different failures used to share one message ("add --remote-debugging-port
   * =9222"), and that was wrong most of the time: a port left behind by the previous
   * instance refuses the connection just as loudly as a missing flag, and re-adding
   * the flag never fixes it. {@link Runtime#resolveCdp} already knows which one
   * happened.
   */
  async attach(signal) {
    const driver = this.ensureDriver();
    let target;
    try {
      target = await this.resolveCdp();
      const listing = await driver.ensureAttached();
      this.attached = true;
      return listing;
    } catch (error) {
      this.attached = false;
      const wrapped = new Error(`${this.attachHint(target)}\n\nUnderlying error: ${error.message}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  /**
   * What to tell the user when no endpoint answered.
   *
   * `stale` is the case that had no explanation before this plugin knew about
   * `DevToolsActivePort`: the port is held, nothing answers, and DSH has already lost
   * the bind — so the fix is to clear the leftover, not to edit the shortcut.
   *
   * @param {CdpTarget | undefined} target
   */
  attachHint(target) {
    const diagnosis = target?.diagnosis ?? 'no-record';
    const port = target?.port;
    const file = target?.file ?? 'DevToolsActivePort';
    const where = target?.url;
    const lines = [
      where
        ? `Could not attach playwright-cli to DSH at ${where}.`
        : 'Could not find the DSH DevTools endpoint: there is no usable DevToolsActivePort record.',
    ];

    if (diagnosis === 'stale') {
      lines.push(
        `Port ${port} is held but nothing answers on it, and this endpoint's record is at ${file}. Either DSH ` +
          'Desktop is not running and a previous session left its listener behind, or DSH could not bind the ' +
          'port at startup (the usual cause is that leftover: its listening socket was inherited by a helper ' +
          'process that outlived the app, so it was never released). Restarting DSH alone does not clear it.',
        '1. Quit DSH Desktop completely.',
        `2. End the helper that still owns it: Get-NetTCPConnection -LocalPort ${port} names a PID that no longer ` +
          'exists (the socket creator); the real holder is a process that outlived DSH, usually node.exe.',
        `3. Start DSH again, then check: Invoke-WebRequest ${where}/json/version`,
        'Launching with --remote-debugging-port=0 prevents this: each run gets a fresh port, and this plugin ' +
          `follows it from ${file}.`,
      );
    } else if (diagnosis === 'absent') {
      lines.push(
        `The record at ${file} names port ${port}, but nothing answers there and the port is free. DSH Desktop ` +
          'is probably not running, or it is running without --remote-debugging-port (the record would then be ' +
          'left over from an earlier run).',
        '1. Start DSH with the flag: append --remote-debugging-port=0 to the shortcut target, after the .exe path.',
        '2. If DSH is already running, it was started without the flag — quit it and start it again with the flag.',
        `3. Check the record afterwards: Get-Content ${file} should show a port and a /devtools/browser/ path.`,
      );
    } else {
      lines.push(
        'DSH Desktop only opens a debugging endpoint when it is started with --remote-debugging-port, and this ' +
          'plugin can only find it through the record Chromium writes.',
        '1. Quit DSH Desktop, then start it with --remote-debugging-port=0 appended to the shortcut target ' +
          '(after the .exe path). Every launch then picks a free port and the plugin follows it.',
        "2. If it already has that flag, the record went somewhere else: point cdpPortFile at that directory's DevToolsActivePort file.",
        '3. A fixed port works too (--remote-debugging-port=9222), with the leftover-endpoint risk described in README §6.2.',
      );
    }
    lines.push('Check the CLI: playwright-cli list');
    return lines.join('\n');
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
      const opened = await this.requestSidebarOpen(url, request.sessionId);
      const background = opened?.background === true;
      const flashed = opened?.flashed === true;
      const pageId = newPageId(request.sessionId, new Set(this.manager.all().map((page) => page.pageId)));
      const found = await this.waitForNewTab(before, url, request.waitMs ?? 15_000);
      if (!found) {
        // A background tab that never became a CLI target must not be left behind: the
        // page half already saw its webview, so close it again before reporting.
        let rolledBack = false;
        if (background && opened?.tabId) {
          rolledBack = await this.requestSidebarClose(request.sessionId, opened.tabId);
        }
        throw new Error(
          `A sidebar tab was opened for ${url}, but it never appeared in playwright-cli's tab list. ` +
            (background
              ? 'It was opened in a conversation that is not on screen, and its page never started loading' +
                (rolledBack ? ' (the tab was closed again)' : '') +
                '. Switch to that conversation and retry.'
              : 'The page may have failed to load (or the sidebar is showing an error). ' +
                'Check the sidebar, then use browser_list to see what is reachable.') +
            localFileHint(url),
        );
      }
      // No standalone tab-select here: installMarker runs inside the driver's global
      // CLI lock and selects the tab itself. Selecting out here would race any other
      // operation (the daemon has one shared current-tab pointer).
      const marked = await this.injectMarker({ ...found, pageId });
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
        background,
        flashed,
      };
    });
  }

  /**
   * Ask the DSH page to create a sidebar tab. There is no fallback by design: the
   * only supported way to create a sidebar tab is `ctx.sidebarRight.openTab` inside
   * the page, and Electron's CDP cannot create targets. Reusing an existing tab
   * instead would be a guess about user intent, so it fails with an actionable error.
   */
  async requestSidebarOpen(url, sessionId) {
    try {
      const result = await this.bridge.request('open-tab', { url, sessionId });
      this.log(`sidebar opened a tab for ${url}: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      // A deliberate policy refusal travels with its own code and must not be dressed up
      // as "the page did not create a tab".
      if (/PAGE_FOREIGN_SESSION/.test(String(error.message))) throw new Error(String(error.message));
      throw new Error(
        `The DSH page did not create a sidebar tab for ${url}: ${error.message}\n` +
          'This tool opens tabs only through the DSH page; it will not take over an arbitrary existing tab. ' +
          'Check the DSH sidebar and the bridge state (browser_status), then retry.',
      );
    }
  }

  /**
   * Close a tab that lives in another conversation — the rollback for a background open
   * that never produced a page. Best effort: a failure to close must not mask the
   * original error.
   *
   * @param {string} sessionId
   * @param {string} tabId
   * @returns {Promise<boolean>}
   */
  async requestSidebarClose(sessionId, tabId) {
    try {
      await this.bridge.request('close-tab', { sessionId, tabId }, { timeoutMs: 8_000 });
      this.log(`closed background tab ${tabId} in ${sessionId}`);
      return true;
    } catch (error) {
      this.log(`could not close background tab ${tabId}: ${error.message}`);
      return false;
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
   * Install (or replace) the page identity on one tab: an init script so every later
   * navigation re-applies it, plus one eval for the document already loaded.
   *
   * @param {{ index: number, title?: string, url?: string, current?: boolean, pageId: string }} tab
   */
  async injectMarker(tab) {
    const driver = this.ensureDriver();
    const marked = await driver.installMarker(tab).catch(async (error) => {
      // A page that refuses init scripts (CSP or a non-document target) still gets
      // the one-shot identity, which is better than failing the whole open.
      this.log(`init script failed (${error.message}); falling back to a one-shot identity`);
      return driver.mark(tab);
    });
    const title = typeof marked?.title === 'string' ? marked.title : undefined;
    const url = typeof marked?.url === 'string' ? marked.url : undefined;
    this.log(`marked tab ${tab.index} as ${tab.pageId}`);
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
   * @param {{ sessionId: string, signal?: AbortSignal }} request
   */
  async claimPage(request) {
    const driver = this.ensureDriver();
    requireBridge(this.bridge, 'browser_claim');
    const listing = await this.attach(request.signal);
    const target = await this.requireVisibleTab(listing.tabs, request.sessionId);
    // Replace whatever identity the page already carries, so the previous owner's
    // handle stops resolving. The catalog is read before the identity is installed;
    // the entry is matched by index first and by URL as a fallback.
    const catalog = await driver.catalog();
    const previous =
      catalog.find(
        (entry) =>
          !entry.closed && entry.index === target.index && samePage(entry.url ?? '', target.url),
      ) ?? catalog.find((entry) => !entry.closed && samePage(entry.url ?? '', target.url));
    const previousPageId = previous?.pageId ?? null;
    const pageId = newPageId(request.sessionId, new Set(this.manager.all().map((page) => page.pageId)));
    // Selecting happens inside installMarker (under the driver's CLI lock), for the
    // same reason as browser_open.
    const marked = await this.injectMarker({ ...target, pageId });
    if (previousPageId) this.manager.unregister(previousPageId);
    const title = marked.title ?? target.title;
    const url = marked.url ?? target.url;
    this.manager.register({
      pageId,
      sessionId: request.sessionId,
      url,
      title,
      source: 'claim',
      tabId: target.tabId ?? null,
    });
    return {
      pageId,
      title,
      url,
      replacedExistingPageId: previousPageId ?? undefined,
    };
  }

  /**
   * The tab the user is looking at, or a failure that names the fix.
   *
   * A collapsed sidebar keeps the page alive but gives its carrier no box, and the
   * page half reports the visible carrier only — so "open the sidebar" is a real
   * requirement, not a workaround.
   *
   * "The page in view" is a property of the **window**, not of the caller: the page half
   * reports whichever webview is on screen, which belongs to the conversation currently
   * mounted in the sidebar. A background conversation must therefore not be allowed to
   * claim it — that would take the page away from the session the user is looking at.
   * `caps.mounted` is that mounted session, and it is the same id used to mint pageIds
   * (verified: `sessionTag(mounted)` equals the tag inside this session's handles).
   *
   * @param {import('./tab-list.js').TabEntry[]} tabs
   * @param {string} [sessionId] the calling session; omitted by internal callers
   * @returns {Promise<import('./tab-list.js').TabEntry & { tabId: string | null }>}
   */
  async requireVisibleTab(tabs, sessionId) {
    let caps;
    try {
      caps = await this.bridge.request('ping', {}, { timeoutMs: 5_000 });
    } catch (error) {
      throw new Error(
        `browser_claim has to ask the DSH page which page you have open, and that request failed: ${error.message}\n` +
          'Reload the DSH window and retry, or use browser_open once the page half is back.',
      );
    }
    // The page in view belongs to whichever conversation is mounted; a background
    // conversation claiming it would take the tab away from the user's current view.
    const mounted = typeof caps?.mounted === 'string' && caps.mounted !== '' ? caps.mounted : null;
    if (mounted && sessionId && mounted !== sessionId) {
      throw new Error(
        `PAGE_FOREIGN_SESSION: the browser page in view belongs to another DSH conversation (mounted ${mounted}). ` +
          'browser_claim takes over the tab the user is looking at, so it only works from the conversation that is ' +
          'currently open in the window. Switch to that conversation and run it there, or use browser_open to ' +
          'create a tab in this one.',
      );
    }
    const visibleUrl = caps?.visibleUrl;
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
      // Two different failures wear the same shape, and the old single message sent
      // people looking for a loading problem. Zero web pages in the list means the CLI
      // never adopted this page at all — it only tracks sidebar pages created after it
      // attached — and no amount of waiting changes that.
      if (candidates.length === 0) throw new Error(stalePageWarning(visibleUrl, tabs.length));
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
    let pages = [];
    let warning;
    try {
      await this.attach();
      // The catalog reads each page's in-page identity; tab-list alone carries no
      // pageId any more.
      pages = await driver.catalog();
    } catch (error) {
      warning = error.message;
      pages = [];
    }
    const rows = discover({
      pages,
      manager: this.manager,
      sessionId: request.sessionId,
      includeUnclaimed: request.scope === 'all',
    });
    const filtered = request.scope === 'all' ? rows : rows.filter((row) => row.mine === true);
    // A sidebar page the user opened before this automation session is invisible to the
    // CLI even though Electron exposes it over CDP, so an empty list next to a visibly
    // open page is this limitation, not an empty sidebar.
    const live = pages.filter((page) => !page.closed);
    if (!warning && live.every((page) => !/^https?:/i.test(page.url ?? ''))) {
      const visible = await this.visiblePageUrl();
      if (visible) warning = stalePageWarning(visible, live.length);
    }
    return { count: filtered.length, pages: filtered, warning };
  }

  /**
   * The URL of the sidebar page the user can see, straight from the page half.
   *
   * @returns {Promise<string | undefined>}
   */
  async visiblePageUrl() {
    try {
      const caps = await this.bridge.request('ping', {}, { timeoutMs: 2_000 });
      const url = caps?.visibleUrl;
      return typeof url === 'string' && url !== '' ? url : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * What the page half needs to locate one page in the sidebar: the stored tab id,
   * plus the URL when the registry has no record (a page discovered after a Host
   * reload). No attach is performed; with the CLI detached the caller still gets
   * the registry values and the page half reports that it cannot match the tab.
   *
   * @param {string} pageId
   * @returns {Promise<{ tabId: string | null, url: string | null }>}
   */
  async locateTab(pageId) {
    const record = this.manager.get(pageId);
    let url = record?.url ?? null;
    if (!url) {
      const driver = this.ensureDriver();
      if (driver.attached) {
        try {
          const entry = (await driver.catalog()).find((page) => !page.closed && page.pageId === pageId);
          url = entry?.url ?? null;
        } catch (error) {
          this.log(`could not look up ${pageId}: ${error.message}`);
        }
      }
    }
    return { tabId: record?.tabId ?? null, url };
  }

  /**
   * Whether a sidebar tab is controlled by this Host, for the overlay badge.
   *
   * The badge lives in the DSH page and cannot read the in-page identity, so it
   * asks here instead of parsing a title. The tab id is exact. The URL fallback
   * only answers for a record with no known tab id (a page discovered after a
   * Host reload), so two tabs showing the same URL cannot borrow each other's
   * badge.
   *
   * @param {{ tabId?: string, url?: string }} [request]
   * @returns {{ shared: boolean, pageId: string | null }}
   */
  sharedTab(request = {}) {
    const tabId = typeof request.tabId === 'string' && request.tabId !== '' ? request.tabId : null;
    const url = typeof request.url === 'string' && request.url !== '' ? request.url : null;
    if (tabId) {
      const exact = this.manager.all().find((page) => page.tabId === tabId);
      if (exact) return { shared: true, pageId: exact.pageId };
    }
    if (url) {
      const byUrl = this.manager.all().find((page) => !page.tabId && page.url === url);
      if (byUrl) return { shared: true, pageId: byUrl.pageId };
    }
    return { shared: false, pageId: null };
  }

  /**
   * Close one sidebar browser tab.
   *
   * This is a UI action, not a CLI one: `playwright-cli tab-close` only destroys the
   * CDP target, which leaves the sidebar tab behind as an empty shell ("页面加载失败")
   * that keeps focus. Only `ctx.sidebarRight.close(tabId)` removes the tab, so the
   * page half performs it and the CLI is not involved at all.
   *
   * @param {{ pageId: string }} request
   */
  async closePage(request) {
    const pageId = requirePageId(request.pageId);
    requireBridge(this.bridge, 'browser_close');
    // Closing is an action on one conversation's strip: the handle must belong to the
    // caller (a registered page, or at least a handle carrying that session's tag — which
    // is how a tab left over from an earlier run can still be cleaned up).
    requireOwnership(this.manager, pageId, request.sessionId);
    const located = await this.locateTab(pageId);
    const result = await this.bridge.request(
      'close-page',
      {
        pageId,
        sessionId: request.sessionId,
        tabId: located.tabId,
        url: located.url,
      },
      { timeoutMs: 8_000 },
    );
    if (!result || result.closed !== true) {
      throw new Error(
        `The DSH page did not close this tab: ${result?.reason ?? 'no reason reported'}.\n` +
          'browser_close removes the sidebar tab itself (the CLI cannot: closing the CDP target leaves an ' +
          'empty tab behind). Use browser_list to see what is still open, or close the tab in the sidebar.',
      );
    }
    this.manager.unregister(pageId);
    return { pageId, closed: true, tabId: result.tabId ?? null };
  }

  /**
   * Run one page-scoped operation, serialized per page. The tab is resolved once
   * here and threaded into the driver, so a tool call costs two CLI round trips
   * (list, select) instead of four.
   *
   * The page must belong to the calling session: a page handle is only meaningful
   * together with the session that minted it, and acting across sessions would mutate
   * a page the user is working in from a conversation they are not looking at.
   * `browser_claim` remains the sanctioned way to take a page over.
   *
   * @param {string} pageId
   * @param {(driver: PageDriver, tab: { index: number, title: string, url: string, current: boolean }) => Promise<Record<string, unknown>>} operation
   * @param {{ signal?: AbortSignal, sessionId?: string }} [context]
   */
  async onPage(pageId, operation, context = {}) {
    const { signal, sessionId } = context;
    const driver = this.ensureDriver();
    // §4.1 of the migration plan: name the *format check* result for what it is. A
    // valid pageId says nothing about whether the page still exists — that is what
    // resolvePage reports.
    const validPageId = requirePageId(pageId);
    requireOwnership(this.manager, validPageId, sessionId);
    if (signal?.aborted) throw new Error('The operation was cancelled.');
    return this.manager.withLock(validPageId, async () => {
      // Attach through this path on the first call so a missing DSH debug port is
      // reported with the restart instructions instead of a raw CLI error.
      if (!driver.attached) await this.attach(signal);
      // Resolved exactly once; the operation's own driver call selects the tab and
      // retries a stale index (executeOnResolvedTab). Resolving twice per call is the
      // duplication §4.4 of the plan asks to remove.
      const tab = await driver.resolvePage(validPageId);
      const result = await operation(driver, tab);
      // The model addresses pages by pageId; the tab index is an internal detail and
      // never leaves this layer.
      return { pageId: validPageId, ...result };
    });
  }

  async snapshot(request) {
    return this.onPage(
      request.pageId,
      async (driver, tab) => {
        const detail = await driver.snapshot(tab, { depth: request.depth });
        return {
          title: tab.title,
          url: tab.url,
          refCount: detail.refCount,
          snapshot: detail.snapshot,
        };
      },
      { signal: request.signal, sessionId: request.sessionId },
    );
  }

  /**
   * Capture a page to a PNG file.
   *
   * Chromium only frames a widget that is laid out and on screen, and a sidebar tab
   * that is not the visible one sits in a `display:none` cell measuring 0x0 — so a
   * capture waits forever. The page half therefore reports whether the tab is
   * already visible (cheap path: the CLI's own screenshot command) and otherwise
   * brings it to the front, expanding the panel first if needed. Two details make
   * the slow path work: the first frame after a resize needs a moment, and
   * Playwright's default 5s deadline is too tight for it, so the capture goes
   * through Playwright's API with a deadline of our own.
   *
   * Per the user's decision, the sidebar is left on the captured tab afterwards.
   *
   * @param {{ pageId: string, fullPage?: boolean, target?: string, signal?: AbortSignal }} request
   */
  async screenshot(request) {
    // Fail in microseconds instead of burning the capture deadline: a hidden window is
    // knowable before any command runs, and no amount of focusing changes it.
    if (this.bridge?.caps?.()?.hidden === true) throw new Error(WINDOW_HIDDEN_MESSAGE);
    const driver = this.ensureDriver();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(driver.cli.workdir(), `screenshot-${stamp}.png`);

    let plan = { visible: null, tabId: null, expanded: null, expandedNow: false };
    if (this.bridge?.hasClient()) {
      const located = await this.locateTab(request.pageId);
      plan = await this.bridge
        .request(
          'prepare-capture',
          {
            pageId: request.pageId,
            tabId: located.tabId,
            url: located.url,
          },
          { timeoutMs: 6_000 },
        )
        .catch((error) => {
          this.log(`prepare-capture failed, capturing as-is: ${error.message}`);
          return plan;
        });
    }
    // A tab that was just brought to the front (or un-collapsed) needs a frame
    // before Chromium will hand one to the capture.
    const settleMs = Number(this.config.screenshotSettleMs ?? 1_200);
    if (plan.visible === false && plan.tabId && settleMs > 0) await sleep(settleMs);

    return this.onPage(
      request.pageId,
      async (driver, tab) => {
        // Only the CLI command understands snapshot refs, so an element capture
        // always takes that path — even after focusing, where its 5s deadline is
        // the only risk. Capturing the whole page is what gets the long deadline.
        const elementTarget = Boolean(request.target);
        try {
          if (plan.visible === false && plan.tabId && !elementTarget) {
            // Playwright's capture path with a deadline that matches a cold frame.
            await driver.screenshotToFile(
              tab,
              {
                path: file,
                fullPage: request.fullPage,
                timeoutMs: Number(this.config.screenshotTimeoutMs ?? 25_000),
              },
              tab,
            );
          } else {
            await driver.screenshot(
              tab,
              { path: file, fullPage: request.fullPage, target: request.target },
              tab,
            );
          }
        } catch (error) {
          if (/Timeout/i.test(error.message)) {
            // The window can go away between the check above and the capture (a test
            // run starts, the user minimizes): same cause, same precise answer.
            if (this.bridge?.caps?.()?.hidden === true) throw new Error(WINDOW_HIDDEN_MESSAGE);
            // A page that belongs to a conversation that is not on screen has no surface
            // at all: bringing its tab to the front cannot help, because the tab strip the
            // controller can address is the one on screen.
            const mounted = String(this.bridge?.caps?.()?.mounted ?? '');
            const owner = this.manager.get(request.pageId)?.sessionId ?? '';
            const foreignSurface = mounted !== '' && owner !== '' && owner !== mounted;
            if (foreignSurface) {
              throw new Error(
                `The browser could not capture this tab (${error.message}). This page belongs to a conversation ` +
                  'that is not on screen, so it has no visible surface — Chromium produces no frames for it and ' +
                  'focusing cannot help. Use browser_snapshot (or browser_run_code) instead: they read the page ' +
                  'without capturing pixels. To get a picture, switch to that conversation and take it there.',
              );
            }
            const hint =
              plan.visible === false
                ? plan.tabId
                  ? ` The plugin brought the tab to the front (tabId ${plan.tabId}) and still could not capture it` +
                    (elementTarget ? ', and element captures use the CLI\u2019s fixed 5s deadline' : '') +
                    '.'
                  : ' The plugin could not locate this page\u2019s sidebar tab, so it could not bring it to the front.'
                : '';
            throw new Error(
              `The browser could not capture this tab (${error.message}). Chromium only frames a sidebar tab that ` +
                `is laid out and visible.${hint} Open the sidebar, select this tab, and retry — ` +
                'browser_snapshot reads the same page without capturing pixels and always works.',
            );
          }
          throw error;
        }
        return { path: file };
      },
      { signal: request.signal, sessionId: request.sessionId },
    );
  }

  /**
   * Bring a page to the front so the user can see the operation happening.
   *
   * Every visible tool (goto, reload, click, fill, press) calls this first: a sidebar
   * tab that is not the selected one is invisible to the user, and the whole point of
   * driving *their* sidebar is that they can watch it. Best effort — a page that
   * cannot be located still gets its operation, which then reports the real failure.
   *
   * The page half already owns this: `prepare-capture` selects the tab, expanding the
   * collapsed column first, and answers quickly when the page is already visible.
   *
   * @param {string} pageId
   */
  async reveal(pageId) {
    try {
      const located = await this.locateTab(pageId);
      await this.bridge?.request(
        'prepare-capture',
        { pageId, tabId: located.tabId, url: located.url },
        { timeoutMs: 6_000 },
      );
    } catch (error) {
      this.log(`could not reveal ${pageId}: ${error.message}`);
    }
  }

  async click(request) {
    await this.reveal(request.pageId);
    return this.onPage(
      request.pageId,
      async (driver, tab) => ({
        result: await driver.click(
          tab,
          {
            ref: request.ref,
            button: request.button ?? undefined,
            double: request.double === true,
            modifiers: request.modifiers,
          },
          tab,
        ),
      }),
      { signal: request.signal, sessionId: request.sessionId },
    );
  }

  async fill(request) {
    await this.reveal(request.pageId);
    return this.onPage(
      request.pageId,
      async (driver, tab) => ({
        result: await driver.fill(
          tab,
          { ref: request.ref, text: request.text, submit: request.submit },
          tab,
        ),
      }),
      { signal: request.signal, sessionId: request.sessionId },
    );
  }

  async press(request) {
    await this.reveal(request.pageId);
    return this.onPage(
      request.pageId,
      async (driver, tab) => ({
        result: await driver.press(tab, { key: request.key }),
      }),
      { signal: request.signal, sessionId: request.sessionId },
    );
  }

  async goto(request) {
    const url = normalizeUrl(request.url);
    await this.reveal(request.pageId);
    return this.onPage(
      request.pageId,
      async (driver, tab) => {
        const result = await driver.goto(tab, { url });
        this.manager.update(request.pageId, { url: result.reportedUrl ?? url, title: result.title });
        return { url: result.reportedUrl ?? url, title: result.title };
      },
      { signal: request.signal, sessionId: request.sessionId },
    );
  }

  /**
   * Reload one sidebar page.
   *
   * Implemented as "navigate to the same URL", never with `playwright-cli reload`:
   * that command reloads the whole DSH page whatever the selected tab is, and every
   * sidebar browser page is lost with it. `goto` reaches only the tab this pageId
   * resolved to, so a reload cannot touch the shell.
   *
   * @param {{ pageId: string, signal?: AbortSignal }} request
   */
  async reload(request) {
    await this.reveal(request.pageId);
    return this.onPage(
      request.pageId,
      async (driver, tab) => {
        const target = refuseApplicationTab(tab, 'browser_reload');
        if (!/^[a-z]+:/i.test(String(target.url ?? ''))) {
          throw new Error(
            `Cannot reload: this page has no URL to navigate back to (got "${target.url ?? ''}"). ` +
              'Use browser_goto with an explicit URL instead.',
          );
        }
        const result = await driver.reload(target, { url: target.url });
        const url = result.reportedUrl ?? target.url;
        this.manager.update(request.pageId, { url, title: result.title ?? target.title });
        return { url, title: result.title ?? target.title };
      },
      { signal: request.signal, sessionId: request.sessionId },
    );
  }

  async runCode(request) {
    return this.onPage(
      request.pageId,
      // driver.runCode answers with { output, title, url }: `title`/`url` are the
      // post-run identity read-back, used to keep the registry honest when a snippet
      // navigates. Only `output` crosses to the tool, whose schema says `output: string`
      // — wrapping the whole object here made every call fail validation *after* the
      // snippet had already run (a retry would repeat its side effects).
      async (driver, tab) => {
        const { output, title, url } = await driver.runCode(tab, { code: request.code });
        if (typeof url === 'string' && url !== '' && (url !== tab.url || title !== tab.title)) {
          this.manager.update(request.pageId, { url, title: title ?? tab.title });
        }
        return { output: typeof output === 'string' ? output : String(output ?? '') };
      },
      { signal: request.signal, sessionId: request.sessionId },
    );
  }

  async consoleMessages(request) {
    return this.onPage(
      request.pageId,
      async (driver, tab) => {
        const text = await driver.console(tab, { level: request.level });
        const limit = Number.isFinite(request.limit) ? Number(request.limit) : 50;
        const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
        return { messages: lines.slice(-limit).join('\n') };
      },
      { signal: request.signal, sessionId: request.sessionId },
    );
  }

  /** @param {{ sessionId: string, action: string, signal?: AbortSignal }} request */
  async status(request) {
    const driver = this.ensureDriver();
    const base = {
      action: request.action,
      attached: false,
      // Null until discovery runs: the endpoint is Chromium's decision, not a setting.
      cdpUrl: null,
      // Where the port actually came from and what an unreachable endpoint means.
      // Filled in by finish(), after attach() has had a chance to resolve it.
      cdp: null,
      cli: { command: String(this.config.command ?? 'playwright-cli'), session: String(this.config.session ?? 'dsh') },
      bridgeError: this.health?.bridgeError ?? null,
      currentIndex: -1,
      // Whether the startup attach got through, so a broken CLI is visible without
      // waiting for a tool to fail.
      autoAttach: this.autoAttach ?? null,
      // `pages` is the only tab list: it carries every field the raw tab-list had
      // plus the plugin's bookkeeping, so shipping both was pure duplication.
      pages: [],
      // The two start modes, so the model never has to guess what is possible now.
      modes: { open: false, claim: false },
    };
    /**
     * Snapshot the bridge last, not first.
     *
     * Reading it before `attach()` and the claim ping produced self-contradictory
     * output — `state: "never"` next to `open: true` — because the page had
     * connected in between. One snapshot, taken when everything else is settled.
     */
    const finish = () => {
      // The endpoint is only known once attach() resolved it (or failed to), and the
      // panel is where the user looks when it did fail — so report the real one.
      if (this.cdp) {
        base.cdpUrl = this.cdp.url ?? null;
        base.cdp = {
          url: this.cdp.url ?? null,
          port: this.cdp.port,
          diagnosis: this.cdp.diagnosis,
          file: this.cdp.file ?? null,
        };
      }
      base.bridge = this.bridge ? this.bridge.snapshot() : { state: 'never', clients: [] };
      return base;
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
      return finish();
    }
    try {
      await this.attach(request.signal);
      base.attached = true;
      // `pages` comes from the page catalog, which reads the in-page identity of
      // every page; the raw tab list only has titles and cannot name a page.
      const catalog = await driver.catalog();
      base.currentIndex = catalog.find((page) => page.current)?.index ?? -1;
      base.pages = discover({
        pages: catalog,
        manager: this.manager,
        sessionId: request.sessionId,
        includeUnclaimed: true,
      });
      const resolved = this.cli?.plan;
      base.cli.resolved = resolved
        ? {
            // Which node runs the CLI, and which JS entry it runs. Where that node
            // came from stays in the log: it only matters when nothing runs.
            node: resolved.file,
            entry: resolved.prefix.join(' '),
          }
        : null;
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
      base.modes.claim = Boolean(caps?.visibleUrl);
    }
    return finish();
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
  // The plugin does not restrict the test subject: `file:` is accepted here and the
  // platform decides. DSH's own sidebar browser rejects `file:`/`data:`/`blob:` and
  // owns local files through Document Preview, so a `file:` URL surfaces as "never
  // appeared in the tab list" — `localFileHint` turns that into the workaround.
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) {
    throw new Error(`the sidebar browser only opens http, https and file URLs (got ${url.protocol})`);
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

/**
 * Explain the one case where a page is plainly on screen and still unreachable.
 *
 * Electron exposes every sidebar page over CDP (`/json/list` lists them as `webview`
 * targets), but playwright-cli only adopts the ones created *after* it attached: a
 * page the user opened earlier, or a page whose webview was recreated by an app
 * restart, never shows up in `tab-list`. Re-attaching does not help — verified by
 * detaching and attaching again with four pre-existing webviews on screen. Closing
 * the tab and reopening the URL creates a fresh target, which is adopted.
 *
 * @param {string} url
 * @param {number} tabCount
 */
export function stalePageWarning(url, tabCount) {
  return (
    `browser_claim cannot see the page you have open (${url}): playwright-cli only tracks sidebar pages created ` +
    `after it attached, and this one existed before (${tabCount} tab(s) visible, none of them a web page). ` +
    'Waiting will not change that — Electron does expose the page over CDP, the CLI just never adopts it. ' +
    'Close that tab and open the same URL again (or run browser_open with it): the new tab is adopted and ' +
    'browser_claim works on it.'
  );
}

/**
 * Extra explanation when a local-file URL is the reason an open failed.
 *
 * The sidebar browser's own address parser accepts HTTP/HTTPS (loopback included) and
 * rejects `file:`, script/data/blob and the application origin; local files belong to
 * Document Preview. Rather than pre-empting that rule in the plugin, this turns the
 * platform's silent failure into the workaround the user actually needs.
 *
 * @param {string} rawUrl
 */
export function localFileHint(rawUrl) {
  const scheme = String(rawUrl ?? '').split(':')[0].toLowerCase();
  if (scheme !== 'file' && scheme !== 'data' && scheme !== 'blob') return '';
  return (
    `\n"${scheme}:" is refused by the DSH sidebar browser itself (its address parser accepts http/https only; ` +
    'local files belong to Document Preview). To test a local page, serve its directory over loopback and open ' +
    'http://127.0.0.1:<port>/<file>: e.g. `python -m http.server 8000` in that directory.'
  );
}

/**
 * Refuse to touch the DSH application page itself.
 *
 * The only target that must never be reached is the application: reloading it takes
 * the whole window down. Everything else a sidebar tab can show is fair game —
 * `http(s)`, `file:` for local static pages, `data:`, anything the webview loaded —
 * because restricting the *test subject* to protect the shell would defeat the
 * point of the tool.
 *
 * This is the second line of defence, not the first: the application page has no
 * `pageId` at all (identities are only installed on opened or claimed pages), so it
 * cannot be addressed. This guard covers an identity that somehow leaked onto an
 * application-scheme tab.
 *
 * @param {{ url?: string, title?: string }} tab
 * @param {string} [tool]
 */
export function refuseApplicationTab(tab, tool = 'this tool') {
  const url = String(tab?.url ?? '');
  if (/^dsh-app:/i.test(url)) {
    throw new Error(
      `${tool} cannot act on the DSH application page (dsh-app:). That page has no pageId and reloading it ` +
        'restarts the whole window. Nothing was executed.',
    );
  }
  return tab;
}

/**
 * Refuse to act on a page that belongs to another DSH session.
 *
 * A page handle is meaningful together with the session that minted it: acting across
 * sessions would mutate a page the user is working in from a conversation they are not
 * looking at (and `browser_list scope=all` deliberately shows those pages, which made
 * that mistake easy). `browser_claim` — not a page action — is the sanctioned way to
 * take a page over: it replaces the identity and registers it under the caller.
 *
 * Ownership comes from the registry when the page is registered there; otherwise from
 * the 24-bit session tag embedded in the handle, so a page whose registry entry was lost
 * (plugin restart) is still attributed correctly.
 *
 * @param {import('./sessions.js').SessionManager} manager
 * @param {string} pageId
 * @param {string | undefined} sessionId the calling session; undefined skips the check
 */
function requireOwnership(manager, pageId, sessionId) {
  if (!sessionId) return;
  const record = manager.get(pageId);
  const owner = record ? record.sessionId : `tag:${pageId.split('-')[1]}`;
  const mine = record ? record.sessionId === sessionId : pageId.split('-')[1] === sessionTag(sessionId);
  if (mine) return;
  throw new Error(
    `PAGE_FOREIGN_SESSION: ${pageId} belongs to another DSH session (${owner}). ` +
      'Page actions are limited to the session that opened or claimed the page, because the user is ' +
      'looking at a different conversation. To take this page over in the current session, call ' +
      'browser_claim while that tab is the visible one; browser_list scope="all" only lists such pages.',
  );
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

export { sessionTag };









