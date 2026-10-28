/**
 * Parser for `playwright-cli tab-list` output.
 *
 * Real samples (verified against playwright-cli 0.1.22 with `--raw`):
 *
 *   - 0: (current) [Example Domain](https://example.com/)
 *   - 0: [A [b] (c) - pageId-s1-ab12cd34](https://example.com/)
 *   - 1: [Example Domain](https://example.org/)
 *
 * The format is a markdown list served by playwright's own output helper, so a
 * title may contain `[`, `]`, `(` and `)`. The `(current)` marker is a prefix on
 * the line; the index is the list number and is the only thing `tab-select`
 * accepts. Everything here is pure and synchronous so it can be unit tested
 * against captured text.
 *
 * @typedef {object} TabEntry
 * @property {number} index       zero-based tab index as printed by tab-list
 * @property {boolean} current    whether this line carried the (current) marker
 * @property {string} title       page title, verbatim (may contain brackets)
 * @property {string} url         page URL, verbatim
 * @property {string} text        the original line
 */

const LINE = /^\s*[-*]\s*(\d+)\s*:\s*(.*)$/;
const CURRENT = /^\(current\)\s*/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Split `<rest>` into title and URL at the last `](` whose right-hand side still
 * looks like a URL. Titles legitimately contain `](` (rare) and URLs legitimately
 * contain `)` (less rare), so prefer the right-most split that yields a scheme.
 *
 * @param {string} rest
 * @returns {{ title: string, url: string } | undefined}
 */
function splitLink(rest) {
  if (!rest.startsWith('[') || !rest.endsWith(')')) return undefined;
  let at = rest.lastIndexOf('](');
  while (at > 0) {
    const url = rest.slice(at + 2, -1);
    if (SCHEME.test(url)) return { title: rest.slice(1, at), url };
    at = rest.lastIndexOf('](', at - 1);
  }
  return undefined;
}

/**
 * Parse the whole of a tab-list response.
 *
 * Lines that do not parse are collected rather than thrown away: playwright-cli
 * appends trailing sections (for example `- [Snapshot](.playwright-cli/page.yml)`)
 * to some commands, and a future format change should be diagnosable instead of
 * silently yielding an empty list.
 *
 * @param {string} output
 * @returns {{ tabs: TabEntry[], ignored: string[] }}
 */
export function parseTabList(output) {
  /** @type {TabEntry[]} */
  const tabs = [];
  /** @type {string[]} */
  const ignored = [];
  for (const rawLine of String(output ?? '').split(/\r?\n/)) {
    if (rawLine.trim() === '') continue;
    const lineMatch = LINE.exec(rawLine);
    if (!lineMatch) {
      ignored.push(rawLine);
      continue;
    }
    const index = Number(lineMatch[1]);
    let rest = lineMatch[2];
    let current = false;
    const currentMatch = CURRENT.exec(rest);
    if (currentMatch) {
      current = true;
      rest = rest.slice(currentMatch[0].length);
    }
    const link = splitLink(rest.trim());
    if (!link) {
      ignored.push(rawLine);
      continue;
    }
    tabs.push({ index, current, title: link.title, url: link.url, text: rawLine });
  }
  return { tabs, ignored };
}

/**
 * Find the single tab whose title or URL contains `pageId`.
 *
 * Matching is a plain substring test on purpose: the marker is an opaque ASCII
 * token, and a regex over the whole line would have to re-derive the markdown
 * escaping rules this module exists to avoid.
 *
 * @param {TabEntry[]} tabs
 * @param {string} pageId
 * @returns {TabEntry[]} every match, in tab order
 */
export function matchPage(tabs, pageId) {
  if (!pageId) return [];
  return tabs.filter((tab) => tab.title.includes(pageId) || tab.url.includes(pageId));
}

/**
 * Resolve one page id to exactly one tab index.
 *
 * @param {string} output            raw tab-list text
 * @param {string} pageId
 * @returns {{ index: number, title: string, url: string, current: boolean, tabs: TabEntry[] }}
 * @throws {Error} `code: 'PAGE_NOT_FOUND'` or `code: 'AMBIGUOUS_PAGE'`
 */
export function resolveIndex(output, pageId) {
  const { tabs } = parseTabList(output);
  const matches = matchPage(tabs, pageId);
  if (matches.length === 1) {
    const [tab] = matches;
    return { index: tab.index, title: tab.title, url: tab.url, current: tab.current, tabs };
  }
  if (matches.length === 0) {
    const error = new Error(
      `pageId ${pageId} is not present in playwright-cli's tab list. ` +
        'The tab may have been closed by the user; open or claim a page again.',
    );
    Object.assign(error, { code: 'PAGE_NOT_FOUND', pageId, tabs });
    throw error;
  }
  const error = new Error(
    `pageId ${pageId} matched ${matches.length} tabs (indices ${matches
      .map((tab) => tab.index)
      .join(', ')}); refusing to guess.`,
  );
  Object.assign(error, {
    code: 'AMBIGUOUS_PAGE',
    pageId,
    matches: matches.map((tab) => ({ index: tab.index, title: tab.title, url: tab.url })),
    tabs,
  });
  throw error;
}

/**
 * Index of the tab playwright-cli currently drives.
 *
 * @param {string} output
 * @returns {number | undefined}
 */
export function currentIndex(output) {
  const { tabs } = parseTabList(output);
  const current = tabs.find((tab) => tab.current);
  return current?.index;
}

/**
 * Describe tabs for a model-facing tool result without leaking the whole line.
 *
 * @param {TabEntry[]} tabs
 */
export function describeTabs(tabs) {
  return tabs.map((tab) => ({
    index: tab.index,
    current: tab.current,
    title: tab.title,
    url: tab.url,
  }));
}
