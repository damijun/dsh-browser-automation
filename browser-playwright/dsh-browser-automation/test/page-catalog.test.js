import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PageDriver } from '../src/driver.js';
import { parsePageCatalog, describeCatalog, PAGE_CATALOG_CODE } from '../src/page-catalog.js';

/**
 * Stage B of docs/run-code-migration-plan.md: two explicit mapping directions and a
 * single executor.
 *
 *   resolveTabIndex(pageId) -> tab-list index
 *   resolvePageId(tabIndex) -> pageId
 *
 * The index is only meaningful for one call, so every test asserts that the catalog is
 * re-read rather than cached. Per §4.6 the first match wins and a duplicate never
 * becomes an error; per §3.3 the title marker is a *reported* fallback, not a silent
 * second attempt.
 */

const ID_A = 'dshpg-aaaaaa-11111111';
const ID_B = 'dshpg-bbbbbb-22222222';

function catalogOutput(entries) {
  // Real run-code output is double-encoded: the script returns a JSON string.
  return JSON.stringify(JSON.stringify(entries));
}

function driverWith(entries, overrides = {}) {
  let calls = 0;
  const cli = {
    workdir: () => '.',
    run: async (args) => {
      calls += 1;
      if (args.includes('run-code')) return { stdout: catalogOutput(entries), stderr: '', code: 0 };
      return { stdout: '""', stderr: '', code: 0 };
    },
  };
  const driver = new PageDriver(cli, { cdpUrl: 'http://127.0.0.1:9222', log: () => {} });
  driver.ensureAttached = async () => ({ tabs: [], ignored: [] });
  return Object.assign(driver, overrides, { calls: () => calls });
}

const THREE_PAGES = [
  { index: 0, current: false, closed: false, pageId: null, title: 'App', url: 'dsh-app://app/' },
  { index: 1, current: true, closed: false, pageId: ID_A, title: `Page A [${ID_A}]`, url: 'https://a.test/' },
  { index: 2, current: false, closed: false, pageId: ID_B, title: `Page B [${ID_B}]`, url: 'https://b.test/' },
];

test('the catalog parser accepts the double-encoded run-code output', () => {
  const parsed = parsePageCatalog(catalogOutput(THREE_PAGES));
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[1], {
    index: 1,
    current: true,
    closed: false,
    pageId: ID_A,
    title: `Page A [${ID_A}]`,
    url: 'https://a.test/',
  });
  // A plain array (CLI printed the value directly) parses too.
  assert.equal(parsePageCatalog(JSON.stringify(THREE_PAGES)).length, 3);
});

test('an unreadable catalog fails with the raw text in the message', () => {
  assert.throws(() => parsePageCatalog('not json at all'), /unreadable.*not json at all/s);
  assert.throws(() => parsePageCatalog('"just a string"'), /string that is not JSON/);
  assert.throws(() => parsePageCatalog('{"pages":[]}'), /not an array/);
});

test('describeCatalog names the ids that do exist, which is what a failure needs', () => {
  const text = describeCatalog(parsePageCatalog(catalogOutput(THREE_PAGES)));
  assert.match(text, /0: dsh-app:\/\/app\/ \(unmarked\)/);
  assert.match(text, new RegExp(`1: https://a\\.test/ \\(${ID_A}\\)`));
});

test('pageId -> index uses the in-page identity, not the title', async () => {
  const retitled = THREE_PAGES.map((entry) =>
    entry.pageId ? { ...entry, title: 'the page renamed itself' } : entry,
  );
  const driver = driverWith(retitled);
  const hit = await driver.resolveTabIndex(ID_B);
  assert.equal(hit.index, 2);
  assert.equal(hit.current, false);
  assert.equal(hit.addressedBy, 'page');
});

test('the title marker is a reported fallback, and the log says so', async () => {
  const legacy = THREE_PAGES.map((entry) => (entry.pageId === ID_A ? { ...entry, pageId: null } : entry));
  const logged = [];
  const driver = driverWith(legacy, { log: (message) => logged.push(message) });
  const hit = await driver.resolveTabIndex(ID_A);
  assert.equal(hit.index, 1);
  assert.equal(hit.addressedBy, 'title');
  assert.match(logged.join('\n'), /no in-page identity; using the title marker at index 1/);
});

test('a missing page fails with PAGE_NOT_FOUND and the open-pages list', async () => {
  const driver = driverWith(THREE_PAGES);
  await assert.rejects(() => driver.resolveTabIndex('dshpg-cccccc-33333333'), (error) => {
    assert.equal(error.code, 'PAGE_NOT_FOUND');
    assert.match(error.message, new RegExp(ID_A));
    assert.match(error.message, /browser_claim it again/);
    return true;
  });
});

test('a closed page is skipped even if its identity matches', async () => {
  const withClosed = [...THREE_PAGES, { index: 3, current: false, closed: true, pageId: ID_B, title: 'B old', url: 'https://b.test/old' }];
  const driver = driverWith(withClosed);
  const hit = await driver.resolveTabIndex(ID_B);
  assert.equal(hit.index, 2, 'the live copy wins, the closed duplicate is ignored');
});

test('index -> pageId reads the in-page identity, then the title marker', async () => {
  const driver = driverWith(THREE_PAGES);
  const second = await driver.resolvePageId(2);
  assert.equal(second.pageId, ID_B);
  assert.equal(second.addressedBy, 'page');

  const legacy = THREE_PAGES.map((entry) => (entry.pageId === ID_A ? { ...entry, pageId: null } : entry));
  const viaTitle = await driverWith(legacy).resolvePageId(1);
  assert.equal(viaTitle.pageId, ID_A);
  assert.equal(viaTitle.addressedBy, 'title');
});

test('index -> pageId rejects a bad index and a closed tab', async () => {
  const driver = driverWith(THREE_PAGES);
  await assert.rejects(() => driver.resolvePageId(-1), /not a tab index/);
  await assert.rejects(() => driver.resolvePageId(9), (error) => {
    assert.equal(error.code, 'PAGE_NOT_FOUND');
    assert.match(error.message, /no tab at index 9/);
    return true;
  });
  const withClosed = [{ index: 0, current: false, closed: true, pageId: null, title: null, url: null }];
  await assert.rejects(() => driverWith(withClosed).resolvePageId(0), (error) => {
    assert.equal(error.code, 'PAGE_CLOSED');
    return true;
  });
});

test('the index is never cached: every mapping re-reads the catalog', async () => {
  const driver = driverWith(THREE_PAGES);
  await driver.resolveTabIndex(ID_A);
  await driver.resolveTabIndex(ID_A);
  await driver.resolvePageId(1);
  assert.equal(driver.calls(), 3, 'three catalogues, three run-code calls');
});

test('executeOnResolvedTab does not re-resolve a tab resolved in the same call', async () => {
  let resolved = 0;
  const driver = driverWith(THREE_PAGES, {
    resolvePage: async () => {
      resolved += 1;
      return { index: 1, current: true, title: '', url: '' };
    },
    resolveTabIndex: async () => {
      resolved += 1;
      return { index: 1, current: true, title: '', url: '' };
    },
  });
  const tab = { index: 1, current: true, title: '', url: '' };
  const result = await driver.executeOnResolvedTab(ID_A, tab, async () => 'done');
  assert.equal(result, 'done');
  assert.equal(resolved, 0, 'no resolution when the tab is already known');
});

test('executeOnResolvedTab re-resolves once after a failure and then gives up', async () => {
  let resolved = 0;
  const driver = driverWith(THREE_PAGES, {
    resolvePage: async () => {
      resolved += 1;
      return { index: 1, current: true, title: '', url: '' };
    },
  });
  const tab = { index: 1, current: true, title: '', url: '' };
  await assert.rejects(() =>
    driver.executeOnResolvedTab(ID_A, tab, async () => {
      throw new Error('tab went away');
    }),
  );
  assert.equal(resolved, 1, 'exactly one re-resolution, not a loop');
});

test('the catalog script stays a single run-code argument', () => {
  assert.match(PAGE_CATALOG_CODE, /^async page => \{/);
  assert.match(PAGE_CATALOG_CODE, /page\.context\(\)\.pages\(\)/);
  assert.match(PAGE_CATALOG_CODE, /window\.__dshBrowserAutomation/);
  assert.match(PAGE_CATALOG_CODE, /candidate === page/, 'current is derived, not guessed');
  assert.match(PAGE_CATALOG_CODE, /setTimeout\(\(\) => resolve\(null\), 3000\)/, 'a hung page cannot hang the catalog');
});

/**
 * ttach opens a new CDP session, and playwright-cli only adopts sidebar pages
 * created while attached — so a redundant attach strands every page the user already
 * has open (measured: four sidebar tabs on screen, 	ab-list left with the app page
 * only). The probe therefore has to run before every attach, including on a fresh
 * driver.
 */
function driverWithTabs(behaviour, calls) {
  const cli = {
    workdir: () => '.',
    run: async (args) => {
      calls.push(args.join(' '));
      if (args.includes('tab-list')) return behaviour.tabs();
      if (args.includes('attach')) return behaviour.attach();
      return { stdout: '""', stderr: '', code: 0 };
    },
  };
  return new PageDriver(cli, { cdpUrl: 'http://127.0.0.1:9222', log: () => {} });
}

const TAB_LIST = '- 0: (current) [App](dsh-app://app/)\n- 1: [Page](https://a.test/)';

test('a live session is adopted instead of re-attached', async () => {
  const calls = [];
  const driver = driverWithTabs(
    { tabs: async () => ({ stdout: TAB_LIST, stderr: '', code: 0 }), attach: async () => { throw new Error('must not attach'); } },
    calls,
  );
  const listing = await driver.ensureAttached();
  assert.equal(listing.tabs.length, 2);
  assert.equal(driver.attached, true);
  assert.deepEqual(calls, ['--raw tab-list'], 'no attach command when the session is alive');
});

test('a session with no attached browser attaches, then lists', async () => {
  const calls = [];
  let listed = 0;
  const driver = driverWithTabs(
    {
      tabs: async () => {
        listed += 1;
        if (listed === 1) throw new Error('browser is not open');
        return { stdout: TAB_LIST, stderr: '', code: 0 };
      },
      attach: async () => ({ stdout: 'attached', stderr: '', code: 0 }),
    },
    calls,
  );
  const listing = await driver.ensureAttached();
  assert.equal(listing.tabs.length, 2);
  assert.match(listing.attachOutput, /attached/);
  assert.deepEqual(calls, ['--raw tab-list', '--raw attach --cdp=http://127.0.0.1:9222', '--raw tab-list']);
});

test('force still performs a fresh attach for diagnostics', async () => {
  const calls = [];
  const driver = driverWithTabs(
    { tabs: async () => ({ stdout: TAB_LIST, stderr: '', code: 0 }), attach: async () => ({ stdout: '', stderr: '', code: 0 }) },
    calls,
  );
  await driver.ensureAttached({ force: true });
  assert.ok(calls.includes('--raw attach --cdp=http://127.0.0.1:9222'));
});
