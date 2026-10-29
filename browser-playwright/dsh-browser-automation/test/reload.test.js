import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Runtime, localFileHint, refuseApplicationTab } from '../src/runtime.js';

/**
 * `browser_reload` exists because reloading the DSH application page by hand took the
 * whole window down. The tool therefore has to make that target unreachable in two
 * independent ways, and both are pinned here.
 */

const PAGE_ID = 'dshpg-abcdef-01234567';

function harness({ url = 'https://example.test/' } = {}) {
  const calls = [];
  const runtime = new Runtime({ config: {} });
  runtime.cli = {
    plan: { file: 'x', prefix: [], nodeSource: 'test' },
    run: async (args) => {
      calls.push(['cli', ...args]);
      return { stdout: '"-"', stderr: '', code: 0 };
    },
  };
  const tab = { index: 3, current: false, title: `Page [${PAGE_ID}]`, url };
  runtime.driver = {
    attached: true,
    resolve: async () => tab,
    reload: async (pageId, target) => {
      calls.push(['driver.reload', pageId, target.index]);
      return { url: target.url, title: 'Reloaded title' };
    },
  };
  runtime.attach = async () => ({ tabs: [tab], ignored: [] });
  return { runtime, calls, tab };
}

test('reload acts on the resolved page and records the new title', async () => {
  const { runtime, calls } = harness();
  runtime.manager.register({ pageId: PAGE_ID, sessionId: 's1', url: 'https://example.test/', source: 'open' });

  const result = await runtime.reload({ pageId: PAGE_ID });
  assert.equal(result.pageId, PAGE_ID);
  assert.equal(result.index, 3);
  assert.equal(result.url, 'https://example.test/');
  assert.equal(result.title, 'Reloaded title');
  // The driver received the resolved tab, so the CLI reloads that page, not whatever
  // tab happened to be current.
  assert.deepEqual(calls, [['driver.reload', PAGE_ID, 3]]);
  assert.equal(runtime.manager.get(PAGE_ID)?.title, 'Reloaded title');
});

test('reload refuses the DSH application page even if a marker points at it', async () => {
  // The application page normally has no pageId at all; this fabricates the only case
  // the second guard exists for — a marker that leaked onto the application.
  const { runtime, calls } = harness({ url: 'dsh-app://app/' });
  await assert.rejects(() => runtime.reload({ pageId: PAGE_ID }), (error) => {
    assert.match(error.message, /cannot act on the DSH application page/);
    assert.match(error.message, /restarts the whole window/);
    return true;
  });
  assert.deepEqual(calls, [], 'nothing may run against the application page');
});

/**
 * The guard refuses the shell, not the test subject: a local static page over
 * ile: (or a data: document) is a legitimate target and must stay reachable.
 */
test('the guard refuses only the application scheme, not other test subjects', () => {
  assert.throws(() => refuseApplicationTab({ url: 'dsh-app://app/' }, 'browser_reload'), /dsh-app:/);
  assert.throws(() => refuseApplicationTab({ url: 'dsh-app://app/index.html' }, 'browser_reload'), /dsh-app:/);

  for (const url of [
    'file:///C:/Users/damijun/IdeaProjects/tool_calling/src/main/resources/static/index.html',
    'data:text/html,<h1>hi</h1>',
    'http://127.0.0.1:9222/json',
    'https://example.test/',
  ]) {
    assert.equal(refuseApplicationTab({ url }, 'browser_reload').url, url);
  }
});

/**
 * ile: is rejected by the sidebar browser itself, not by this plugin. The hint has
 * to say so and name the workaround, otherwise the failure reads as a plugin bug.
 */
test('a local-file failure explains the platform rule and the workaround', () => {
  const hint = localFileHint('file:///C:/Users/damijun/IdeaProjects/tool_calling/index.html');
  assert.match(hint, /refused by the DSH sidebar browser itself/);
  assert.match(hint, /python -m http\.server/);
  assert.match(localFileHint('data:text/html,hi'), /"data:"/);
  assert.equal(localFileHint('https://example.com/'), '');
  assert.equal(localFileHint('http://127.0.0.1:8000/x.html'), '');
});

test('a pageId that resolves to nothing fails before any reload', async () => {
  const runtime = new Runtime({ config: {} });
  runtime.cli = { plan: { file: 'x', prefix: [] }, run: async () => ({ stdout: '"[]"', stderr: '', code: 0 }) };
  let reloaded = false;
  runtime.driver = {
    attached: true,
    resolve: async () => {
      const error = new Error('PAGE_NOT_FOUND: no tab carries this page id');
      error.code = 'PAGE_NOT_FOUND';
      throw error;
    },
    reload: async () => {
      reloaded = true;
      return {};
    },
  };
  await assert.rejects(() => runtime.reload({ pageId: PAGE_ID }), /PAGE_NOT_FOUND/);
  assert.equal(reloaded, false);
});


