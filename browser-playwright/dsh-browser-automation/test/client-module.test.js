import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/**
 * The Client half is only ever loaded by the DSH page's module loader. A mistake
 * there is fatal at boot ("web boot: 1 entry did not activate … import failed")
 * and the detail exists only in the renderer console — exactly the situation this
 * harness prevents. It loads the real file the way the page does and drives
 * `apply()` against a fake sidebar service.
 */

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/**
 * @param {{ reply?: (url: string, init: unknown) => object }} [options]
 */
function harness(options = {}) {
  let loaded;
  const requests = [];
  const longTimers = [];
  const disposers = [];

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (mod) => {
          loaded = mod;
        },
      },
      location: { origin: 'dsh-app://app', href: 'dsh-app://app/', protocol: 'dsh-app:' },
      crypto: { randomUUID: () => 'client-1' },
      sessionStorage: { getItem: () => null, setItem: () => {} },
    },
    document: { baseURI: 'dsh-app://app/' },
    URL,
    JSON,
    AbortController,
    console: { info: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn, ms) => {
      // Long waits are recorded but never fired: a retry backoff should park the
      // loop instead of keeping the test process alive.
      if (ms > 1_000) {
        longTimers.push(ms);
        return 0;
      }
      return setTimeout(fn, ms);
    },
    clearTimeout,
    fetch: (url, init) => {
      requests.push({ url, init });
      const reply = options.reply ? options.reply(url, init) : { ok: true, value: { command: null } };
      // Resolve on a macrotask so a loop iteration cannot starve the event loop.
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            ok: reply.ok !== false,
            status: reply.status ?? 200,
            json: async () => reply,
            text: async () => JSON.stringify(reply),
          });
        }, 0);
      });
    },
  };
  sandbox.window.document = sandbox.document;
  runInNewContext(source, sandbox);

  /** Start the plugin and remember how to stop its loop. */
  const start = (overrides = {}) => {
    const opened = [];
    const service = {
      mounted: { getSnapshot: () => 'session-1' },
      openTabs: { getSnapshot: () => overrides.tabs ?? [] },
      active: () => overrides.active ?? { id: 'tab1', kind: 'browser', contentId: 'sidebar://browser/u1' },
      openTab: (kind, opts) => opened.push({ kind, opts }),
      focus: (tabId) => opened.push({ focused: tabId }),
    };
    const plugin = loaded.factory(() => ({}));
    plugin.apply({
      sidebarRight: service,
      effect: (callback) => {
        const cleanup = callback();
        if (typeof cleanup === 'function') disposers.push(cleanup);
        return () => {};
      },
    });
    return { opened, service, plugin };
  };

  const stop = () => {
    for (const dispose of disposers) dispose();
  };

  return { loaded, requests, longTimers, start, stop };
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test('the client module loads through the page module loader', () => {
  const { loaded } = harness();
  assert.ok(loaded, 'the module never called window.__ModuleLoader__.load');
  assert.equal(loaded.id, '@local/dsh-browser-automation');
  const plugin = loaded.factory(() => ({}));
  assert.equal(JSON.stringify(plugin.inject), JSON.stringify(['sidebarRight']));
  assert.equal(typeof plugin.apply, 'function');
});

test('apply announces the page on the document-relative bridge URL', async () => {
  const { requests, start, stop } = harness();
  start();
  await settle();
  stop();

  assert.ok(requests.length >= 1, 'no bridge request was made');
  assert.equal(requests[0].url, 'dsh-app://app/dsh-browser-automation/bridge/hello');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.hasSidebarRight, true);
  assert.equal(body.mounted, 'session-1');
  assert.equal(body.activeTabId, 'tab1');
});

test('an open-tab command reaches ctx.sidebarRight.openTab once', async () => {
  let delivered = false;
  const { requests, start, stop } = harness({
    reply: (url) => {
      if (url.endsWith('/poll') && !delivered) {
        delivered = true;
        return { ok: true, value: { command: { requestId: 'r1', kind: 'open-tab', url: 'https://a.test/' } } };
      }
      return { ok: true, value: { command: null } };
    },
  });
  const { opened } = start();
  await settle(80);
  stop();

  const openCalls = opened.filter((entry) => entry.kind === 'browser');
  assert.equal(openCalls.length, 1, 'openTab was not called exactly once');
  // Values built inside the vm realm have foreign prototypes, so compare text.
  assert.equal(JSON.stringify(openCalls[0].opts), JSON.stringify({ params: { url: 'https://a.test/' } }));

  const results = requests.filter((request) => request.url.endsWith('/result'));
  assert.equal(results.length, 1);
  const body = JSON.parse(results[0].init.body);
  assert.equal(body.ok, true);
  assert.equal(body.value.tabId, 'tab1');
  assert.equal(body.value.address, 'sidebar://browser/u1');
});

test('a focus-tab command focuses the tab instead of opening one', async () => {
  let delivered = false;
  const { requests, start, stop } = harness({
    reply: (url) => {
      if (url.endsWith('/poll') && !delivered) {
        delivered = true;
        return { ok: true, value: { command: { requestId: 'r2', kind: 'focus-tab', tabId: 'tab7' } } };
      }
      return { ok: true, value: { command: null } };
    },
  });
  const { opened } = start();
  await settle(80);
  stop();

  assert.equal(JSON.stringify(opened), JSON.stringify([{ focused: 'tab7' }]));
  const results = requests.filter((request) => request.url.endsWith('/result'));
  assert.equal(JSON.parse(results[0].init.body).value.focused, true);
});

test('a failing transport is reported once and retried with a backoff', async () => {
  const { requests, longTimers, start, stop } = harness({
    reply: () => ({ ok: false, status: 405, error: 'nope' }),
  });
  start();
  await settle(60);
  stop();

  assert.ok(requests.length >= 1);
  assert.ok(longTimers.length >= 1, 'a retry backoff was not scheduled');
});

test('an empty poll answer does not spin the loop', async () => {
  const { requests, start, stop } = harness();
  start();
  await settle(300);
  stop();
  // hello + a handful of polls; without the floor this would be hundreds.
  assert.ok(requests.length <= 8, `the loop spun: ${requests.length} requests in 300ms`);
});


