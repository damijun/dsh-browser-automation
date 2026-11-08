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
    // The package name and row id this bundle's configuration belongs to: the
    // Plugins page seats a bundle's settings by package name, and the form model is
    // addressed by the row id the patch declares.
    const PACKAGE_NAME = '@local/dsh-browser-automation';
    const ROW_ID = 'browser-automation';

    const DICT = {
      en: {
        'panel.title': 'Browser automation',
        'panel.guide': 'CDP, bridge, interpreter and this session\u2019s pages',
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
        'panel.autoAttach': 'Startup attach',
        'panel.autoAttachOk': 'attached',
        'panel.autoAttachPending': 'connecting…',
        'panel.autoAttachFailed': 'failed',
        'panel.autoAttachOff': 'off (autoAttach: false)',
        'cfg.title': 'Browser automation settings',
        'cfg.summary': 'Sidebar browser automation',
        'cfg.loading': 'Loading configuration…',
        'cfg.save': 'Save',
        'cfg.saving': 'Saving…',
        'cfg.saved': 'Written to the profile patch. Restart DSH to apply it.',
        'cfg.reset': 'Reset to default. Restart DSH to apply it.',
        'cfg.resetField': 'Reset',
        'cfg.readOnly':
          'Read-only: this host does not serve the settings form. Edit cordis.patch.yml in the profile to change these values.',
        'cfg.noService': 'no configForms service',
        'cfg.noForm': 'no form for this row',
        'cfg.writeHint': 'A save only writes the profile patch; restart DSH to apply it.',
        'cfg.path': 'Profile patch: cordis.patch.yml → id: browser-automation',
        'cfg.errNumber': '{key} must be a number.',
        'cfg.field.nodePath': 'Node path',
        'cfg.field.command': 'CLI command',
        'cfg.field.session': 'CLI session name',
        'cfg.field.timeoutMs': 'CLI timeout (ms)',
        'cfg.field.requestTimeoutMs': 'Bridge timeout (ms)',
        'cfg.field.screenshotSettleMs': 'Screenshot settle (ms)',
        'cfg.field.debug': 'Debug logging',
        'cfg.subtitle': 'Saved to this profile patch. Restart DSH to apply it.',
        'cfg.auto': 'Auto',
        'cfg.path': 'PATH',
        'cfg.custom': 'Custom path',
        'cfg.customPlaceholder': 'absolute path to node.exe,eg.C:\\Program Files\\nodejs\\node.exe',
        'cfg.on': 'On',
        'cfg.off': 'Off',
        'cfg.overridden': 'overridden',
        'cfg.desc.nodePath': 'Auto prefers the Node DSH ships, then PATH.',
        'cfg.desc.command': 'Command name on PATH, or an absolute path of "playwright-cli.js".',
        'cfg.desc.session': 'playwright-cli -s= name; every DSH session shares it.',
        'cfg.desc.timeoutMs': 'Per-call timeout for one CLI invocation.',
        'cfg.desc.requestTimeoutMs': 'How long a tool waits for the page half to answer.',
        'cfg.field.attachTimeoutMs': 'Attach timeout (ms)',
        'cfg.desc.attachTimeoutMs': 'How long the CLI may take to attach before one retry.',
        'cfg.field.screenshotTimeoutMs': 'Capture timeout (ms)',
        'cfg.desc.screenshotTimeoutMs': 'Deadline for one screenshot capture.',
        'cfg.desc.screenshotSettleMs': 'Wait for a first frame after focusing a hidden tab.',
        'cfg.desc.debug': 'Print bridge and CLI diagnostics to the host log.',
        'cfg.field.autoAttach': 'Attach at startup',
        'cfg.desc.autoAttach':
          'Attach once when DSH starts, so sidebar pages opened afterwards are visible to the CLI. Costs one daemon process while DSH runs; only one DSH instance at a time.',
    'chip.shared': 'shared with the agent',
    'cfg.field.showSharedBadge': 'Shared page badge',
        'cfg.desc.showSharedBadge':
          'Show a small "driven by the agent" badge above the sidebar while the browser tab in view is controlled by this plugin. Nothing is painted into the page, and the badge ignores pointer events.',
      },
      zh: {
        'panel.title': '浏览器自动化',
        'panel.guide': '查看 CDP、桥、解释器与本会话的受控页面',
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
        'panel.autoAttach': '开机自动连接',
        'panel.autoAttachOk': '已连接',
        'panel.autoAttachPending': '连接中…',
        'panel.autoAttachFailed': '失败',
        'panel.autoAttachOff': '已关闭（autoAttach: false）',
        'cfg.title': '浏览器自动化配置',
        'cfg.summary': '侧边栏浏览器自动化',
        'cfg.loading': '正在读取配置…',
        'cfg.save': '保存',
        'cfg.saving': '保存中…',
        'cfg.saved': '已写入 profile patch。重启 DSH 后生效。',
        'cfg.reset': '已恢复默认值。重启 DSH 后生效。',
        'cfg.resetField': '恢复默认',
        'cfg.readOnly': '只读：当前宿主没有提供设置表单。要改这些值，请编辑 profile 里的 cordis.patch.yml。',
        'cfg.noService': '没有 configForms 服务',
        'cfg.noForm': '这一行没有可编辑的表单',
        'cfg.writeHint': '保存本身只写 profile patch；重启 DSH 后生效。',
        'cfg.path': 'Profile patch：cordis.patch.yml → id: browser-automation',
        'cfg.errNumber': '{key} 必须是数字。',
        'cfg.field.nodePath': 'Node 路径',
        'cfg.field.command': 'CLI 命令',
        'cfg.field.session': 'CLI 会话名',
        'cfg.field.timeoutMs': 'CLI 超时（ms）',
        'cfg.field.requestTimeoutMs': '桥超时（ms）',
        'cfg.field.screenshotSettleMs': '截图首帧等待（ms）',
        'cfg.field.debug': '调试日志',
        'cfg.subtitle': '只写入这个 profile 的 patch；重启 DSH 后生效。',
        'cfg.auto': '自动',
        'cfg.path': 'PATH',
        'cfg.custom': '自定义路径',
        'cfg.customPlaceholder': 'node.exe的绝对路径,例如C:\\Program Files\\nodejs\\node.exe',
        'cfg.on': '开启',
        'cfg.off': '关闭',
        'cfg.overridden': '已覆盖',
        'cfg.desc.nodePath': '自动：优先用 DSH 自带的 Node，其次是 PATH。',
        'cfg.desc.command': 'PATH 上的命令名，或 playwright-cli.js 的绝对路径。',
        'cfg.desc.session': 'playwright-cli 的 -s= 会话名；所有 DSH 会话共用。',
        'cfg.desc.timeoutMs': '单次 CLI 调用的超时时间。',
        'cfg.desc.requestTimeoutMs': '等页面半边回答的最长时间。',
        'cfg.field.attachTimeoutMs': 'Attach 超时（ms）',
        'cfg.desc.attachTimeoutMs': 'CLI 附着的最长等待，超时后重试一次。',
        'cfg.field.screenshotTimeoutMs': '截图超时（ms）',
        'cfg.desc.screenshotTimeoutMs': '单次截图抓取的最长等待。',
        'cfg.desc.screenshotSettleMs': '把隐藏标签页切到前台后，等首帧的时间。',
        'cfg.desc.debug': '把桥与 CLI 诊断打印到宿主日志。',
        'cfg.field.autoAttach': '开机自动连接',
        'cfg.desc.autoAttach':
          'DSH 启动时先 attach 一次，之后打开的侧边栏页面才能被 CLI 看见。代价是运行期间常驻一个 daemon 进程；同时只能有一个 DSH 实例。',
    'chip.shared': '正在与智能体共享',
    'cfg.field.showSharedBadge': '共享页面标记',
        'cfg.desc.showSharedBadge':
          '当正在看的浏览器页由本插件控制时，在侧栏上方显示一个「由智能体驱动」的小浮标：不往页面里画任何东西，浮标也不接收点击。',
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
     * The guide row's glyph, matching `icon.svg` (a browser window whose title bar
     * is a robot visor, with a click cursor on the page).
     *
     * The guide renders `entry.icon` as a node, so this has to be a component and
     * not the file path: without one the row is the only blank leading slot in the
     * start page's list.
     *
     * This is the 16px mono reduction of the cover: the page cursor and the two
     * content lines are dropped because at that size they collapse into noise. What
     * survives is the window silhouette, the antenna and the two knocked-out eyes,
     * which are what makes the row recognizable.
     */
    function panelIcon(props) {
      const size = (props && props.size) || 16;
      const h = React.createElement;
      return h('svg', { width: size, height: size, viewBox: '0 0 64 64', fill: 'none', 'aria-hidden': 'true' }, [
        h('circle', { key: 'antenna', cx: 32, cy: 3.8, r: 2.3, fill: 'currentColor' }),
        h('path', {
          key: 'stem',
          d: 'M32 8.8V6',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.1,
          strokeLinecap: 'round',
        }),
        h('rect', { key: 'body', x: 4, y: 9, width: 56, height: 47, rx: 10, fill: 'currentColor', opacity: 0.9 }),
        h('path', { key: 'visor', d: 'M4 19a10 10 0 0 1 10-10h36a10 10 0 0 1 10 10v8H4z', fill: 'currentColor' }),
        h('circle', { key: 'eye-left', cx: 23.5, cy: 18, r: 4, fill: 'var(--dsw-alias-bg-base)' }),
        h('circle', { key: 'eye-right', cx: 40.5, cy: 18, r: 4, fill: 'var(--dsw-alias-bg-base)' }),
      ]);
    }

    /**
     * The "driven by the agent" badge, drawn on the frame-wide overlay above the
     * sidebar, never inside the page.
     *
     * The page itself is untouched. This half cannot read the sidebar page's
     * `window` object, and the page title no longer carries an identity, so "is
     * this visible tab shared" is asked of the Host using the sidebar's own tab id
     * (with the URL as the fallback). The overlay layer is click-through, and the
     * badge opts out of pointer events too, so it can never intercept a click
     * meant for the page.
     *
     * @param {(key: string) => string} t
     */
    function makeSharedBadge(t) {
      return function SharedBadge() {
        const h = React.createElement;
        const [box, setBox] = React.useState(null);
        const [enabled, setEnabled] = React.useState(true);
        React.useEffect(() => {
          let alive = true;
          call('config', {})
            .then((config) => {
              const values = config && config.values ? config.values : config;
              if (alive && values && values.showSharedBadge === false) setEnabled(false);
            })
            .catch(() => {});
          return () => {
            alive = false;
          };
        }, []);
        React.useEffect(() => {
          if (!enabled) {
            setBox(null);
            return undefined;
          }
          // Tab switches are event driven: the pane that leaves view goes to 0x0 and the
          // one that enters regains a real box, and a switch to a never-rendered tab
          // creates the pane — a size observer plus a mutation observer cover both.
          // Everything else keeps its old behaviour; the slow safety net below catches
          // anything these observers miss.
          let disposed = false;
          let frame = 0;
          const observed = new Set();
          // The last Host answer, keyed by "tab id|url". Reusing it for a moment keeps
          // observer bursts from turning into request bursts; a tab switch changes the
          // key and asks immediately.
          let answer = { key: null, shared: false, at: 0 };
          let asking = null;

          /**
           * The sidebar tab the user is looking at: the active one when it is a
           * browser pane, otherwise the first laid-out pane that carries a webview
           * (a split view can show two).
           */
          const visibleCarrier = () => {
            const candidates = [];
            for (const pane of document.querySelectorAll('[data-sidebar-right-tab]')) {
              const rect = pane.getBoundingClientRect();
              if (rect.width < 80 || rect.height < 80) continue;
              const view = typeof pane.querySelector === 'function' ? pane.querySelector('webview') : null;
              if (!view) continue;
              let url = '';
              try {
                url = view.getURL() || '';
              } catch (error) {
                url = '';
              }
              let tabId = '';
              try {
                tabId = pane.getAttribute('data-sidebar-right-tab') || '';
              } catch (error) {
                tabId = '';
              }
              candidates.push({ pane, rect, tabId, url });
            }
            if (candidates.length <= 1) return candidates[0] ?? null;
            let activeId = null;
            try {
              const service = sidebar();
              activeId = service && typeof service.active === 'function' ? service.active()?.id ?? null : null;
            } catch (error) {
              activeId = null;
            }
            return candidates.find((candidate) => activeId !== null && candidate.tabId === activeId) ?? candidates[0];
          };

          const place = (candidate, shared) => {
            if (!shared) {
              setBox((previous) => (previous === null ? previous : null));
              return;
            }
            // Anchor to the address field: flush against its right end, which keeps
            // the "open in system browser" button next to it untouched.
            const field =
              typeof candidate.pane.querySelector === 'function' ? candidate.pane.querySelector('input') : null;
            const anchor = field ? field.getBoundingClientRect() : candidate.rect;
            const found = { top: anchor.top, height: anchor.height, right: anchor.right };
            setBox((previous) => {
              if (
                previous !== null &&
                Math.abs(previous.top - found.top) < 1 &&
                Math.abs(previous.right - found.right) < 1 &&
                Math.abs(previous.height - found.height) < 1
              ) {
                return previous;
              }
              return found;
            });
          };

          const measure = () => {
            frame = 0;
            if (disposed) return;
            const candidate = visibleCarrier();
            if (!candidate) {
              setBox((previous) => (previous === null ? previous : null));
              return;
            }
            const key = `${candidate.tabId}|${candidate.url}`;
            if (answer.key === key && Date.now() - answer.at < 1_200) {
              place(candidate, answer.shared);
              return;
            }
            if (asking === key) return;
            asking = key;
            call('shared-state', { tabId: candidate.tabId, url: candidate.url }, 3_000)
              .then((reply) => {
                answer = { key, shared: Boolean(reply && reply.shared), at: Date.now() };
                asking = null;
                if (!disposed) measure();
              })
              .catch(() => {
                asking = null;
              });
          };

          const schedule = () => {
            if (disposed || frame) return;
            frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : setTimeout(measure, 16);
          };

          // Every pane, so a switch (0x0 <-> real box) reports itself. Re-armed whenever
          // panes appear or disappear.
          const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
          const syncPanes = () => {
            if (!resize) return;
            const live = new Set();
            for (const pane of document.querySelectorAll("[data-sidebar-right-tab]")) {
              live.add(pane);
              if (!observed.has(pane)) {
                resize.observe(pane);
                observed.add(pane);
              }
            }
            for (const pane of observed) {
              if (live.has(pane)) continue;
              try {
                resize.unobserve(pane);
              } catch (error) {}
              observed.delete(pane);
            }
          };

          // Only the sidebar subtree matters: the conversation column mutates constantly
          // while a reply streams, and those records must not wake this up.
          const mutate = typeof MutationObserver === 'function'
            ? new MutationObserver((records) => {
                let relevant = records.length > 200;
                for (const record of records) {
                  if (relevant) break;
                  const target = record.target;
                  if (target && typeof target.closest === 'function' && target.closest('[data-sidebar-right-session]')) {
                    relevant = true;
                    break;
                  }
                  for (const node of record.addedNodes || []) {
                    if (node && node.nodeType === 1 && typeof node.closest === 'function' && node.closest('[data-sidebar-right-session]')) {
                      relevant = true;
                      break;
                    }
                  }
                }
                if (!relevant) return;
                syncPanes();
                schedule();
              })
            : null;

          syncPanes();
          measure();
          if (mutate) mutate.observe(document.body, { childList: true, subtree: true });
          window.addEventListener('resize', schedule);
          // Safety net: two seconds, sizes and tab ids only, in case the observers stop
          // matching (a future DSH could rename the data attribute).
          const safety = setInterval(measure, 2000);
          return () => {
            disposed = true;
            clearInterval(safety);
            window.removeEventListener('resize', schedule);
            if (mutate) mutate.disconnect();
            if (resize) {
              for (const pane of observed) {
                try {
                  resize.unobserve(pane);
                } catch (error) {}
              }
              observed.clear();
            }
            if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
          };
        }, [enabled]);
        if (!enabled || box === null) return null;
        return h(
          'div',
          {
            'data-dsh-ba-shared': '1',
            role: 'status',
            'aria-live': 'polite',
            title: t('chip.shared'),
            style: {
              position: 'fixed',
              // The <webview> paints above the overlay inside the page area, so this
              // sits in the browser toolbar instead: right end of the address field,
              // vertically centred, with a small gap before the external-open button.
              top: box.top + (box.height - 22) / 2,
              right: window.innerWidth - box.right + 3,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '2px 9px 2px 7px',
              borderRadius: '999px',
              border: '1px solid rgba(255,255,255,.28)',
              background: 'linear-gradient(135deg, #5b9bff 0%, #2f6fed 100%)',
              color: '#fff',
              boxShadow: '0 1px 4px rgba(24,64,148,.28)',
              font: '11px/1.5 system-ui, sans-serif',
              letterSpacing: '.01em',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 1,
            },
          },
          h(
            'svg',
            {
              width: 10,
              height: 10,
              viewBox: '0 0 12 12',
              'aria-hidden': 'true',
            },
            h('circle', { cx: 6, cy: 6, r: 4, fill: '#fff', opacity: 0.95 }),
            h('circle', { cx: 6, cy: 6, r: 1.6, fill: '#2f6fed' }),
          ),
          t('chip.shared'),
        );
      };
    }

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

      /**
       * One line for the startup attach: connected at HH:MM, still trying, given up
       * (with the reason), or switched off in the config.
       *
       * @param {{ ok?: boolean | null, at?: number | null, error?: string | null, skipped?: boolean } | null} value
       * @param {(key: string) => string} translate
       */
      const autoAttachLine = (value, translate) => {
        if (!value) return h('span', { className: 'dshba-label' }, '—');
        if (value.skipped) return h('span', { className: 'dshba-label' }, translate('panel.autoAttachOff'));
        if (value.ok === true) {
          const at = value.at ? new Date(value.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
          return h('span', { className: 'dshba-ok' }, `${translate('panel.autoAttachOk')} ${at}`.trim());
        }
        if (value.ok === false) {
          return h('span', { className: 'dshba-bad' }, `${translate('panel.autoAttachFailed')}: ${value.error ?? '?'}`);
        }
        return h('span', { className: 'dshba-warn' }, translate('panel.autoAttachPending'));
      };

      return function BrowserAutomationPanel(props) {
        const sessionId = props && props.sessionId;
        const [state, setState] = React.useState({ phase: 'loading', data: null, error: null, busy: null });
        const alive = React.useRef(true);
        const settleTimer = React.useRef(null);
        const settleRetries = React.useRef(0);
        React.useEffect(
          () => () => {
            alive.current = false;
            if (settleTimer.current) clearTimeout(settleTimer.current);
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
                if (!alive.current) return;
                setState({ phase: 'ready', data, error: null, busy: null });
                // A panel restored at boot can read the status while the startup attach
                // is still retrying, which would leave "connecting…" on screen forever.
                // Check back until it settles (bounded).
                const pending = data && data.autoAttach && data.autoAttach.ok === null && !data.autoAttach.skipped;
                if (pending && settleRetries.current < 5 && !settleTimer.current) {
                  settleRetries.current += 1;
                  settleTimer.current = setTimeout(() => {
                    settleTimer.current = null;
                    load();
                  }, 2_000);
                }
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
        // `status.pages` is the plugin's whole tab list — the same snapshot
        // `browser_status` returns to the agent, which deliberately includes every
        // session's pages. This panel is scoped to one session's sidebar seat, so a
        // row that is not ours would otherwise be counted and listed as if it were;
        // `mine` is the Host's answer to exactly that question.
        const pages = ((data && data.pages) || []).filter((page) => page && page.pageId && page.mine === true);
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
              // The URL alone cannot explain a failure: "stale" (a leftover endpoint holds
              // the port) and "absent" (no flag, or DSH gone) look identical from here and
              // need different fixes.
              data && data.cdp && data.cdp.diagnosis && data.cdp.diagnosis !== 'serving'
                ? h('span', { key: 'diag', className: 'dshba-tag' }, `! ${data.cdp.diagnosis}`)
                : null,
            ]),
            h('div', { key: 'bridge', className: 'dshba-row' }, [
              h('span', { key: 'k' }, 'Bridge'),
              dot(bridge.state === 'live', dash(bridge.state)),
              h('span', { key: 'c', className: 'dshba-tag' }, `${(bridge.clients || []).length} ${t('panel.clients')}`),
              h('span', { key: 'p', className: 'dshba-tag' }, `${bridge.heldPolls ?? 0} ${t('panel.polls')}`),
            ]),
            // The startup attach decides whether a page the user opens afterwards is
            // drivable at all, so its outcome gets a visible line — including failure.
            h('div', { key: 'auto', className: 'dshba-row' }, [
              h('span', { key: 'k' }, t('panel.autoAttach')),
              autoAttachLine(data && data.autoAttach, t),
            ]),
            data && data.bridgeError
              ? h('div', { key: 'be', className: 'dshba-warn dshba-mono' }, String(data.bridgeError))
              : null,
          ]),

          h('div', { key: 'cli', className: 'dshba-card' }, [
            h('div', { key: 'label', className: 'dshba-label' }, t('panel.interpreter')),
            h('div', { key: 'file', className: 'dshba-mono' }, resolved ? baseName(resolved.node) : '—'),
            h('div', { key: 'meta', className: 'dshba-row' }, [
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
     * The configuration card on this bundle's page in the sidebar's Plugins view.
     *
     * Reads through the page bridge (`config`) and writes through the same route
     * (`config-set` / `config-reset`), which the Host resolves with
     * `ctx.configEditor` — the service that persists a raw config and re-applies it
     * through the normal Loader path, the same place a hand edit of the profile patch
     * lands. A Host without that service answers `editable: false`, and the card
     * stays read-only while still showing what is in effect.
     */
    const CONFIG_FIELDS = [
      { key: 'nodePath', kind: 'text' },
      { key: 'command', kind: 'text' },
      { key: 'session', kind: 'text' },
      { key: 'timeoutMs', kind: 'number' },
      { key: 'attachTimeoutMs', kind: 'number' },
      { key: 'requestTimeoutMs', kind: 'number' },
      { key: 'screenshotTimeoutMs', kind: 'number' },
      { key: 'screenshotSettleMs', kind: 'number' },
      { key: 'autoAttach', kind: 'boolean' },
      { key: 'showSharedBadge', kind: 'boolean' },
      { key: 'debug', kind: 'boolean' },
    ];

    const CONFIG_CSS = [
      '.dshcfg{color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px}',
      '.dshcfg-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.dshcfg-header{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;',
      'background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:12px 14px}',
      '.dshcfg-head-text{display:flex;flex-direction:column;gap:2px;flex:1}',
      '.dshcfg-name{font-weight:600;font-size:13px}',
      '.dshcfg-desc{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.45}',
      '.dshcfg-chev{width:7px;height:7px;border-right:1.5px solid var(--dsw-alias-label-secondary);',
      'border-bottom:1.5px solid var(--dsw-alias-label-secondary);transform:rotate(45deg);',
      'transition:transform .15s ease;margin-right:2px;flex:none}',
      '.dshcfg-chev-open{transform:rotate(-135deg)}',
      '.dshcfg-body{border-top:1px solid var(--dsw-alias-border-l1);padding:4px 14px 12px;',
      'display:flex;flex-direction:column;gap:2px}',
      '.dshcfg-field{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,300px);gap:14px;',
      'align-items:center;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dshcfg-field:last-of-type{border-bottom:0}',
      '.dshcfg-left{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dshcfg-row-name{display:flex;align-items:center;gap:8px}',
      '.dshcfg-label{font-weight:500}',
      '.dshcfg-badge{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;',
      'font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.dshcfg-link{background:none;border:0;padding:0;color:var(--dsw-alias-brand-primary);',
      'font:inherit;font-size:11px;cursor:pointer}',
      '.dshcfg-link:disabled{opacity:.5;cursor:default}',
      '.dshcfg-control{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dshcfg-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:6px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;padding:5px 8px}',
      '.dshcfg-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dshcfg-input:disabled{opacity:.6}',
      '.dshcfg-seg{display:flex;align-items:center;gap:2px;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:7px;padding:2px;width:fit-content;max-width:100%;flex-wrap:wrap}',
      '.dshcfg-seg-btn{background:none;border:0;border-radius:5px;color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-size:11.5px;padding:3px 10px;cursor:pointer}',
      '.dshcfg-seg-btn:disabled{opacity:.5;cursor:default}',
      '.dshcfg-seg-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dshcfg-foot{display:flex;align-items:center;gap:10px;padding-top:12px;flex-wrap:wrap}',
      '.dshcfg-grow{flex:1}',
      '.dshcfg-primary{border:0;border-radius:7px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);',
      'font:inherit;font-weight:600;padding:6px 16px;cursor:pointer}',
      '.dshcfg-primary:disabled{opacity:.45;cursor:default}',
      // A secondary button (the per-field "reset"), so it reads as an action rather
      // than as a link sitting next to the value.
      '.dshcfg-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);',
      'color:inherit;border-radius:6px;font:inherit;padding:3px 9px;cursor:pointer}',
      '.dshcfg-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}',
      '.dshcfg-btn:disabled{opacity:.5;cursor:default}',
      '.dshcfg-btn-sm{padding:2px 9px;font-size:11px;border-radius:5px}',
      '.dshcfg-err{border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px;',
      'color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;margin:8px 0 4px}',
      '.dshcfg-note{color:var(--dsw-alias-state-success-primary);font-size:11.5px}',
      '.dshcfg-hint{color:var(--dsw-alias-label-secondary);font-size:11.5px}',
      '.dshcfg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}',
    ].join('');

    /**
     * @param {(key: string) => string} t
     */
    function makeConfigCard(t) {
      const h = React.createElement;

      /** Segmented choices for the two fields with a small, fixed option set. */
      const segmentsFor = (key, value) => {
        if (key === 'nodePath') {
          const picked = value === 'auto' || value === 'path' ? value : 'custom';
          return [
            { value: 'auto', label: t('cfg.auto'), picked: picked === 'auto' },
            { value: 'path', label: t('cfg.path'), picked: picked === 'path' },
            { value: 'custom', label: t('cfg.custom'), picked: picked === 'custom' },
          ];
        }
        // Every boolean field renders as the same on/off pair.
        if (key === 'debug' || key === 'autoAttach' || key === 'showSharedBadge') {
          const on = value === true;
          return [
            { value: false, label: t('cfg.off'), picked: !on },
            { value: true, label: t('cfg.on'), picked: on },
          ];
        }
        return null;
      };

      return function ConfigCard(props) {
        const view = props && props.view;
        const [state, setState] = React.useState({
          phase: 'loading',
          values: null,
          overrides: {},
          dirty: {},
          error: null,
          note: null,
          writable: false,
          reason: null,
          open: true,
        });
        const alive = React.useRef(true);
        const noteTimer = React.useRef(null);
        React.useEffect(
          () => () => {
            alive.current = false;
            if (noteTimer.current) clearTimeout(noteTimer.current);
          },
          [],
        );

        /**
         * Show a short-lived result line ("saved", "reset").
         *
         * Both are writes to the patch, so both need the same restart hint;
         * the text used to stay on screen after a reset, which read as a permanent
         * state rather than a one-off confirmation.
         *
         * @param {string} text
         */
        const flashNote = React.useCallback((text) => {
          if (!alive.current) return;
          if (noteTimer.current) clearTimeout(noteTimer.current);
          setState((previous) => ({ ...previous, note: text }));
          noteTimer.current = setTimeout(() => {
            noteTimer.current = null;
            if (alive.current) setState((previous) => ({ ...previous, note: null }));
          }, 6_000);
        }, []);

        const load = React.useCallback(async () => {
          try {
            const answer = await call('config', {}, 10_000);
            if (!alive.current) return;
            setState((previous) => ({
              ...previous,
              phase: 'ready',
              values: answer && answer.values ? answer.values : null,
              overrides: (answer && answer.overrides) || {},
              writable: Boolean(answer && answer.editable === true),
              reason: (answer && answer.reason) || null,
              error: null,
            }));
          } catch (failure) {
            if (!alive.current) return;
            setState((previous) => ({ ...previous, phase: 'ready', error: failure.message }));
          }
        }, []);

        React.useEffect(() => {
          load();
        }, [load]);

        if (view === 'summary') return h('span', { className: 'dshcfg-desc' }, t('cfg.summary'));
        if (state.phase === 'loading' && !state.values) {
          return h('div', { className: 'dshcfg' }, h('div', { className: 'dshcfg-card' }, t('cfg.loading')));
        }

        const values = state.values ?? {};
        const dirty = state.dirty;
        const setDirty = (key, value) =>
          setState((previous) => ({ ...previous, dirty: { ...previous.dirty, [key]: value } }));
        const pendingCount = Object.keys(dirty).length;
        const valueOf = (key) => (Object.hasOwn(dirty, key) ? dirty[key] : values[key]);

        const save = async () => {
          if (!state.writable) return;
          setState((previous) => ({ ...previous, phase: 'saving', error: null, note: null }));
          try {
            for (const [key, raw] of Object.entries(dirty)) {
              const field = CONFIG_FIELDS.find((entry) => entry.key === key);
              const value = field && field.kind === 'number' ? Number(raw) : raw;
              if (field && field.kind === 'number' && !Number.isFinite(value)) {
                throw new Error(t('cfg.errNumber').replace('{key}', key));
              }
              await call('config-set', { key, value }, 20_000);
            }
            if (alive.current) setState((previous) => ({ ...previous, dirty: {}, phase: 'ready' }));
            flashNote(t('cfg.saved'));
            await load();
          } catch (failure) {
            if (alive.current) setState((previous) => ({ ...previous, phase: 'ready', error: failure.message }));
          }
        };

        const reset = async (key) => {
          if (!state.writable) return;
          try {
            await call('config-reset', { key }, 20_000);
            // Drop this key's draft too: keeping it would show the typed value again
            // right after the reset and re-save it on the next click.
            if (alive.current) {
              setState((previous) => {
                const nextDirty = { ...previous.dirty };
                delete nextDirty[key];
                return { ...previous, dirty: nextDirty, error: null };
              });
            }
            // A reset is a write like any other: it lands in the patch and needs the
            // same restart, so it says so instead of staying silent.
            flashNote(t('cfg.reset'));
            await load();
          } catch (failure) {
            if (alive.current) setState((previous) => ({ ...previous, error: failure.message }));
          }
        };

        const busy = state.phase === 'saving';

        const control = (field) => {
          const current = valueOf(field.key);
          const segments = segmentsFor(field.key, current);
          if (segments) {
            return h('div', { className: 'dshcfg-seg', role: 'group' }, [
              ...segments.map((segment) =>
                h(
                  'button',
                  {
                    key: String(segment.value),
                    type: 'button',
                    className: 'dshcfg-seg-btn' + (segment.picked ? ' dshcfg-seg-on' : ''),
                    disabled: busy || !state.writable,
                    onClick: () => {
                      if (segment.value === 'custom') {
                        // Keep whatever custom path is in force, so switching to
                        // "custom" never silently blanks the field.
                        const existing = current === 'auto' || current === 'path' ? '' : current;
                        setDirty(field.key, existing ?? '');
                      } else {
                        setDirty(field.key, segment.value);
                      }
                    },
                  },
                  segment.label,
                ),
              ),
              field.key === 'nodePath' && (current !== 'auto' && current !== 'path')
                ? h('input', {
                    key: 'custom-path',
                    className: 'dshcfg-input dshcfg-mono',
                    type: 'text',
                    placeholder: t('cfg.customPlaceholder'),
                    value: current === undefined || current === null ? '' : String(current),
                    disabled: busy || !state.writable,
                    onChange: (event) => setDirty(field.key, event.target.value),
                  })
                : null,
            ]);
          }
          return h('input', {
            className: 'dshcfg-input' + (field.kind === 'number' ? ' dshcfg-mono' : ''),
            type: 'text',
            value: current === undefined || current === null ? '' : String(current),
            disabled: busy || !state.writable,
            onChange: (event) => setDirty(field.key, event.target.value),
          });
        };

        return h('div', { className: 'dshcfg' }, [
          h('style', { key: 'css' }, CONFIG_CSS),
          h('section', { key: 'card', className: 'dshcfg-card' }, [
            h(
              'button',
              {
                key: 'header',
                type: 'button',
                className: 'dshcfg-header',
                'aria-expanded': state.open ? 'true' : 'false',
                onClick: () => setState((previous) => ({ ...previous, open: !previous.open })),
              },
              [
                h('span', { key: 'text', className: 'dshcfg-head-text' }, [
                  h('span', { key: 'title', className: 'dshcfg-name' }, t('cfg.title')),
                  h('span', { key: 'sub', className: 'dshcfg-desc' }, t('cfg.subtitle')),
                ]),
                state.note ? h('span', { key: 'note', className: 'dshcfg-note' }, state.note) : null,
                h('span', {
                  key: 'chevron',
                  className: 'dshcfg-chev' + (state.open ? ' dshcfg-chev-open' : ''),
                  'aria-hidden': 'true',
                }),
              ],
            ),
            state.open
              ? h('div', { key: 'body', className: 'dshcfg-body' }, [
                  state.error ? h('div', { key: 'err', className: 'dshcfg-err' }, state.error) : null,
                  !state.writable
                    ? h(
                        'div',
                        { key: 'ro', className: 'dshcfg-hint' },
                        [t('cfg.readOnly'), state.reason ? ` (${state.reason})` : ''].join(''),
                      )
                    : null,
                  ...CONFIG_FIELDS.map((field) => {
                    const overridden = Object.hasOwn(state.overrides, field.key);
                    return h('div', { key: field.key, className: 'dshcfg-field' }, [
                      h('div', { key: 'left', className: 'dshcfg-left' }, [
                        h('div', { key: 'name', className: 'dshcfg-row-name' }, [
                          h('span', { key: 'label', className: 'dshcfg-label' }, t(`cfg.field.${field.key}`)),
                          overridden
                            ? h('span', { key: 'badge', className: 'dshcfg-desc' }, t('cfg.overridden'))
                            : null,
                          overridden
                            ? h(
                                'button',
                                {
                                  key: 'reset',
                                  type: 'button',
                                  className: 'dshcfg-btn dshcfg-btn-sm',
                                  disabled: busy || !state.writable,
                                  onClick: () => reset(field.key),
                                },
                                t('cfg.resetField'),
                              )
                            : null,
                        ]),
                        h('div', { key: 'desc', className: 'dshcfg-desc' }, t(`cfg.desc.${field.key}`)),
                      ]),
                      h('div', { key: 'control', className: 'dshcfg-control' }, control(field)),
                    ]);
                  }),
                  h('div', { key: 'foot', className: 'dshcfg-foot' }, [
                    h('span', { key: 'hint', className: 'dshcfg-hint' }, t('cfg.writeHint')),
                    h('span', { key: 'grow', className: 'dshcfg-grow' }),
                    h(
                      'button',
                      {
                        key: 'save',
                        type: 'button',
                        className: 'dshcfg-primary',
                        disabled: busy || pendingCount === 0 || !state.writable,
                        onClick: save,
                      },
                      busy ? t('cfg.saving') : t('cfg.save'),
                    ),
                  ]),
                ])
              : null,
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
       * The URL of the web page the user is actually looking at, if any.
       *
       * Playwright's "current tab" is its own bookkeeping and has nothing to do
       * with which sidebar tab is visible — it also resets to the application page
       * whenever the CLI re-attaches. `browser_claim` needs the visible page, and
       * the only surface that reports it is the carrier element itself: in Desktop
       * a `<webview>` (whose `getURL()` the shell also uses), in Web the browser
       * iframe.
       *
       * @returns {string | null}
       */
      function visibleUrl() {
        try {
          for (const view of document.querySelectorAll('webview')) {
            if (!onScreen(view)) continue;
            const url = typeof view.getURL === 'function' ? view.getURL() : null;
            if (url) return url;
          }
          for (const frame of document.querySelectorAll('iframe[data-sidebar-browser-frame]')) {
            if (!onScreen(frame)) continue;
            return frame.getAttribute('src') ?? null;
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
          visibleUrl: visibleUrl(),
          // Whether this window can produce pixels at all. A minimized (or otherwise
          // hidden) window keeps its layout — innerWidth and the webview boxes are
          // unchanged — so this flag is the only way the Host can tell "no frames"
          // apart from "the tab is merely not the selected one".
          hidden: typeof document.hidden === 'boolean' ? document.hidden : null,
          // One word for "which carrier is this": the custom scheme only exists in
          // Desktop, so it is also the answer to "can this window ever work".
          carrier: window.location.protocol === 'dsh-app:' ? 'desktop' : 'web',
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
      async function openTab(url, sessionId) {
        const service = sidebar();
        if (!service) throw new Error('the sidebar-right client service is not available in this page');

        // A conversation that is not the one on screen gets its tab through the
        // per-session entry point (`openTabIn`, not on `ISidebarRight`). That only works
        // while the conversation's sidebar is MOUNTED: an evicted seat commits the tab to
        // the store but never creates the webview, so the page does not load (measured:
        // it appeared ~2 minutes later, when a store change re-mounted the seat).
        //
        // So when the seat is missing, the plugin briefly selects that conversation
        // (uiWorkspace.openSession), waits for its sidebar, opens the tab, and switches
        // straight back. The user sees a short flash; that is the accepted price of a
        // deterministic background open.
        const mounted = typeof service.mounted?.getSnapshot === "function" ? service.mounted.getSnapshot() : null;
        const background = typeof sessionId === "string" && sessionId !== "" && mounted !== sessionId;
        if (background) {
          if (typeof service.openTabIn !== "function") {
            throw new Error(
              "this DSH build does not let a plugin open a tab for a conversation that is not on screen " +
                "(ctx.sidebarRight has no openTabIn)",
            );
          }
          const surfaceOf = () => document.querySelector(`[data-sidebar-right-session="${sessionId}"]`);
          // Mounted is not enough: a hidden seat keeps its old webviews but creates no new
          // one, so the tab would be committed and never loaded. The seat must be laid out.
          const visible = () =>
            [...document.querySelectorAll(`[data-sidebar-right-session="${sessionId}"]`)].some((element) => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
          const workspace = (() => {
            try {
              return typeof ctx.get === "function" ? ctx.get("uiWorkspace") : null;
            } catch (error) {
              return null;
            }
          })();
          const canSwitch = Boolean(workspace && typeof workspace.openSession === "function" && mounted);
          let switched = false;
          const switchBack = () => {
            if (!switched) return;
            switched = false;
            try {
              workspace.openSession(mounted);
            } catch (error) {}
          };
          try {
            if (!visible() && canSwitch) {
              switched = true;
              workspace.openSession(sessionId);
              const until = Date.now() + 3_000;
              while (!visible() && Date.now() < until) await sleep(100);
            }
            if (!visible()) {
              throw new Error(
                `PAGE_FOREIGN_SESSION: the sidebar of conversation ${sessionId} is not on screen and could not be ` +
                  "brought up, so a tab created there would never load. Open the page from the conversation that " +
                  "is on screen instead.",
              );
            }
          const tabIds = () => {
              try {
                return [...service.tabsIn(sessionId)].map((tab) => tab.tabId ?? tab.id);
              } catch (error) {
                return null;
              }
            };
            const viewCount = () => (surfaceOf() ? surfaceOf().querySelectorAll("webview").length : 0);
            const idsBefore = tabIds();
            const viewsBefore = viewCount();
            service.openTabIn(sessionId, "browser", { params: { url } });
            let added = [];
            let loaded = false;
            const deadline = Date.now() + 6_000;
            for (;;) {
              await sleep(250);
              const idsAfter = tabIds();
              if (idsBefore !== null && idsAfter !== null) added = idsAfter.filter((id) => !idsBefore.includes(id));
              loaded = viewCount() > viewsBefore;
              if ((added.length > 0 && loaded) || Date.now() >= deadline) break;
            }
            if (added.length === 0 || !loaded) {
              // Roll back instead of leaving a tab that can never load.
              for (const doomed of added) {
                try {
                  if (typeof service.closeIn === "function") service.closeIn(sessionId, doomed);
                } catch (error) {}
              }
              throw new Error(
                `PAGE_FOREIGN_SESSION: a tab for conversation ${sessionId} could not be started (no webview was ` +
                  "created). Nothing was left behind. Open the page from the conversation that is on screen, or " +
                  "switch to this one and retry.",
              );
            }
            return { tabId: added[0], sessionId, address: null, url, background: true, identified: true, flashed: switched };
          } finally {
            switchBack();
          }
        }
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
            return { tabId: entry.tabId, sessionId: entry.sessionId, address: entry.contentId, url, background: false };
          }
          const active = service.active();
          if (active && active.kind === 'browser' && !before.has(active.id)) {
            return { tabId: active.id, sessionId: null, address: active.contentId, url, background: false };
          }
          if (Date.now() > identifyDeadline) {
            return { tabId: null, sessionId: null, address: null, url, identified: false, background: false };
          }
          await sleep(100);
        }
      }

      /**
       * The sidebar tab container for one page.
       *
       * The sidebar's own tab id is exact, and it is what the Host stored when it
       * opened or claimed the page. A page discovered after a Host reload has no
       * stored tab id, so its URL is the fallback; two tabs on the same URL are
       * ambiguous, and the caller reports that instead of guessing.
       *
       * @param {{ tabId?: string | null, url?: string | null }} target
       * @param {ParentNode} [root] scope, so per-conversation tab ids cannot collide
       * @returns {Element | null}
       */
      function paneFor(target, root = document) {
        try {
          const panes = [...root.querySelectorAll('[data-sidebar-right-tab]')];
          const tabId = typeof target.tabId === 'string' && target.tabId !== '' ? target.tabId : null;
          if (tabId) {
            // Exact id only. A stale id must fail the action instead of falling through
            // to a same-URL tab, which could close or focus a page nobody asked for.
            return panes.find((pane) => pane.getAttribute('data-sidebar-right-tab') === tabId) ?? null;
          }
          const url = typeof target.url === 'string' && target.url !== '' ? target.url : null;
          if (!url) return null;
          const matches = panes.filter((pane) => {
            const view = pane.querySelector('webview');
            if (!view || typeof view.getURL !== 'function') return false;
            try {
              return view.getURL() === url;
            } catch (error) {
              return false;
            }
          });
          return matches.length === 1 ? matches[0] : null;
        } catch (error) {
          return null;
        }
      }

      /** The `<webview>` inside one sidebar tab container, if this page can see it. */
      function viewFor(pane) {
        try {
          return pane && typeof pane.querySelector === 'function' ? pane.querySelector('webview') : null;
        } catch (error) {
          return null;
        }
      }

      /** The sidebar's own id for a container, when the DOM exposes it. */
      function tabIdOf(pane) {
        try {
          return pane && typeof pane.getAttribute === 'function'
            ? pane.getAttribute('data-sidebar-right-tab')
            : null;
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
       * @param {string} tabId the sidebar's own tab id, when the Host knows it
       * @param {string} url the page URL, the fallback when no tab id exists
       */
      async function prepareCapture(tabId, url) {
        const service = sidebar();
        const target = { tabId, url };
        let pane = paneFor(target);
        let view = viewFor(pane);
        let visible = view ? Boolean(onScreen(view)) : false;
        const expanded = service && typeof service.isExpanded === 'function' ? service.isExpanded() : null;
        if (visible) return { visible: true, tabId: tabIdOf(pane), expanded, expandedNow: false };

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
          // The strip mounts with the panel; tab containers do not exist before that.
          if (expandedNow) await sleep(350);
        }
        pane = paneFor(target);
        view = viewFor(pane);
        visible = view ? Boolean(onScreen(view)) : false;
        if (visible) return { visible: true, tabId: tabIdOf(pane), expanded, expandedNow, expandVia, expandError };
        // Only a container that was actually found may be focused: a stale tab id must
        // not select whichever tab now happens to carry that id.
        const focusId = tabIdOf(pane);
        if (!focusId) return { visible: false, tabId: null, expanded, expandedNow, expandVia, expandError };
        service.focus(focusId);
        return { visible: false, tabId: focusId, expanded, expandedNow, expandVia, expandError };
      }

      /**
       * Close the sidebar tab itself.
       *
       * `playwright-cli tab-close` only destroys the CDP target: the sidebar tab
       * survives as an empty shell showing "页面加载失败；请刷新重试或在系统浏览器中打开。",
       * and stays focused. Only the sidebar controller can remove the tab, so this
       * is a UI action like `openTab`, not a CLI one.
       *
       * @param {string} sessionId
       * @param {string} tabId the sidebar's own tab id, when the Host knows it
       * @param {string} url the page URL, the fallback when no tab id exists
       */
      async function closePage(sessionId, tabId, url) {
        const service = sidebar();
        if (!service || typeof service.close !== 'function') {
          return { closed: false, tabId: null, reason: 'the sidebar-right client service cannot close tabs' };
        }
        // Look only inside the owning conversation: tab ids repeat per conversation, so a
        // document-wide lookup could close a same-numbered tab in the conversation
        // that happens to be on screen.
        const rootFor = (owner) =>
          typeof owner === "string" && owner !== ""
            ? document.querySelector(`[data-sidebar-right-session="${owner}"]`)
            : document;
        const root = rootFor(sessionId);
        if (!root) {
          return {
            closed: false,
            tabId: null,
            reason: `the sidebar of conversation ${sessionId} is not mounted, so its tab cannot be closed from here`,
          };
        }
        const mounted = typeof service.mounted?.getSnapshot === "function" ? service.mounted.getSnapshot() : null;
        const owner = typeof sessionId === "string" && sessionId !== "" ? sessionId : mounted;
        const pane = paneFor({ tabId, url }, root);
        const resolved = tabId || tabIdOf(pane);
        if (!resolved) {
          return {
            closed: false,
            tabId: null,
            reason:
              "no sidebar tab matches this page (the tab may already be gone, or the Host has no tab id for it)",
          };
        }
        const workspace = (() => {
          try {
            return typeof ctx.get === "function" ? ctx.get("uiWorkspace") : null;
          } catch (error) {
            return null;
          }
        })();
        const canSwitch = Boolean(workspace && typeof workspace.openSession === "function" && mounted);
        const visible = (who) =>
          [...document.querySelectorAll(`[data-sidebar-right-session="${who}"]`)].some((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
        let switched = false;
        try {
          if (owner && mounted && owner !== mounted) {
            if (!canSwitch) {
              return {
                closed: false,
                tabId: resolved,
                reason:
                  `conversation ${owner} is not on screen and this DSH build cannot select it, so its tab ` +
                  "cannot be closed from here. Close it in that conversation.",
              };
            }
            // `closeIn` is silent for a conversation without an adopted store, and
            // `close` addresses the on-screen strip — so select the owner, close its tab
            // normally, and switch back.
            switched = true;
            workspace.openSession(owner);
            const until = Date.now() + 3_000;
            while (!visible(owner) && Date.now() < until) await sleep(100);
          }
          service.close(resolved);
        } catch (error) {
          return { closed: false, tabId: resolved, reason: error && error.message ? error.message : String(error) };
        } finally {
          if (switched) {
            try {
              workspace.openSession(mounted);
            } catch (error) {}
          }
        }
        // Verify against the controller's own tab list, which knows about tabs the DOM
        // no longer shows; the DOM lookup is the fallback for builds without it.
        const listed = () => {
          try {
            if (typeof service.tabsIn === "function") {
              return [...service.tabsIn(owner)].map((tab) => tab.tabId ?? tab.id);
            }
          } catch (error) {}
          try {
            const snapshot =
              service.openTabs && typeof service.openTabs.getSnapshot === "function"
                ? service.openTabs.getSnapshot()
                : null;
            if (Array.isArray(snapshot)) {
              return snapshot
                .filter((tab) => !tab.sessionId || tab.sessionId === owner)
                .map((tab) => tab.tabId);
            }
          } catch (error) {}
          return null;
        };
        const until = Date.now() + 2_000;
        for (;;) {
          const ids = listed();
          const stillThere = ids ? ids.includes(resolved) : Boolean(paneFor({ tabId: resolved }, root));
          if (!stillThere) break;
          if (Date.now() >= until) {
            return {
              closed: false,
              tabId: resolved,
              reason:
                `the sidebar still lists tab ${resolved} of conversation ${owner} after closing it, so the tab was ` +
                "not removed. Try again from that conversation.",
            };
          }
          await sleep(150);
        }
        return { closed: true, tabId: resolved };
      }
      /** @param {{ requestId: string, kind: string, url?: string, pageId?: string }} command */
      async function handle(command) {
        if (command.kind === 'open-tab') {
          const value = await openTab(command.url, command.sessionId);
          await call('result', { requestId: command.requestId, ok: true, value });
          return;
        }
        if (command.kind === 'close-tab') {
          // Rollback for a background open that never produced a page.
          const service = sidebar();
          if (!service || typeof service.closeIn !== "function") {
            throw new Error('this DSH build cannot close a tab in another conversation');
          }
          service.closeIn(String(command.sessionId ?? ''), String(command.tabId ?? ''));
          await call('result', { requestId: command.requestId, ok: true, value: { closed: true } });
          return;
        }
        if (command.kind === 'ping') {
          await call('result', { requestId: command.requestId, ok: true, value: capabilities() });
          return;
        }
        if (command.kind === 'prepare-capture') {
          const value = await prepareCapture(String(command.tabId ?? ''), String(command.url ?? ''));
          await call('result', { requestId: command.requestId, ok: true, value });
          return;
        }
        if (command.kind === 'close-page') {
          const value = await closePage(
            String(command.sessionId ?? ''),
            String(command.tabId ?? ''),
            String(command.url ?? ''),
          );
          await call('result', { requestId: command.requestId, ok: true, value });
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
            const reply = await call(
            'poll',
            // Carry a fresh capability snapshot: which Session is on screen and
            // which page is visible change without any bridge command.
            { clientId: id, waitMs: POLL_WAIT_MS, capabilities: capabilities() },
            POLL_WAIT_MS + 10_000,
          );
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
                // The start page lists one capsule per guide entry, so this is what
                // makes the panel discoverable without a model tool call. Order puts
                // it after the built-in browser (10) and before the terminal (100).
                guide: [
                  {
                    id: 'panel',
                    order: 20,
                    title: () => t('panel.title'),
                    description: () => t('panel.guide'),
                    icon: panelIcon,
                  },
                ],
              }),
            );
            disposers.push(
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PANEL_ID }, makePanel(t)),
            );
            // The "shared with the agent" marker lives on the frame-wide overlay, above
            // the sidebar: the page is never touched, and the chip keeps the official
            // renderer (which is the only thing that can read the browser store title).
            try {
              disposers.push(
                ctx.slots.register(
                  { name: 'shell.overlay', id: 'browser-automation:shared', order: 30 },
                  makeSharedBadge(t),
                ),
              );
            } catch (error) {
              console.warn(`[dsh-browser-automation] shared badge could not register: ${error.message}`);
            }
            // A bundle's own configuration is seated on its page in the sidebar's
            // Plugins view (the slot contract says a third-party bundle's config
            // belongs in `plugins.bundle.config`, not `plugins.item`). Nested inject
            // so a host that never declares that slot still loads everything else.
            const slotCtx = ctx;
            if (slotCtx.slots && typeof slotCtx.slots.inject === 'function') {
              slotCtx.slots.inject('plugins.bundle.config', () => {
                const dispose = slotCtx.slots.register(
                  {
                    name: 'plugins.bundle.config',
                    key: PACKAGE_NAME,
                    locale: LOCALE_NS,
                  },
                  makeConfigCard(t),
                );
                disposers.push(dispose);
                return dispose;
              });
            }
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






















