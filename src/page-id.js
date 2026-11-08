import { createHash, randomBytes } from 'node:crypto';

/**
 * A page identity is the stable contract this whole plugin exposes; the
 * playwright-cli tab index is a volatile intermediate that is re-derived on
 * every call.
 *
 * The identity lives in exactly one place: the page's own `window`, as
 * `window.__dshBrowserAutomation.pageId`. The marker expression writes it, an
 * init script re-writes it after every navigation, and `src/page-catalog.js`
 * reads it back through `run-code` (the Host half is the only half that can run
 * code inside the page). Nothing is written into `document.title` or anywhere
 * else a page renders, so the sidebar tab keeps the page's own title.
 *
 * The id must be unique across every DSH session (including two sessions opening
 * the same URL) and traceable back to its owner: the six hexadecimal characters
 * after `dshpg-` are a digest of the owning DSH session, which is what keeps
 * attribution working when the Host's in-memory registry is empty.
 */
const PREFIX = 'dshpg';

/**
 * Deterministic short digest of the owning DSH session, so a page id carries the
 * answer to "which conversation owns this page" even when the registry lost it.
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
 * Expression evaluated inside the page (through `playwright-cli eval`, or as an
 * init script) that installs the page's identity on its `window` object.
 *
 * The page owns this object: nothing in the plugin ever deletes it, and a page
 * that rewrites its own title cannot lose it. Re-running the expression is
 * idempotent — it replaces the object with the same id.
 *
 * The whole thing is one IIFE because playwright-cli evaluates the argument as
 * `() => (<expr>)` — a bare statement list is a syntax error there.
 *
 * @param {string} pageId
 * @returns {string} JavaScript source for `playwright-cli eval`
 */
export function pageMarkerExpression(pageId) {
  const id = JSON.stringify(pageId);
  return [
    '(() => {',
    `  const id = ${id};`,
    '  try { window.__dshBrowserAutomation = { pageId: id }; } catch (error) {}',
    '  return JSON.stringify({ pageId: id, title: document.title, url: location.href });',
    '})()',
  ].join('\n');
}

/**
 * Playwright code that makes the identity survive every future navigation.
 *
 * A navigation creates a new document, so an identity written only through
 * `eval` disappears on the next click. `page.addInitScript` is registered on the
 * tab and runs in every new document (verified across CLI invocations and across
 * origins), so the field is re-installed without spending a round trip per
 * action.
 *
 * @param {string} pageId
 * @returns {string} JavaScript for `playwright-cli run-code`
 */
export function installMarkerCode(pageId) {
  const script = pageMarkerExpression(pageId);
  return `async page => { await page.addInitScript(${JSON.stringify(script)}); return "installed" }`;
}

/**
 * Expression that reports the identity currently installed in a page, if any.
 * Used as a read-back after a navigation or an arbitrary snippet.
 */
export const probeMarkerExpression = [
  '(() => JSON.stringify({',
  '  title: document.title,',
  '  url: location.href,',
  '  readyState: document.readyState,',
  '  pageId: window.__dshBrowserAutomation ? window.__dshBrowserAutomation.pageId : null,',
  '}))()',
].join('\n');
