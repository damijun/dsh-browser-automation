import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Runtime } from '../src/runtime.js';

/**
 * Closing a sidebar browser tab must be a UI action.
 *
 * `playwright-cli tab-close` only destroys the CDP target, which leaves the DSH
 * sidebar tab behind as an empty shell ("页面加载失败；请刷新重试或在系统浏览器中打开。")
 * that keeps focus. Only `ctx.sidebarRight.close(tabId)` removes the tab, so
 * browser_close goes through the page bridge and never touches the CLI.
 */

const PAGE_ID = 'dshpg-abcdef-01234567';

function harness({ bridge }) {
  const runtime = new Runtime({ config: {} });
  const cliCalls = [];
  const cli = {
    plan: undefined,
    workdir: () => '.',
    run: async (args) => {
      cliCalls.push(args);
      return { stdout: '""', stderr: '', code: 0 };
    },
  };
  runtime.cli = cli;
  runtime.driver = { cli, listTabs: async () => ({ tabs: [], ignored: [] }) };
  runtime.attach = async () => ({ tabs: [], ignored: [] });
  runtime.bridge = bridge;
  runtime.manager.register({ pageId: PAGE_ID, sessionId: 's1', url: 'https://a.test/', source: 'open' });
  return { runtime, cliCalls };
}

const live = (response) => ({
  clientState: () => 'live',
  hasClient: () => true,
  request: async () => response,
});

test('closing removes the tab through the page half, not through the CLI', async () => {
  const { runtime, cliCalls } = harness({ bridge: live({ closed: true, tabId: 'tab7' }) });
  const result = await runtime.closePage({ pageId: PAGE_ID });
  assert.equal(result.closed, true);
  assert.equal(result.tabId, 'tab7');
  // The CLI must stay out of this: `tab-close` leaves a broken tab behind.
  assert.deepEqual(cliCalls, []);
  // And the registry must forget the page.
  assert.equal(runtime.manager.get(PAGE_ID), undefined);
});

test('a page half that cannot find the tab reports why instead of pretending', async () => {
  const { runtime, cliCalls } = harness({
    bridge: live({ closed: false, tabId: null, reason: 'no sidebar tab chip carries this page' }),
  });
  await assert.rejects(() => runtime.closePage({ pageId: PAGE_ID }), (error) => {
    assert.match(error.message, /did not close this tab/);
    assert.match(error.message, /no sidebar tab chip carries this page/);
    assert.match(error.message, /leaves an empty tab behind/);
    return true;
  });
  assert.deepEqual(cliCalls, []);
  // A failed close must NOT unregister the page: it may still be there.
  assert.notEqual(runtime.manager.get(PAGE_ID), undefined);
});

test('a close without the page half fails instead of falling back to the CLI', async () => {
  const { runtime, cliCalls } = harness({ bridge: { clientState: () => 'never', hasClient: () => false } });
  await assert.rejects(() => runtime.closePage({ pageId: PAGE_ID }), /browser_close needs the DSH page/);
  assert.deepEqual(cliCalls, []);
  assert.notEqual(runtime.manager.get(PAGE_ID), undefined);
});

test('an invalid page handle is rejected before any work', async () => {
  const { runtime, cliCalls } = harness({ bridge: live({ closed: true, tabId: 'tab7' }) });
  await assert.rejects(() => runtime.closePage({ pageId: 'nope' }), /is not a page handle/);
  assert.deepEqual(cliCalls, []);
});
