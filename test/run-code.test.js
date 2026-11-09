import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatRunCodeOutput, wrapRunCodeBody } from '../src/run-code.js';

/**
 * `browser_run_code` owns both halves of the contract that used to be implicit:
 * it accepts a body (and adds the `async page => { … }` wrapper playwright-cli
 * requires), and it refuses a body that would make playwright-cli encode the
 * result twice.
 */

test('wraps a function body exactly once', () => {
  assert.equal(
    wrapRunCodeBody('return await page.title()'),
    'async page => {\nreturn await page.title()\n}',
  );
  // A comment at the end must not swallow the closing brace.
  assert.equal(
    wrapRunCodeBody('return rows // done'),
    'async page => {\nreturn rows // done\n}',
  );
});

test('rejects a body that still carries the async page wrapper', () => {
  const wrapped = [
    'async page => { return 1; }',
    'async page => ({ a: 1 })',
    'page => { return 1; }',
    'async (page) => { return 1; }',
    '(page) => { return 1; }',
    '(async page => { return 1; })',
    '((page) => { return 1; })',
    'async function (page) { return 1; }',
    'function (page) { return 1; }',
    'async function named(page) { return 1; }',
    'function named(page) { return 1; }',
    '(async function (page) { return 1; })',
  ];
  for (const code of wrapped) {
    assert.throws(() => wrapRunCodeBody(code), /function body only/, code);
  }
});

test('detects the wrapper behind leading comments and whitespace', () => {
  assert.throws(
    () => wrapRunCodeBody('  // what the last attempt used\nasync page => { return 1; }'),
    /function body only/,
  );
  assert.throws(() => wrapRunCodeBody('/* wrapper */ (page) => { return 1; }'), /function body only/);
});

test('a legitimate IIFE body is not mistaken for the wrapper', () => {
  assert.equal(
    wrapRunCodeBody('(async () => { await page.title(); })();\nreturn "done";'),
    'async page => {\n(async () => { await page.title(); })();\nreturn "done";\n}',
  );
});

test('rejects a return that JSON-stringifies the result', () => {
  const offenders = [
    'return JSON.stringify(rows);',
    'return JSON?.stringify(rows);',
    'return JSON.stringify(await page.evaluate(() => document.body.innerText), null, 2);',
    "return await page.evaluate(() => JSON.stringify({ a: 1 }));",
    "if (rows.length) { return JSON.stringify(rows); } return 'none';",
    'return { json: JSON.stringify(rows) };',
  ];
  for (const code of offenders) {
    assert.throws(() => wrapRunCodeBody(code), /not a JSON string/, code);
  }
});

test('JSON.stringify outside a return is allowed', () => {
  const allowed = [
    "await page.evaluate(() => localStorage.setItem('state', JSON.stringify({ a: 1 }))); return 'saved';",
    "const text = 'JSON.stringify(rows)'; return text;",
    '// return JSON.stringify(rows)\nreturn rows;',
    'const same = JSON.stringify(a) === JSON.stringify(b); return same;',
  ];
  for (const code of allowed) {
    assert.match(wrapRunCodeBody(code), /^async page => \{/, code);
  }
});

test('a whitespace-only body is rejected', () => {
  assert.throws(() => wrapRunCodeBody('   \n\t'), /needs code/);
  assert.throws(() => wrapRunCodeBody(undefined), /needs code/);
});

test('decodes the CLI serialization once', () => {
  assert.equal(formatRunCodeOutput(''), '');
  assert.equal(formatRunCodeOutput('""'), '');
  assert.equal(formatRunCodeOutput('"hello"'), 'hello');
  assert.equal(formatRunCodeOutput('"  hi  "'), '  hi  ');
  assert.equal(formatRunCodeOutput('42'), '42');
  assert.equal(formatRunCodeOutput('true'), 'true');
  assert.equal(formatRunCodeOutput('null'), 'null');
  assert.equal(formatRunCodeOutput('not json'), 'not json');
});

test('object and array results are indented', () => {
  assert.equal(formatRunCodeOutput('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(formatRunCodeOutput('[1,2]'), '[\n  1,\n  2\n]');
});

test('a JSON string is not decoded a second time', () => {
  // This is what a forbidden `return JSON.stringify(...)` would produce. It is
  // shown as the JSON text it is, not guessed at and reformatted.
  assert.equal(formatRunCodeOutput('"{\\"a\\":1}"'), '{"a":1}');
});
