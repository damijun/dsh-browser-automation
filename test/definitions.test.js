import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { Bridge } from '../src/bridge.js';
import { createTools, sanitize, selectTools, TOOL_NAMES } from '../src/tools.js';
import {
  newPageId,
  sessionTag,
  pageMarkerExpression,
  probeMarkerExpression,
  installMarkerCode,
} from '../src/page-id.js';
import { SessionManager, discover } from '../src/sessions.js';
import { normalizeUrl } from '../src/runtime.js';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

/**
 * The registry validates every schema with `assertSupportedJsonSchema`, and a
 * violation fails plugin activation. These assertions restate that subset so a
 * broken schema fails here instead of during installation.
 */
const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
]);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function checkSchema(node, path, errors) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(`${path}: schema node must be an object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      errors.push(`${path}.${key}: unsupported JSON schema keyword`);
    }
  }
  // An annotation that is present must be real JSON data: the registry rejects a
  // key whose value is `undefined`.
  for (const key of ['description', 'title']) {
    if (Object.hasOwn(node, key) && typeof node[key] !== 'string') {
      errors.push(`${path}.${key} must be a string when present`);
    }
  }
  if (Object.hasOwn(node, 'oneOf')) {
    if (Object.hasOwn(node, 'type')) errors.push(`${path}: cannot declare both type and oneOf`);
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) errors.push(`${path}.oneOf must hold at least two schemas`);
    else node.oneOf.forEach((branch, index) => checkSchema(branch, `${path}.oneOf[${index}]`, errors));
    return;
  }
  if (!Object.hasOwn(node, 'type')) {
    errors.push(`${path}: missing type`);
    return;
  }
  if (!TYPES.has(node.type)) errors.push(`${path}.type ${JSON.stringify(node.type)} is not a supported scalar type`);
  if (node.type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') {
      errors.push(`${path}.additionalProperties must be explicitly true or false`);
    }
    if (Object.hasOwn(node, 'properties')) {
      if (node.properties === null || typeof node.properties !== 'object') {
        errors.push(`${path}.properties must be an object`);
      } else {
        for (const [key, value] of Object.entries(node.properties)) {
          checkSchema(value, `${path}.properties.${key}`, errors);
        }
      }
    }
  }
  if (Object.hasOwn(node, 'required') && node.type !== 'object') {
    errors.push(`${path}.required is only meaningful on an object`);
  }
  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
      errors.push(`${path}.required must be an array of property names`);
    } else {
      for (const name of node.required) {
        if (node.properties?.[name] === undefined) errors.push(`${path}.required names unknown property ${name}`);
      }
    }
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) {
    checkSchema(node.items, `${path}.items`, errors);
  }
}

const stubRuntime = new Proxy(
  {},
  {
    get: () => async () => ({}),
  },
);

test('every tool definition satisfies the runtime schema subset', () => {
  const tools = createTools(stubRuntime);
  const errors = [];
  const names = new Set();
  for (const tool of tools) {
    if (typeof tool.name !== 'string' || tool.name === '') errors.push('a tool has no name');
    if (names.has(tool.name)) errors.push(`duplicate tool name ${tool.name}`);
    names.add(tool.name);
    if (tool.name === 'run_code') errors.push('run_code is a reserved tool name');
    if (typeof tool.description !== 'string' || tool.description.length < 20) {
      errors.push(`${tool.name}: description is missing or too short`);
    }
    if (typeof tool.execute !== 'function') errors.push(`${tool.name}: execute is not a function`);
    if (!tool.output || typeof tool.output.render !== 'function') errors.push(`${tool.name}: output.render missing`);
    checkSchema(tool.parameters, `${tool.name}.parameters`, errors);
    checkSchema(tool.output.schema, `${tool.name}.output.schema`, errors);
    if (tool.parameters.required !== undefined && tool.parameters.required.length === 0) {
      errors.push(`${tool.name}: parameters.required must be omitted or non-empty`);
    }
  }
  // Spot-check that the tools whose arguments are genuinely mandatory say so.
  const required = Object.fromEntries(tools.map((tool) => [tool.name, tool.parameters.required ?? []]));
  assert.deepEqual(required.browser_open, ['url']);
  assert.deepEqual(required.browser_claim, []);
  assert.deepEqual(required.browser_snapshot, ['pageId']);
  assert.deepEqual(required.browser_fill, ['pageId', 'ref', 'text']);
  assert.deepEqual(required.browser_list, []);
  assert.deepEqual(required.browser_navigate, ['pageId']);
  assert.deepEqual(errors, []);
  assert.equal(tools.length, 12);
});

/**
 * The registry rejects a returned value that has a field the output schema does
 * not declare (`additionalProperties: false`), so a runtime field added without
 * its schema entry turns a working tool into "returned invalid output". Two such
 * gaps shipped once (screenshot's `index`, claim's `replacedExistingPageId`).
 */
test('every field the runtime can add is declared in the output schema', () => {
  const extras = {
    browser_claim: ['replacedExistingPageId'],
    browser_list: ['warning'],
    browser_status: ['bridgeError'],
  };
  const problems = [];
  for (const tool of createTools(stubRuntime)) {
    const schema = tool.output.schema;
    const declared = new Set(Object.keys(schema.properties ?? {}));
    // Every page-scoped tool goes through Runtime.onPage, which adds pageId.
    // The tab index is deliberately absent: the model addresses pages by pageId only.
    const pageScoped = Object.hasOwn(tool.parameters.properties ?? {}, 'pageId');
    if (pageScoped) {
      for (const field of ['pageId']) {
        if (!declared.has(field)) problems.push(`${tool.name}: missing output field ${field}`);
      }
    }
    for (const field of extras[tool.name] ?? []) {
      if (!declared.has(field)) problems.push(`${tool.name}: missing optional output field ${field}`);
    }
    if (schema.additionalProperties === false) {
      for (const field of schema.required ?? []) {
        if (!declared.has(field)) problems.push(`${tool.name}: required field ${field} is not declared`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every renderer returns non-empty text blocks', () => {
  for (const tool of createTools(stubRuntime)) {
    const sample = sampleValueFor(tool.output.schema);
    const blocks = tool.output.render({}, sample);
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${tool.name}: render returned nothing`);
    for (const block of blocks) {
      assert.equal(block.type, 'text', `${tool.name}: only text blocks are expected`);
      assert.equal(typeof block.text, 'string');
    }
  }
});

/** Build a value that satisfies the required properties of an output schema. */
function sampleValueFor(schema) {
  const value = {};
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const required = schema.required?.includes(key) === true;
    if (!required) continue;
    value[key] = sampleFor(spec);
  }
  return value;
}

function sampleFor(spec) {
  if (spec.type === 'string') return 'sample';
  if (spec.type === 'integer' || spec.type === 'number') return 1;
  if (spec.type === 'boolean') return true;
  if (spec.type === 'array') return [];
  if (spec.type === 'object') return sampleValueFor(spec);
  return null;
}

test('browser tool names all carry the browser_ prefix', () => {
  for (const tool of createTools(stubRuntime)) assert.match(tool.name, /^browser_[a-z_]+$/);
});

test('the tool set covers the documented capability list', () => {
  const names = createTools(stubRuntime).map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'browser_claim',
    'browser_click',
    'browser_console',
    'browser_fill',
    'browser_list',
    'browser_navigate',
    'browser_open',
    'browser_press',
    'browser_run_code',
    'browser_screenshot',
    'browser_snapshot',
    'browser_status',
  ]);
  // TOOL_NAMES is the list `disabledTools` validates against; it must not drift.
  assert.deepEqual([...TOOL_NAMES].sort(), names);
});

test('disabledTools removes exactly the named tools and reports typos', () => {
  const all = createTools(stubRuntime);
  const selection = selectTools(all, ' browser_console , browser_press ');
  const kept = selection.tools.map((tool) => tool.name);
  assert.equal(kept.includes('browser_console'), false);
  assert.equal(kept.includes('browser_press'), false);
  assert.equal(kept.length, all.length - 2);
  assert.deepEqual(selection.unknown, []);
  // Unknown names are reported, not silently ignored, and never remove anything.
  const typo = selectTools(all, 'browser_consol');
  assert.deepEqual(typo.unknown, ['browser_consol']);
  assert.equal(typo.tools.length, all.length);
  // The default (empty) configuration keeps everything.
  assert.equal(selectTools(all, '').tools.length, all.length);
});

test('no tool opens the status panel: the user opens it from the sidebar', () => {
  const status = createTools(stubRuntime).find((tool) => tool.name === 'browser_status');
  assert.deepEqual(status.parameters.properties.action.enum, ['status', 'attach', 'detach']);
  // The panel is a session-scoped tab the user opens from the guide card; a
  // bridge command for it would land in whichever conversation is on screen.
  assert.doesNotMatch(read('../src/runtime.js'), /openPanel/);
  assert.doesNotMatch(read('../client.js'), /open-panel/);
});

test('no tool exposes a tab index or relies on tab-new/targetId', () => {
  const source = read('../src/tools.js') + read('../src/driver.js') + read('../src/runtime.js');
  assert.ok(!/tab-new/.test(source.replace(/[^\n]*tab-new[^\n]*\btab-new\b/g, (match) => match)));
  assert.ok(!/targetId/.test(source));
  for (const tool of createTools(stubRuntime)) {
    const properties = Object.keys(tool.parameters.properties ?? {});
    assert.ok(!properties.includes('index'), `${tool.name} exposes an index`);
    assert.ok(!properties.includes('tab'), `${tool.name} exposes a tab argument`);
  }
});

test('client.js is syntactically valid JavaScript', () => {
  const source = read('../client.js');
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /window\.__ModuleLoader__\.load/);
  assert.match(source, /id: 'dsh-browser-automation'/);
  assert.match(source, /inject: \['sidebarRight', 'layout', 'slots', 'sidebarRightTabs', 'locale'\]/);
  // The bridge must stay document-relative: an absolute origin would break the
  // Desktop `dsh-app://app/` carrier (the protocol is named only in the comment).
  assert.match(source, /new URL\(`\$\{BRIDGE_PATH\}\$\{action\}`, document\.baseURI\)/);
  assert.doesNotMatch(source, /fetch\(\s*[`'"]https?:/);
});

test('index.js mounts the bridge as a loopback-only route, not an authenticated RPC channel', () => {
  const source = read('../index.js');
  assert.match(source, /export const inject = \['tools', 'webServer'\]/);
  assert.match(source, /ctx\.webServer\.register\(/);
  assert.doesNotMatch(source, /connection\.rpc/);
  assert.match(source, /isLoopback/);
  assert.match(source, /sec-fetch-site/);
});

/**
 * `WebServer.match` accepts a prefix as `pathname === prefix || pathname.startsWith(prefix + '/')`.
 * A registered prefix that already ends in '/' can therefore only match a
 * doubled slash, and the request silently reaches the SPA fallback instead.
 */
test('the bridge registers a prefix without a trailing slash and slices with it', () => {
  const source = read('../index.js');
  assert.match(source, /const ROUTE_PREFIX = '\/dsh-browser-automation\/bridge\/';/);
  assert.match(source, /const ROUTE_REGISTRATION = ROUTE_PREFIX\.slice\(0, -1\);/);
  assert.match(source, /path: ROUTE_REGISTRATION,/);
  assert.doesNotMatch(source, /path: ROUTE_PREFIX,/);
  assert.match(source, /\.slice\(ROUTE_PREFIX\.length\)/);
});

test('package.json wires both halves and the locale resources', () => {
  const manifest = JSON.parse(read('../package.json'));
  assert.equal(manifest.name, 'dsh-browser-automation');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'));
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg']) {
    assert.ok(manifest.files.includes(file), `${file} missing from files`);
  }
  for (const name of ['en', 'zh']) {
    const locale = JSON.parse(read(`../locale/${name}.json`));
    assert.ok(locale.meta.title.length > 3, `${name}: meta.title`);
    assert.ok(locale.meta.description.length > 10, `${name}: meta.description`);
  }
  const patch = read('../cordis.patch.yml');
  assert.match(patch, /id: browser-automation/);
  assert.match(patch, /name: 'dsh-browser-automation'/);
});

test('page ids are unique, well formed and session-tagged', () => {
  const id = newPageId('session-alpha');
  assert.match(id, /^dshpg-[0-9a-f]{6}-[0-9a-f]{8}$/);
  assert.equal(id.split('-')[1], sessionTag('session-alpha'));

  const taken = new Set();
  for (let i = 0; i < 200; i += 1) {
    const next = newPageId('session-alpha', taken);
    assert.ok(!taken.has(next), 'collision with an id already in use');
    taken.add(next);
  }
  assert.notEqual(sessionTag('session-a'), sessionTag('session-b'));
});

test('the marker installs the identity on window and leaves the title alone', () => {
  const pageId = 'dshpg-abcdef-01234567';
  const sandbox = fakePage('Original title');
  const raw = runInNewContext(pageMarkerExpression(pageId), sandbox);
  assert.equal(sandbox.document.title, 'Original title', 'the page title must not be rewritten');
  assert.equal(sandbox.window.__dshBrowserAutomation.pageId, pageId);

  const parsed = JSON.parse(raw);
  assert.equal(parsed.pageId, pageId);
  assert.equal(parsed.title, 'Original title');
  assert.equal(parsed.url, 'https://example.test/');

  // Re-applying is idempotent and never duplicates anything in the title.
  runInNewContext(pageMarkerExpression(pageId), sandbox);
  assert.equal(sandbox.window.__dshBrowserAutomation.pageId, pageId);
  assert.equal(sandbox.document.title, 'Original title');
  const probe = JSON.parse(runInNewContext(probeMarkerExpression, sandbox));
  assert.equal(probe.pageId, pageId);
  assert.equal(probe.url, 'https://example.test/');
});

function fakePage(initialTitle) {
  return {
    document: { title: initialTitle },
    location: { href: 'https://example.test/' },
    window: {},
    JSON,
    String,
  };
}

test('the durable marker installer injects the same script through addInitScript', () => {
  const pageId = 'dshpg-abcdef-01234567';
  const code = installMarkerCode(pageId);
  // It must be a valid Playwright snippet: a function taking `page`.
  assert.match(code, /^async page => \{ await page\.addInitScript\(/);
  assert.ok(code.includes(pageId));
  // The embedded script is the same source the eval path uses, JSON-escaped.
  const source = pageMarkerExpression(pageId);
  assert.ok(code.includes(JSON.stringify(source)), 'addInitScript must receive the eval expression');
  // And that source really is executable script text.
  assert.doesNotThrow(() => new Function(source));
  assert.doesNotThrow(() => new Function(`return ${code}`));
});

test('the marker expression reports the identity it installed', () => {
  const pageId = 'dshpg-abcdef-01234567';
  const sandbox = fakePage('Start');
  const raw = runInNewContext(pageMarkerExpression(pageId), sandbox);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.pageId, pageId);
  assert.equal(parsed.title, 'Start');
  const probe = JSON.parse(runInNewContext(probeMarkerExpression, sandbox));
  assert.equal(probe.pageId, pageId);
  assert.equal(probe.url, 'https://example.test/');
});

test('normalizeUrl applies the sidebar browser rules', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl('  http://localhost:3000/x  '), 'http://localhost:3000/x');
  assert.equal(normalizeUrl('localhost:3000/x'), 'https://localhost:3000/x');
  assert.throws(() => normalizeUrl(''), /must not be empty/);
  // A local static page is a legitimate test subject; only the application scheme and
  // other non-document schemes are refused.
  assert.equal(
    normalizeUrl('file:///C:/Users/damijun/IdeaProjects/x/index.html'),
    'file:///C:/Users/damijun/IdeaProjects/x/index.html',
  );
  assert.throws(() => normalizeUrl('javascript:alert(1)'), /only opens http, https and file/);
  assert.throws(() => normalizeUrl('dsh-app://app/'), /only opens http, https and file/);
  assert.throws(() => normalizeUrl('https://user:pass@example.com/'), /must not embed credentials/);
});

test('the session manager serializes one page and leaves others parallel', async () => {
  const manager = new SessionManager();
  const order = [];
  const slow = manager.withLock('a', async () => {
    order.push('a:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('a:end');
  });
  const fast = manager.withLock('b', async () => {
    order.push('b:start');
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(order.slice(0, 2), ['a:start', 'b:start']);

  const nested = [];
  const one = manager.withLock('c', async () => {
    nested.push('one');
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const two = manager.withLock('c', async () => {
    nested.push('two');
  });
  await Promise.all([one, two]);
  assert.deepEqual(nested, ['one', 'two']);
});

test('discover attributes pages by session tag even without a registry entry', () => {
  const manager = new SessionManager();
  const mine = 'dshpg-aaaaaa-11111111';
  const other = 'dshpg-bbbbbb-22222222';
  manager.register({ pageId: mine, sessionId: 'session-a', url: 'https://mine.test/', source: 'open' });
  const pages = [
    { index: 0, current: false, closed: false, pageId: null, title: 'App', url: 'dsh-app://app/' },
    { index: 1, current: true, closed: false, pageId: mine, title: 'Mine', url: 'https://mine.test/' },
    { index: 2, current: false, closed: false, pageId: other, title: 'Other', url: 'https://other.test/' },
    { index: 3, current: false, closed: false, pageId: null, title: 'Plain', url: 'https://plain.test/' },
    { index: 4, current: false, closed: true, pageId: 'dshpg-cccccc-33333333', title: 'Gone', url: 'https://gone.test/' },
  ];
  const rows = discover({ pages, manager, sessionId: 'session-a', includeUnclaimed: false });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].mine, true);
  assert.equal(rows[1].mine, false);
  assert.equal(rows[1].session, 'session-tag:bbbbbb');

  const discoveredOwn = discover({
    pages: [{ index: 0, current: false, closed: false, pageId: newPageId('session-a'), title: 'New', url: 'https://x.test/' }],
    manager: new SessionManager(),
    sessionId: 'session-a',
  });
  assert.equal(discoveredOwn[0].mine, true);
  assert.equal(discoveredOwn[0].source, 'discovered');
});

test('a command that a page never answers is re-queued for the next poll', async (t) => {
  // The bridge unrefs its timers so it can never hold the Host open; a test that
  // waits on one must keep the loop alive, or Node 22 cancels the pending promise.
  const keepAlive = setTimeout(() => {}, 5_000);
  t.after(() => clearTimeout(keepAlive));

  const bridge = new Bridge({ pollTimeoutMs: 400, requestTimeoutMs: 3_000, deliveryTimeoutMs: 60 });
  bridge.hello('live', {});
  // Two held polls: the older one stands for a page that already reloaded, so its
  // socket is dead and it will never answer.
  const zombie = bridge.nextCommand('zombie', 400);
  const live = bridge.nextCommand('live', 400);

  const pending = bridge.request('open-tab', { url: 'https://a.test/' }, { timeoutMs: 2_500 });
  // The newest poll gets it first (LIFO), so the zombie stays untouched.
  const first = await live;
  assert.equal(first.kind, 'open-tab');
  assert.equal(await Promise.race([zombie.then(() => 'delivered'), Promise.resolve('idle')]), 'idle');

  // Pretend the live page died too: nothing settles it, so it is re-queued and the
  // next poll receives the same command instead of the caller timing out.
  const next = bridge.nextCommand('live', 400);
  const again = await next;
  assert.equal(again.requestId, first.requestId);
  bridge.submitResult({ requestId: again.requestId, ok: true, value: { tabId: 'tab9' } });
  assert.deepEqual(await pending, { tabId: 'tab9' });
});

/**
 * A `hello` runs once per connection, but the facts it carries (which Session is
 * on screen, which page is visible) change with every panel open or sidebar click.
 * Polls refresh them, so status never reports a window that is plainly on screen as
 * "no session surface".
 */
test('a poll can refresh capabilities without a new welcome', () => {
  const bridge = new Bridge({ pollTimeoutMs: 100, requestTimeoutMs: 100 });
  bridge.hello('client-1', { mounted: null, hasSidebarRight: true });
  assert.equal(bridge.snapshot().clients[0].mounted, null);

  bridge.note('client-1', { mounted: 'session-1', visibleUrl: 'https://a.test/' });
  const client = bridge.snapshot().clients[0];
  assert.equal(client.mounted, 'session-1');
  assert.equal(client.visibleUrl, 'https://a.test/');
  // The rest of the announcement survives; a poll only overrides what it carries.
  assert.equal(client.hasSidebarRight, true);

  // An unknown client, or an empty refresh, changes nothing.
  bridge.note('client-2', { mounted: 'session-2' });
  bridge.note('client-1', {});
  assert.equal(bridge.snapshot().clients.length, 1);
  assert.equal(bridge.snapshot().clients[0].mounted, 'session-1');
});

test('the bridge holds a poll until a command exists and settles it', async (t) => {
  const keepAlive = setTimeout(() => {}, 5_000);
  t.after(() => clearTimeout(keepAlive));

  const bridge = new Bridge({ pollTimeoutMs: 200, requestTimeoutMs: 500 });
  assert.equal(bridge.hasClient(), false);
  await assert.rejects(() => bridge.request('open-tab', { url: 'https://a.test/' }), /No DSH page is connected/);

  // Announcing is not listening: only a held poll can receive a command.
  bridge.hello('client-1', { hasSidebarRight: true });
  assert.equal(bridge.hasClient(), false);

  const opened = bridge.nextCommand('client-1', 200);
  const pending = bridge.request(
    'open-tab',
    // A payload field named `kind` must not be able to rewrite the envelope.
    { url: 'https://a.test/', kind: 'browser' },
    { timeoutMs: 1_000 },
  );
  assert.equal(bridge.hasClient(), true);

  const command = await opened;
  assert.equal(command.kind, 'open-tab');
  assert.equal(command.url, 'https://a.test/');
  assert.equal(bridge.submitResult({ requestId: command.requestId, ok: true, value: { tabId: 'tab3' } }).ok, true);
  assert.deepEqual(await pending, { tabId: 'tab3' });

  const held = bridge.nextCommand('client-1', 50);
  assert.equal(await held, null);
  assert.equal(bridge.snapshot().queuedCommands, 0);
});

test('the bridge rejects a failed result and times out a silent page', async (t) => {
  const keepAlive = setTimeout(() => {}, 5_000);
  t.after(() => clearTimeout(keepAlive));

  const bridge = new Bridge({ pollTimeoutMs: 100, requestTimeoutMs: 100 });
  bridge.hello('client-1');
  const opened = bridge.nextCommand('client-1', 100);
  const failed = bridge.request('open-tab', { url: 'https://a.test/' }, { timeoutMs: 500 });
  const command = await opened;
  bridge.submitResult({ requestId: command.requestId, ok: false, error: 'no session surface is mounted' });
  await assert.rejects(() => failed, /no session surface is mounted/);

  await assert.rejects(() => bridge.request('open-tab', { url: 'https://a.test/' }, { timeoutMs: 40 }), /did not answer/);
  bridge.dispose();
  await assert.rejects(() => bridge.request('open-tab', {}, { timeoutMs: 10 }), /shutting down/);
});

test('sanitize removes undefined so tool results stay lossless JSON', () => {
  assert.deepEqual(sanitize({ a: 1, b: undefined, c: [undefined, 2] }), { a: 1, c: [null, 2] });
  assert.equal(sanitize(undefined), null);
  assert.throws(() => sanitize({ big: 1n }));
});








