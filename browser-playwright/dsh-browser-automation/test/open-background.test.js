import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Runtime } from '../src/runtime.js';
import { sessionTag } from '../src/page-id.js';

/**
 * Host-side behaviour of a background open (`browser_open` from a conversation that is
 * not on screen): the tab is created by the page half through `openTabIn`, the host still
 * has to find it in playwright-cli's tab list, and a tab that never becomes a CLI target
 * must be rolled back instead of left behind.
 *
 * The page half's own preconditions (the conversation's sidebar is mounted, a webview was
 * created) live in `client.js` and are exercised live; here we pin the host contract.
 */

const SESSION = 'session-f5af60ee-1220-4ae4-86c3-cd000571ad26';
const APP_TAB = { index: 0, current: false, title: 'App', url: 'dsh-app://app/', text: '- 0: [App](dsh-app://app/)' };

function runtimeWith({ opened, tabsAfter = [], calls }) {
  const runtime = new Runtime({ config: { timeoutMs: 5_000 } });
  runtime.cli = { workdir: () => '.', run: async () => ({ stdout: '""', stderr: '', code: 0 }) };
  runtime.bridge = {
    hasClient: () => true,
    clientState: () => 'live',
    request: async (kind, payload) => {
      calls.push({ kind, payload });
      if (kind === 'open-tab') return opened;
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
  const calls = [];
  const runtime = runtimeWith({
    opened: { tabId: 'tab9', background: true, url: 'https://a.test/' },
    tabsAfter: [
      { index: 1, current: false, title: 'Opened', url: 'https://a.test/', text: '- 1: [Opened](https://a.test/)' },
    ],
    calls,
  });

  const value = await runtime.openPage({ sessionId: SESSION, url: 'https://a.test/' });
  assert.equal(value.background, true);
  assert.equal(value.flashed, false);
  assert.equal(value.pageId.split('-')[1], sessionTag(SESSION));
  assert.deepEqual(calls[0], { kind: 'open-tab', payload: { url: 'https://a.test/', sessionId: SESSION } });
  assert.equal(runtime.manager.get(value.pageId).sessionId, SESSION);
});

test('a foreground open stays background: false', async () => {
  const runtime = runtimeWith({
    opened: { tabId: 'tab7', background: false, url: 'https://a.test/' },
    tabsAfter: [
      { index: 1, current: false, title: 'Opened', url: 'https://a.test/', text: '- 1: [Opened](https://a.test/)' },
    ],
    calls: [],
  });
  const value = await runtime.openPage({ sessionId: SESSION, url: 'https://a.test/' });
  assert.equal(value.background, false);
});

test('a background tab that never becomes a CLI target is rolled back', async () => {
  const calls = [];
  const runtime = runtimeWith({
    opened: { tabId: 'tab9', background: true, url: 'https://a.test/' },
    tabsAfter: [],
    calls,
  });

  await assert.rejects(() => runtime.openPage({ sessionId: SESSION, url: 'https://a.test/', waitMs: 150 }), (error) => {
    assert.match(error.message, /never started loading/);
    assert.match(error.message, /the tab was closed again/);
    return true;
  });
  const close = calls.find((call) => call.kind === 'close-tab');
  assert.deepEqual(close, { kind: 'close-tab', payload: { sessionId: SESSION, tabId: 'tab9' } });
});

test('a failed foreground open leaves the sidebar alone', async () => {
  const calls = [];
  const runtime = runtimeWith({
    opened: { tabId: 'tab7', background: false, url: 'https://a.test/' },
    tabsAfter: [],
    calls,
  });

  await assert.rejects(() => runtime.openPage({ sessionId: SESSION, url: 'https://a.test/', waitMs: 150 }), (error) => {
    assert.match(error.message, /may have failed to load/);
    return true;
  });
  assert.equal(calls.some((call) => call.kind === 'close-tab'), false);
});

test('a mount that needed a session flash is reported', async () => {
  const runtime = runtimeWith({
    opened: { tabId: 'tab9', background: true, flashed: true, url: 'https://a.test/' },
    tabsAfter: [
      { index: 1, current: false, title: 'Opened', url: 'https://a.test/', text: '- 1: [Opened](https://a.test/)' },
    ],
    calls: [],
  });
  const value = await runtime.openPage({ sessionId: SESSION, url: 'https://a.test/' });
  assert.equal(value.flashed, true);
});
