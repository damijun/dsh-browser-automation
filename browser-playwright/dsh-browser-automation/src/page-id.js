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
/**
 * The floating "shared with the agent" badge.
 *
 * Why in the page rather than on the tab chip: the sidebar's per-tab title slot is
 * keyed by pane id and only covers panes a plugin registers itself, so the browser
 * tabs DSH owns have no public decoration hook. The page is the one surface this
 * plugin fully controls, and an injected node survives every navigation because it is
 * part of the init script — the same mechanism the title marker uses.
 *
 * Two properties matter more than looks:
 *   - `pointer-events: none`, so it can never eat a click meant for the page;
 *   - a shadow root plus `all: initial`, so the host page's CSS cannot restyle or hide
 *     it and it cannot leak styles into the page.
 */
export const SHARED_BADGE_ID = '__dsh-ba-shared__';

/**
 * The badge a controlled page shows, as part of the marker expression.
 *
 * `badge: false` keeps the marker (title token) but paints nothing — that is the
 * `showSharedBadge: false` setting.
 *
 * @param {string} pageId
 * @param {{ badge?: boolean, text?: string }} [options]
 * @returns {string} JavaScript source for `playwright-cli eval`
 */
export function titleMarkerExpression(pageId, options = {}) {
  const id = JSON.stringify(pageId);
  const badge = options.badge !== false;
  const text = JSON.stringify(options.text ?? '正在与智能体共享');
  const badgeScript = badge
    ? [
        `  const BADGE_ID = ${JSON.stringify(SHARED_BADGE_ID)};`,
        `  const BADGE_TEXT = ${text};`,
        '  let badgeTimer = 0;',
        '  const dropBadge = () => {',
        '    try {',
        '      const node = document.getElementById(BADGE_ID);',
        '      if (node) node.remove();',
        '    } catch (error) {}',
        '  };',
        '  const paintBadge = () => {',
        '    try {',
        '      if (!document.body) return false;',
        '      if (document.getElementById(BADGE_ID)) return true;',
        '      const host = document.createElement("div");',
        '      host.id = BADGE_ID;',
        '      host.setAttribute("aria-hidden", "true");',
        '      host.style.cssText = "position:fixed!important;top:12px!important;right:12px!important;" +',
        '        "z-index:2147483647!important;pointer-events:none!important;contain:layout style!important";',
        '      const shadow = host.attachShadow({ mode: "open" });',
        '      const pill = document.createElement("div");',
        // Decorative and non-interactive: keep it out of the accessibility tree so a
        // page snapshot does not surface a ref the model could try to click.
        '      pill.setAttribute("role", "presentation");',
        '      pill.setAttribute("aria-hidden", "true");',
        '      pill.style.cssText = "all:initial;display:inline-flex;align-items:center;gap:6px;" +',
        '        "font:500 12px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;" +',
        '        "background:rgba(17,24,39,.86);border-radius:999px;padding:4px 12px 4px 9px;" +',
        '        "box-shadow:0 2px 10px rgba(0,0,0,.28);white-space:nowrap;user-select:none";',
        '      const dot = document.createElement("span");',
        '      dot.style.cssText = "all:initial;display:block;width:7px;height:7px;border-radius:50%;" +',
        '        "background:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.28)";',
        '      const label = document.createElement("span");',
        '      label.style.cssText = "all:initial;font:inherit;color:#fff";',
        '      label.setAttribute("aria-hidden", "true");',
        '      label.textContent = BADGE_TEXT;',
        '      pill.appendChild(dot);',
        '      pill.appendChild(label);',
        '      shadow.appendChild(pill);',
        '      document.body.appendChild(host);',
        '      return true;',
        '    } catch (error) { return false; }',
        '  };',
        '  const ensureBadge = () => {',
        '    if (paintBadge()) return;',
        '    if (badgeTimer) return;',
        // An init script can run before <body> exists; retry briefly instead of giving up.
        '    let tries = 0;',
        '    badgeTimer = setInterval(() => {',
        '      if (paintBadge() || ++tries > 40) { clearInterval(badgeTimer); badgeTimer = 0; }',
        '    }, 50);',
        '  };',
        '  ensureBadge();',
        '  const badgePresent = () => { try { return Boolean(document.getElementById(BADGE_ID)); } catch (error) { return null; } };',
      ]
    : ['  const dropBadge = () => {};', '  const badgePresent = () => false;'];
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
    ...badgeScript,
    '  let timer = 0;',
    '  const schedule = () => {',
    '    if (timer) return;',
    '    timer = setTimeout(() => { timer = 0; tag(); }, 60);',
    '  };',
    '  try {',
    '    const observer = new MutationObserver(schedule);',
    '    const target = document.head || document.documentElement;',
    '    if (target) observer.observe(target, { childList: true, subtree: true, characterData: true });',
    '    window.__dshBrowserAutomation = { pageId: id, dispose: () => { observer.disconnect(); if (timer) clearTimeout(timer); if (badgeTimer) clearInterval(badgeTimer); dropBadge(); } };',
    '  } catch (error) {}',
    // An init script runs before the document has a <title>; keep trying briefly.
    '  let tries = 0;',
    '  const retry = setInterval(() => { tag(); ensureBadge(); if (++tries > 40) clearInterval(retry); }, 100);',
    '  return JSON.stringify({ pageId: id, title: document.title, url: location.href, badge: badgePresent() });',
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
 * @param {{ badge?: boolean, text?: string }} [options]
 * @returns {string} JavaScript for `playwright-cli run-code`
 */
export function installMarkerCode(pageId, options = {}) {
  const script = titleMarkerExpression(pageId, options);
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



