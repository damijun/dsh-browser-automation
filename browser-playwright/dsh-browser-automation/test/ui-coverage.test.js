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

test('reset is a button and the overridden marker is plain text', () => {
  // The row used to render both as links: the reset read as a label and the badge as
  // a control. The requirement is the other way round.
  assert.match(source, /className: 'dshcfg-btn dshcfg-btn-sm'/);
  assert.match(source, /key: 'badge', className: 'dshcfg-desc'/);
});

test('both a save and a reset report that a re-enable is needed, briefly', () => {
  // A reset used to be silent, and its note stayed on screen forever.
  assert.match(source, /flashNote\(t\('cfg\.saved'\)\)/);
  assert.match(source, /flashNote\(t\('cfg\.reset'\)\)/);
  assert.match(source, /noteTimer\.current = setTimeout/);
  assert.match(source, /cfg\.reset': '[^']*Restart DSH/);
});


test('the shared badge is an overlay registration, not a page patch', async () => {
  // The badge must live on the frame-wide overlay layer: the page is never modified, and
  // the marker cannot be painted into a screenshot.
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(source, /name: 'shell\.overlay', id: 'browser-automation:shared'/);
  assert.match(source, /data-dsh-ba-shared/);
  assert.match(source, /pointerEvents: 'none'/);
});

test('the shared badge follows tab switches by event, with only a slow safety tick', async () => {
  // A 250ms poll cost ~0.3ms/s of layout work; switches are observable through the pane
  // size (0x0 <-> real box) and through the sidebar's DOM churn, so the badge uses those.
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  assert.match(source, /new ResizeObserver\(schedule\)/);
  assert.match(source, /new MutationObserver\(/);
  assert.match(source, /data-sidebar-right-session/, 'the mutation filter must stay scoped');
  assert.match(source, /setInterval\(measure, 2000\)/, 'the safety net must stay slow');
  assert.doesNotMatch(source, /setInterval\(tick, 250\)/, 'the old poll must be gone');
});

