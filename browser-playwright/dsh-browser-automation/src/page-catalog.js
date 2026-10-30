/**
 * One `run-code` call that reads every page in the daemon's context.
 *
 * The mapping in this plugin is bidirectional and has to be cheap:
 *
 *   pageId      -> tab-list index   (resolveTabIndex)
 *   tab-list index -> pageId        (resolvePageId)
 *
 * Both directions need the same raw material — the page collection plus each page's
 * in-page identity — so they share this catalog instead of hitting `tab-list` and
 * parsing titles. Two facts make the index trustworthy:
 *
 *   - `page.context().pages()` order matches `tab-list` order. Verified live in this
 *     environment (Electron webviews, 4 tabs, app page at index 0); the migration plan
 *     (docs/run-code-migration-plan.md) records the same contract from an Edge test.
 *   - the identity is `window.__dshBrowserAutomation.pageId`, written by the init
 *     script, so it survives navigation and does not depend on the title marker.
 *
 * The title is still read, but only as a compatibility/diagnostic fallback (§3.3 of
 * the plan: the marker stays until every tool uses the in-page identity).
 *
 * Nothing here caches: an index is valid for one call only, because the user can close
 * or reorder tabs at any moment.
 *
 * @module page-catalog
 */

/**
 * Playwright snippet for `playwright-cli run-code`.
 *
 * `page` is the daemon's current tab, so `candidate === page` is exactly "this is the
 * current tab" — that is how `current` is known without a second CLI call.
 *
 * Each page gets one `evaluate`; a closed page is reported without one, and a page that
 * does not answer within 3s is reported as unreachable instead of hanging the catalog.
 * Per §4.6 of the plan a failing page never aborts the scan.
 */
export const PAGE_CATALOG_CODE = [
  'async page => {',
  '  const pages = page.context().pages();',
  '  const out = [];',
  '  for (let index = 0; index < pages.length; index += 1) {',
  '    const candidate = pages[index];',
  '    let closed = false;',
  '    try { closed = candidate.isClosed(); } catch (error) { closed = true; }',
  '    let info = null;',
  '    if (!closed) {',
  '      try {',
  '        info = await Promise.race([',
  '          candidate.evaluate(() => ({',
  '            pageId: (window.__dshBrowserAutomation && window.__dshBrowserAutomation.pageId) || null,',
  '            title: document.title,',
  '            url: location.href,',
  '          })),',
  '          new Promise((resolve) => setTimeout(() => resolve(null), 3000)),',
  '        ]);',
  '      } catch (error) { info = null; }',
  '    }',
  '    out.push({',
  '      index,',
  '      current: candidate === page,',
  '      closed,',
  '      pageId: info && typeof info.pageId === "string" && info.pageId ? info.pageId : null,',
  '      title: info && typeof info.title === "string" ? info.title : null,',
  '      url: info && typeof info.url === "string" ? info.url : null,',
  '    });',
  '  }',
  '  return JSON.stringify(out);',
  '}',
].join('\n');

/**
 * `playwright-cli` prints the run-code return value as JSON, and we return a JSON
 * string, so the value arrives double-encoded (`"[{...}]"`).
 *
 * @param {string} stdout
 * @returns {Array<{ index: number, current: boolean, closed: boolean, pageId: string | null, title: string | null, url: string | null }>}
 */
export function parsePageCatalog(stdout) {
  let value;
  try {
    value = JSON.parse(String(stdout ?? '').trim());
  } catch {
    throw new Error(`The page catalog came back unreadable (expected JSON, got: ${String(stdout ?? '').slice(0, 120) || '<empty>'})`);
  }
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(`The page catalog returned a string that is not JSON: ${value.slice(0, 120)}`);
    }
  }
  if (!Array.isArray(value)) {
    throw new Error(`The page catalog is not an array: ${JSON.stringify(value).slice(0, 120)}`);
  }
  return value
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry, fallbackIndex) => ({
      index: Number.isInteger(entry.index) ? entry.index : fallbackIndex,
      current: entry.current === true,
      closed: entry.closed === true,
      pageId: typeof entry.pageId === 'string' && entry.pageId !== '' ? entry.pageId : null,
      title: typeof entry.title === 'string' ? entry.title : null,
      url: typeof entry.url === 'string' ? entry.url : null,
    }))
    .sort((left, right) => left.index - right.index);
}

/**
 * Human-readable diagnostics for a failed lookup: which pages exist, with their ids.
 *
 * A PAGE_NOT_FOUND has to tell the model what to do next, and "the page is gone" is
 * useless without the list of pages that are still there.
 *
 * @param {Array<{ index: number, closed: boolean, pageId: string | null, url: string | null }>} catalog
 */
export function describeCatalog(catalog) {
  if (catalog.length === 0) return 'no pages are open in this browser session';
  return catalog
    .map((entry) => {
      const id = entry.closed ? 'closed' : entry.pageId ?? 'unmarked';
      return `${entry.index}: ${entry.url ?? '?'} (${id})`;
    })
    .join('; ');
}
