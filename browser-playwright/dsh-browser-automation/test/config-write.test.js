import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITABLE_KEYS,
  applyConfigChange,
  coerceConfigValue,
  findRow,
  resetConfigKey,
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
    'cdpUrl',
    'command',
    'debug',
    'nodePath',
    'requestTimeoutMs',
    'screenshotSettleMs',
    'session',
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



