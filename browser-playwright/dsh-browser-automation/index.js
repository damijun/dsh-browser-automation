import { Bridge } from './src/bridge.js';
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
 * bridge carries that one request over the app's own authenticated RPC channel;
 * every page operation goes through the CLI.
 */

export const name = '@local/dsh-browser-automation';

/**
 * `connection` mounts the authenticated RPC channel the page half polls, and
 * `webServer` is required by that channel itself: `ctx.connection.rpc.handle`
 * registers its route through the caller's context, so the service has to be in
 * this plugin's inject list even though the plugin never touches it directly.
 */
export const inject = ['tools', 'connection', 'webServer'];

/**
 * One channel, four endpoints. `ctx.connection.rpc` mounts this as a top-level
 * authenticated namespace on the app's own carrier, so the same code serves the
 * Web app (same-origin cookie) and Desktop (the shell injects the cookie when it
 * forwards `dsh-app://app/<path>` to the Host).
 */
const CHANNEL = '/dsh-browser-automation';

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  const settings = {
    session: 'dsh',
    command: 'playwright-cli',
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

  ctx.effect(
    () => {
      let dispose;
      try {
        dispose = ctx.connection.rpc.handle(CHANNEL, (endpoint, payload, signal) =>
          serve({ bridge, endpoint, payload, signal, settings, log }),
        );
      } catch (error) {
        // A bridge that cannot mount must not cost the CLI tools: every page
        // operation still works, only browser_open loses its native path.
        health.bridgeError = error?.message ?? String(error);
        // eslint-disable-next-line no-console
        console.warn(`[dsh-browser-automation] page bridge could not mount: ${health.bridgeError}`);
      }
      return () => {
        if (dispose) void Promise.resolve(dispose()).catch(() => {});
        bridge.dispose();
      };
    },
    'dsh-browser-automation: page bridge',
  );
  runtime.health = health;

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

  log(`mounted ${tools.length} tools on ${CHANNEL}`);
}

/**
 * Dispatch one bridge endpoint. The envelope shape is fixed by
 * `ctx.connection.rpc`: `{ ok: true, value }` or `{ ok: false, error }`, and a
 * throw would surface as an HTTP 500 in the page instead of a readable error.
 *
 * @param {object} input
 * @param {Bridge} input.bridge
 * @param {string} input.endpoint
 * @param {unknown} input.payload
 * @param {AbortSignal} [input.signal]
 * @param {Record<string, unknown>} input.settings
 * @param {(message: string) => void} input.log
 */
async function serve({ bridge, endpoint, payload, signal, settings, log }) {
  /** @type {Record<string, unknown>} */
  const body = payload && typeof payload === 'object' ? payload : {};
  try {
    switch (endpoint) {
      case 'hello': {
        const clientId = String(body.clientId ?? '');
        if (!clientId) return failure('BRIDGE_NO_CLIENT_ID', 'hello requires a clientId');
        const welcome = bridge.hello(clientId, {
          origin: body.origin ?? null,
          href: body.href ?? null,
          hasSidebarRight: body.hasSidebarRight === true,
          mounted: body.mounted ?? null,
          protocol: body.protocol ?? null,
        });
        return { ok: true, value: welcome };
      }
      case 'poll': {
        const clientId = String(body.clientId ?? '');
        const waitMs = Number(body.waitMs ?? settings.requestTimeoutMs) || 15_000;
        const command = await bridge.nextCommand(clientId, waitMs, signal);
        return { ok: true, value: { command: command ?? null } };
      }
      case 'result': {
        log(`page answered ${String(body.requestId)}: ok=${body.ok}`);
        return { ok: true, value: bridge.submitResult(body) };
      }
      case 'status': {
        return {
          ok: true,
          value: {
            bridge: bridge.snapshot(),
            cdpUrl: String(settings.cdpUrl),
            session: String(settings.session),
          },
        };
      }
      default:
        return failure('BRIDGE_UNKNOWN_ENDPOINT', `unknown bridge endpoint "${endpoint}"`);
    }
  } catch (error) {
    log(`bridge failure on ${endpoint}: ${error.message}`);
    return failure('BRIDGE_FAILURE', error.message);
  }
}

/**
 * @param {string} code
 * @param {string} message
 */
function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}
