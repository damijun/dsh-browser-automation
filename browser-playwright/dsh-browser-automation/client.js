window.__ModuleLoader__.load({
  id: '@local/dsh-browser-automation',
  factory(require) {
    /**
     * Client half of the sidebar-browser automation plugin.
     *
     * The Host owns every page operation (it runs playwright-cli). This half owns
     * the one thing the Host cannot do: create a sidebar tab, which is
     * `ctx.sidebarRight.openTab('browser', { params: { url } })`.
     *
     * The two halves meet over a route the Host serves on the app's own origin.
     * Requests are **document-relative**, which is what makes one code path work
     * in both carriers: the Web app resolves them against its own origin, and
     * Desktop forwards `dsh-app://app/<path>` to the Host's loopback port. The
     * route only answers loopback sockets and refuses cross-site requests.
     */
    const BRIDGE_PATH = 'dsh-browser-automation/bridge/';
    const CLIENT_ID_KEY = 'dsh-browser-automation:clientId';
    const POLL_WAIT_MS = 15_000;

    /** Stable id for this browser tab, so the Host can tell pages apart. */
    function clientId() {
      let id;
      try {
        id = window.sessionStorage.getItem(CLIENT_ID_KEY);
      } catch (error) {
        id = undefined;
      }
      if (!id) {
        const random =
          window.crypto && typeof window.crypto.randomUUID === 'function'
            ? window.crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        id = random;
        try {
          window.sessionStorage.setItem(CLIENT_ID_KEY, id);
        } catch (error) {
          /* private mode: the id stays in memory for this page only */
        }
      }
      return id;
    }

    /** @param {number} ms */
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * One bridge call. Resolves the route against the document base so a mounted
     * sub-path and the Desktop custom scheme both work unchanged.
     *
     * @param {string} action
     * @param {Record<string, unknown>} body
     * @param {number} [timeoutMs]
     */
    async function call(action, body, timeoutMs = 20_000) {
      const url = new URL(`${BRIDGE_PATH}${action}`, document.baseURI).href;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`bridge ${action} returned HTTP ${response.status} ${detail.slice(0, 200)}`);
        }
        const reply = await response.json();
        if (!reply || reply.ok !== true) {
          throw new Error(reply && reply.error ? reply.error : `bridge ${action} failed`);
        }
        return reply.value;
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * @param {import('@deepseek-ai/cordis').Context} ctx
     */
    function apply(ctx) {
      const id = clientId();
      let stopped = false;
      let connected = false;
      let failureStreak = 0;

      const sidebar = () => ctx.sidebarRight;

      /**
       * The web page the user is actually looking at.
       *
       * Playwright's "current tab" is its own bookkeeping and has nothing to do
       * with which sidebar tab is visible — it also resets to the application page
       * whenever the CLI re-attaches. `browser_claim` needs the visible page, and
       * the only surface that reports it is the carrier element itself: in Desktop
       * a `<webview>` (whose `getURL()`/`getTitle()` the shell also uses), in Web
       * the browser iframe.
       *
       * @returns {{ url: string | null, title: string | null } | null}
       */
      function visiblePage() {
        try {
          const views = [...document.querySelectorAll('webview')];
          for (const view of views) {
            const rect = view.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) continue;
            const style = window.getComputedStyle(view);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const url = typeof view.getURL === 'function' ? view.getURL() : null;
            const title = typeof view.getTitle === 'function' ? view.getTitle() : null;
            if (url) return { url, title };
          }
          const frames = [...document.querySelectorAll('iframe[data-sidebar-browser-frame]')];
          for (const frame of frames) {
            const rect = frame.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) continue;
            return { url: frame.getAttribute('src') ?? null, title: null };
          }
        } catch (error) {
          /* the carrier may be absent or restricted; capability stays null */
        }
        return null;
      }

      function capabilities() {
        const service = sidebar();
        let mounted = null;
        let activeTabId = null;
        try {
          mounted = service.mounted.getSnapshot() ?? null;
        } catch (error) {
          mounted = null;
        }
        try {
          activeTabId = service.active()?.id ?? null;
        } catch (error) {
          activeTabId = null;
        }
        return {
          hasSidebarRight: Boolean(service),
          mounted,
          activeTabId,
          visible: visiblePage(),
          origin: window.location.origin,
          href: window.location.href,
          protocol: window.location.protocol,
        };
      }

      /** Announce this page; retried by the loop until the Host answers. */
      async function announce() {
        await call('hello', { clientId: id, ...capabilities() }, 10_000);
        if (!connected) {
          connected = true;
          console.info('[dsh-browser-automation] connected to the Host bridge');
        }
        failureStreak = 0;
      }

      /**
       * Open one sidebar tab. The DSH store only exists once the Session's
       * right-bar seat has rendered, so a first attempt can legitimately throw
       * "no session surface is mounted"; retrying briefly covers the race while a
       * session is being opened.
       *
       * @param {string} url
       */
      async function openTab(url) {
        const service = sidebar();
        if (!service) throw new Error('the sidebar-right client service is not available in this page');

        // Capture the tab set BEFORE opening: `openTabs` is a published snapshot
        // store that catches up a beat later, so it cannot be asked "what did you
        // just add" synchronously.
        const before = new Set(service.openTabs.getSnapshot().map((tab) => tab.tabId));

        const deadline = Date.now() + 10_000;
        for (;;) {
          try {
            service.openTab('browser', { params: { url } });
            break;
          } catch (error) {
            // The store exists only once the Session's right-bar seat has rendered.
            if (/no session surface is mounted/.test(error.message) && Date.now() < deadline) {
              await sleep(250);
              continue;
            }
            throw error;
          }
        }

        // Identify the tab. `active()` is synchronous and already points at it, so
        // it is the primary answer; `openTabs` is the fallback that also carries
        // the Session id. Failing to identify it is NOT a failure to open it: the
        // Host finds the tab by diffing playwright-cli's own tab list.
        const identifyDeadline = Date.now() + 3_000;
        for (;;) {
          const entry = service.openTabs
            .getSnapshot()
            .find((tab) => tab.kind === 'browser' && !before.has(tab.tabId));
          if (entry !== undefined) {
            return { tabId: entry.tabId, sessionId: entry.sessionId, address: entry.contentId, url };
          }
          const active = service.active();
          if (active && active.kind === 'browser' && !before.has(active.id)) {
            return { tabId: active.id, sessionId: null, address: active.contentId, url };
          }
          if (Date.now() > identifyDeadline) {
            return { tabId: null, sessionId: null, address: null, url, identified: false };
          }
          await sleep(100);
        }
      }

      /** @param {{ requestId: string, kind: string, url?: string }} command */
      async function handle(command) {
        if (command.kind === 'open-tab') {
          const value = await openTab(command.url);
          await call('result', { requestId: command.requestId, ok: true, value });
          return;
        }
        if (command.kind === 'ping') {
          await call('result', { requestId: command.requestId, ok: true, value: capabilities() });
          return;
        }
        if (command.kind === 'focus-tab') {
          // A hidden sidebar tab has no compositor surface, so a screenshot of it
          // times out. Bringing it to the front is the only way to capture it, and
          // it is visible to the user (it changes which tab is showing).
          const service = sidebar();
          if (!service) throw new Error('the sidebar-right client service is not available in this page');
          if (!command.tabId) throw new Error('focus-tab needs a tabId');
          service.focus(command.tabId);
          await call('result', {
            requestId: command.requestId,
            ok: true,
            value: { focused: true, tabId: command.tabId },
          });
          return;
        }
        await call('result', {
          requestId: command.requestId,
          ok: false,
          error: `this page does not implement the "${command.kind}" command`,
        });
      }

      async function loop() {
        while (!stopped) {
          try {
            if (!connected) await announce();
            const reply = await call('poll', { clientId: id, waitMs: POLL_WAIT_MS }, POLL_WAIT_MS + 10_000);
            connected = true;
            if (stopped) return;
            const command = reply && reply.command;
            if (!command) {
              // A held poll blocks for POLL_WAIT_MS; an immediate empty answer means
              // something between the page and the Host is not holding the request.
              // Do not turn that into a hot loop.
              await sleep(120);
              continue;
            }
            try {
              await handle(command);
            } catch (error) {
              await call('result', {
                requestId: command.requestId,
                ok: false,
                error: error && error.message ? error.message : String(error),
              }).catch(() => {});
            }
          } catch (error) {
            connected = false;
            failureStreak += 1;
            if (failureStreak === 1 || failureStreak % 20 === 0) {
              console.warn(
                `[dsh-browser-automation] Host bridge unavailable (${error && error.message}); ` +
                  'browser_open will fall back to navigating an existing tab',
              );
            }
            if (stopped) return;
            await sleep(Math.min(10_000, 1_000 * failureStreak));
          }
        }
      }

      ctx.effect(
        () => {
          loop();
          return () => {
            stopped = true;
          };
        },
        'dsh-browser-automation: host bridge',
      );
    }

    return {
      inject: ['sidebarRight'],
      apply,
    };
  },
});
