import { Bridge, readJsonBody } from './src/bridge.js';
import { Runtime } from './src/runtime.js';
import { createTools } from './src/tools.js';

/**
 * Host half of the DSH sidebar-browser automation plugin.
 *
 *   tools (browser_*)  →  Runtime  →  PageDriver  →  playwright-cli
 *                                  ↘  Bridge  ←→  client.js (DSH page)
 *
 * The Client half exists for exactly one reason: `ctx.sidebarRight.openTab` is
 * the only supported way to create a sidebar tab, and it lives in the page. The
 * bridge carries that one request; every page operation goes through the CLI.
 */

export const name = '@local/dsh-browser-automation';

export const inject = ['tools', 'webServer'];

/**
 * Route prefix for the page bridge. The page requests it as a document-relative
 * URL (`dsh-browser-automation/bridge/<action>`), which is what makes one code
 * path work in both carriers: the Web app resolves it against its own origin,
 * and Desktop forwards `dsh-app://app/<path>` to the Host's loopback port.
 *
 * The route table matches a prefix as `pathname === prefix || pathname.startsWith(prefix + '/')`,
 * so the registered path must NOT carry a trailing slash: `/x/bridge/` would only
 * ever match `/x/bridge//…` and silently fall through to the SPA handler, which
 * answers 404 to GET and 405 to POST.
 */
const ROUTE_PREFIX = '/dsh-browser-automation/bridge/';
const ROUTE_REGISTRATION = ROUTE_PREFIX.slice(0, -1);

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  const settings = {
    session: 'dsh',
    command: 'playwright-cli',
    nodePath: 'auto',
    cdpUrl: 'http://127.0.0.1:9222',
    timeoutMs: 20_000,
    requestTimeoutMs: 20_000,
    debug: false,
    ...(config ?? {}),
  };

  const debug = settings.debug === true;
  const log = (message) => {
    if (!debug) return;
    // eslint-disable-next-line no-console
    console.debug(`[dsh-browser-automation] ${message}`);
  };

  const runtime = new Runtime({ config: settings, log });
  const bridge = new Bridge({ requestTimeoutMs: Number(settings.requestTimeoutMs), log });
  runtime.bridge = bridge;
  const health = { bridgeError: null };
  runtime.health = health;

  ctx.effect(
    () => {
      let dispose;
      try {
        dispose = ctx.webServer.register({
          kind: 'prefix',
          path: ROUTE_REGISTRATION,
          handler: (request, response) => serve({ request, response, bridge, settings, log }),
        });
      } catch (error) {
        // A bridge that cannot mount must not cost the CLI tools: every page
        // operation still works, only browser_open loses its native path.
        health.bridgeError = error?.message ?? String(error);
        // eslint-disable-next-line no-console
        console.warn(`[dsh-browser-automation] page bridge could not mount: ${health.bridgeError}`);
      }
      return () => {
        if (dispose) dispose();
        bridge.dispose();
      };
    },
    'dsh-browser-automation: page bridge',
  );

  ctx.effect(
    () => () => {
      runtime.dispose();
    },
    'dsh-browser-automation: playwright-cli processes',
  );

  const tools = createTools(runtime);
  for (const tool of tools) {
    ctx.tools.register(tool);
  }

  log(`mounted ${tools.length} tools; bridge at ${ROUTE_PREFIX}`);
}

/**
 * Serve the Host <-> page bridge.
 *
 * A page announces itself, long-polls for one command, and posts one result. The
 * route carries no page content and no credentials of its own: it refuses
 * non-loopback sockets and requests a browser marks as cross-site, which is the
 * same fence the app's own API applies. Nothing here is reachable off-machine.
 *
 * @param {object} input
 * @param {import('node:http').IncomingMessage} input.request
 * @param {import('node:http').ServerResponse} input.response
 * @param {Bridge} input.bridge
 * @param {Record<string, unknown>} input.settings
 * @param {(message: string) => void} input.log
 */
async function serve({ request, response, bridge, settings, log }) {
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type');
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (!isLoopback(request.socket?.remoteAddress)) {
    reply(response, 403, { ok: false, error: 'the browser bridge only answers loopback requests' });
    return;
  }
  if (request.method !== 'POST') {
    reply(response, 405, { ok: false, error: 'the browser bridge accepts POST only' });
    return;
  }
  if (String(request.headers['sec-fetch-site'] ?? '') === 'cross-site') {
    reply(response, 403, { ok: false, error: 'cross-site requests are refused' });
    return;
  }

  let body;
  try {
    body = (await readJsonBody(request)) ?? {};
  } catch (error) {
    reply(response, 400, { ok: false, error: error.message });
    return;
  }

  const action = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    .slice(ROUTE_PREFIX.length)
    .replace(/\/+$/, '');

  try {
    switch (action) {
      case 'hello': {
        const clientId = String(body.clientId ?? '');
        if (!clientId) {
          reply(response, 400, { ok: false, error: 'hello requires a clientId' });
          return;
        }
        const welcome = bridge.hello(clientId, {
          origin: body.origin ?? null,
          href: body.href ?? null,
          hasSidebarRight: body.hasSidebarRight === true,
          mounted: body.mounted ?? null,
          protocol: body.protocol ?? null,
        });
        reply(response, 200, { ok: true, value: welcome });
        return;
      }
      case 'poll': {
        const clientId = String(body.clientId ?? '');
        const waitMs = Number(body.waitMs ?? settings.requestTimeoutMs) || 15_000;
        const command = await bridge.nextCommand(clientId, waitMs, abortOnClose(request, response));
        reply(response, 200, { ok: true, value: { command: command ?? null } });
        return;
      }
      case 'result': {
        log(`page answered ${String(body.requestId)}: ok=${body.ok}`);
        reply(response, 200, { ok: true, value: bridge.submitResult(body) });
        return;
      }
      default:
        reply(response, 404, { ok: false, error: `unknown bridge action "${action}"` });
    }
  } catch (error) {
    log(`bridge failure on ${action}: ${error.message}`);
    reply(response, 500, { ok: false, error: error.message });
  }
}

/**
 * A held poll must end when the page navigates away, or its waiter lingers until
 * the deadline.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
function abortOnClose(request, response) {
  const controller = new AbortController();
  const abort = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.on('close', abort);
  response.on('close', abort);
  return controller.signal;
}

/** @param {string | undefined} address */
function isLoopback(address) {
  if (!address) return false;
  const value = address.replace(/^::ffff:/, '');
  return value === '::1' || value === '127.0.0.1' || value.startsWith('127.');
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
function reply(response, status, body) {
  if (response.writableEnded) return;
  const text = JSON.stringify(body ?? null);
  response.writeHead(status, { 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

