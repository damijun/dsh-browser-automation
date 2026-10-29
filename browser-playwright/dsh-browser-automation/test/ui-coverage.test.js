import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { EDITABLE_KEYS } from '../src/config-write.js';

/**
 * Guards against the mistake this file exists for: adding a config key to the schema
 * and the write allowlist but forgetting the UI. That failure is silent — the plugin
 * works, the tool reports the field, and the settings card simply never shows it — so
 * a source-level check is worth more than another happy-path test.
 *
 * The same applies to a helper that is defined and then never called (the startup
 * attach line was written once, its call site was never applied, and nothing failed).
 */
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

test('every editable config key is readable and writable from the settings card', () => {
  const missing = [];
  for (const key of Object.keys(EDITABLE_KEYS)) {
    if (!source.includes(`'cfg.field.${key}'`)) missing.push(`label for ${key}`);
    if (!source.includes(`'cfg.desc.${key}'`)) missing.push(`description for ${key}`);
    if (!new RegExp(`key: '${key}', kind:`).test(source)) missing.push(`control for ${key}`);
  }
  assert.deepEqual(missing, []);
});

test('the settings card knows a boolean field renders as on/off', () => {
  // Any boolean key in the field list must be handled by segmentsFor, otherwise the
  // row falls through to a text input and the user types "true".
  const booleans = [...source.matchAll(/key: '([A-Za-z]+)', kind: 'boolean'/g)].map((match) => match[1]);
  assert.ok(booleans.length > 0, 'no boolean field in the card');
  for (const key of booleans) {
    assert.match(
      source,
      new RegExp(`key === '[A-Za-z]+' \\|\\| key === '${key}'|key === '${key}'`),
      `${key} is not handled as a segmented control`,
    );
  }
});

test('the panel actually renders the startup attach line', () => {
  // Defined-but-never-called is exactly how the row went missing for a whole restart.
  // The definition itself does not match `name(` — only a call site does.
  assert.ok(source.includes('autoAttachLine(data && data.autoAttach'), 'the helper is never called');
  assert.match(source, /key: 'auto', className: 'dshba-row'/);
  assert.match(source, /'panel\.autoAttach'/);
});
