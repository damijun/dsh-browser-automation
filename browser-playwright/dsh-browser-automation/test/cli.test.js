import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveCli, resolveNode, describeFailure, CliBridge, CliUnavailableError } from '../src/cli.js';
import { parseEvalOutput } from '../src/driver.js';

/**
 * A stand-in for the CLI entry: a real script file rather than `node -e`, because
 * `-e` keeps parsing the CLI arguments as Node options.
 */
const scratch = mkdtempSync(path.join(tmpdir(), 'dsh-ba-test-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

function script(name, source) {
  const file = path.join(scratch, `${name}.mjs`);
  writeFileSync(file, source, 'utf8');
  return file;
}

const HANG = script('hang', 'setTimeout(() => {}, 60_000);\n');

test('resolves the npm shim to the JavaScript entry, so no shell quoting is needed', () => {
  const plan = resolveCli({ command: 'playwright-cli' });
  assert.match(plan.file, /node(\.exe)?$/i);
  assert.match(plan.prefix[0], /playwright-cli\.js$/);
});

/**
 * The plugin runs inside the DSH Desktop Host, which is Electron: there
 * `process.execPath` is `DeepSeek Harness.exe`, and handing it a `.js` entry
 * makes the CLI's own daemon child die with "too many arguments". A plain Node
 * must be preferred whenever the host itself is not Node.
 */
test('under an Electron host the interpreter is a node binary from PATH, with an env fallback', () => {
  const saved = process.versions.electron;
  try {
    Object.defineProperty(process.versions, 'electron', { value: '39.0.0', configurable: true });

    // A PATH that holds node must yield that node, with no env override.
    const withNode = resolveNode({ env: { PATH: path.dirname(process.execPath) } });
    assert.match(withNode.file, /[\\/]node(\.exe)?$/i);
    assert.equal(withNode.env, undefined);

    // No node anywhere: the Electron binary runs as node only with this env flag.
    const withoutNode = resolveNode({ env: { PATH: path.join(scratch, 'empty-dir') } });
    assert.deepEqual(withoutNode, {
      file: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });

    // A plain Node host always runs the entry itself, regardless of PATH.
    delete process.versions.electron;
    assert.deepEqual(resolveNode({ env: { PATH: '' } }), { file: process.execPath });
  } finally {
    if (saved === undefined) delete process.versions.electron;
    else Object.defineProperty(process.versions, 'electron', { value: saved, configurable: true });
  }
});

test('an explicit nodePath wins, and a wrong one fails loudly', () => {
  assert.equal(resolveNode({ explicit: process.execPath }).file, process.execPath);
  assert.throws(() => resolveNode({ explicit: path.join(scratch, 'no-node.exe') }), CliUnavailableError);
});

test('an explicit shim path resolves to the JS entry it points at', () => {
  const entryDir = path.join(scratch, 'node_modules', '@playwright', 'cli');
  mkdirSync(entryDir, { recursive: true });
  const entry = path.join(entryDir, 'playwright-cli.js');
  writeFileSync(entry, 'export {};\n', 'utf8');
  const shim = path.join(scratch, 'playwright-cli.cmd');
  writeFileSync(
    shim,
    '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@playwright\\cli\\playwright-cli.js" %*\r\n',
    'utf8',
  );
  const plan = resolveCli({ command: shim });
  assert.equal(plan.file, process.execPath);
  assert.equal(plan.prefix[0], entry);
  assert.equal(plan.shim, shim);
});

test('a missing command is reported, not silently ignored', () => {
  assert.throws(() => resolveCli({ command: 'definitely-not-installed-cli' }), CliUnavailableError);
});

test('failure text drops the Node stack and keeps the cause', () => {
  const stderr = [
    'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\playwright-core\\lib\\tools\\cli-client\\session.js:172',
    '    const rejectWithPid = (reject, message) => reject(Object.assign(new Error(`Daemon pid=${child.pid}`)));',
    '                                                                    ^',
    '',
    'Error: Daemon pid=13328: Daemon process exited with code 1',
    '[PlaywrightError: connect ECONNREFUSED 127.0.0.1:9222',
    '    at Object.connect (node:net:1:1)',
  ].join('\n');
  const message = describeFailure(['--raw', 'attach', '--cdp=http://127.0.0.1:9222'], 1, null, '', stderr);
  assert.match(message, /playwright-cli attach exited with code 1/);
  assert.doesNotMatch(message, /\.js:172/);
  assert.doesNotMatch(message, /^\s+at /m);
  assert.match(message, /ECONNREFUSED|Daemon/);
});

test('failure text falls back to stdout, where the CLI writes user errors', () => {
  const message = describeFailure(['--raw', 'tab-list'], 1, null, "The browser 'dsh' is not open, please run open first", '');
  assert.match(message, /playwright-cli tab-list/);
  assert.match(message, /not open/);
});

test('eval output parses JSON values and tolerates plain text', () => {
  assert.equal(parseEvalOutput('"Example Domain"\n'), 'Example Domain');
  assert.equal(parseEvalOutput('42\n'), 42);
  assert.equal(parseEvalOutput('null'), null);
  assert.equal(parseEvalOutput('undefined'), undefined);
  assert.equal(parseEvalOutput(''), undefined);
  assert.deepEqual(parseEvalOutput('{"a":1}'), { a: 1 });
  assert.equal(parseEvalOutput('plain words'), 'plain words');
});

test('the bridge advances arguments as an argv array', async () => {
  const bridge = new CliBridge({ session: 'probe-argv', command: 'playwright-cli' });
  bridge.plan = {
    file: process.execPath,
    prefix: [script('argv', 'console.log(JSON.stringify(process.argv.slice(2)));\n')],
  };
  const result = await bridge.run(['--raw', 'fill', 'e12', 'a "quoted" ] (title) $env:PATH']);
  const argv = JSON.parse(result.stdout);
  assert.deepEqual(argv, ['-s=probe-argv', '--raw', 'fill', 'e12', 'a "quoted" ] (title) $env:PATH']);
});

test('a non-zero exit rejects with the parsed detail', async () => {
  const bridge = new CliBridge({ session: 'probe-fail', command: 'playwright-cli' });
  bridge.plan = {
    file: process.execPath,
    prefix: [script('fail', 'console.error("boom: bad ref"); process.exit(3);\n')],
  };
  await assert.rejects(() => bridge.run(['--raw', 'click', 'e99']), (error) => {
    assert.equal(error.code, 'CLI_EXIT');
    assert.equal(error.exitCode, 3);
    assert.match(error.message, /boom: bad ref/);
    return true;
  });
});

test('a hung CLI client is killed at the deadline and reported as a timeout', async () => {
  const bridge = new CliBridge({ session: 'probe-hang', command: 'playwright-cli', timeoutMs: 300 });
  bridge.plan = { file: process.execPath, prefix: [HANG] };
  await assert.rejects(() => bridge.run(['--raw', 'snapshot']), (error) => {
    assert.equal(error.code, 'CLI_TIMEOUT');
    return true;
  });
});

test('an aborted call stops the child immediately', async () => {
  const bridge = new CliBridge({ session: 'probe-abort', timeoutMs: 30_000 });
  bridge.plan = { file: process.execPath, prefix: [HANG] };
  const controller = new AbortController();
  const pending = bridge.run(['--raw', 'snapshot'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(() => pending, (error) => error.code === 'CLI_ABORTED');
});
