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
    // The panel is a React component; React comes from the page's module table.
    const React = require('react');

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
     * The status panel: a session-scoped sidebar tab that shows what the tools are
     * doing, for the user rather than for the model.
     *
     * `browser_status` already answers every question here for an agent; the panel
     * exists so a person can see the same facts without asking. It is deliberately
     * read-only plus two global actions (detach / reconnect) — opening URLs or
     * closing pages would create a second, unregistered way to start work.
     *
     * A tab type is two registrations under one id: the type (kind, chip title) and
     * the body under the `sidebar.right.pane.tab` slot, whose props include
     * `sessionId`. The chip title is captured at open time, hence the localized
     * `title()`.
     */
    const PANEL_ID = '@local/dsh-browser-automation/panel';
    const PANEL_KIND = 'browser-automation';
    const LOCALE_NS = 'browser-automation';

    const DICT = {
      en: {
        'panel.title': 'Browser automation',
        'panel.refresh': 'Refresh',
        'panel.detach': 'Detach CLI',
        'panel.attach': 'Reconnect',
        'panel.connection': 'Connection',
        'panel.interpreter': 'CLI interpreter',
        'panel.modes': 'Start modes',
        'panel.pages': 'Pages in this session',
        'panel.empty': 'No controlled pages yet — ask for browser_open or browser_claim.',
        'panel.loading': 'Working…',
        'panel.unavailable': 'unavailable',
        'panel.available': 'available',
        'panel.open': 'open a new tab',
        'panel.claim': 'take over the visible page',
        'panel.detachHint': 'Detach ends the automation session: existing pageIds stop resolving.',
        'panel.noSession': 'This tab is not bound to a session.',
        'panel.clients': 'clients',
        'panel.polls': 'held polls',
      },
      zh: {
        'panel.title': '浏览器自动化',
        'panel.refresh': '刷新',
        'panel.detach': '断开 CLI',
        'panel.attach': '重新连接',
        'panel.connection': '连接',
        'panel.interpreter': 'CLI 解释器',
        'panel.modes': '启动模式',
        'panel.pages': '本会话的页面',
        'panel.empty': '还没有受控页面 —— 让模型调用 browser_open 或 browser_claim。',
        'panel.loading': '处理中…',
        'panel.unavailable': '不可用',
        'panel.available': '可用',
        'panel.open': '新开标签页',
        'panel.claim': '接管可见页',
        'panel.detachHint': '断开即结束自动化会话：已有 pageId 会失效。',
        'panel.noSession': '这个标签页没有绑定到会话。',
        'panel.clients': '客户端',
        'panel.polls': '挂起轮询',
      },
    };

    const PANEL_CSS = [
      '.dshba{display:flex;flex-direction:column;gap:10px;padding:12px;height:100%;overflow:auto;',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.5}',
      '.dshba-head{display:flex;align-items:center;gap:8px}',
      '.dshba-title{font-weight:600}',
      '.dshba-grow{flex:1}',
      '.dshba-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);',
      'color:inherit;border-radius:6px;padding:3px 9px;cursor:pointer;font:inherit}',
      '.dshba-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}',
      '.dshba-btn:disabled{opacity:.5;cursor:default}',
      '.dshba-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1);padding:9px 10px;display:flex;flex-direction:column;gap:4px}',
      '.dshba-label{color:var(--dsw-alias-label-secondary)}',
      '.dshba-row{display:flex;align-items:baseline;gap:8px}',
      '.dshba-ok{color:var(--dsw-alias-state-success-primary)}',
      '.dshba-bad{color:var(--dsw-alias-state-error-primary)}',
      '.dshba-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dshba-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}',
      '.dshba-page{border-top:1px solid var(--dsw-alias-border-l1);padding:7px 0;display:flex;flex-direction:column;gap:2px}',
      '.dshba-page:first-of-type{border-top:none;padding-top:0}',
      '.dshba-url{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshba-tag{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;font-size:11px;',
      'color:var(--dsw-alias-label-secondary)}',
      '.dshba-err{border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px;',
      'color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}',
      '.dshba-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    ].join('');

    const baseName = (value) => String(value ?? '').split(/[\\/]/).pop();

    /**
     * Build the panel component. `t` comes from the effect that owns the locale
     * registration, so the strings live exactly as long as the registrations do.
     *
     * @param {(key: string) => string} t
     */
    function makePanel(t) {
      const h = React.createElement;
      const dash = (value) => (value === null || value === undefined || value === '' ? '—' : String(value));
      const dot = (ok, label) => h('span', { className: ok ? 'dshba-ok' : 'dshba-bad' }, label);

      return function BrowserAutomationPanel(props) {
        const sessionId = props && props.sessionId;
        const [state, setState] = React.useState({ phase: 'loading', data: null, error: null, busy: null });
        const alive = React.useRef(true);
        React.useEffect(
          () => () => {
            alive.current = false;
          },
          [],
        );

        const load = React.useCallback(
          (action) => {
            if (!sessionId) {
              setState({ phase: 'ready', data: null, error: null, busy: null });
              return;
            }
            setState((previous) => ({ ...previous, phase: 'loading', busy: action ?? 'status' }));
            call('status', { sessionId, action: action ?? 'status' }, 30_000)
              .then((data) => {
                if (alive.current) setState({ phase: 'ready', data, error: null, busy: null });
              })
              .catch((error) => {
                if (alive.current) {
                  setState((previous) => ({ ...previous, phase: 'ready', error: error.message, busy: null }));
                }
              });
          },
          [sessionId],
        );

        React.useEffect(() => {
          load();
        }, [load]);

        const data = state.data;
        const bridge = (data && data.bridge) || {};
        const resolved = data && data.cli ? data.cli.resolved : null;
        const modes = (data && data.modes) || { open: false, claim: false };
        const pages = ((data && data.pages) || []).filter((page) => page && page.pageId);
        const busy = Boolean(state.busy);

        return h('div', { className: 'dshba' }, [
          h('style', { key: 'css' }, PANEL_CSS),
          h('div', { key: 'head', className: 'dshba-head' }, [
            h('span', { key: 'title', className: 'dshba-title' }, t('panel.title')),
            state.phase === 'loading' ? h('span', { key: 'busy', className: 'dshba-label' }, t('panel.loading')) : null,
            h('span', { key: 'grow', className: 'dshba-grow' }),
            h(
              'button',
              { key: 'refresh', className: 'dshba-btn', disabled: busy, onClick: () => load() },
              t('panel.refresh'),
            ),
          ]),

          !sessionId ? h('div', { key: 'nosession', className: 'dshba-err' }, t('panel.noSession')) : null,
          state.error ? h('div', { key: 'error', className: 'dshba-err' }, state.error) : null,

          h('div', { key: 'conn', className: 'dshba-card' }, [
            h('div', { key: 'label', className: 'dshba-label' }, t('panel.connection')),
            h('div', { key: 'cdp', className: 'dshba-row' }, [
              h('span', { key: 'k' }, 'CDP'),
              dot(Boolean(data && data.attached), data && data.attached ? 'connected' : 'disconnected'),
              h('span', { key: 'url', className: 'dshba-mono dshba-label' }, dash(data && data.cdpUrl)),
            ]),
            h('div', { key: 'bridge', className: 'dshba-row' }, [
              h('span', { key: 'k' }, 'Bridge'),
              dot(bridge.state === 'live', dash(bridge.state)),
              h('span', { key: 'c', className: 'dshba-tag' }, `${(bridge.clients || []).length} ${t('panel.clients')}`),
              h('span', { key: 'p', className: 'dshba-tag' }, `${bridge.heldPolls ?? 0} ${t('panel.polls')}`),
            ]),
            data && data.bridgeError
              ? h('div', { key: 'be', className: 'dshba-warn dshba-mono' }, String(data.bridgeError))
              : null,
          ]),

          h('div', { key: 'cli', className: 'dshba-card' }, [
            h('div', { key: 'label', className: 'dshba-label' }, t('panel.interpreter')),
            h('div', { key: 'file', className: 'dshba-mono' }, resolved ? baseName(resolved.file) : '—'),
            h('div', { key: 'meta', className: 'dshba-row' }, [
              resolved && resolved.source ? h('span', { key: 's', className: 'dshba-tag' }, resolved.source) : null,
              h('span', { key: 'cmd', className: 'dshba-label dshba-mono' }, dash(data && data.cli && data.cli.command)),
              h('span', { key: 'sess', className: 'dshba-label dshba-mono' }, data && data.cli ? `-s=${data.cli.session}` : ''),
            ]),
          ]),

          h('div', { key: 'modes', className: 'dshba-card' }, [
            h('div', { key: 'label', className: 'dshba-label' }, t('panel.modes')),
            h('div', { key: 'open', className: 'dshba-row' }, [
              t('panel.open'),
              dot(modes.open, modes.open ? t('panel.available') : t('panel.unavailable')),
            ]),
            h('div', { key: 'claim', className: 'dshba-row' }, [
              t('panel.claim'),
              dot(modes.claim, modes.claim ? t('panel.available') : t('panel.unavailable')),
            ]),
          ]),

          h('div', { key: 'pages', className: 'dshba-card' }, [
            h('div', { key: 'label', className: 'dshba-label' }, `${t('panel.pages')} (${pages.length})`),
            pages.length === 0 ? h('div', { key: 'empty', className: 'dshba-label' }, t('panel.empty')) : null,
            ...pages.map((page) =>
              h('div', { key: page.pageId, className: 'dshba-page' }, [
                h('div', { key: 'row', className: 'dshba-row' }, [
                  h('span', { key: 'pid', className: 'dshba-mono' }, page.pageId),
                  page.current ? h('span', { key: 'cur', className: 'dshba-tag' }, 'current') : null,
                  page.source ? h('span', { key: 'src', className: 'dshba-tag' }, page.source) : null,
                ]),
                h('div', { key: 'title', className: 'dshba-url' }, dash(page.title)),
                h('div', { key: 'url', className: 'dshba-url dshba-mono' }, dash(page.url)),
              ]),
            ),
          ]),

          h('div', { key: 'foot', className: 'dshba-foot' }, [
            h(
              'button',
              { key: 'detach', className: 'dshba-btn', disabled: busy, onClick: () => load('detach') },
              t('panel.detach'),
            ),
            h(
              'button',
              { key: 'attach', className: 'dshba-btn', disabled: busy, onClick: () => load('attach') },
              t('panel.attach'),
            ),
            h('span', { key: 'hint', className: 'dshba-label' }, t('panel.detachHint')),
          ]),
        ]);
      };
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
       * Whether a carrier element is really on screen, and its box.
       *
       * Two different things keep Chromium from painting a sidebar page, and they
       * need different tests:
       *  - a tab that is not the selected one lives in a `display:none` cell, so it
       *    measures 0x0;
       *  - a collapsed panel slides the whole column out of the viewport, but its
       *    content keeps a real box (measured at x=959 with a 958px-wide window),
       *    so size alone would wrongly call it visible.
       *
       * @param {HTMLElement} view
       * @returns {{ width: number, height: number } | null}
       */
      function onScreen(view) {
        const rect = view.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return null;
        const style = window.getComputedStyle(view);
        if (style.display === 'none' || style.visibility === 'hidden') return null;
        const intersects =
          rect.right > 0 &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight;
        return intersects ? rect : null;
      }

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
          for (const view of document.querySelectorAll('webview')) {
            if (!onScreen(view)) continue;
            const url = typeof view.getURL === 'function' ? view.getURL() : null;
            const title = typeof view.getTitle === 'function' ? view.getTitle() : null;
            if (url) return { url, title };
          }
          for (const frame of document.querySelectorAll('iframe[data-sidebar-browser-frame]')) {
            if (!onScreen(frame)) continue;
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

      /**
       * The carrier `<webview>` showing one page, if this page can see it.
       *
       * Desktop renders every sidebar browser tab as a `<webview>` guest whose
       * `getTitle()` is the guest's `document.title` — which carries the pageId
       * marker. That makes it the join key between a pageId and a sidebar tab.
       *
       * @param {string} pageId
       */
      function viewFor(pageId) {
        try {
          const views = [...document.querySelectorAll('webview')];
          return (
            views.find((view) => String(view.getTitle && view.getTitle()).includes(pageId)) ?? null
          );
        } catch (error) {
          return null;
        }
      }

      /**
       * The sidebar tab id (`tabN`) whose chip shows this page's title.
       *
       * The strip renders one chip per tab with `data-sidebar-right-tab="tabN"`,
       * and a browser chip's label is the observed page title — so the marker in
       * `document.title` is what connects pageId to the UI's own tab identity.
       * A collapsed sidebar renders no strip, hence no chips.
       *
       * @param {string} pageId
       */
      function tabIdFor(pageId) {
        try {
          const chips = [...document.querySelectorAll('[data-sidebar-right-tab]')];
          const chip = chips.find((element) => (element.textContent || '').includes(pageId));
          return chip ? chip.getAttribute('data-sidebar-right-tab') : null;
        } catch (error) {
          return null;
        }
      }

      /**
       * Make one page capturable.
       *
       * Chromium only frames a widget that is laid out and on screen: a sidebar tab
       * that is not the visible one sits in a `display:none` cell and measures 0x0,
       * so `page.screenshot()` waits forever. The fix is to bring that tab to the
       * front (expanding the panel first if it is collapsed), and the Host then
       * captures with a generous timeout because the first frame after a resize
       * takes a moment.
       *
       * @param {string} pageId
       */
      async function prepareCapture(pageId) {
        const service = sidebar();
        const view = viewFor(pageId);
        const visible = view ? Boolean(onScreen(view)) : false;
        const expanded = service && typeof service.isExpanded === 'function' ? service.isExpanded() : null;
        if (visible) return { visible: true, tabId: tabIdFor(pageId), expanded, expandedNow: false };

        let expandedNow = false;
        let expandVia = null;
        let expandError = null;
        if (service && expanded === false) {
          // Two ways to open the column: the sidebar controller's own toggle, and
          // the layout action the panel control uses. Try them in that order and
          // report which one worked, because a silently failed expand makes the
          // whole capture look like a Chromium problem.
          try {
            service.toggleExpanded();
            expandedNow = true;
            expandVia = 'sidebarRight.toggleExpanded';
          } catch (error) {
            expandError = error && error.message ? error.message : String(error);
          }
          if (!expandedNow) {
            try {
              ctx.layout.openRightbar(false, false);
              expandedNow = true;
              expandVia = 'layout.openRightbar';
            } catch (error) {
              expandError = `${expandError ?? ''} / ${error && error.message ? error.message : String(error)}`.trim();
            }
          }
          // The strip mounts with the panel; chips do not exist before that.
          if (expandedNow) await sleep(350);
        }
        const tabId = tabIdFor(pageId);
        if (!tabId) return { visible: false, tabId: null, expanded, expandedNow, expandVia, expandError };
        service.focus(tabId);
        return { visible: false, tabId, expanded, expandedNow, expandVia, expandError };
      }

      /**
       * Close the sidebar tab itself.
       *
       * `playwright-cli tab-close` only destroys the CDP target: the sidebar tab
       * survives as an empty shell showing "页面加载失败；请刷新重试或在系统浏览器中打开。",
       * and stays focused. Only the sidebar controller can remove the tab, so this
       * is a UI action like `openTab`, not a CLI one.
       *
       * @param {string} pageId
       */
      function closePage(pageId) {
        const service = sidebar();
        if (!service || typeof service.close !== 'function') {
          return { closed: false, tabId: null, reason: 'the sidebar-right client service cannot close tabs' };
        }
        const tabId = tabIdFor(pageId);
        if (!tabId) {
          return {
            closed: false,
            tabId: null,
            reason: 'no sidebar tab chip carries this page (the tab may already be gone, or its title lost the marker)',
          };
        }
        try {
          service.close(tabId);
        } catch (error) {
          return { closed: false, tabId, reason: error && error.message ? error.message : String(error) };
        }
        return { closed: true, tabId };
      }

      /** @param {{ requestId: string, kind: string, url?: string, pageId?: string }} command */
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
        if (command.kind === 'prepare-capture') {
          const value = await prepareCapture(String(command.pageId ?? ''));
          await call('result', { requestId: command.requestId, ok: true, value });
          return;
        }
        if (command.kind === 'close-page') {
          const value = closePage(String(command.pageId ?? ''));
          await call('result', { requestId: command.requestId, ok: true, value });
          return;
        }
        if (command.kind === 'open-panel') {
          // Opening the panel is the same navigation every other entry point uses:
          // a page type is opened by kind, and DSH dedupes it within the pane.
          const service = sidebar();
          if (!service) throw new Error('the sidebar-right client service is not available in this page');
          service.openTab(PANEL_KIND);
          await call('result', { requestId: command.requestId, ok: true, value: { opened: true, kind: PANEL_KIND } });
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
                  'browser_open and browser_claim will report the bridge as the cause until it returns',
              );
            }
            if (stopped) return;
            await sleep(Math.min(10_000, 1_000 * failureStreak));
          }
        }
      }

      /**
       * The panel tab type, its body, and its strings, all as one effect.
       *
       * A tab type is two registrations under one id: `sidebarRightTabs.register`
       * names the kind and the chip title (captured when the tab opens), and the
       * body registers into `sidebar.right.pane.tab` under that id and receives
       * `sessionId` as a prop. Both are owned by this effect, so they disappear with
       * the plugin instead of leaving a tab with no body.
       */
      ctx.effect(
        () => {
          const disposers = [];
          let t = (key) => DICT.en[key] ?? key;
          try {
            const disposeLocale = ctx.locale.register(LOCALE_NS, DICT);
            if (typeof disposeLocale === 'function') disposers.push(disposeLocale);
            const bound = ctx.locale.bind(LOCALE_NS);
            t = (key) => {
              try {
                const value = bound(key);
                if (typeof value === 'string' && value !== key) return value;
              } catch (error) {
                /* fall through to the built-in English copy */
              }
              return DICT.en[key] ?? key;
            };
          } catch (error) {
            console.warn(`[dsh-browser-automation] locale registration skipped: ${error.message}`);
          }
          try {
            disposers.push(
              ctx.sidebarRightTabs.register({
                id: PANEL_ID,
                kind: PANEL_KIND,
                title: () => t('panel.title'),
              }),
            );
            disposers.push(
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PANEL_ID }, makePanel(t)),
            );
          } catch (error) {
            console.warn(`[dsh-browser-automation] status panel could not register: ${error.message}`);
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch (error) {
                /* already gone */
              }
            }
          };
        },
        'dsh-browser-automation: status panel',
      );

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
      // `layout` opens a collapsed column for a screenshot; `slots`/`sidebarRightTabs`
      // host the status panel; `locale` carries its copy. All are hard injects so a
      // profile without them fails loudly instead of half-working.
      inject: ['sidebarRight', 'layout', 'slots', 'sidebarRightTabs', 'locale'],
      apply,
    };
  },
});
