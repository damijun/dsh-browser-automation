import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { Runtime } from '../src/runtime.js';
import { createTools } from '../src/tools.js';

/**
 * The gap that shipped `browser_run_code` broken for its whole life: every test checked
 * the *declared* schema, none checked a *real* runtime return value against it.
 *
 * `Runtime.runCode` wrapped `driver.runCode`'s `{ output, title, url }` inside an
 * `output` field, so the tool answered `output: {…}` where the schema says
 * `output: string`. The harness rejected the result *after* the snippet had already run,
 * which is the worst shape of failure: the model sees an error, the page is mutated, and
 * a retry repeats the side effects.
 *
 * These cases drive the real runtime methods with a stub driver, then validate the
 * result against the tool's own schema.
 */

const PAGE_ID = 'dshpg-abcdef-01234567';

function runtimeWith(driverOverrides) {
  const runtime = new Runtime({ config: {} });
  const cli = {
    workdir: () => os.tmpdir(),
    run: async () => ({ stdout: '""', stderr: '', code: 0 }),
  };
  runtime.cli = cli;
  runtime.attach = async () => ({ tabs: [], ignored: [] });
  runtime.bridge = { hasClient: () => false, caps: () => ({}) };
  // Page actions are limited to the owning session, so the fixture page must belong to
  // the caller these tests use.
  runtime.manager.register({ pageId: PAGE_ID, sessionId: 's1', url: 'https://a.test/', source: 'open' });
  runtime.driver = {
    cli,
    resolvePage: async () => ({ index: 1, current: true, title: 'T', url: 'https://a.test/', pageId: PAGE_ID }),
    ...driverOverrides,
  };
  return runtime;
}

function toolNamed(name, runtime = new Proxy({}, { get: () => async () => ({}) })) {
  const tool = createTools(runtime).find((entry) => entry.name === name);
  assert.ok(tool, `no tool named ${name}`);
  return tool;
}

/** Validate a real return value against the tool's declared output schema. */
function assertMatchesSchema(value, schema, label) {
  const properties = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      assert.ok(key in properties, `${label}: undeclared output field ${key}`);
    }
  }
  for (const key of schema.required ?? []) {
    assert.ok(key in value, `${label}: missing required field ${key}`);
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (!(key in value) || value[key] === undefined) continue;
    const actual = value[key];
    if (spec.type === 'string') assert.equal(typeof actual, 'string', `${label}.${key} must be a string`);
    if (spec.type === 'integer' || spec.type === 'number') {
      assert.equal(typeof actual, 'number', `${label}.${key} must be a number`);
    }
    if (spec.type === 'boolean') assert.equal(typeof actual, 'boolean', `${label}.${key} must be a boolean`);
    if (spec.type === 'array') assert.ok(Array.isArray(actual), `${label}.${key} must be an array`);
  }
}

test('run_code output is the snippet stdout, never the driver result object', async () => {
  const runtime = runtimeWith({
    runCode: async () => ({ output: 'hi', title: 'T', url: 'https://a.test/' }),
  });
  const value = await runtime.runCode({ pageId: PAGE_ID, code: 'async page => "hi"' });
  assert.equal(typeof value.output, 'string');
  assert.equal(value.output, 'hi');
  assertMatchesSchema(value, toolNamed('browser_run_code').output.schema, 'browser_run_code');
});

test('run_code records a navigation the snippet performed', async () => {
  const runtime = runtimeWith({
    runCode: async () => ({ output: 'navigated', title: 'New title', url: 'https://a.test/next' }),
  });
  runtime.manager.register({ pageId: PAGE_ID, sessionId: 's1', url: 'https://a.test/', source: 'open' });
  const value = await runtime.runCode({ pageId: PAGE_ID, code: 'async page => 1' });
  assert.equal(value.output, 'navigated');
  const entry = runtime.manager.get(PAGE_ID);
  assert.equal(entry.url, 'https://a.test/next');
  assert.equal(entry.title, 'New title');
});

/**
 * The wrapper-style tools (`{ field: <string from the driver> }`) are the ones that can
 * regress into "object where a string was declared" — checked against their own schema.
 */
test('every wrapping page tool answers with a value its own schema accepts', async () => {
  const runtime = runtimeWith({
    runCode: async () => ({ output: 'hi', title: 'T', url: 'https://a.test/' }),
    console: async () => 'no messages',
    press: async () => 'Pressed ok',
  });

  const cases = [
    ['browser_run_code', { code: 'return 1' }, 'runCode'],
    ['browser_console', {}, 'console'],
    ['browser_press', { key: 'Tab' } , 'press'],
  ];

  for (const [name, extra, method] of cases) {
    const tool = toolNamed(name, runtime);
    const value = await tool.execute({ pageId: PAGE_ID, ...extra }, { agent: { id: 's1' } });
    // The runtime method named by the tool is stubbed above; make sure the tool really
    // called it (otherwise this would pass on a different, empty path).
    assert.ok(typeof runtime.driver[method] === 'function', `${name}: driver.${method} missing`);
    assertMatchesSchema(value, tool.output.schema, name);
    assert.equal(value.pageId, PAGE_ID, `${name}: pageId must survive`);
  }
});

test('browser_run_code wraps the body and validates before touching the page', async () => {
  const seen = [];
  const runtime = runtimeWith({
    runCode: async (tab, options) => {
      seen.push(options.code);
      return { output: '"hi"', title: 'T', url: 'https://a.test/' };
    },
  });
  const tool = toolNamed('browser_run_code', runtime);

  const value = await tool.execute(
    { pageId: PAGE_ID, code: 'return await page.title()' },
    { agent: { id: 's1' } },
  );
  // The body is wrapped for playwright-cli; the string result loses its JSON quotes.
  assert.deepEqual(seen, ['async page => {\nreturn await page.title()\n}']);
  assert.equal(value.output, 'hi');

  await assert.rejects(
    () => tool.execute({ pageId: PAGE_ID, code: 'async page => { return 1; }' }, { agent: { id: 's1' } }),
    /function body only/,
  );
  await assert.rejects(
    () => tool.execute({ pageId: PAGE_ID, code: 'return JSON.stringify(rows)' }, { agent: { id: 's1' } }),
    /not a JSON string/,
  );
  assert.equal(seen.length, 1, 'rejected code must never reach playwright-cli');
});

test('browser_run_code keeps an object result as compact JSON', async () => {
  const runtime = runtimeWith({
    runCode: async () => ({ output: '{"a":1}', title: 'T', url: 'https://a.test/' }),
  });
  const tool = toolNamed('browser_run_code', runtime);
  const value = await tool.execute({ pageId: PAGE_ID, code: 'return { a: 1 }' }, { agent: { id: 's1' } });
  assert.equal(value.output, '{"a":1}');
});

