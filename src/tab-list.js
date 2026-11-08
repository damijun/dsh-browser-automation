/**
 * Parser for `playwright-cli tab-list` output.
 *
 * Real samples (verified against playwright-cli 0.1.22 with `--raw`):
 *
 *   - 0: (current) [Example Domain](https://example.com/)
 *   - 0: [A [b] (c)](https://example.com/)
 *   - 1: [Example Domain](https://example.org/)
 *
 * The format is a markdown list served by playwright's own output helper, so a
 * title may contain `[`, `]`, `(` and `)`. The `(current)` marker is a prefix on
 * the line; the index is the list number and is the only thing `tab-select`
 * accepts. Everything here is pure and synchronous so it can be unit tested
 * against captured text.
 *
 * This module parses what playwright-cli prints; it does not identify pages.
 * Identity comes from the in-page field (see page-catalog.js).
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
