import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { Runtime } from '../src/runtime.js';

/**
 * Screenshot routing: the cheap path when the page is already on screen, and the
 * "bring it to the front + capture with a generous deadline" path when it is not.
 * Both exist because Chromium only frames a laid-out, on-screen widget.
 */

const PAGE_ID = 'dshpg-abcdef-01234567';

function harness({ plan, hidden = false }) {
  const runtime = new Runtime({ config: { screenshotSettleMs: 0 } });
  const calls = [];
  const cli = {
    plan: undefined,
    workdir: () => os.tmpdir(),
    run: async () => ({ stdout: '', stderr: '', code: 0 }),
  };
  runtime.cli = cli;
  runtime.driver = {
    cli,
    resolve: async () => ({ index: 1, current: false, title: `Title [${PAGE_ID}]`, url: 'https://a.test/' }),
    screenshot: async () => {
      calls.push(['plain']);
      return { path: 'plain.png' };
    },
    screenshotToFile: async (pageId, options) => {
      calls.push(['toFile', options.fullPage === true, options.timeoutMs]);
      return { path: options.path };
    },
  };
  runtime.attach = async () => ({ tabs: [], ignored: [] });
  runtime.bridge = {
    clientState: () => 'live',
    hasClient: () => true,
    caps: () => ({ hidden: hidden === true }),
    request: async (kind) => (kind === 'prepare-capture' ? plan : {}),
  };
  return { runtime, calls };
}

test('a visible page is captured with the CLI command', async () => {
  const { runtime, calls } = harness({ plan: { visible: true, tabId: 'tab7', expanded: true, expandedNow: false } });
  const result = await runtime.screenshot({ pageId: PAGE_ID });
  assert.deepEqual(calls, [['plain']]);
  assert.match(result.path, /screenshot-.*\.png$/);
});

test('a hidden page is brought forward and captured with a long deadline', async () => {
  const { runtime, calls } = harness({ plan: { visible: false, tabId: 'tab7', expanded: true, expandedNow: false } });
  await runtime.screenshot({ pageId: PAGE_ID });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'toFile');
  assert.equal(calls[0][1], false, 'fullPage defaults to off');
  assert.equal(calls[0][2], 25_000);
});

test('fullPage is forwarded on the long-deadline path', async () => {
  const { runtime, calls } = harness({ plan: { visible: false, tabId: 'tab7', expanded: true, expandedNow: false } });
  await runtime.screenshot({ pageId: PAGE_ID, fullPage: true });
  assert.equal(calls[0][1], true);
});

test('an element target keeps the CLI path, because only it understands refs', async () => {
  const { runtime, calls } = harness({ plan: { visible: false, tabId: 'tab7', expanded: true, expandedNow: false } });
  await runtime.screenshot({ pageId: PAGE_ID, target: 'f1e13' });
  // The long-deadline path cannot take a snapshot ref, so it must not be chosen.
  assert.deepEqual(calls, [['plain']]);
});

test('without a tab id the plugin does not pretend to have focused anything', async () => {
  const { runtime, calls } = harness({ plan: { visible: false, tabId: null, expanded: true, expandedNow: false } });
  await runtime.screenshot({ pageId: PAGE_ID });
  // No focus happened, so the plain path (and its error hint) applies.
  assert.deepEqual(calls, [['plain']]);
});

test('a dead bridge still allows the cheap path', async () => {
  const { runtime, calls } = harness({ plan: undefined });
  runtime.bridge = { clientState: () => 'stale', hasClient: () => false, request: async () => assert.fail('no bridge call expected') };
  await runtime.screenshot({ pageId: PAGE_ID });
  assert.deepEqual(calls, [['plain']]);
});

/**
 * A minimized window has no frames at all, and every "is the tab visible" measurement
 * still says yes (the layout is unchanged). The page half now reports document.hidden,
 * so the capture can refuse immediately instead of timing out after 5s or 25s.
 */
test('a hidden window is refused before any command runs', async () => {
  const { runtime, calls } = harness({ plan: { visible: true, tabId: 'tab7' }, hidden: true });
  await assert.rejects(() => runtime.screenshot({ pageId: PAGE_ID }), (error) => {
    assert.match(error.message, /no frames/);
    assert.match(error.message, /browser_snapshot/);
    assert.doesNotMatch(error.message, /Open the sidebar/);
    return true;
  });
  assert.deepEqual(calls, [], 'no capture may be attempted');
});
