import { CliError } from './cli.js';
import { resolveIndex, parseTabList, currentIndex, describeTabs } from './tab-list.js';
import { titleMarkerExpression, probeMarkerExpression, installMarkerCode } from './page-id.js';

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
 * @typedef {object} ResolvedTab
 * @property {number} index
 * @property {boolean} current
 * @property {string} title
 * @property {string} url
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
   * @param {string} options.cdpUrl
   * @param {{ badge?: boolean }} [options.marker] page marker/badge defaults
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
    // Read once at construction: the config is a boot snapshot by design, and the
    // badge is painted by every marker (re)application, including after navigation.
    this.marker = options.marker && typeof options.marker === 'object' ? options.marker : {};
    this.attached = false;
  }

  /** Raw tab list. */
  async listTabs() {
    const { stdout } = await this.cli.run(['--raw', 'tab-list']);
    return parseTabList(stdout);
  }

  /**
   * Make sure a `playwright-cli` session is attached to the DSH browser.
   *
   * Attachment is idempotent in the CLI (attaching an already-attached session
   * reconnects it), so the cheap path is: try to list tabs, attach only when
   * that fails. Both a never-attached session and a stale one (DSH restarted)
   * fail the same way, which is exactly the recovery we want.
   *
   * @param {{ force?: boolean }} [options]
   */
  async ensureAttached(options = {}) {
    if (this.attached && !options.force) {
      try {
        return await this.listTabs();
      } catch (error) {
        this.log(`tab-list failed while attached, re-attaching: ${error.message}`);
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
  }

  /** Detach without closing the DSH application. */
  async detach() {
    const result = await this.cli.run(['--raw', 'detach'], { retries: 0 });
    this.attached = false;
    return result;
  }

  /**
   * Resolve a page id to its tab.
   *
   * @param {string} pageId
   * @param {{ attach?: boolean }} [options]
   * @returns {Promise<ResolvedTab>}
   */
  async resolve(pageId, options = {}) {
    const tabs = options.attach === false ? (await this.listTabs()).tabs : (await this.ensureAttached()).tabs;
    const hit = resolveIndex(
      tabs.map((tab) => tab.text).join('\n'),
      pageId,
    );
    return { index: hit.index, current: hit.current, title: hit.title, url: hit.url };
  }

  /**
   * The core execution template: select the tab, run the command, and retry once
   * if the index went stale between listing and selecting (the user can close a
   * tab at any moment).
   *
   * @template T
   * @param {string} pageId
   * @param {(tab: ResolvedTab) => Promise<T>} operation
   * @param {ResolvedTab} [target] a tab resolved earlier in the same call
   * @returns {Promise<T>}
   */
  async withPage(pageId, operation, target) {
    let lastError;
    let known = target;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const hit = known ?? (await this.resolve(pageId));
      known = undefined;
      try {
        if (hit.current !== true) await this.cli.run(['--raw', 'tab-select', String(hit.index)]);
        return await operation(hit);
      } catch (error) {
        lastError = error;
        this.log(`tab ${hit.index} failed, re-resolving: ${error.message}`);
      }
    }
    throw lastError ?? new CliError(`Could not select the tab for ${pageId}.`, { code: 'PAGE_NOT_FOUND' });
  }

  /**
   * Evaluate one JavaScript expression in the page behind `pageId`.
   *
   * playwright-cli wraps the argument as `() => (<expr>)`, so callers must pass
   * an expression or an IIFE — never a statement list.
   *
   * @param {string} pageId
   * @param {string} expression
   * @param {ResolvedTab} [target]
   */
  async evaluate(pageId, expression, target) {
    return this.withPage(
      pageId,
      async () => {
        const { stdout } = await this.cli.run(['--raw', 'eval', expression]);
        return parseEvalOutput(stdout);
      },
      target,
    );
  }

  /**
   * Append the page marker, replacing any marker from a previous claim, and keep
   * it attached across the page's own title rewrites.
   *
   * @param {string} pageId
   * @param {ResolvedTab} [target]
   * @returns {Promise<{ title?: string, url?: string } | undefined>}
   */
  async mark(pageId, target) {
    return this.withPage(
      pageId,
      async () => {
        const { stdout } = await this.cli.run(['--raw', 'eval', titleMarkerExpression(pageId, this.marker)]);
        return parseMarkerOutput(stdout);
      },
      target,
    );
  }

  /**
   * Install the marker durably and apply it to the current document.
   *
   * The init script makes the marker survive every later navigation; the eval
   * covers the document that is already loaded (an init script only runs on the
   * next one). Two CLI calls, paid once per open/claim.
   *
   * @param {string} pageId
   * @param {ResolvedTab} [target]
   * @returns {Promise<{ title?: string, url?: string } | undefined>}
   */
  async installMarker(pageId, target) {
    return this.withPage(
      pageId,
      async () => {
        await this.cli.run(['--raw', 'run-code', installMarkerCode(pageId, this.marker)], { timeoutMs: 60_000 });
        const { stdout } = await this.cli.run(['--raw', 'eval', titleMarkerExpression(pageId, this.marker)]);
        return parseMarkerOutput(stdout);
      },
      target,
    );
  }

  /**
   * Read back the marker state of the current tab (diagnostics).
   *
   * @param {string} pageId
   * @param {ResolvedTab} [target]
   */
  async probe(pageId, target) {
    return this.withPage(
      pageId,
      async () => {
        const { stdout } = await this.cli.run(['--raw', 'eval', probeMarkerExpression]);
        return parseMarkerOutput(stdout);
      },
      target,
    );
  }

  /**
   * @param {string} pageId
   * @param {{ depth?: number }} [options]
   * @param {ResolvedTab} [target]
   */
  async snapshot(pageId, options = {}, target) {
    return this.withPage(
      pageId,
      async () => {
        const args = ['--raw', 'snapshot'];
        if (options.depth) args.push(`--depth=${options.depth}`);
        const { stdout } = await this.cli.run(args);
        const text = stdout.trim();
        const refs = [...text.matchAll(/\[ref=([^\]]+)\]/g)].map((match) => match[1]);
        return { snapshot: text, refCount: refs.length };
      },
      target,
    );
  }

  /**
   * The CLI's own screenshot command. It understands snapshot refs, but uses
   * Playwright's default 5s capture deadline, which a tab that was just brought
   * to the front can exceed. Prefer {@link screenshotToFile} for those.
   *
   * @param {string} pageId
   * @param {{ path: string, fullPage?: boolean, target?: string }} options
   * @param {ResolvedTab} [target]
   */
  async screenshot(pageId, options, target) {
    return this.withPage(
      pageId,
      async () => {
        const args = ['--raw', 'screenshot', `--filename=${options.path}`];
        if (options.fullPage) args.push('--full-page');
        if (options.target) args.push(options.target);
        const { stdout, stderr } = await this.cli.run(args, { timeoutMs: 60_000 });
        return { path: options.path, output: `${stdout}${stderr}`.trim() };
      },
      target,
    );
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
   * @param {string} pageId
   * @param {{ path: string, fullPage?: boolean, timeoutMs?: number }} options
   * @param {ResolvedTab} [target]
   */
  async screenshotToFile(pageId, options, target) {
    const settings = [
      `path: ${JSON.stringify(options.path)}`,
      `timeout: ${Number(options.timeoutMs ?? this.screenshotTimeoutMs)}`,
      ...(options.fullPage ? ['fullPage: true'] : []),
    ].join(', ');
    const code = `async page => { await page.screenshot({ ${settings} }); return "saved"; }`;
    return this.withPage(
      pageId,
      async () => {
        await this.cli.run(['--raw', 'run-code', code], { timeoutMs: 60_000 });
        return { path: options.path };
      },
      target,
    );
  }

  /**
   * @param {string} pageId
   * @param {{ ref: string, button?: string, modifiers?: string[], double?: boolean }} options
   * @param {ResolvedTab} [target]
   */
  async click(pageId, options, target) {
    return this.withPage(
      pageId,
      async () => {
        const args = ['--raw', options.double ? 'dblclick' : 'click', options.ref];
        if (options.button) args.push(options.button);
        for (const modifier of options.modifiers ?? []) args.push(`--modifiers=${modifier}`);
        const { stdout } = await this.cli.run(args);
        return actionOutput(stdout);
      },
      target,
    );
  }

  /**
   * @param {string} pageId
   * @param {{ ref: string, text: string, submit?: boolean }} options
   * @param {ResolvedTab} [target]
   */
  async fill(pageId, options, target) {
    return this.withPage(
      pageId,
      async () => {
        const args = ['--raw', 'fill', options.ref, options.text];
        if (options.submit) args.push('--submit');
        const { stdout } = await this.cli.run(args);
        return actionOutput(stdout);
      },
      target,
    );
  }

  /**
   * @param {string} pageId
   * @param {{ key: string }} options
   * @param {ResolvedTab} [target]
   */
  async press(pageId, options, target) {
    return this.withPage(
      pageId,
      async () => {
        const { stdout } = await this.cli.run(['--raw', 'press', options.key]);
        return actionOutput(stdout);
      },
      target,
    );
  }

  /**
   * Navigate the page behind a page id, then restore the marker: a navigation
   * destroys the observer and the page's own title rewrite would drop the
   * marker, so the marker is re-applied and reported back.
   *
   * @param {string} pageId
   * @param {{ url: string }} options
   * @param {ResolvedTab} [target]
   */
  async goto(pageId, options, target) {
    return this.withPage(
      pageId,
      async () => {
        await this.cli.run(['--raw', 'goto', options.url], { timeoutMs: 60_000 });
        const { stdout } = await this.cli.run(['--raw', 'eval', titleMarkerExpression(pageId, this.marker)], {
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
      },
      target,
    );
  }

  /**
   * Reload the page behind a page id, implemented as "navigate to the same URL".
   *
   * `playwright-cli reload` is never used: measured on a real window, it reloads the
   * whole DSH page no matter which tab is current, and every sidebar browser page is
   * lost with it. `goto <current url>` reaches only the tab this id resolved to, so a
   * reload can never touch the shell.
   *
   * @param {string} pageId
   * @param {{ url: string }} target
   * @param {ResolvedTab} [resolved]
   */
  async reload(pageId, target, resolved) {
    return this.goto(pageId, { url: target.url }, resolved);
  }

  /**
   * @param {string} pageId
   * @param {{ level?: string }} [options]
   * @param {ResolvedTab} [target]
   */
  async console(pageId, options = {}, target) {
    return this.withPage(
      pageId,
      async () => {
        const args = ['--raw', 'console'];
        if (options.level) args.push(options.level);
        const { stdout } = await this.cli.run(args);
        return stdout.trim();
      },
      target,
    );
  }

  /**
   * @param {string} pageId
   * @param {{ code: string }} options
   * @param {ResolvedTab} [target]
   */
  async runCode(pageId, options, target) {
    return this.withPage(
      pageId,
      async () => {
        const { stdout } = await this.cli.run(['--raw', 'run-code', options.code], { timeoutMs: 120_000 });
        const output = stdout.trim();
        // A snippet may rewrite the document (page.setContent) or replace its head,
        // which discards the marker without any navigation that would re-run the
        // init script. Re-applying it here keeps the pageId resolvable.
        const { stdout: marked } = await this.cli.run(['--raw', 'eval', titleMarkerExpression(pageId, this.marker)]);
        const marker = parseMarkerOutput(marked);
        return { output, title: marker?.title, url: marker?.url };
      },
      target,
    );
  }

  /** Current tab index, or -1 when nothing is attached. */
  async listCurrent() {
    const { stdout } = await this.cli.run(['--raw', 'tab-list']);
    return { index: currentIndex(stdout) ?? -1, tabs: describeTabs(parseTabList(stdout).tabs) };
  }
}




