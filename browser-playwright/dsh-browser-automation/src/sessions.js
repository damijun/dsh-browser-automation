import { extractPageIds, sessionTag } from './page-id.js';

/**
 * In-memory page registry and the per-page mutex.
 *
 * This is a derived cache, not durable state: after a DSH restart both the CDP
 * session and every sidebar tab are gone, so persisting page ids would only
 * manufacture references to pages that no longer exist. What survives is the
 * token embedded in the page title, which `discover()` can re-read from
 * `tab-list` at any time — that is why a plugin reload does not orphan pages.
 */
export class SessionManager {
  constructor(options = {}) {
    this.log = options.log ?? (() => {});
    /** @type {Map<string, PageRecord>} */
    this.pages = new Map();
    /** @type {Map<string, Promise<unknown>>} */
    this.locks = new Map();
  }

  /**
   * @param {{ pageId: string, sessionId: string, url?: string, title?: string, source?: string }} record
   */
  register(record) {
    const entry = {
      pageId: record.pageId,
      sessionId: record.sessionId,
      url: record.url,
      title: record.title,
      source: record.source ?? 'open',
      createdAt: Date.now(),
    };
    this.pages.set(entry.pageId, entry);
    return entry;
  }

  /** @param {Record<string, unknown>} patch */
  update(pageId, patch) {
    const current = this.pages.get(pageId);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.pages.set(pageId, next);
    return next;
  }

  get(pageId) {
    return this.pages.get(pageId);
  }

  unregister(pageId) {
    return this.pages.delete(pageId);
  }

  bySession(sessionId) {
    return [...this.pages.values()].filter((page) => page.sessionId === sessionId);
  }

  all() {
    return [...this.pages.values()];
  }

  clear() {
    this.pages.clear();
    this.locks.clear();
  }

  /**
   * Serialize work for one page id. Different pages stay concurrent.
   *
   * @template T
   * @param {string} pageId
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async withLock(pageId, operation) {
    const previous = this.locks.get(pageId) ?? Promise.resolve();
    /** @type {Promise<T>} */
    const next = previous.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(pageId, settled);
    try {
      return await next;
    } finally {
      if (this.locks.get(pageId) === settled) this.locks.delete(pageId);
    }
  }
}

/**
 * @typedef {object} PageRecord
 * @property {string} pageId
 * @property {string} sessionId
 * @property {string | undefined} url
 * @property {string | undefined} title
 * @property {string} source
 * @property {number} createdAt
 */

/**
 * Merge the in-memory registry with what the live tab list actually shows.
 *
 * A tab is attributed to a session by the token in its title (the token carries
 * a digest of the owning session), so attribution keeps working for tabs this
 * plugin process never registered — after a plugin reload, or when two DSH
 * windows share one browser.
 *
 * @param {object} input
 * @param {import('./tab-list.js').TabEntry[]} input.tabs
 * @param {import('./sessions.js').SessionManager} input.manager
 * @param {import('node:crypto').Hash} input.sessionId current DSH session id
 * @param {boolean} [input.includeUnclaimed]
 */
export function discover({ tabs, manager, sessionId, includeUnclaimed = true }) {
  const ownTag = sessionId ? sessionTag(sessionId) : undefined;
  /** @type {Array<Record<string, unknown>>} */
  const rows = [];
  for (const tab of tabs) {
    const tokens = extractPageIds(`${tab.title} ${tab.url}`);
    if (tokens.length === 0) {
      if (!includeUnclaimed) continue;
      rows.push({
        index: tab.index,
        current: tab.current,
        title: tab.title,
        url: tab.url,
        pageId: null,
        session: tab.url.startsWith('dsh-app://') ? 'application' : 'unclaimed',
      });
      continue;
    }
    const primary = tokens[0];
    const record = manager.get(primary);
    const tag = primary.split('-')[1];
    rows.push({
      index: tab.index,
      current: tab.current,
      title: tab.title,
      url: tab.url,
      pageId: primary,
      session: record?.sessionId ?? (tag === ownTag ? sessionId : `session-tag:${tag}`),
      mine: record ? record.sessionId === sessionId : tag === ownTag,
      source: record?.source ?? 'discovered',
    });
  }
  return rows;
}
