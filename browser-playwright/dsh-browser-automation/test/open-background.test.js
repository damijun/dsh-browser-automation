import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Runtime } from '../src/runtime.js';
import { sessionTag } from '../src/page-id.js';

/**
 * `browser_open` from a conversation that is not on screen.
 *
 * `ctx.sidebarRight.openTab` only writes to the mounted conversation, so a background
 * conversation goes through the per-session `openTabIn`, which fails *silently* when the
 * conversation's sidebar has never rendered. The host therefore (a) passes the calling
 * session down, (b) reports `background` so the model knows the page is invisible and
 * cannot be screenshotted, and (c) turns "no tab appeared" into an explanation instead of
 * a generic load failure.
 */

const SESSION = 'session-f5af60ee-1220-4ae4-86c3-cd000571ad26';
const APP_TAB = { index: 0, current: false, title: 'App', url: 'dsh-app://app/', text: '- 0: [App](dsh-app://app/)' };

function runtimeWith({ opened, tabsAfter, command }) {
  const runtime = new Runtime({ config: { timeoutMs: 5_000 } });
  runtime.cli = { workdir: () => '.', run: async () => ({ stdout: '""', stderr: '', code: 0 }) };
  runtime.bridge = {
    hasClient: () => true,
    clientState: () => 'live',
    request: async (kind, payload) => {
      if (kind === 'open-tab') {
        command.push(payload);
        return opened;
      }
      return {};
    },
  };
  runtime.attach = async () => ({ tabs: [APP_TAB] });
  runtime.injectMarker = async (tab) => ({ title: `Opened [${tab.pageId}]`, url: 'https://a.test/' });
  runtime.driver = {
    cli: runtime.cli,
    attached: true,
    listTabs: async () => ({ tabs: [APP_TAB, ...tabsAfter] }),
  };
  return runtime;
}

test('a background open reports itself as background', async () => {
  const command = [];
  const runtime = runtimeWith({
    opened: { tabId: null, background: true, url: 'https://a.test/' },
    tabsAfter: [
      { index: 1, current: false, title: 'Opened', url: 'https://a.test/', text: '- 1: [Opened](https://a.test/)' },
    ],
    command,
  });

  const value = await runtime.openPage({ sessionId: SESSION, url: 'https://a.test/' });
  assert.equal(value.background, true);
  // The handle carries the calling session's tag, so ownership can be checked later.
  assert.equal(value.pageId.split('-')[1], sessionTag(SESSION));
  // The calling session has to travel with the command: the page half decides between
  // openTab and openTabIn from it.
  assert.deepEqual(command, [{ url: 'https://a.test/', sessionId: SESSION }]);
  assert.equal(runtime.manager.get(value.pageId).sessionId, SESSION);
});

test('a foreground open stays background: false', async () => {
  const command = [];
  const runtime = runtimeWith({
    opened: { tabId: 'tab7', background: false, url: 'https://a.test/' },
    tabsAfter: [
      { index: 1, current: false, title: 'Opened', url: 'https://a.test/', text: '- 1: [Opened](https://a.test/)' },
    ],
    command,
  });
  const value = await runtime.openPage({ sessionId: SESSION, url: 'https://a.test/' });
  assert.equal(value.background, false);
});

test('a tab that never appears in a background open explains why', async () => {
  const runtime = runtimeWith({
    opened: { tabId: null, background: true, url: 'https://a.test/' },
    tabsAfter: [],
    command: [],
  });
  await assert.rejects(() => runtime.openPage({ sessionId: SESSION, url: 'https://a.test/', waitMs: 200 }), (error) => {
    assert.match(error.message, /not on screen/);
    assert.match(error.message, /Switch to that conversation/);
    return true;
  });
});

test('a tab that never appears in a foreground open keeps the load-failure advice', async () => {
  const runtime = runtimeWith({
    opened: { tabId: 'tab7', background: false, url: 'https://a.test/' },
    tabsAfter: [],
    command: [],
  });
  await assert.rejects(() => runtime.openPage({ sessionId: SESSION, url: 'https://a.test/', waitMs: 200 }), (error) => {
    assert.match(error.message, /may have failed to load/);
    assert.match(error.message, /browser_list/);
    return true;
  });
});

