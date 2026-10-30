import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Runtime } from '../src/runtime.js';
import { newPageId, sessionTag } from '../src/page-id.js';

/**
 * A page handle is only meaningful together with the session that minted it.
 *
 * `browser_list scope="all"` deliberately shows other sessions' pages, which makes it
 * easy to grab a foreign pageId by mistake; acting on it would mutate a page the user is
 * working in from a conversation they are not looking at. Ownership therefore comes from
 * the registry (full session id), with the 24-bit tag inside the handle as the fallback
 * for pages whose registry entry was lost across a plugin restart.
 */

const SESSION = 'session-6101b673-7d26-4b98-bcfb-b2a38cbdb82d';
const FOREIGN = 'session-10fafe2e-cc0f-47d7-bb15-d3d5336295ce';

function runtimeWith() {
  const runtime = new Runtime({ config: {} });
  runtime.cli = { workdir: () => '.', run: async () => ({ stdout: '""', stderr: '', code: 0 }) };
  runtime.attach = async () => ({ tabs: [], ignored: [] });
  runtime.bridge = { hasClient: () => false, caps: () => ({}) };
  const calls = [];
  runtime.driver = {
    attached: true,
    resolvePage: async () => ({ index: 1, current: true, title: 'T', url: 'https://a.test/', pageId: 'x' }),
    snapshot: async () => {
      calls.push('snapshot');
      return { snapshot: '- tree', refCount: 0 };
    },
  };
  return { runtime, calls };
}

test('a page registered to this session is allowed', async () => {
  const { runtime, calls } = runtimeWith();
  const pageId = newPageId(SESSION);
  runtime.manager.register({ pageId, sessionId: SESSION, url: 'https://a.test/', source: 'open' });
  const value = await runtime.snapshot({ pageId, sessionId: SESSION });
  assert.equal(value.pageId, pageId);
  assert.deepEqual(calls, ['snapshot']);
});

test("a page registered to another session is refused before anything runs", async () => {
  const { runtime, calls } = runtimeWith();
  const pageId = newPageId(FOREIGN);
  runtime.manager.register({ pageId, sessionId: FOREIGN, url: 'https://b.test/', source: 'claim' });

  await assert.rejects(() => runtime.snapshot({ pageId, sessionId: SESSION }), (error) => {
    assert.match(error.message, /PAGE_FOREIGN_SESSION/);
    assert.match(error.message, new RegExp(FOREIGN));
    assert.match(error.message, /browser_claim/);
    return true;
  });
  assert.deepEqual(calls, [], 'no page operation may run');
});

test('an unregistered page is judged by the tag inside the handle', async () => {
  const { runtime, calls } = runtimeWith();
  // Registry lost (plugin restart): the handle still carries the session tag.
  const mine = newPageId(SESSION);
  assert.equal(mine.split('-')[1], sessionTag(SESSION));
  const value = await runtime.snapshot({ pageId: mine, sessionId: SESSION });
  assert.equal(value.pageId, mine);
  assert.deepEqual(calls, ['snapshot']);

  const theirs = newPageId(FOREIGN);
  await assert.rejects(() => runtime.snapshot({ pageId: theirs, sessionId: SESSION }), /PAGE_FOREIGN_SESSION/);
});

test('a caller without a session is not checked', async () => {
  // Internal callers (diagnostics, the probe script) may have no session context; the
  // check is about isolation between user conversations, not about authentication.
  const { runtime } = runtimeWith();
  const pageId = newPageId(FOREIGN);
  runtime.manager.register({ pageId, sessionId: FOREIGN, url: 'https://b.test/', source: 'claim' });
  const value = await runtime.snapshot({ pageId });
  assert.equal(value.pageId, pageId);
});

/**
 * Claiming is a UI action on *the page in view*, which belongs to the conversation
 * mounted in the window — not to whoever calls the tool. A background conversation must
 * not be able to take over the page the user is looking at; caps.mounted is exactly
 * the session id used to mint pageIds, so it is the right thing to compare.
 */
test('a background conversation cannot claim the page in view', async () => {
  const runtime = new Runtime({ config: {} });
  runtime.cli = { workdir: () => '.', run: async () => ({ stdout: '""', stderr: '', code: 0 }) };
  runtime.attach = async () => ({ tabs: [{ index: 1, current: true, title: 'A page', url: 'https://a.test/', text: '' }] });
  runtime.driver = { cli: runtime.cli, attached: true };
  runtime.bridge = {
    hasClient: () => true,
    clientState: () => 'live',
    request: async (kind) =>
      kind === 'ping'
        ? { mounted: SESSION, visibleUrl: 'https://a.test/', activeTabId: 'tab1', hasSidebarRight: true }
        : {},
  };
  let marked = false;
  runtime.injectMarker = async () => {
    marked = true;
    return {};
  };

  await assert.rejects(() => runtime.claimPage({ sessionId: FOREIGN }), (error) => {
    assert.match(error.message, /PAGE_FOREIGN_SESSION/);
    assert.match(error.message, /browser_claim/);
    assert.match(error.message, new RegExp(SESSION));
    return true;
  });
  assert.equal(marked, false, 'the page must not be re-marked or registered');
  assert.equal(runtime.manager.all().length, 0);
});

test('the mounted conversation can still claim the page in view', async () => {
  const runtime = new Runtime({ config: {} });
  runtime.cli = { workdir: () => '.', run: async () => ({ stdout: '""', stderr: '', code: 0 }) };
  const tab = { index: 1, current: true, title: 'A page [dshpg-111111-22222222]', url: 'https://a.test/', text: '' };
  runtime.attach = async () => ({ tabs: [tab] });
  runtime.driver = { cli: runtime.cli, attached: true };
  runtime.bridge = {
    hasClient: () => true,
    clientState: () => 'live',
    request: async (kind) =>
      kind === 'ping'
        ? { mounted: SESSION, visibleUrl: 'https://a.test/', activeTabId: 'tab1', hasSidebarRight: true }
        : {},
  };
  runtime.injectMarker = async (target) => ({ title: 'A page [' + target.pageId + ']', url: target.url });

  const claimed = await runtime.claimPage({ sessionId: SESSION });
  assert.match(claimed.pageId, /^dshpg-[0-9a-f]{6}-[0-9a-f]{8}$/);
  assert.equal(claimed.url, 'https://a.test/');
  assert.equal(runtime.manager.get(claimed.pageId).sessionId, SESSION);
  assert.equal(runtime.manager.get(claimed.pageId).tabId, 'tab1');
});

