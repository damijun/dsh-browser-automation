import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  ACTIVE_PORT_FILE,
  defaultActivePortFile,
  parseActivePort,
  probeCdp,
  portIsFree,
  readActivePort,
  resolveCdpTarget,
} from '../src/cdp-target.js';
import { Runtime } from '../src/runtime.js';

/** Temp dir for `DevToolsActivePort` fixtures; one per run, removed by `after`. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-target-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let serial = 0;
function portFile(contents) {
  const file = path.join(scratch, `active-port-${(serial += 1)}`);
  fs.writeFileSync(file, contents);
  return file;
}

/** A real HTTP server answering `/json/version`, so the probe paths are not stubbed. */
function devtoolsServer(body) {
  const server = http.createServer((request, response) => {
    if (request.url === '/json/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  // `close()` alone waits for the sockets the probe left open, and the test run would
  // hang on it instead of failing. http.Server can drop them itself; a raw net.Server
  // cannot (it has no closeAllConnections), so the blackhole fixture tracks its own.
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.destroyAll?.();
    server.close(resolve);
  });
}

/**
 * A listener that accepts a connection and then says nothing — the shape of the
 * leftover debugging endpoint. `resolveCdpTarget` must give up on it and classify the
 * port, not wait for an answer that never comes.
 */
function blackhole() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.destroyAll = () => {
    for (const socket of sockets) socket.destroy();
  };
  return server;
}

/** A port nothing listens on (an ephemeral one the OS just freed). */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await close(server);
  return port;
}

describe('DevToolsActivePort parsing', () => {
  it('reads the port Chromium recorded, with its browser path', () => {
    const entry = parseActivePort('64440\n/devtools/browser/cb61d15d-0000-0000-0000-000000000000\n');
    assert.equal(entry.port, 64440);
    assert.equal(entry.browserPath, '/devtools/browser/cb61d15d-0000-0000-0000-000000000000');
  });

  it('treats a half-written or nonsensical file as no answer', () => {
    for (const text of ['', '\n', 'abc\n/devtools/browser/x', '0\n/devtools/browser/x', '70000\n', undefined]) {
      assert.equal(parseActivePort(text), undefined, `accepted ${JSON.stringify(text)}`);
    }
  });

  it('keeps the port even when the second line is not a browser path', () => {
    // Chromium updates the port line first; the browser path can lag behind.
    const entry = parseActivePort('63333\n');
    assert.equal(entry.port, 63333);
    assert.equal(entry.browserPath, undefined);
  });

  it('reads from disk and answers undefined for a missing file', () => {
    const file = portFile('51234\n/devtools/browser/abc\n');
    assert.deepEqual(readActivePort(file), { port: 51234, browserPath: '/devtools/browser/abc' });
    assert.equal(readActivePort(path.join(scratch, 'does-not-exist')), undefined);
    assert.equal(readActivePort(undefined), undefined);
  });

  it('locates the record in the app user-data directory', () => {
    assert.equal(
      defaultActivePortFile({ APPDATA: path.join('C:', 'Users', 'x', 'AppData', 'Roaming') }),
      path.join('C:', 'Users', 'x', 'AppData', 'Roaming', '@deepseek-ai', 'dsh-desktop', ACTIVE_PORT_FILE),
    );
    assert.equal(defaultActivePortFile({}), undefined);
  });
});

describe('probing the endpoint', () => {
  it('accepts a live DevTools server', async () => {
    const body = { webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/x', Browser: 'Chrome/152' };
    const { server, port } = await devtoolsServer(body);
    try {
      assert.deepEqual(await probeCdp(`http://127.0.0.1:${port}`), body);
    } finally {
      await close(server);
    }
  });

  it('rejects a socket that answers something else', async () => {
    const { server, port } = await devtoolsServer({ Browser: 'Chrome/152' });
    try {
      assert.equal(await probeCdp(`http://127.0.0.1:${port}`), undefined);
    } finally {
      await close(server);
    }
  });

  it('rejects a refused connection without throwing', async () => {
    assert.equal(await probeCdp(`http://127.0.0.1:${await freePort()}`), undefined);
  });

  it('reports a port as taken only while a listener holds it', async () => {
    const { server, port } = await devtoolsServer({});
    assert.equal(await portIsFree(port), false);
    await close(server);
    assert.equal(await portIsFree(port), true);
  });
});

describe('choosing the endpoint', () => {
  it('follows the port Chromium recorded', async () => {
    const recorded = await devtoolsServer({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/recorded' });
    try {
      const file = portFile(`${recorded.port}\n/devtools/browser/x\n`);
      const target = await resolveCdpTarget({ portFile: file });
      assert.equal(target.port, recorded.port);
      assert.equal(target.diagnosis, 'serving');
      assert.equal(target.activePort, recorded.port);
      assert.equal(target.url, `http://127.0.0.1:${recorded.port}`);
      assert.equal(target.file, file);
    } finally {
      await close(recorded.server);
    }
  });

  it('says "no-record" when there is nothing to follow', async () => {
    const target = await resolveCdpTarget({ portFile: path.join(scratch, 'no-such-file') });
    assert.equal(target.diagnosis, 'no-record');
    assert.equal(target.port, null);
    assert.equal(target.url, undefined);
  });

  it('says "absent" when the recorded port is free and silent', async () => {
    // A stale record: the previous run used this port, this one has no DevTools server.
    const port = await freePort();
    const file = portFile(`${port}\n/devtools/browser/x\n`);
    const target = await resolveCdpTarget({ portFile: file });
    assert.equal(target.diagnosis, 'absent');
    assert.equal(target.port, port);
  });

  it('says "stale" when the recorded port is held but nothing answers', async () => {
    // A listener that accepts and never speaks is exactly the leaked endpoint.
    const port = await freePort();
    const holder = blackhole();
    await new Promise((resolve) => holder.listen(port, '127.0.0.1', resolve));
    try {
      const file = portFile(`${port}\n/devtools/browser/x\n`);
      const target = await resolveCdpTarget({ portFile: file });
      assert.equal(target.diagnosis, 'stale');
      assert.equal(target.port, port);
    } finally {
      await close(holder);
    }
  });
});

describe('attach messages', () => {
  /** A runtime whose discovery is fully injected: no file, no socket, no CLI. */
  function stubbed({ readPort, probe, portFree, ensureAttached }) {
    const runtime = new Runtime({ config: { cdpPortFile: 'auto' } });
    runtime.cdpReadPort = readPort ?? (() => undefined);
    runtime.cdpProbe = probe ?? (async () => undefined);
    runtime.cdpPortFree = portFree ?? (async () => true);
    runtime.driver = { cdpUrl: '', ensureAttached };
    return runtime;
  }

  const attachError = () => {
    const error = new Error("playwright-cli attach exited with code 1: code: 'ECONNREFUSED'");
    return error;
  };

  it('follows the recorded port all the way into the driver', async () => {
    const runtime = stubbed({
      readPort: () => ({ port: 64001 }),
      probe: async (url) => (url.endsWith(':64001') ? { webSocketDebuggerUrl: 'ws://x/1' } : undefined),
      ensureAttached: async () => [{ id: 'page-1' }],
    });
    assert.deepEqual(await runtime.attach(), [{ id: 'page-1' }]);
    assert.equal(runtime.driver.cdpUrl, 'http://127.0.0.1:64001');
    assert.equal(runtime.attached, true);
  });

  it('blames the leftover endpoint, not the missing flag, when the port is held', async () => {
    const runtime = stubbed({
      readPort: () => ({ port: 64000 }),
      portFree: async () => false,
      ensureAttached: async () => {
        throw attachError();
      },
    });
    await assert.rejects(runtime.attach(), (error) => {
      assert.match(error.message, /Could not attach playwright-cli to DSH at http:\/\/127\.0\.0\.1:64000\./);
      assert.match(error.message, /Port 64000 is held but nothing answers on it/);
      assert.match(error.message, /inherited by a helper process that outlived the app/);
      assert.match(error.message, /Launching with --remote-debugging-port=0 prevents this/);
      // The old advice — edit the shortcut to pin the port — is wrong for this case.
      assert.doesNotMatch(error.message, /append --remote-debugging-port=64000 to the shortcut/);
      assert.match(error.message, /Underlying error: playwright-cli attach exited with code 1/);
      assert.equal(error.cause.message, "playwright-cli attach exited with code 1: code: 'ECONNREFUSED'");
      return true;
    });
    assert.equal(runtime.attached, false);
    assert.equal(runtime.cdp.diagnosis, 'stale');
  });

  it('explains that a stale record means DSH is down or started without the flag', async () => {
    const runtime = stubbed({
      readPort: () => ({ port: 64000 }),
      portFree: async () => true,
      ensureAttached: async () => {
        throw attachError();
      },
    });
    await assert.rejects(runtime.attach(), (error) => {
      assert.match(error.message, /names port 64000, but nothing answers there and the port is free/);
      assert.match(error.message, /running without --remote-debugging-port/);
      assert.match(error.message, /append --remote-debugging-port=0 to the shortcut/);
      assert.match(error.message, /playwright-cli list/);
      return true;
    });
    assert.equal(runtime.cdp.diagnosis, 'absent');
  });

  it('explains that there is nothing to follow when no record exists', async () => {
    const runtime = stubbed({
      ensureAttached: async () => {
        throw attachError();
      },
    });
    await assert.rejects(runtime.attach(), (error) => {
      assert.match(error.message, /Could not find the DSH DevTools endpoint: there is no usable DevToolsActivePort record/);
      assert.match(error.message, /only opens a debugging endpoint when it is started with --remote-debugging-port/);
      assert.match(error.message, /--remote-debugging-port=0/);
      assert.match(error.message, /playwright-cli list/);
      return true;
    });
    assert.equal(runtime.cdp.diagnosis, 'no-record');
  });

  it('reports the resolved endpoint in status, not a configured guess', async () => {
    const runtime = stubbed({
      readPort: () => ({ port: 64002 }),
      probe: async (url) => (url.endsWith(':64002') ? { webSocketDebuggerUrl: 'ws://x/2' } : undefined),
      ensureAttached: async () => [],
    });
    const status = await runtime.status({ action: 'status' });
    assert.equal(status.cdpUrl, 'http://127.0.0.1:64002');
    assert.equal(status.cdp.port, 64002);
    assert.equal(status.cdp.diagnosis, 'serving');
    assert.equal(status.cdp.source, undefined, 'source is gone: there is only one source now');
    assert.equal(typeof status.cdp.file, 'string');
  });
});
