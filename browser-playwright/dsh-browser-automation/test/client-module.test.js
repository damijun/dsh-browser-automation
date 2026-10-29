import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/**
 * The Client half runs inside the DSH page: it is the only place that can create a
 * sidebar tab (`ctx.sidebarRight.openTab`), see which page the user has in front,
 * or turn a hidden tab into something Chromium will paint. A mistake in it is fatal
 * at boot and visible only in the renderer console, so this file loads the real
 * `client.js` the way the page's module loader does and drives `apply()`.
 */

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/**
 * @param {{
 *   reply?: (url: string, init: unknown) => object,
 *   webviews?: Array<{ title: string, url: string, width: number, height: number }>,
 *   chips?: Array<{ tabId: string, text: string }>,
 *   expanded?: boolean,
 * }} [options]
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
      // A real viewport size: onScreen intersects the carrier box with it.
      innerWidth: options.innerWidth ?? 1280,
      innerHeight: options.innerHeight ?? 800,
      crypto: { randomUUID: () => 'client-1' },
      sessionStorage: { getItem: () => null, setItem: () => {} },
      getComputedStyle: () => ({ display: 'flex', visibility: 'visible' }),
    },
    // One document object, as in a real page: baseURI plus the carriers and the
    // tab strip chips. Two webviews, one hidden (zero box), so "is this page
    // visible" has a real choice to make.
    document: {
      baseURI: 'dsh-app://app/',
      querySelectorAll: (selector) => {
        if (selector === 'webview') {
          return (
            options.webviews ?? [
              { title: 'Hidden page [dshpg-aaaaaa-00000001]', url: 'https://hidden.test/', width: 0, height: 0 },
              { title: 'Visible page', url: 'https://visible.test/page', width: 800, height: 600 },
            ]
          ).map((view) => ({
            getTitle: () => view.title,
            getURL: () => view.url,
            getBoundingClientRect: () => {
              const x = view.x ?? 0;
              const y = view.y ?? 0;
              return {
                width: view.width,
                height: view.height,
                left: x,
                top: y,
                right: x + view.width,
                bottom: y + view.height,
              };
            },
          }));
        }
        if (selector === '[data-sidebar-right-tab]') {
          return (options.chips ?? []).map((chip) => ({
            getAttribute: () => chip.tabId,
            textContent: chip.text,
          }));
        }
        return [];
      },
    },
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
    const calls = [];
    const registrations = [];
    let expanded = overrides.expanded ?? options.expanded ?? true;
    const toggle = overrides.toggleExpanded ?? options.toggleExpanded;
    const service = {
      mounted: { getSnapshot: () => 'session-1' },
      openTabs: { getSnapshot: () => overrides.tabs ?? [] },
      active: () => overrides.active ?? { id: 'tab1', kind: 'browser', contentId: 'sidebar://browser/u1' },
      openTab: (kind, opts) => opened.push({ kind, opts }),
      focus: (tabId) => calls.push(['focus', tabId]),
      close: (tabId) => calls.push(['close', tabId]),
      isExpanded: () => expanded,
      toggleExpanded: toggle
        ? () => toggle(calls, () => (expanded = true))
        : () => {
            expanded = true;
            calls.push(['toggleExpanded']);
          },
    };
    const plugin = loaded.factory(requireStub());
    plugin.apply({
      sidebarRight: service,
      layout: { openRightbar: () => calls.push(['openRightbar']) },
      sidebarRightTabs: {
        register: (definition) => {
          registrations.push(['tabType', definition.id, definition.kind, definition.guide]);
          return () => {};
        },
      },
      slots: {
        register: (options, component) => {
          registrations.push(['slot', options.name, options.key, typeof component]);
          return () => {};
        },
      },
      locale: {
        register: (ns) => {
          registrations.push(['locale', ns]);
          return () => {};
        },
        bind: () => (key) => key,
      },
      effect: (callback) => {
        const cleanup = callback();
        if (typeof cleanup === 'function') disposers.push(cleanup);
        return () => {};
      },
    });
    return { opened, calls, registrations, service, plugin };
  };

  const stop = () => {
    for (const dispose of disposers) dispose();
  };

  return { loaded, requests, longTimers, start, stop };
}

/**
 * The page module table supplies React. The panel only needs `createElement` at
 * registration time (hooks run when the tab renders, which this harness does not
 * do), so the stub stays tiny on purpose.
 */
function requireStub() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
  };
  return (name) => (name === 'react' ? React : {});
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test('the client module loads through the page module loader', () => {
  const { loaded } = harness();
  assert.ok(loaded, 'the module never called window.__ModuleLoader__.load');
  assert.equal(loaded.id, '@local/dsh-browser-automation');
  const plugin = loaded.factory(requireStub());
  assert.equal(
    JSON.stringify(plugin.inject),
    JSON.stringify(['sidebarRight', 'layout', 'slots', 'sidebarRightTabs', 'locale']),
  );
  assert.equal(typeof plugin.apply, 'function');
});

/**
 * The panel is a tab type plus a body under one id. Getting either registration
 * wrong means the user sees a tab with no body (or nothing at all), and neither
 * shows up as an error anywhere else.
 */
test('apply registers the panel tab type, its body and its strings', async () => {
  const { start, stop } = harness();
  const { registrations } = start();
  await settle(40);
  stop();

  const tabType = registrations.find((entry) => entry[0] === 'tabType');
  assert.ok(tabType, 'no tab type was registered');
  assert.equal(tabType[1], '@local/dsh-browser-automation/panel');
  assert.equal(tabType[2], 'browser-automation');
  // Without a guide entry the panel only exists behind a chip or a tool call.
  const guide = tabType[3];
  assert.ok(Array.isArray(guide) && guide.length === 1, 'the type contributes exactly one guide entry');
  assert.equal(guide[0].id, 'panel');
  assert.equal(typeof guide[0].title, 'function');
  assert.equal(typeof guide[0].icon, 'function');

  const body = registrations.find((entry) => entry[0] === 'slot');
  assert.ok(body, 'no body was registered');
  assert.equal(body[1], 'sidebar.right.pane.tab');
  assert.equal(body[2], '@local/dsh-browser-automation/panel', 'the body must key on the type id');
  assert.equal(body[3], 'function');

  assert.ok(
    registrations.some((entry) => entry[0] === 'locale' && entry[1] === 'browser-automation'),
    'the panel strings were not registered with the locale service',
  );
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
  // The visible carrier is what browser_claim needs: the hidden one must be skipped.
  assert.equal(
    JSON.stringify(body.visible),
    JSON.stringify({ url: 'https://visible.test/page', title: 'Visible page' }),
  );
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

/**
 * `prepare-capture` is how a screenshot becomes possible: the Host cannot frame a
 * sidebar tab that is not on screen, so the page brings it to the front (expanding
 * the panel when needed) and reports what it did.
 */
function captureHarness(options) {
  let delivered = false;
  return harness({
    ...options,
    reply: (url) => {
      if (url.endsWith('/poll') && !delivered) {
        delivered = true;
        return {
          ok: true,
          value: { command: { requestId: 'r3', kind: 'prepare-capture', pageId: 'dshpg-aaaaaa-00000001' } },
        };
      }
      return { ok: true, value: { command: null } };
    },
  });
}

test('prepare-capture does nothing when the page is already visible', async () => {
  const { requests, start, stop } = captureHarness({
    webviews: [{ title: 'Page [dshpg-aaaaaa-00000001]', url: 'https://a.test/', width: 573, height: 916 }],
    chips: [{ tabId: 'tab7', text: 'Page [dshpg-aaaaaa-00000001]' }],
  });
  const { calls } = start();
  await settle(80);
  stop();

  const results = requests.filter((request) => request.url.endsWith('/result'));
  const value = JSON.parse(results[0].init.body).value;
  assert.equal(value.visible, true);
  assert.equal(value.tabId, 'tab7');
  assert.deepEqual(calls, [], 'a visible page must not be focused or expanded');
});

test('prepare-capture brings a hidden page to the front by its chip', async () => {
  const { requests, start, stop } = captureHarness({
    webviews: [{ title: 'Page [dshpg-aaaaaa-00000001]', url: 'https://a.test/', width: 0, height: 0 }],
    chips: [
      { tabId: 'tab6', text: 'Other page [dshpg-aaaaaa-00000009]' },
      { tabId: 'tab7', text: 'Page [dshpg-aaaaaa-00000001]' },
    ],
  });
  const { calls } = start();
  await settle(80);
  stop();

  assert.equal(JSON.stringify(calls), JSON.stringify([['focus', 'tab7']]));
  const value = JSON.parse(requests.filter((r) => r.url.endsWith('/result'))[0].init.body).value;
  assert.equal(value.visible, false);
  assert.equal(value.tabId, 'tab7');
  assert.equal(value.expandedNow, false);
  assert.equal(value.expandVia, null);
});

test('prepare-capture expands a collapsed sidebar before looking for the chip', async () => {
  const { requests, start, stop } = captureHarness({
    webviews: [{ title: 'Page [dshpg-aaaaaa-00000001]', url: 'https://a.test/', width: 0, height: 0 }],
    chips: [{ tabId: 'tab7', text: 'Page [dshpg-aaaaaa-00000001]' }],
    expanded: false,
  });
  const { calls } = start();
  await settle(600);
  stop();

  assert.equal(JSON.stringify(calls), JSON.stringify([['toggleExpanded'], ['focus', 'tab7']]));
  const value = JSON.parse(requests.filter((r) => r.url.endsWith('/result'))[0].init.body).value;
  assert.equal(value.expandedNow, true);
  assert.equal(value.expandVia, 'sidebarRight.toggleExpanded');
});

test('prepare-capture falls back to layout.openRightbar when the toggle throws', async () => {
  const { requests, start, stop } = captureHarness({
    webviews: [{ title: 'Page [dshpg-aaaaaa-00000001]', url: 'https://a.test/', width: 0, height: 0 }],
    chips: [{ tabId: 'tab7', text: 'Page [dshpg-aaaaaa-00000001]' }],
    expanded: false,
    toggleExpanded: () => {
      throw new Error('no session surface is mounted');
    },
  });
  const { calls } = start();
  await settle(600);
  stop();

  assert.equal(JSON.stringify(calls), JSON.stringify([['openRightbar'], ['focus', 'tab7']]));
  const value = JSON.parse(requests.filter((r) => r.url.endsWith('/result'))[0].init.body).value;
  assert.equal(value.expandVia, 'layout.openRightbar');
});

/**
 * Closing is a UI action: `playwright-cli tab-close` only destroys the CDP target
 * and leaves the sidebar tab as an empty "页面加载失败" shell, so the page half must
 * remove the tab itself.
 */
function closeHarness(options) {
  let delivered = false;
  return harness({
    ...options,
    reply: (url) => {
      if (url.endsWith('/poll') && !delivered) {
        delivered = true;
        return {
          ok: true,
          value: { command: { requestId: 'r4', kind: 'close-page', pageId: 'dshpg-aaaaaa-00000001' } },
        };
      }
      return { ok: true, value: { command: null } };
    },
  });
}

test('close-page removes the tab through the sidebar controller', async () => {
  const { requests, start, stop } = closeHarness({
    chips: [{ tabId: 'tab7', text: 'Page [dshpg-aaaaaa-00000001]' }],
  });
  const { calls } = start();
  await settle(80);
  stop();

  assert.equal(JSON.stringify(calls), JSON.stringify([['close', 'tab7']]));
  const value = JSON.parse(requests.filter((r) => r.url.endsWith('/result'))[0].init.body).value;
  assert.equal(value.closed, true);
  assert.equal(value.tabId, 'tab7');
});

test('close-page reports why it could not find the tab', async () => {
  const { requests, start, stop } = closeHarness({ chips: [] });
  const { calls } = start();
  await settle(80);
  stop();

  assert.deepEqual(calls, []);
  const value = JSON.parse(requests.filter((r) => r.url.endsWith('/result'))[0].init.body).value;
  assert.equal(value.closed, false);
  assert.match(value.reason, /no sidebar tab chip carries this page/);
});

/** A collapsed panel slides the whole column out of the viewport while its content
 * keeps a real box (measured live: x=959 with a 958px-wide window). Size alone
 * therefore cannot decide visibility, which is what this pins down.
 */
test('a carrier box outside the viewport counts as hidden', async () => {
  const { requests, start, stop } = captureHarness({
    innerWidth: 958,
    innerHeight: 1031,
    webviews: [
      { title: 'Page [dshpg-aaaaaa-00000001]', url: 'https://a.test/', width: 430, height: 915, x: 959, y: 116 },
    ],
    chips: [{ tabId: 'tab7', text: 'Page [dshpg-aaaaaa-00000001]' }],
    expanded: false,
  });
  const { calls } = start();
  await settle(600);
  stop();

  assert.equal(JSON.stringify(calls), JSON.stringify([['toggleExpanded'], ['focus', 'tab7']]));
  const value = JSON.parse(requests.filter((r) => r.url.endsWith('/result'))[0].init.body).value;
  assert.equal(value.visible, false, 'an off-viewport box is not visible');
});

test('prepare-capture reports honestly when no chip carries the page', async () => {
  const { requests, start, stop } = captureHarness({
    webviews: [{ title: 'Page [dshpg-aaaaaa-00000001]', url: 'https://a.test/', width: 0, height: 0 }],
    chips: [],
  });
  const { calls } = start();
  await settle(80);
  stop();

  assert.deepEqual(calls, [], 'nothing to focus without a tab id');
  const value = JSON.parse(requests.filter((r) => r.url.endsWith('/result'))[0].init.body).value;
  assert.equal(value.visible, false);
  assert.equal(value.tabId, null);
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







