import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Config } from '../src/config.js';
import {
  EDITABLE_KEYS,
  applyConfigChange,
  composeConfigValues,
  coerceConfigValue,
  findRow,
  resetConfigKey,
  schemaDefaults,
} from '../src/config-write.js';

/**
 * Settings writes go through the Host's `configEditor`, which persists a complete
 * raw config and re-applies it through the normal Loader path. The danger in this
 * module is not the happy path but the two ways it can lose data: materialising the
 * inherited defaults into the profile patch, and dropping the other overrides.
 */

function fakeEditor(rows, overrides = {}) {
  const edits = [];
  return {
    edits,
    entries: () => rows,
    // configuration() is the override layer, which is the base a write must use.
    configuration: () => rows.map((row) => ({ entry: row, override: overrides[row.id] ?? {}, inherited: {} })),
    async edit(entry, change) {
      edits.push({ entry, next: change({ ...entry.config }, { should: 'not-be-merged' }) });
    },
  };
}

test('every editable key has a declared type and nothing else is writable', () => {
  assert.deepEqual(Object.keys(EDITABLE_KEYS).sort(), [
    'attachTimeoutMs',
    'autoAttach',
    'command',
    'debug',
    'disabledTools',
    'nodePath',
    'requestTimeoutMs',
    'screenshotSettleMs',
    'screenshotTimeoutMs',
    'session',
    'showSharedBadge',
    'timeoutMs',
  ]);
  assert.equal(coerceConfigValue('__proto__', 'x').ok, false);
  assert.equal(coerceConfigValue('nope', 'x').ok, false);
});

test('values are validated and converted by their declared type', () => {
  assert.deepEqual(coerceConfigValue('nodePath', '  path  '), { ok: true, value: 'path' });
  assert.deepEqual(coerceConfigValue('timeoutMs', '2500'), { ok: true, value: 2500 });
  assert.deepEqual(coerceConfigValue('debug', 'true'), { ok: true, value: true });
  assert.deepEqual(coerceConfigValue('debug', false), { ok: true, value: false });

  assert.equal(coerceConfigValue('timeoutMs', 'abc').ok, false);
  assert.equal(coerceConfigValue('timeoutMs', -1).ok, false);
  assert.equal(coerceConfigValue('session', '   ').ok, false);
  assert.equal(coerceConfigValue('debug', 'yes').ok, false);
});

test('disabledTools is the one string field where empty is a valid value', () => {
  assert.deepEqual(coerceConfigValue('disabledTools', ' browser_console, browser_press '), {
    ok: true,
    value: 'browser_console, browser_press',
  });
  assert.deepEqual(coerceConfigValue('disabledTools', ''), { ok: true, value: '' });
  // Every other string key still rejects an empty value.
  assert.equal(coerceConfigValue('command', '').ok, false);
});

/**
 * The card must show the configuration the patch describes, not the one the running
 * instance booted with: a write only reaches the patch, so reading the booted copy
 * made the UI snap back to the old value right after a save.
 */
test('the patch view stacks base, inherited and override in that order', () => {
  assert.deepEqual(
    composeConfigValues({
      base: { a: 1, b: 1 },
      inherited: { b: 2, c: 2 },
      override: { c: 3, d: 3 },
    }),
    { a: 1, b: 2, c: 3, d: 3 },
  );
  // Missing or malformed layers degrade to the base instead of throwing.
  assert.deepEqual(composeConfigValues({ base: { a: 1 } }), { a: 1 });
  assert.deepEqual(composeConfigValues(), {});
});

test('reset falls back to schema defaults, not to the booted values', () => {
  const defaults = schemaDefaults(Config);
  assert.equal(defaults.session, 'dsh');
  assert.equal(defaults.disabledTools, '');
  assert.equal(defaults.showSharedBadge, true);
  // The shape the config card reads after a reset: no override, so the field must
  // show the schema default rather than the value the process booted with.
  assert.equal(composeConfigValues({ base: defaults, override: {} }).disabledTools, '');
  assert.equal(
    composeConfigValues({ base: defaults, override: { disabledTools: 'browser_console' } }).disabledTools,
    'browser_console',
  );
});

test('a write keeps the other overrides and never materialises the inherited layer', async () => {
  // The row's current config already contains the bundle's values (that is what a
  // bundle-inserted row resolves to); only the profile override belongs in the patch.
  const editor = fakeEditor([{ id: 'browser-automation', config: { session: 'mine', timeoutMs: 1000, command: 'from-bundle' } }], {
    'browser-automation': { session: 'mine', timeoutMs: 1000 },
  });
  await applyConfigChange({ editor, rowId: 'browser-automation', key: 'screenshotSettleMs', value: '1500' });

  assert.equal(editor.edits.length, 1);
  assert.deepEqual(editor.edits[0].next, { session: 'mine', timeoutMs: 1000, screenshotSettleMs: 1500 });
  assert.equal(Object.hasOwn(editor.edits[0].next, 'command'), false, 'inherited values must not be copied into the profile');
});

test('a reset removes the key and keeps the rest', async () => {
  const editor = fakeEditor([{ id: 'browser-automation', config: { session: 'mine', debug: true } }], {
    'browser-automation': { session: 'mine', debug: true },
  });
  await resetConfigKey({ editor, rowId: 'browser-automation', key: 'session' });

  assert.deepEqual(editor.edits[0].next, { debug: true });
});

test('the row is found by fiber before any id matching', () => {
  const fiber = { name: 'my-fiber' };
  const editor = {
    entries: () => [
      { id: 'include:other', fiber: {} },
      { id: 'a-renamed-row', fiber },
    ],
  };
  // A profile that renames the row still resolves, because the fiber is the identity.
  assert.equal(findRow(editor, 'browser-automation', fiber).id, 'a-renamed-row');
  // Without the fiber the id fallback finds nothing here.
  assert.equal(findRow(editor, 'browser-automation'), null);
  // Entries that expose the id under options are still matched.
  const nested = { entries: () => [{ options: { id: 'include:browser-automation' } }] };
  assert.notEqual(findRow(nested, 'browser-automation'), null);
});

test('a row inserted by a bundle patch is found under its include: id', () => {
  const editor = { entries: () => [{ id: 'include:browser-automation', config: {} }] };
  assert.notEqual(findRow(editor, 'browser-automation'), null);
});

test('a missing row or a bad value fails with a readable reason', async () => {
  const editor = fakeEditor([{ id: 'other', config: {} }]);
  await assert.rejects(
    () => applyConfigChange({ editor, rowId: 'browser-automation', key: 'session', value: 'x' }),
    /no addressable row/,
  );
  await assert.rejects(
    () => applyConfigChange({ editor, rowId: 'browser-automation', key: 'timeoutMs', value: 'soon' }),
    /non-negative number/,
  );
  assert.equal(editor.edits.length, 0);
  assert.equal(findRow(editor, 'browser-automation'), null);
  assert.equal(findRow({ entries: () => { throw new Error('boom'); } }, 'x'), null);
});











