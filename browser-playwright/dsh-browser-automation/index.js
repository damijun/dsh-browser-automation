import { Bridge, readJsonBody } from './src/bridge.js';
import { Config } from './src/config.js';
import { applyConfigChange, composeConfigValues, findRow, resetConfigKey } from './src/config-write.js';
import { Runtime } from './src/runtime.js';
import { createTools } from './src/tools.js';

export { Config };

/**
 * Read one configuration value.
 *
 * Fields declared `.volatile()` (every user-facing knob, so the settings form can
 * edit them) arrive as reference objects read with `.get()`, while anything else
 * arrives as ordinary data. This helper accepts both, so the plugin keeps working
 * whichever way a field is declared.
 *
 * @param {unknown} value
 * @param {unknown} fallback
 */
const read = (value, fallback) => {
  if (value && typeof (/** @type {any} */ (value).get) === 'function') {
    const got = /** @type {any} */ (value).get();
    return got === undefined ? fallback : got;
  }
  return value === undefined ? fallback : value;
};

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
 * Identity of this plugin's Loader row.
 *
 * The settings page seats configuration by package name and row id: a bundle's own
 * configuration lives in `plugins.bundle.config` keyed by PACKAGE_NAME, and the row
 * id is what the settings service addresses when it builds a form for one entry.
 */
const PACKAGE_NAME = '@local/dsh-browser-automation';
const ROW_ID = 'browser-automation';

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  const source = config ?? {};
  const settings = {
    session: read(source.session, 'dsh'),
    command: read(source.command, 'playwright-cli'),
    nodePath: read(source.nodePath, 'auto'),
    // Where Chromium records the port it really bound — written next to the app's
    // user data. There is deliberately no port setting: the launch argument decides
    // the port, and this record is the only way that decision reaches the plugin.
    cdpPortFile: read(source.cdpPortFile, 'auto'),
    autoAttach: read(source.autoAttach, true) !== false,
    timeoutMs: read(source.timeoutMs, 20_000),
    requestTimeoutMs: read(source.requestTimeoutMs, 20_000),
    attachTimeoutMs: read(source.attachTimeoutMs, 60_000),
    screenshotTimeoutMs: read(source.screenshotTimeoutMs, 25_000),
    screenshotSettleMs: read(source.screenshotSettleMs, 1_200),
    debug: read(source.debug, false) === true,
  };
  // Plain copy for read-out: the settings card shows what this row is running with,
  // whether or not it can reach the form model.
  settings.effective = {
    session: settings.session,
    command: settings.command,
    nodePath: settings.nodePath,
    autoAttach: settings.autoAttach,
    timeoutMs: settings.timeoutMs,
    requestTimeoutMs: settings.requestTimeoutMs,
    attachTimeoutMs: settings.attachTimeoutMs,
    screenshotTimeoutMs: settings.screenshotTimeoutMs,
    screenshotSettleMs: settings.screenshotSettleMs,
    debug: settings.debug,
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

  /**
   * Attach before the user opens anything.
   *
   * playwright-cli only adopts sidebar pages created after it attached, so this moves
   * the boundary to startup — the one window nobody notices. It is scheduled, never
   * awaited: activation must stay fast, and a failure is reported through
   * `browser_status` instead of failing the row (a failed row would break web boot).
   */
  ctx.effect(
    () => {
      runtime.scheduleAutoAttach({
        delayMs: Number(settings.autoAttachDelayMs ?? 500),
        attempts: Number(settings.autoAttachAttempts ?? 10),
        backoffMs: Number(settings.autoAttachBackoffMs ?? 800),
      });
      return () => {
        runtime.cancelAutoAttach?.();
      };
    },
    'dsh-browser-automation: startup attach',
  );

  /**
   * The Host's config editor, when this composition has one.
   *
   * Read with `ctx.get` instead of `inject`: the plugin must keep working on a Host
   * without that service, where the settings card is simply read-only.
   */
  const configEditor = () => {
    try {
      return ctx.get('configEditor') ?? null;
    } catch {
      return null;
    }
  };

  ctx.effect(
    () => {
      let dispose;
      try {
        dispose = ctx.webServer.register({
          kind: 'prefix',
          path: ROUTE_REGISTRATION,
          handler: (request, response) =>
            serve({ request, response, runtime, bridge, settings, log, configEditor, fiber: () => ctx.fiber }),
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
 * A page announces itself, long-polls for one command, and posts one result; the
 * panel tab reads the same route for a status snapshot. The route carries no page
 * content and no credentials of its own: it refuses non-loopback sockets and
 * requests a browser marks as cross-site, which is the same fence the app's own
 * API applies. Nothing here is reachable off-machine.
 *
 * @param {object} input
 * @param {import('node:http').IncomingMessage} input.request
 * @param {import('node:http').ServerResponse} input.response
 * @param {import('./src/runtime.js').Runtime} input.runtime
 * @param {Bridge} input.bridge
 * @param {Record<string, unknown>} input.settings
 * @param {(message: string) => void} input.log
 * @param {() => any} input.configEditor
 * @param {() => any} input.fiber
 */
async function serve({ request, response, runtime, bridge, settings, log, configEditor, fiber }) {
  // Read lazily: the fiber is the identity `findRow` prefers, but it is only
  // guaranteed once the row is settled.
  const ownFiber = typeof fiber === 'function' ? fiber() : fiber;
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
      case 'config': {
        // The settings card's read path: the configuration the patch describes, not the
        // one this instance booted with.
        //
        // A write only reaches the profile patch; the running row keeps its booted
        // values until the Loader re-applies it (a restart).
        // Reporting the booted copy made the card snap back to the old value after every
        // save, so the base here is the patch truth: schema/bundle values for this row
        // (the booted copy is the fallback for keys the layers do not mention) with the
        // profile override on top.
        const editor = configEditor();
        let reason = null;
        let row = null;
        if (!editor) {
          reason = 'this Host does not expose configEditor';
        } else {
          row = findRow(editor, ROW_ID, ownFiber);
          if (!row) {
            // Only name the rows that look like this plugin's: dumping every entry
            // (~150) would bury the one line that matters.
            let near = [];
            try {
              near = (editor.entries() ?? [])
                .map((entry) => (entry && entry.id ? String(entry.id) : ''))
                .filter((id) => id.includes('browser'));
            } catch {
              near = [];
            }
            reason = `no profile row "${ROW_ID}"${near.length ? ` (rows like: ${near.join(', ')})` : ''}`;
          }
        }
        // The override layer, so the card can badge and reset exactly the keys this
        // profile decided on instead of guessing from the values.
        let overrides = {};
        let inherited = {};
        if (row) {
          try {
            const layer = (editor.configuration() ?? []).find(
              (entry) => entry && (entry.entry === row || entry.entry?.id === row.id),
            );
            if (layer && layer.override && typeof layer.override === 'object') overrides = { ...layer.override };
            if (layer && layer.inherited && typeof layer.inherited === 'object') inherited = { ...layer.inherited };
          } catch {
            overrides = {};
            inherited = {};
          }
        }
        const values = composeConfigValues({ base: runtime.config?.effective, inherited, override: overrides });
        reply(response, 200, {
          ok: true,
          value: {
            values,
            packageName: PACKAGE_NAME,
            rowId: ROW_ID,
            editable: Boolean(row),
            reason,
            overrides,
          },
        });
        return;
      }
      case 'config-set': {
        const editor = configEditor();
        if (!editor) {
          reply(response, 501, { ok: false, error: 'this Host does not expose configEditor, so settings are read-only' });
          return;
        }
        const key = String(body.key ?? '');
        const value = await applyConfigChange({ editor, rowId: ROW_ID, fiber: ownFiber, key, value: body.value });
        reply(response, 200, { ok: true, value: { key, value } });
        return;
      }
      case 'config-reset': {
        const editor = configEditor();
        if (!editor) {
          reply(response, 501, { ok: false, error: 'this Host does not expose configEditor, so settings are read-only' });
          return;
        }
        await resetConfigKey({ editor, rowId: ROW_ID, fiber: ownFiber, key: String(body.key ?? '') });
        reply(response, 200, { ok: true, value: { key: String(body.key ?? '') } });
        return;
      }
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
        // Every poll refreshes what the window can see, so status never shows a
        // stale "no session surface" after the user opens a panel or switches.
        if (body.capabilities && typeof body.capabilities === 'object') {
          bridge.note(clientId, body.capabilities);
        }
        const command = await bridge.nextCommand(clientId, waitMs, abortOnClose(request, response));
        reply(response, 200, { ok: true, value: { command: command ?? null } });
        return;
      }
      case 'result': {
        log(`page answered ${String(body.requestId)}: ok=${body.ok}`);
        reply(response, 200, { ok: true, value: bridge.submitResult(body) });
        return;
      }
      case 'shared-state': {
        // The overlay badge asks whether the visible sidebar tab is one this Host
        // controls. It cannot read the page's in-page identity, and titles no longer
        // carry one, so this is a memory lookup here.
        const tabId = String(body.tabId ?? '');
        const url = String(body.url ?? '');
        reply(response, 200, { ok: true, value: runtime.sharedTab({ tabId, url }) });
        return;
      }
      case 'status': {
        // The panel tab reads this. It is the same snapshot browser_status returns,
        // so the UI never has to re-derive plugin state on its own.
        const sessionId = String(body.sessionId ?? '');
        if (!sessionId) {
          reply(response, 400, { ok: false, error: 'status requires a sessionId' });
          return;
        }
        const requested = String(body.action ?? 'status');
        const allowed = requested === 'detach' || requested === 'attach' ? requested : 'status';
        const snapshot = await runtime.status({ sessionId, action: allowed });
        reply(response, 200, { ok: true, value: snapshot });
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












