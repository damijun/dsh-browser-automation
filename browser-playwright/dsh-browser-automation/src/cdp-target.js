import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * Finding the CDP endpoint Electron actually opened.
 *
 * Why this module exists: the port is not something this plugin can assume.
 *
 * Chromium binds `--remote-debugging-port=<n>` **once**, at startup. If that bind
 * fails, the process keeps running with no DevTools server at all, and no client
 * can bring one back — the plugin then sees a connection refused and cannot tell
 * "DSH was started without the flag" from "DSH was started with the flag and lost
 * the port". Those are different failures with different fixes, and this module
 * separates them.
 *
 * The losing case is real and recurring on Windows. A debugging port that the app
 * bound in an earlier run can be inherited by a child process that outlives the
 * app; the listener then stays bound to 127.0.0.1 forever (netstat keeps showing
 * the now-dead creator PID), and the next DSH instance silently fails to bind it.
 * `--remote-debugging-port=0` removes the collision entirely: Chromium picks a
 * free port on every launch and records it, so the previous run's leftover can
 * never be in the way. What the plugin has to do is stop hard-coding 9222 and
 * read that record.
 *
 * `DevToolsActivePort` (in the Electron user-data directory) is that record:
 *
 *     63333
 *     /devtools/browser/3e7c0ea3-547d-4b8d-bbf3-f78850b1273c
 *
 * Chromium writes it whenever the DevTools server starts, port 0 or not, and it
 * is also what `webSocketDebuggerUrl` is built from. The file is not removed on
 * exit, so it can be stale — which is why a candidate is only trusted after it
 * answers `/json/version`.
 */

/** File name Chromium uses for the port it really bound. */
export const ACTIVE_PORT_FILE = 'DevToolsActivePort';

const HOST = '127.0.0.1';

/**
 * Where DSH Desktop keeps `DevToolsActivePort`.
 *
 * Electron writes it into the user-data directory, which this app names after its
 * package (`--user-data-dir=…\@deepseek-ai\dsh-desktop`). An absolute `cdpPortFile`
 * setting wins over this guess, which keeps the plugin usable if the app ever
 * renames that directory.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function defaultActivePortFile(env = process.env) {
  const root = env.APPDATA || env.LOCALAPPDATA || '';
  if (root === '') return undefined;
  return path.join(root, '@deepseek-ai', 'dsh-desktop', ACTIVE_PORT_FILE);
}

/**
 * Parse the two-line file. Anything unexpected is "no answer" rather than a throw:
 * a half-written file during startup is normal, not an error.
 *
 * @param {unknown} text
 * @returns {{ port: number, browserPath?: string } | undefined}
 */
export function parseActivePort(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim());
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const browserPath = /^\/devtools\/browser\/\S+$/.test(lines[1] ?? '') ? lines[1] : undefined;
  return { port, browserPath };
}

/**
 * @param {string | undefined} file
 * @returns {{ port: number, browserPath?: string } | undefined}
 */
export function readActivePort(file) {
  if (!file) return undefined;
  try {
    return parseActivePort(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Is a real DevTools server listening here?
 *
 * A bare TCP connect is not enough: the leaked endpoint accepts the handshake and
 * then never answers (or, as observed, resets it), which looks exactly like a
 * working socket at the TCP layer. `/json/version` is the smallest request that
 * only a live server can answer.
 *
 * @param {string} url e.g. `http://127.0.0.1:63333`
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ webSocketDebuggerUrl: string, Browser?: string } | undefined>}
 */
export async function probeCdp(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 600);
  const base = String(url ?? '').replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    const body = await response.json();
    if (typeof body?.webSocketDebuggerUrl !== 'string') return undefined;
    return body;
  } catch {
    return undefined;
  }
}

/**
 * Can this process bind the port? The complement of what the app tried to do.
 *
 * `exclusive` matters: it is the same rule Chromium's listener has to satisfy, so
 * "false" here means "the next DSH launch will fail too", not merely "something is
 * sleeping on the port".
 *
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<boolean>}
 */
export function portIsFree(port, host = HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Which endpoint should the CLI attach to?
 *
 * One source, because only one exists: the port Chromium recorded in
 * `DevToolsActivePort`. The launch argument decides what DSH listens on — `=0` picks a
 * random port, `=N` pins N, no flag means no endpoint at all — and nothing inside this
 * plugin can move or create it. The record is therefore the only honest answer to
 * "where is it?"; a configured port would be a second guess that is redundant when it
 * agrees and wrong when it does not.
 *
 * Nothing answering is a normal outcome, not an exception: the caller retries (the
 * startup attach does) and turns `diagnosis` into the message the user needs.
 *
 * `diagnosis`:
 *  - `serving`   — the recorded port answered; `url` is the one to use.
 *  - `absent`    — the recorded port is free and silent. DSH is not running, or it is
 *                  running without the flag and the record is left over from an
 *                  earlier run. Bind succeeding is what tells this apart from…
 *  - `stale`     — the port cannot be bound and nothing answers: an earlier instance
 *                  left its listener behind and this one never got to bind.
 *  - `no-record` — there is no usable `DevToolsActivePort` at all: DSH was started
 *                  without `--remote-debugging-port`, or the record went elsewhere.
 *
 * @param {object} [options]
 * @param {string} [options.portFile] absolute path; defaults to {@link defaultActivePortFile}
 * @param {Record<string, string | undefined>} [options.env]
 * @param {(file: string | undefined) => ({ port: number } | undefined)} [options.readPort]
 * @param {(url: string) => Promise<unknown>} [options.probe]
 * @param {(port: number) => Promise<boolean>} [options.portFree]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{
 *   url: string | undefined,
 *   port: number | null,
 *   file: string | undefined,
 *   activePort: number | null,
 *   diagnosis: 'serving' | 'absent' | 'stale' | 'no-record',
 *   version?: { webSocketDebuggerUrl: string, Browser?: string },
 * }>}
 */
export async function resolveCdpTarget(options = {}) {
  const log = options.log ?? (() => {});
  const probe = options.probe ?? probeCdp;
  const readPort = options.readPort ?? readActivePort;
  const portFree = options.portFree ?? portIsFree;
  const file = options.portFile ?? defaultActivePortFile(options.env);
  const entry = readPort(file);
  const activePort = entry?.port ?? null;

  if (activePort === null) {
    log(`no ${ACTIVE_PORT_FILE} record at ${file ?? '(unknown path)'}`);
    return { url: undefined, port: null, file, activePort: null, diagnosis: 'no-record' };
  }

  const url = `http://${HOST}:${activePort}`;
  const version = await probe(url);
  if (version) {
    log(`CDP port ${activePort} came from ${file}`);
    return { url, port: activePort, file, activePort, diagnosis: 'serving', version };
  }
  log(`the recorded CDP port ${activePort} does not answer`);
  const free = await portFree(activePort);
  return { url, port: activePort, file, activePort, diagnosis: free ? 'absent' : 'stale' };
}
