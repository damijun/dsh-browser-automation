import { randomUUID } from 'node:crypto';

/**
 * Host half of the Host <-> Client channel.
 *
 * The plugin needs one thing the Host cannot do for itself: open a sidebar tab.
 * `ctx.sidebarRight.openTab()` exists only in the page, and this DSH version
 * exposes no Host->Client call path for a third-party bundle (forwarded events
 * are a build-time allowlist inside `@deepseek-ai/dsh-api-remotes`). So the two
 * halves meet over the app's own authenticated RPC channel
 * (`ctx.connection.rpc.handle` on this side, `ctx.connection.rpc.call` in the
 * page), which works unchanged in the Web app and in Desktop's IPC/scheme
 * carrier:
 *
 *   endpoint `hello`   announce a page and report its capabilities
 *   endpoint `poll`    long-poll for one queued command
 *   endpoint `result`  settle the pending request
 *   endpoint `status`  diagnostics (surfaced by browser_status)
 *
 * The channel carries no page content and no credentials of its own; the
 * connection layer authenticates every call and only owner peers reach it.
 */
export class Bridge {
  /**
   * @param {object} [options]
   * @param {number} [options.requestTimeoutMs] how long a tool waits for the page to answer
   * @param {number} [options.pollTimeoutMs]    how long one poll is held open
   * @param {(message: string) => void} [options.log]
   */
  constructor(options = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 15_000;
    /** How long a handed-over command waits for its page before being re-queued. */
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 4_000;
    this.log = options.log ?? (() => {});
    /** @type {Map<string, ClientRecord>} */
    this.clients = new Map();
    /** @type {Map<string, Pending>} */
    this.pending = new Map();
    /** @type {Command[]} */
    this.queue = [];
    /** @type {Waiter[]} */
    this.waiters = [];
    this.disposed = false;
  }

  /**
   * @param {string} clientId
   * @param {Record<string, unknown>} [info]
   */
  hello(clientId, info = {}) {
    if (!clientId) throw new Error('bridge: hello requires a clientId');
    const record = this.clients.get(clientId) ?? { clientId, seenAt: 0, capabilities: {} };
    record.seenAt = Date.now();
    record.capabilities = { ...record.capabilities, ...info };
    this.clients.set(clientId, record);
    this.log(`client ${clientId.slice(0, 8)} connected (${Object.keys(info).join(', ') || 'no capabilities'})`);
    return { ok: true, pollTimeoutMs: this.pollTimeoutMs };
  }

  /**
   * Refresh one client's capabilities without a new welcome.
   *
   * `hello` runs once per connection, but the facts it carries go stale: which
   * Session is on screen changes whenever the user opens a panel or switches
   * sessions, and the visible page changes with every sidebar click. Every poll
   * therefore carries a fresh snapshot, so `browser_status` and the panel never
   * report "no session surface" for a window that is plainly on screen.
   *
   * @param {string} clientId
   * @param {Record<string, unknown>} [info]
   */
  note(clientId, info = {}) {
    if (!clientId || !info || Object.keys(info).length === 0) return;
    const record = this.clients.get(clientId);
    if (!record) return;
    record.capabilities = { ...record.capabilities, ...info };
  }

  /**
   * Whether a page is actually listening, and whether it ever was.
   *
   * A `hello` alone is not enough: anything that can reach the loopback route
   * (a probe, a stale tab) can announce itself. Only a page that has held a poll
   * is able to receive a command. The three-way answer lets the caller tell "the
   * window never connected" (a reload fixes it) from "the page just went quiet"
   * (a retry may be enough).
   *
   * @returns {'live' | 'stale' | 'never'}
   */
  clientState() {
    const cutoff = Date.now() - 60_000;
    let polledButStale = false;
    for (const record of this.clients.values()) {
      if (record.polled !== true) continue;
      if (record.seenAt >= cutoff) return 'live';
      polledButStale = true;
    }
    return polledButStale ? 'stale' : 'never';
  }

  /** Whether a page can receive a command right now. */
  hasClient() {
    return this.clientState() === 'live';
  }

  /**
   * Hand the next command to one polling client, holding the request open until
   * a command arrives, `waitMs` elapses, or the caller disconnects. Holding a
   * poll open is what makes this a push channel instead of a polling loop.
   *
   * @param {string} clientId
   * @param {number} [waitMs]
   * @param {AbortSignal} [signal]
   * @returns {Promise<Command | null>}
   */
  nextCommand(clientId, waitMs = this.pollTimeoutMs, signal) {
    if (clientId) {
      const record = this.clients.get(clientId);
      if (record) {
        record.seenAt = Date.now();
        record.polled = true;
      } else {
        this.hello(clientId, {});
        const created = this.clients.get(clientId);
        if (created) created.polled = true;
      }
    }
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.disposed) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = { clientId, resolve, timer: undefined };
      const settle = (command) => {
        if (waiter.done) return;
        waiter.done = true;
        clearTimeout(waiter.timer);
        signal?.removeEventListener?.('abort', onAbort);
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        resolve(command);
      };
      const onAbort = () => settle(null);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      waiter.timer = setTimeout(() => settle(null), Math.max(0, Math.min(waitMs, 60_000)));
      if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  /**
   * Settle the request a command belongs to.
   *
   * @param {{ requestId?: string, ok?: boolean, value?: unknown, error?: string }} payload
   */
  submitResult(payload) {
    const requestId = payload?.requestId;
    if (!requestId) return { ok: false, error: 'bridge: result requires a requestId' };
    const pending = this.pending.get(requestId);
    if (!pending) return { ok: false, error: `bridge: no pending request ${requestId}` };
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    clearTimeout(pending.delivery);
    if (payload.ok === false) {
      pending.reject(new Error(payload.error || 'The DSH page reported a failure.'));
    } else {
      pending.resolve(payload.value);
    }
    return { ok: true };
  }

  /**
   * Queue one command and wait for the page to settle it.
   *
   * @param {string} kind
   * @param {Record<string, unknown>} [payload]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<unknown>}
   */
  request(kind, payload = {}, options = {}) {
    if (this.disposed) return Promise.reject(new Error('bridge: the plugin is shutting down'));
    if (!this.hasClient()) {
      return Promise.reject(
        new Error(
          'No DSH page is connected to the browser bridge, so a sidebar tab cannot be opened. ' +
            'Reload the DSH window (or bring the app back online) and retry.',
        ),
      );
    }
    const requestId = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    // `kind` and `requestId` are the envelope, so they win over payload fields of
    // the same name: a payload that carries its own `kind` must not be able to
    // turn an "open-tab" command into something the page does not implement.
    const command = { ...payload, requestId, kind, queuedAt: Date.now() };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.queue = this.queue.filter((entry) => entry.requestId !== requestId);
        reject(new Error(`The DSH page did not answer "${kind}" within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      this.dispatch(command);
    });
  }

  /**
   * Hand one command to the newest held poll.
   *
   * Newest first, because a page reload leaves the previous page's poll behind:
   * that socket is dead but its waiter lingers until its own timeout, and a FIFO
   * hand-off would spend the whole request timeout talking to it. Delivery is
   * also not confirmation — if the page that received the command never answers,
   * it is re-queued once for whatever polls next.
   *
   * @param {Command} command
   * @param {number} [attempt]
   */
  dispatch(command, attempt = 0) {
    const waiter = this.waiters.pop();
    if (!waiter) {
      this.queue.push(command);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(command);
    const pending = this.pending.get(command.requestId);
    if (!pending || attempt >= 1) return;
    pending.delivery = setTimeout(() => {
      if (!this.pending.has(command.requestId)) return;
      this.log(`no answer for ${command.kind}; re-queueing it for the next poll`);
      this.dispatch(command, attempt + 1);
    }, this.deliveryTimeoutMs);
    if (typeof pending.delivery.unref === 'function') pending.delivery.unref();
  }

  /** Wake every held poll (plugin unload). */
  dispose() {
    this.disposed = true;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.waiters = [];
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      clearTimeout(pending.delivery);
      pending.reject(new Error('bridge: the plugin unloaded before the page answered'));
    }
    this.pending.clear();
    this.queue = [];
  }

  /**
   * The capabilities of the most recently heard client, flat.
   *
   * Used where the answer has to be read on every call rather than rendered, e.g.
   * "is this window able to produce frames at all" before a screenshot.
   *
   * @returns {Record<string, unknown>}
   */
  caps() {
    let latest = null;
    for (const record of this.clients.values()) {
      if (!latest || record.seenAt >= latest.seenAt) latest = record;
    }
    return (latest && latest.capabilities) || {};
  }

  /** Diagnostics for `browser_status`. */
  snapshot() {
    return {
      state: this.clientState(),
      // Flattened on purpose: `clients[].mounted` reads better than
      // `clients[].capabilities.mounted`, and the raw carrier fields
      // (origin/href/protocol) collapse into one `carrier` word.
      clients: [...this.clients.values()].map((record) => {
        const caps = record.capabilities ?? {};
        return {
          clientId: record.clientId.slice(0, 8),
          seenAgoMs: Date.now() - record.seenAt,
          polled: record.polled === true,
          carrier: caps.carrier ?? null,
          hasSidebarRight: caps.hasSidebarRight === true,
          mounted: caps.mounted ?? null,
          activeTabId: caps.activeTabId ?? null,
          visibleUrl: caps.visibleUrl ?? null,
          hidden: caps.hidden ?? null,
        };
      }),
      pendingRequests: this.pending.size,
      queuedCommands: this.queue.length,
      heldPolls: this.waiters.length,
    };
  }
}

/**
 * @typedef {object} ClientRecord
 * @property {string} clientId
 * @property {number} seenAt
 * @property {Record<string, unknown>} capabilities
 */

/**
 * @typedef {object} Pending
 * @property {(value: unknown) => void} resolve
 * @property {(error: Error) => void} reject
 * @property {ReturnType<typeof setTimeout>} timer
 */

/**
 * @typedef {object} Command
 * @property {string} requestId
 * @property {string} kind
 * @property {number} queuedAt
 * @property {Record<string, unknown>} [payload]
 */

/**
 * @typedef {object} Waiter
 * @property {string} clientId
 * @property {(command: Command | null) => void} resolve
 * @property {ReturnType<typeof setTimeout>} timer
 */

/**
 * Read a JSON body from a node:http request, bounded.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {number} [maxBytes]
 * @returns {Promise<unknown>}
 */
export function readJsonBody(request, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('bridge: request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`bridge: malformed JSON body (${error.message})`));
      }
    });
  });
}
