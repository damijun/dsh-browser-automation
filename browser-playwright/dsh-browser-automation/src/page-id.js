import { createHash, randomBytes } from 'node:crypto';

/**
 * A page identity is the stable contract this whole plugin exposes; the
 * playwright-cli tab index is a volatile intermediate that is re-derived on
 * every call.
 *
 * The token is embedded verbatim in the page title (`<title> [dshpg-…]`), which
 * is what `playwright-cli tab-list` prints. It must therefore be:
 *   - unique across every DSH session, including two sessions opening the same URL;
 *   - short enough to stay readable in a tab chip;
 *   - ASCII and free of the characters tab-list escaping has to handle.
 */
const PREFIX = 'dshpg';
const TOKEN = new RegExp(`${PREFIX}-[0-9a-f]{6}-[0-9a-f]{8}`, 'g');

/**
 * Deterministic short digest of the owning DSH session, so a page token is
 * traceable back to its session when reading a raw `tab-list` by hand.
 *
 * @param {string} sessionId
 */
export function sessionTag(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 6);
}

/**
 * Mint a fresh page id.
 *
 * @param {string} sessionId owning DSH session
 * @param {Set<string>} [taken] ids already in use, to guarantee no collision
 * @returns {string} e.g. `dshpg-1a2b3c-9f8e7d6c`
 */
export function newPageId(sessionId, taken) {
  for (;;) {
    const id = `${PREFIX}-${sessionTag(sessionId)}-${randomBytes(4).toString('hex')}`;
    if (!taken || !taken.has(id)) return id;
  }
}

/**
 * Every page token found in a string (a title, a URL, a whole tab-list).
 *
 * @param {string} text
 */
export function extractPageIds(text) {
  return String(text ?? '').match(TOKEN) ?? [];
}

/**
 * Expression evaluated inside the page (through `playwright-cli eval`) that
 * appends the marker to `document.title` and keeps it there.
 *
 * Pages own their title: SPA routers and notification badges rewrite it after
 * load (a Bilibili tab is the classic case), which would erase a one-shot
 * marker. A MutationObserver on `<head>` re-appends it; the guard inside
 * `tag()` makes that idempotent, so re-tagging cannot accumulate brackets.
 *
 * Any marker from an earlier claim is stripped first: two markers in one title
 * would make `resolveIndex` ambiguous for the previous owner.
 *
 * The whole thing is one IIFE because playwright-cli evaluates the argument as
 * `() => (<expr>)` — a bare statement list is a syntax error there.
 *
 * @param {string} pageId
 * @returns {string} JavaScript source for `playwright-cli eval`
 */
export function titleMarkerExpression(pageId) {
  const id = JSON.stringify(pageId);
  return [
    '(() => {',
    `  const id = ${id};`,
    '  const suffix = " [" + id + "]";',
    '  const previous = /\\[\\s*dshpg-[0-9a-f]{6}-[0-9a-f]{8}\\s*\\]/g;',
    '  const tag = () => {',
    '    try {',
    '      const current = String(document.title);',
    '      if (current.includes(id)) return;',
    '      document.title = current.replace(previous, "").replace(/\\s+$/, "") + suffix;',
    '    } catch (error) {}',
    '  };',
    '  tag();',
    '  try { if (window.__dshBrowserAutomation && window.__dshBrowserAutomation.dispose) window.__dshBrowserAutomation.dispose(); } catch (error) {}',
    '  let timer = 0;',
    '  const schedule = () => {',
    '    if (timer) return;',
    '    timer = setTimeout(() => { timer = 0; tag(); }, 60);',
    '  };',
    '  try {',
    '    const observer = new MutationObserver(schedule);',
    '    const target = document.head || document.documentElement;',
    '    if (target) observer.observe(target, { childList: true, subtree: true, characterData: true });',
    '    window.__dshBrowserAutomation = { pageId: id, dispose: () => { observer.disconnect(); if (timer) clearTimeout(timer); } };',
    '  } catch (error) {}',
    // An init script runs before the document has a <title>; keep trying briefly.
    '  let tries = 0;',
    '  const retry = setInterval(() => { tag(); if (++tries > 40) clearInterval(retry); }, 100);',
    '  return JSON.stringify({ pageId: id, title: document.title, url: location.href });',
    '})()',
  ].join('\n');
}

/**
 * Playwright code that makes the marker survive every future navigation.
 *
 * A navigation destroys the injected script and observer, so a marker applied
 * only through `eval` disappears the first time the page navigates — which is
 * most clicks on most sites. `page.addInitScript` is registered on the tab and
 * runs on each new document (verified across CLI invocations and across origins),
 * so the marker is re-applied without spending another round trip per action.
 *
 * @param {string} pageId
 * @returns {string} JavaScript for `playwright-cli run-code`
 */
export function installMarkerCode(pageId) {
  const script = titleMarkerExpression(pageId);
  return `async page => { await page.addInitScript(${JSON.stringify(script)}); return "installed" }`;
}

/**
 * Expression that reports the marker currently installed in a page, if any.
 */
export const probeMarkerExpression = [
  '(() => JSON.stringify({',
  '  title: document.title,',
  '  url: location.href,',
  '  readyState: document.readyState,',
  '  pageId: window.__dshBrowserAutomation ? window.__dshBrowserAutomation.pageId : null,',
  '}))()',
].join('\n');
