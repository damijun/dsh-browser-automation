import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Config } from '../src/config.js';
import * as host from '../index.js';

/**
 * The configuration schema is what makes the settings card possible at all.
 *
 * The settings service renders a form only from fields marked `.volatile()`
 * ("Forms expose only volatile fields from active, uniquely addressed profile
 * entries"), and a volatile field parses into a reference read with `.get()` — so a
 * field that is not marked is invisible to the form, and a field that is marked but
 * read as plain data arrives as an object.
 */
const KEYS = [
  'session',
  'command',
  'nodePath',
  'timeoutMs',
  'requestTimeoutMs',
  'attachTimeoutMs',
  'autoAttach',
  'showSharedBadge',
  'screenshotTimeoutMs',
  'screenshotSettleMs',
  'debug',
];

test('every user-facing field is declared volatile, so the form can edit it', () => {
  const fields = Config.dict ?? {};
  const editable = Object.entries(fields)
    .filter(([, field]) => field.meta?.volatile === true)
    .map(([key]) => key)
    .sort();
  assert.deepEqual(editable, [...KEYS].sort());
  for (const key of KEYS) {
    assert.equal(fields[key].meta?.volatile, true, `${key} is not volatile`);
  }
});

test('the defaults are the values the plugin runs with out of the box', () => {
  const parsed = Config({});
  const value = (key) => (parsed[key] && typeof parsed[key].get === 'function' ? parsed[key].get() : parsed[key]);
  assert.equal(value('session'), 'dsh');
  assert.equal(value('command'), 'playwright-cli');
  assert.equal(value('nodePath'), 'auto');
  assert.equal(value('timeoutMs'), 20_000);
  assert.equal(value('requestTimeoutMs'), 20_000);
  assert.equal(value('screenshotSettleMs'), 1_200);
  assert.equal(value('attachTimeoutMs'), 60_000);
  assert.equal(value('autoAttach'), true);
  assert.equal(value('showSharedBadge'), true);
  assert.equal(value('screenshotTimeoutMs'), 25_000);
  assert.equal(value('debug'), false);
});

test('the port is not configurable: DSH decides it, the record reports it', () => {
  // A port knob would be redundant when it agrees with the launch argument and wrong
  // when it does not, so the schema has none — only where the record lives.
  assert.equal(Config.dict.cdpPort, undefined);
  assert.equal(Config.dict.cdpUrl, undefined);
  assert.equal(Config.dict.cdpPortFile.meta?.volatile, undefined, 'the record path is advanced, not a form field');
});

test('a profile override wins over the default through the reference', () => {
  const parsed = Config({ nodePath: 'path', timeoutMs: 5_000 });
  assert.equal(parsed.nodePath.get(), 'path');
  assert.equal(parsed.timeoutMs.get(), 5_000);
});

test('the host half exports the schema the Loader validates against', () => {
  assert.equal(typeof host.Config, 'function');
  assert.equal(typeof host.apply, 'function');
  assert.deepEqual(host.inject, ['tools', 'webServer']);
});





