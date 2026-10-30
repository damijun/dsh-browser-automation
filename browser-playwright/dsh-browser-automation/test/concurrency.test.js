import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { PageDriver } from '../src/driver.js';

/**
 * The daemon has **one** global "current tab" pointer, and every page command acts on
 * it. `tab-select` followed by a command is therefore a critical section: without a
 * driver-wide lock, caller B's select lands between caller A's select and A's command,
 * so A's click/fill/goto runs on B's page and reports success.
 *
 * These tests fail without `withCli` (the selects would interleave) and pin the
 * invariant that no other file selects a tab on its own.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ID_A = 'dshpg-aaaaaa-11111111';
const ID_B = 'dshpg-bbbbbb-22222222';

function driverWith(log, delay = 15) {
  const cli = {
    run: async (args) => {
      const text = args.join(' ');
      if (text.includes('tab-select')) log.push(`select:${args[args.length - 1]}`);
      if (text.includes('detach')) log.push('cli:detach');
      await sleep(delay);
      return { stdout: '""', stderr: '', code: 0 };
    },
  };
  return new PageDriver(cli, { cdpUrl: 'http://127.0.0.1:9222', log: () => {} });
}

test('two pages never swap the current tab under each other', async () => {
  const log = [];
  const driver = driverWith(log);
  const first = { index: 1, current: false, pageId: ID_A };
  const second = { index: 2, current: false, pageId: ID_B };

  await Promise.all([
    driver.executeOnResolvedTab(first, async () => {
      log.push('op:1:start');
      await sleep(15);
      log.push('op:1:end');
    }),
    driver.executeOnResolvedTab(second, async () => {
      log.push('op:2:start');
      await sleep(15);
      log.push('op:2:end');
    }),
  ]);

  assert.deepEqual(log, ['select:1', 'op:1:start', 'op:1:end', 'select:2', 'op:2:start', 'op:2:end']);
});

test('the lock is re-entrant inside one async context, but not across contexts', async () => {
  const driver = driverWith([], 1);

  // Re-entrant: executeOnResolvedTab resolves the page inside its own lock.
  const nested = await driver.withCli(() => driver.withCli(async () => 'nested'));
  assert.equal(nested, 'nested');

  // Two independent callers still queue.
  const events = [];
  await Promise.all([
    driver.withCli(async () => {
      events.push('a:start');
      await sleep(15);
      events.push('a:end');
    }),
    driver.withCli(async () => {
      events.push('b:start');
      await sleep(15);
      events.push('b:end');
    }),
  ]);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('detach waits for in-flight work instead of cutting it off', async () => {
  const log = [];
  const driver = driverWith(log);
  const tab = { index: 1, current: true, pageId: ID_A };

  const work = driver.executeOnResolvedTab(tab, async () => {
    log.push('op:start');
    await sleep(30);
    log.push('op:end');
  });
  const detach = driver.detach();
  await Promise.all([work, detach]);

  assert.ok(log.indexOf('op:end') >= 0, 'the operation finished');
  assert.ok(
    log.indexOf('cli:detach') > log.indexOf('op:end'),
    `detach must queue behind the operation, got ${JSON.stringify(log)}`,
  );
});

test('nothing outside executeOnResolvedTab selects a tab', () => {
  // Comments may mention the command; only real call sites count.
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const files = readdirSync('src').filter((name) => name.endsWith('.js'));
  const hits = [];
  for (const name of files) {
    const text = strip(readFileSync(`src/${name}`, 'utf8'));
    if (text.includes("'tab-select'")) hits.push(name);
  }
  assert.deepEqual(hits, ['driver.js'], 'only the driver may select a tab');

  const driver = strip(readFileSync('src/driver.js', 'utf8'));
  assert.equal(driver.split("'--raw', 'tab-select'").length - 1, 1, 'exactly one select site');
  const select = driver.indexOf("'--raw', 'tab-select'");
  const method = driver.indexOf('async executeOnResolvedTab(');
  const next = driver.indexOf('async mark(', method);
  assert.ok(select > method && select < next, 'the select lives inside executeOnResolvedTab');

  const runtime = strip(readFileSync('src/runtime.js', 'utf8'));
  assert.ok(!runtime.includes('tab-select'), 'the runtime must not select tabs directly');
});
