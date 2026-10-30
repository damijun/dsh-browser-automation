import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Runtime, requireBridge, samePage } from '../src/runtime.js';

/**
 * The plugin has exactly two start modes and no third, implicit one:
 *   browser_open  → the DSH page creates a tab (needs the page half)
 *   browser_claim → take over the page the user is looking at (needs the page half
 *                   plus an open sidebar with a visible browser tab)
 * An unreachable page half fails loudly instead of reusing an arbitrary tab,
 * because nothing in the tool can prove which tab the user meant.
 */

const tab = (index, url, title, current = false) => ({
  index,
  current,
  url,
  title,
  text: `- ${index}: ${current ? '(current) ' : ''}[${title}](${url})`,
});

function liveBridge(caps) {
  return {
    clientState: () => 'live',
    hasClient: () => true,
    request: async (kind) => {
      if (kind === 'ping') return caps;
      return { tabId: 'tab9' };
    },
  };
}

/** A Runtime with the CLI and tab listing stubbed out, so only the logic runs. */
function harness({ bridge, tabs = [], marker = 'Marked' }) {
  const runtime = new Runtime({ config: {} });
  runtime.bridge = bridge;
  const cliCalls = [];
  const cli = {
    run: async (args) => {
      cliCalls.push(args);
      return { stdout: '""', stderr: '', code: 0 };
    },
    plan: undefined,
  };
  runtime.cli = cli;
  // A truthy driver keeps `ensureDriver()` from building a real CliBridge (and
  // therefore from shelling out to playwright-cli during a unit test).
  runtime.driver = { cli, listTabs: async () => ({ tabs, ignored: [] }) };
  runtime.attach = async () => ({ tabs, ignored: [] });
  // The real installer selects the tab itself, inside the driver's CLI lock, so the
  // contract worth asserting is "which tab was handed to it" — not a raw tab-select.
  const marked = [];
  runtime.injectMarker = async (target) => {
    marked.push({ index: target.index, url: target.url, pageId: target.pageId });
    return { title: `${marker} [${target.pageId}]`, url: target.url };
  };
  return { runtime, cliCalls, marked };
}

test('requireBridge names the tool and both recovery steps, and passes when live', () => {
  const live = { clientState: () => 'live' };
  assert.doesNotThrow(() => requireBridge(live, 'browser_open'));

  for (const [state, hint] of [
    ['off', /no page bridge mounted/],
    ['never', /no DSH page has connected/],
    ['stale', /has gone quiet/],
  ]) {
    const bridge = { clientState: () => state };
    assert.throws(
      () => requireBridge(bridge, 'browser_claim'),
      (error) => {
        assert.match(error.message, /^browser_claim needs the DSH page/);
        assert.match(error.message, hint);
        assert.match(error.message, /Reload the DSH window/);
        assert.match(error.message, /browser_status/);
        return true;
      },
    );
  }
  // No bridge object at all is the same failure, not a crash.
  assert.throws(() => requireBridge(undefined, 'browser_open'), /no page bridge mounted/);
});

test('browser_open fails before touching the CLI when the page half is down', async () => {
  const { runtime, cliCalls } = harness({ bridge: undefined });
  await assert.rejects(() => runtime.openPage({ sessionId: 's1', url: 'https://a.test/' }), (error) => {
    assert.match(error.message, /browser_open needs the DSH page/);
    return true;
  });
  // No CLI work at all: no attach, no tab-select, no goto — nothing to undo.
  assert.deepEqual(cliCalls, []);
  assert.equal(runtime.cli.plan, undefined);
});

test('browser_open never falls back to navigating an existing tab', async () => {
  const { runtime, cliCalls } = harness({
    bridge: undefined,
    tabs: [tab(1, 'https://user.test/form', 'User form')],
  });
  await assert.rejects(() => runtime.openPage({ sessionId: 's1', url: 'https://a.test/' }));
  // The old degraded path would have selected the user's tab and issued a goto.
  assert.deepEqual(cliCalls, []);
  // Nothing was registered, so no pageId claims to point at the user's tab.
  assert.deepEqual(runtime.manager.all(), []);
});

test('browser_list warns when the sidebar shows a page the CLI cannot see', async () => {
  const bridge = liveBridge({ visibleUrl: 'https://www.runoob.com/deepseek-harness/x.html', activeTabId: 'tab143' });
  const tabs = [tab(0, 'dsh-app://app/', 'DeepSeek Harness')];
  const { runtime } = harness({ bridge, tabs });
  const result = await runtime.listPages({ sessionId: 's1' });
  assert.equal(result.count, 0);
  assert.match(result.warning, /only tracks sidebar pages created after it attached/);
});

test('browser_list stays quiet when the CLI does list a web page', async () => {
  const bridge = liveBridge({ visibleUrl: 'https://a.test/', activeTabId: 'tab7' });
  const tabs = [tab(0, 'dsh-app://app/', 'DeepSeek Harness'), tab(1, 'https://a.test/', 'Page')];
  const { runtime } = harness({ bridge, tabs });
  const result = await runtime.listPages({ sessionId: 's1' });
  assert.equal(result.warning, undefined);
});

test('claim fails with the sidebar instruction when no page is visible', async () => {
  const bridge = liveBridge({ visibleUrl: null, activeTabId: null });
  const { runtime } = harness({ bridge, tabs: [tab(1, 'https://a.test/', 'A')] });
  await assert.rejects(() => runtime.claimPage({ sessionId: 's1' }), (error) => {
    assert.match(error.message, /sidebar must be open/);
    assert.match(error.message, /collapsed sidebar/);
    return true;
  });
});

/**
 * A page opened before playwright-cli attached is exposed by Electron over CDP but never
 * adopted by the CLI. Waiting cannot fix it, so the message must say that instead of
 * "it may still be loading".
 */
test('claim explains a page the CLI never adopted instead of blaming loading', async () => {
  const bridge = liveBridge({ visibleUrl: 'https://www.runoob.com/deepseek-harness/x.html', activeTabId: 'tab143' });
  const tabs = [tab(0, 'dsh-app://app/', 'DeepSeek Harness')];
  const { runtime } = harness({ bridge, tabs });
  await assert.rejects(() => runtime.claimPage({ sessionId: 's1' }), (error) => {
    assert.match(error.message, /only tracks sidebar pages created after it attached/);
    assert.match(error.message, /Close that tab and open the same URL again/);
    assert.doesNotMatch(error.message, /may still be loading/);
    return true;
  });
});

test('claim fails when the visible page is not in the CLI tab list yet', async () => {
  const bridge = liveBridge({ visibleUrl: 'https://loading.test/', activeTabId: 'tab5' });
  const { runtime } = harness({ bridge, tabs: [tab(1, 'https://a.test/', 'A')] });
  await assert.rejects(() => runtime.claimPage({ sessionId: 's1' }), (error) => {
    assert.match(error.message, /not in playwright-cli's tab list yet/);
    assert.match(error.message, /https:\/\/loading\.test\//);
    return true;
  });
});

test('claim takes over the visible page even when the CLI current tab is elsewhere', async () => {
  const pageId = 'dshpg-abcdef-01234567';
  const oldPageId = 'dshpg-111111-22222222';
  const bridge = liveBridge({ visibleUrl: 'https://visible.test/x', activeTabId: 'tab7' });
  const tabs = [
    tab(0, 'dsh-app://app/', 'DSH', true),
    tab(1, `https://other.test/ [${oldPageId}]`, 'Other'),
    tab(2, 'https://visible.test/x', 'Visible'),
  ];
  const { runtime, cliCalls, marked } = harness({ bridge, tabs, marker: 'Visible page' });
  runtime.manager.register({ pageId: oldPageId, sessionId: 's1', url: 'https://other.test/', source: 'open' });

  const claimed = await runtime.claimPage({ sessionId: 's1', note: 'user logged in' });
  assert.match(claimed.pageId, /^dshpg-[0-9a-f]{6}-[0-9a-f]{8}$/);
  assert.equal(claimed.url, 'https://visible.test/x');
  // The returned title is the tab's own title before the marker was installed.
  assert.equal(claimed.title, 'Visible');
  assert.equal(claimed.note, 'user logged in');
  assert.equal(claimed.replacedExistingPageId, undefined);
  // Claiming hands the visible tab (index 2) to the installer, which selects it under
  // the driver's CLI lock; no standalone tab-select may happen out here.
  assert.deepEqual(marked, [{ index: 2, url: 'https://visible.test/x', pageId: claimed.pageId }]);
  assert.ok(
    cliCalls.every((call) => !call.includes('tab-select')),
    'claim must not select outside the driver lock',
  );
  assert.equal(runtime.manager.get(claimed.pageId).tabId, 'tab7');
});

test('claim replaces a previous marker and unregisters the old pageId', async () => {
  const oldPageId = 'dshpg-111111-22222222';
  const bridge = liveBridge({ visibleUrl: 'https://visible.test/x', activeTabId: 'tab7' });
  const tabs = [tab(1, 'https://visible.test/x', `Visible page [${oldPageId}]`)];
  const { runtime } = harness({ bridge, tabs, marker: 'Visible page' });
  runtime.manager.register({ pageId: oldPageId, sessionId: 's1', url: 'https://visible.test/x', source: 'open' });

  const claimed = await runtime.claimPage({ sessionId: 's1' });
  assert.equal(claimed.replacedExistingPageId, oldPageId);
  assert.equal(runtime.manager.get(oldPageId), undefined);
  assert.notEqual(claimed.pageId, oldPageId);
});

test('claim matches the visible URL across a trailing slash and a hash', async () => {
  const bridge = liveBridge({ visibleUrl: 'https://visible.test/x/', activeTabId: 'tab7' });
  const tabs = [tab(1, 'https://visible.test/x#section', 'Visible')];
  const { runtime } = harness({ bridge, tabs });
  assert.equal(samePage(tabs[0].url, 'https://visible.test/x/'), true);
  const claimed = await runtime.claimPage({ sessionId: 's1' });
});

test('claim refuses to run when the page half went quiet', async () => {
  const { runtime } = harness({
    bridge: { clientState: () => 'stale', hasClient: () => false, request: async () => ({}) },
    tabs: [tab(1, 'https://a.test/', 'A')],
  });
  await assert.rejects(() => runtime.claimPage({ sessionId: 's1' }), /has gone quiet/);
});




