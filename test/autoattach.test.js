import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Runtime } from '../src/runtime.js';

/**
 * The startup attach is what keeps `tab-list` useful: playwright-cli only adopts
 * sidebar pages created after it attached, so attaching during activation puts that
 * boundary before the user's first page. It must never be able to fail the row, and
 * its outcome has to be visible — a silent failure is what makes pages "invisible".
 */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runtimeWith(attach) {
  const runtime = new Runtime({ config: {} });
  runtime.attach = attach;
  return runtime;
}

test('auto-attach is on by default and attaches once', async () => {
  let calls = 0;
  const runtime = runtimeWith(async () => {
    calls += 1;
    return { tabs: [] };
  });
  runtime.scheduleAutoAttach({ delayMs: 1, attempts: 3, backoffMs: 2 });
  await wait(40);
  assert.equal(calls, 1);
  assert.equal(runtime.autoAttach.ok, true);
  assert.equal(runtime.autoAttach.attempts, 1);
  assert.equal(typeof runtime.autoAttach.at, 'number');
});

test('autoAttach: false leaves the CLI alone and says so', async () => {
  let calls = 0;
  const runtime = new Runtime({ config: { autoAttach: false } });
  runtime.attach = async () => {
    calls += 1;
    return { tabs: [] };
  };
  runtime.scheduleAutoAttach({ delayMs: 1, attempts: 3, backoffMs: 2 });
  await wait(30);
  assert.equal(calls, 0);
  assert.equal(runtime.autoAttach.skipped, true);
});

test('a slow start retries, then reports success', async () => {
  let calls = 0;
  const runtime = runtimeWith(async () => {
    calls += 1;
    if (calls < 3) throw new Error('CDP endpoint not up yet');
    return { tabs: [] };
  });
  runtime.scheduleAutoAttach({ delayMs: 1, attempts: 5, backoffMs: 2 });
  await wait(80);
  assert.equal(calls, 3);
  assert.equal(runtime.autoAttach.ok, true);
  assert.equal(runtime.autoAttach.attempts, 3);
});

test('giving up is recorded, not thrown', async () => {
  const runtime = runtimeWith(async () => {
    throw new Error('playwright-cli not found');
  });
  runtime.scheduleAutoAttach({ delayMs: 1, attempts: 2, backoffMs: 2 });
  await wait(60);
  assert.equal(runtime.autoAttach.ok, false);
  assert.match(runtime.autoAttach.error, /not found/);
  assert.equal(runtime.autoAttach.attempts, 2);
});

test('disposing stops the retries', async () => {
  let calls = 0;
  const runtime = runtimeWith(async () => {
    calls += 1;
    throw new Error('nope');
  });
  runtime.scheduleAutoAttach({ delayMs: 1, attempts: 50, backoffMs: 5 });
  await wait(20);
  runtime.cancelAutoAttach?.();
  const seen = calls;
  await wait(40);
  assert.equal(calls, seen, 'no further attempts after cancellation');
});
