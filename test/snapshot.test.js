import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PageDriver } from '../src/driver.js';
import { Runtime } from '../src/runtime.js';
import { createTools } from '../src/tools.js';
import {
  DEFAULT_SNAPSHOT_MAX_CHARS,
  resolveSnapshotMaxChars,
  truncateByLines,
} from '../src/snapshot.js';

/**
 * Snapshot output is the one tool result that can grow without bound: an accessibility
 * tree of a real page is thousands of lines. The rule these tests protect is
 * mechanical — return the raw text when it fits, otherwise save the complete text to
 * a file and return the longest whole-line prefix that fits. No filtering, no
 * summarizing, and no `depth` argument.
 */

const PAGE_ID = 'dshpg-abcdef-01234567';
const TAB = { index: 1, current: true, title: 'T', url: 'https://a.test/', pageId: PAGE_ID };
const SESSION = 's1';

function scratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-ba-snapshot-'));
  return {
    dir,
    files: () => readdirSync(dir),
    read: (name) => readFileSync(path.join(dir, name), 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A PageDriver whose only CLI command is the snapshot, with the calls recorded. */
function driverWith(stdout, dir) {
  const calls = [];
  const cli = {
    workdir: () => dir,
    run: async (args) => {
      calls.push(args);
      return { stdout, stderr: '', code: 0 };
    },
  };
  const driver = new PageDriver(cli, { snapshotDir: dir });
  driver.attached = true;
  driver.resolvePage = async () => TAB;
  return { driver, calls, cli };
}

function runtimeWith(stdout, options = {}) {
  const area = scratch();
  const { driver, calls, cli } = driverWith(stdout, area.dir);
  const runtime = new Runtime({ config: options.config ?? {} });
  runtime.cli = cli;
  runtime.attach = async () => ({ tabs: [], ignored: [] });
  runtime.bridge = { hasClient: () => false, caps: () => ({}) };
  runtime.manager.register({ pageId: PAGE_ID, sessionId: SESSION, url: TAB.url, source: 'open' });
  runtime.driver = driver;
  return { runtime, area, calls };
}

function snapshotTool(runtime) {
  const tool = createTools(runtime).find((entry) => entry.name === 'browser_snapshot');
  assert.ok(tool, 'browser_snapshot tool is missing');
  return tool;
}

async function callSnapshot(runtime) {
  const tool = snapshotTool(runtime);
  const value = await tool.execute({ pageId: PAGE_ID }, { agent: { id: SESSION } });
  const rendered = tool.output.render({}, value)[0].text;
  return { tool, value, rendered };
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
    assert.notEqual(value[key], undefined, `${label}: required field ${key} is undefined`);
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (!(key in value) || value[key] === undefined) continue;
    const actual = value[key];
    if (spec.type === 'string') assert.equal(typeof actual, 'string', `${label}.${key} must be a string`);
    if (spec.type === 'integer' || spec.type === 'number') {
      assert.equal(typeof actual, 'number', `${label}.${key} must be a number`);
    }
    if (spec.type === 'boolean') assert.equal(typeof actual, 'boolean', `${label}.${key} must be a boolean`);
  }
}

test('browser_snapshot takes pageId only: the depth argument is gone', () => {
  const tool = snapshotTool(new Proxy({}, { get: () => async () => ({}) }));
  assert.deepEqual(Object.keys(tool.parameters.properties), ['pageId']);
  assert.deepEqual(tool.parameters.required, ['pageId']);
  assert.equal(tool.parameters.properties.depth, undefined);
  assert.ok(tool.parameters.additionalProperties === false);
});

test('a snapshot under the limit is returned untouched and writes no file', async () => {
  const stdout = 'pageId root\n  heading "Docs" [ref=e1]\n  button "Go" [ref=e2]';
  const { runtime, area, calls } = runtimeWith(stdout);
  try {
    const { tool, value, rendered } = await callSnapshot(runtime);

    assert.equal(value.pageId, PAGE_ID);
    assert.equal(value.snapshot, stdout);
    assert.equal(value.truncated, false);
    assert.equal(value.maxChars, DEFAULT_SNAPSHOT_MAX_CHARS);
    assert.equal(value.totalChars, stdout.length);
    assert.equal('snapshotPath' in value, false, 'a fitting snapshot must not name a file');
    assert.equal('title' in value, false, 'title is not part of the snapshot output');
    assert.equal('url' in value, false, 'url is not part of the snapshot output');
    assert.equal('refCount' in value, false, 'refCount was removed');
    assertMatchesSchema(value, tool.output.schema, 'browser_snapshot');

    // The fixed layout: pageId, then the raw snapshot, nothing else.
    assert.equal(rendered, `pageId: ${PAGE_ID}\nSnapshot:\n${stdout}`);
    assert.doesNotMatch(rendered, /saved to/i);
    assert.deepEqual(area.files(), [], 'no file is created when the snapshot fits');
    // playwright-cli is asked for the complete snapshot, with no depth flag.
    assert.deepEqual(calls, [['--raw', 'snapshot']]);
  } finally {
    area.cleanup();
  }
});

test('a snapshot over the limit is saved in full and only whole lines are shown', async () => {
  const lines = Array.from({ length: 20 }, (_, index) => `- row ${index} ${'x'.repeat(50)}`);
  const stdout = `${lines.join('\n')}\n`;
  const maxChars = 100;
  const { runtime, area, calls } = runtimeWith(stdout, { config: { snapshotMaxChars: maxChars } });
  try {
    const { tool, value, rendered } = await callSnapshot(runtime);

    assert.equal(value.truncated, true);
    assert.equal(value.maxChars, maxChars);
    assert.equal(value.totalChars, lines.join('\n').length);
    assert.equal(typeof value.snapshotPath, 'string');
    assert.ok(path.isAbsolute(value.snapshotPath), 'the returned path must be absolute');

    // Only the first whole line fits in 100 characters; the next one would overflow.
    assert.equal(value.snapshot, lines[0]);
    assert.ok(!value.snapshot.includes(lines[1]), 'the line that would overflow must not be included');
    assert.ok(!value.snapshot.endsWith('\n'), 'the prefix must not end with a partial line separator');

    // The file holds the complete snapshot, not the prefix.
    assert.equal(path.dirname(value.snapshotPath), area.dir);
    const files = area.files();
    assert.equal(files.length, 1);
    assert.match(files[0], /^snapshot-.*\.txt$/);
    assert.equal(area.read(files[0]), lines.join('\n'));

    assertMatchesSchema(value, tool.output.schema, 'browser_snapshot');
    assert.match(rendered, new RegExp(`^pageId: ${PAGE_ID}$`, 'm'));
    assert.match(rendered, /^Snapshot exceeds the maximum output size\.$/m);
    assert.match(rendered, /^Full snapshot saved to:$/m);
    assert.match(rendered, /^Showing the first 100 characters by complete lines:$/m);
    assert.match(rendered, /^Snapshot:$/m);
    assert.ok(rendered.includes(value.snapshotPath));
    assert.ok(rendered.includes(value.snapshot));
    assert.doesNotMatch(rendered, /^title:/m);
    assert.doesNotMatch(rendered, /^url:/m);

    // The CLI is still asked for the complete snapshot; the plugin does the cutting.
    assert.deepEqual(calls, [['--raw', 'snapshot']]);
  } finally {
    area.cleanup();
  }
});

test('a first line longer than the limit yields an empty snapshot but keeps the file', async () => {
  const stdout = `${'y'.repeat(500)}\nsecond line`;
  const { runtime, area } = runtimeWith(stdout, { config: { snapshotMaxChars: 80 } });
  try {
    const { value, rendered } = await callSnapshot(runtime);
    assert.equal(value.truncated, true);
    assert.equal(value.snapshot, '', 'a single over-long line must not be cut in half');
    assert.ok(value.snapshotPath);
    assert.equal(area.files().length, 1);
    assert.equal(area.read(area.files()[0]), stdout);
    assert.match(rendered, /^Snapshot exceeds the maximum output size\.$/m);
    assert.ok(rendered.endsWith(`Snapshot:`), 'the banner and file path survive an empty prefix');
  } finally {
    area.cleanup();
  }
});

test('a snapshot exactly at the limit is not truncated', async () => {
  const stdout = 'a'.repeat(50);
  const { runtime, area } = runtimeWith(stdout, { config: { snapshotMaxChars: 50 } });
  try {
    const { value } = await callSnapshot(runtime);
    assert.equal(value.truncated, false);
    assert.equal(value.snapshot, stdout);
    assert.deepEqual(area.files(), []);
  } finally {
    area.cleanup();
  }
});

test('truncateByLines appends whole lines only and stops at the first overflow', () => {
  assert.equal(truncateByLines('aa\nbbb\nc', 5), 'aa');
  assert.equal(truncateByLines('aa\nbbb\nc', 6), 'aa\nbbb');
  assert.equal(truncateByLines('aa\nbbb\nc', 8), 'aa\nbbb\nc');
  assert.equal(truncateByLines('toolongline', 5), '');
  assert.equal(truncateByLines('a\r\nb', 3), 'a\nb', 'CRLF input keeps the line semantics');
  assert.equal(truncateByLines('', 10), '');
});

test('invalid snapshotMaxChars values fall back to a safe positive integer', () => {
  assert.equal(DEFAULT_SNAPSHOT_MAX_CHARS, 5_000);
  assert.equal(resolveSnapshotMaxChars(2_500), 2_500);
  assert.equal(resolveSnapshotMaxChars('2500'), 2_500);
  assert.equal(resolveSnapshotMaxChars(2_500.9), 2_500);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'abc', '', null, undefined, {}]) {
    assert.equal(resolveSnapshotMaxChars(bad), DEFAULT_SNAPSHOT_MAX_CHARS, `bad budget ${String(bad)}`);
  }
});

test('an invalid configured budget cannot make the output unbounded', async () => {
  const runtime = new Runtime({ config: { snapshotMaxChars: 0 } });
  const seen = [];
  runtime.manager.register({ pageId: PAGE_ID, sessionId: SESSION, url: TAB.url, source: 'open' });
  runtime.driver = {
    attached: true,
    resolvePage: async () => TAB,
    snapshot: async (_tab, options) => {
      seen.push(options.maxChars);
      return { snapshot: 'x'.repeat(10), truncated: false, maxChars: options.maxChars, totalChars: 10 };
    },
  };

  const value = await runtime.snapshot({ pageId: PAGE_ID, sessionId: SESSION });
  assert.deepEqual(seen, [DEFAULT_SNAPSHOT_MAX_CHARS], 'the driver must receive a positive limit');
  assert.equal(value.maxChars, DEFAULT_SNAPSHOT_MAX_CHARS);
  assert.equal(value.truncated, false);
});

test('the runtime forwards a truncated snapshot with its absolute path intact', async () => {
  const saved = path.join(os.tmpdir(), 'dsh-browser-automation', 'snapshot-fixture.txt');
  const runtime = new Runtime({ config: { snapshotMaxChars: 4_000 } });
  runtime.manager.register({ pageId: PAGE_ID, sessionId: SESSION, url: TAB.url, source: 'open' });
  runtime.driver = {
    attached: true,
    resolvePage: async () => TAB,
    snapshot: async () => ({
      snapshot: 'prefix',
      truncated: true,
      maxChars: 4_000,
      totalChars: 9_000,
      snapshotPath: saved,
    }),
  };
  const value = await runtime.snapshot({ pageId: PAGE_ID, sessionId: SESSION });
  assert.deepEqual(value, {
    pageId: PAGE_ID,
    snapshot: 'prefix',
    truncated: true,
    maxChars: 4_000,
    totalChars: 9_000,
    snapshotPath: saved,
  });
});
