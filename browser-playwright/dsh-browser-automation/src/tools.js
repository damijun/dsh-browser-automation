import { readFileSync } from 'node:fs';

/**
 * Tool definitions for the DSH sidebar-browser automation plugin.
 *
 * Definitions are written in the **compiled** form accepted by
 * `ctx.tools.register()` (raw JSON Schema, no `defineTool` import) so the bundle
 * stays dependency-free: a profile-installed bundle cannot resolve
 * `@deepseek-ai/dsh-tools` from its own directory. Only the JSON Schema subset
 * the registry enforces is used — `type`, `properties`, `required` (array),
 * `additionalProperties`, `items`, `enum`, `oneOf`, plus annotations.
 *
 * Three invariants every tool here keeps:
 *  - the first positional argument is a `pageId`, never a tab index;
 *  - a failure is thrown, and its message names the next action for the model;
 *  - the returned value is lossless JSON (`sanitize` drops `undefined`).
 */

/** @param {unknown} value */
export function sanitize(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * Build one schema node. `description` is omitted rather than set to
 * `undefined`: the registry's annotation check requires every present
 * annotation to be real JSON data, so `{ description: undefined }` fails.
 */
function spec(type, description, extra = {}) {
  return description === undefined ? { type, ...extra } : { type, description, ...extra };
}
const string = (description, extra = {}) => spec('string', description, extra);
const integer = (description, extra = {}) => spec('integer', description, extra);
const boolean = (description, extra = {}) => spec('boolean', description, extra);

/** Assistant-side rendering: one text block built from the returned value. */
const renderWith =
  (toText) =>
  (_args, value) => [{ type: 'text', text: toText(value) }];

const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** Shared sentence, because 14 tools repeating it would be pure token cost. */
const PAGE_ID_NOTE =
  'pageId is the stable handle from browser_open or browser_claim; the playwright-cli tab index is resolved internally on every call.';

/**
 * @param {import('./runtime.js').Runtime} runtime
 * @returns {any[]} tool definitions for ctx.tools.register
 */
export function createTools(runtime) {
  return [
    {
      name: 'browser_open',
      description:
        'Open an http(s) or file URL in a new DSH right-sidebar browser tab and take control of it. ' +
        'It creates a real sidebar tab through the DSH UI, so the user can see the page and keep using it. ' +
        'Open a tab only when the sidebar needs an extra one: the column shows one tab at a time and every ' +
        'tab is a live page the user has to close. Check browser_list first — when a page you already ' +
        'control no longer needs its current state, browser_goto reaches the new URL in that tab and keeps ' +
        'its pageId, which is the cheap path. Open what must coexist: a page you keep as it is, a comparison, ' +
        "the session's first tab. " +
        'It never takes over an existing tab; use browser_claim for the page the user already has open. ' +
        'Fails when the DSH page half is not connected. ' +
        PAGE_ID_NOTE,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: string('Absolute http(s) or file URL. A bare host becomes https://<host>.'),
          waitMs: integer('How long to wait for the tab to become reachable, in milliseconds. Defaults to 15000.'),
        },
        required: ['url'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string('Stable page handle for every later call.'),
            url: string('The URL the tab reports after loading.'),
            title: string('Current page title, including the page marker.'),
            background: boolean(
              'True when the tab was created in a conversation that is not on screen: the page has no visible ' +
                'surface, so it will not be focused and cannot be screenshotted.',
            ),
            flashed: boolean(
              'True when the plugin had to select this conversation for a moment to mount its sidebar (the window ' +
                'briefly switched and switched back).',
            ),
          },
          required: ['pageId', 'url'],
        },
        render: renderWith(
          (value) =>
            `Opened ${value.url}\npageId: ${value.pageId}` +
            (value.title ? `\ntitle: ${value.title}` : '') +
            (value.background
              ? '\nbackground: this conversation is not the one on screen, so the tab was created in the background — ' +
                'it is not focused and cannot be screenshotted; every other tool works on it.' +
                (value.flashed
                  ? ' The window briefly switched to this conversation to mount its sidebar, then switched back.'
                  : '')
              : ''),
        ),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(await runtime.openPage({ sessionId, url: args.url, waitMs: args.waitMs, signal: exec.signal }));
      },
    },

    {
      name: 'browser_claim',
      description:
        'Take over the browser page the user currently has open in the DSH right sidebar — the second of the ' +
        'two ways to start work (the other is browser_open). Use it when the user says they already opened or ' +
        'logged into a page and want you to continue from there. ' +
        'The sidebar must be open with a browser tab selected: a collapsed sidebar keeps the page alive but ' +
        'gives it no surface, so the plugin cannot tell which page the user is on. ' +
        'SIDE EFFECT: this replaces the page marker on that tab, so any earlier pageId for the same tab stops ' +
        'resolving; the user may be actively using that page, so ask before claiming when the intent is unclear. ' +
        'Cannot take over a page that existed before playwright-cli attached (for example one opened before an app ' +
        'restart): the CLI never adopts it. Reopen that URL (or browser_open it) and claim the new tab instead. ' +
        'Fails when no page is visible, when the page half is not connected, or when the page is still loading.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          note: string('Optional reminder of why the page is being taken over; echoed back.'),
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string('Stable page handle for every later call.'),
            title: string('Page title before the marker was replaced.'),
            url: string('Current URL.'),
            note: string('The note that was passed in, if any.'),
            replacedExistingPageId: string(
              'Present when the tab already carried a marker: the pageId it lost, now unregistered.',
            ),
          },
          required: ['pageId', 'url'],
        },
        render: renderWith(
          (value) =>
            `Claimed "${value.title ?? ''}" (${value.url})\npageId: ${value.pageId}`,
        ),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(await runtime.claimPage({ sessionId, note: args.note, signal: exec.signal }));
      },
    },

    {
      name: 'browser_list',
      description:
        'List browser tabs with their page handles. scope="session" (default) shows only pages this DSH session controls; ' +
        'scope="all" also shows tabs other sessions control and unmarked tabs. ' +
        'Read this before browser_open: a page you already control can take the new URL through ' +
        'browser_goto instead of spending another tab. ' +
        'Always re-read this instead of reusing a page handle from an earlier call.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: string('session (default) or all.', { enum: ['session', 'all'] }),
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: integer('Number of rows returned.'),
            pages: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            warning: string(
              'Present when the tab list could not be read, or when the sidebar shows a page playwright-cli never adopted; explains why.',
            ),
          },
          required: ['count', 'pages'],
        },
        // No tab index in the rendered line: the model addresses pages by pageId, and
        // the index is the one piece of a row it could never pass back to a tool.
        render: renderWith((value) => {
          const body =
            value.pages.length === 0
              ? 'No browser tabs are controlled by this session yet. Use browser_open to open one, or browser_claim to take over the tab the user has open.'
              : value.pages
                  .map(
                    (page) =>
                      `${page.current ? '(current) ' : ''}${page.pageId ?? '(unmarked)'} — ${page.title ?? ''} — ${page.url}`,
                  )
                  .join('\n');
          // The warning is the whole point when the sidebar looks non-empty and this
          // list does not: it must reach the model, not just the JSON.
          return value.warning ? `${body}\n\nWarning: ${value.warning}` : body;
        }),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(await runtime.listPages({ sessionId, scope: args.scope ?? 'session' }));
      },
    },

    {
      name: 'browser_close',
      description:
        'Close one sidebar browser tab by pageId. It removes the DSH sidebar tab itself, so nothing is left behind. ' +
        'It never detaches playwright-cli and never closes DSH. ' +
        'Close tabs you are done with: the sidebar shows one tab at a time, so a tab you keep open keeps ' +
        'costing the user attention. ' +
        'Fails when the DSH page half is not connected, because only the page can remove a sidebar tab.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string('Page handle to close.'),
        },
        required: ['pageId'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            closed: boolean(),
            tabId: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              description: 'The sidebar tab id that was removed, when the page could report it.',
            },
          },
          required: ['pageId', 'closed'],
        },
        render: renderWith((value) => `Closed the sidebar tab for ${value.pageId}.`),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(await runtime.closePage({ pageId: args.pageId, sessionId, signal: exec.signal }));
      },
    },

    {
      name: 'browser_snapshot',
      description:
        'Capture the accessibility snapshot of a page: one line per element with a [ref=…] handle for click/fill. ' +
        'Snapshots are returned verbatim — refs are only valid for this snapshot, so re-snapshot after the page changes. ' +
        'Prefer snapshot over screenshot for reading content; use screenshot only to judge visual layout.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string('Page handle.'),
          depth: integer('Optional maximum tree depth. Omit for the whole page.'),
        },
        required: ['pageId'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            title: string(),
            url: string(),
            refCount: integer(),
            snapshot: string('The snapshot text, exactly as playwright-cli produced it.'),
          },
          required: ['pageId', 'refCount', 'snapshot'],
        },
        render: renderWith((value) => value.snapshot),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(
          await runtime.snapshot({
            pageId: args.pageId,
            depth: args.depth,
            sessionId,
            signal: exec.signal,
          }),
        );
      },
    },

    {
      name: 'browser_screenshot',
      description:
        'Save a PNG screenshot of a page to disk and return its absolute path. ' +
        'Screenshots are for judging layout, spacing, overflow and colour; read text with browser_snapshot instead. ' +
        'SIDE EFFECT: Chromium only frames a sidebar tab that is on screen, so if this tab is not the visible one the ' +
        'plugin brings it to the front (expanding the right sidebar if it is collapsed) and leaves it there. ' +
        'The image is the sidebar tab as the user sees it. ' +
        'Fails immediately when the DSH window itself is minimized or off screen: a hidden window produces no frames, ' +
        'so ask the user to keep the window visible for screenshot runs. Every tool that does not need pixels still works. ' +
        'Captures the sidebar as it is: the image is the current sidebar size, and nothing is resized to fit it. ' +
        'A page opened from a conversation that is not on screen has no surface at all, so it cannot be captured ' +
        'either — drive it with the other tools instead.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string('Page handle.'),
          fullPage: boolean('Capture the whole scrollable page instead of the viewport.'),
          target: string('Optional element ref or selector to capture that element only.'),
        },
        required: ['pageId'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            path: string('Absolute path of the written PNG.'),
          },
          required: ['pageId', 'path'],
        },
        render: renderWith((value) => `Screenshot saved to ${value.path}`),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(
          await runtime.screenshot({
            pageId: args.pageId,
            fullPage: args.fullPage === true,
            target: args.target,
            sessionId,
            signal: exec.signal,
          }),
        );
      },
    },

    {
      name: 'browser_click',
      description:
        'Click an element in a page by its [ref=…] handle from the latest snapshot (or a unique CSS selector). ' +
        'The command switches playwright-cli\'s current tab to this page and leaves it there.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string('Page handle.'),
          ref: string('Element ref from the latest snapshot, e.g. e12, or a unique selector.'),
          button: string('left (default), right or middle.', { enum: ['left', 'right', 'middle'] }),
          double: boolean('Double-click instead of a single click.'),
          modifiers: {
            type: 'array',
            description: 'Modifier keys held during the click.',
            items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
          },
        },
        required: ['pageId', 'ref'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            result: string('playwright-cli output.'),
          },
          required: ['pageId'],
        },
        render: renderWith((value) => `Clicked ${value.result || 'ok'}.`),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(
          await runtime.click({
            pageId: args.pageId,
            ref: args.ref,
            button: args.button,
            double: args.double === true,
            modifiers: args.modifiers,
            sessionId,
            signal: exec.signal,
          }),
        );
      },
    },

    {
      name: 'browser_fill',
      description:
        'Replace the contents of an editable element (input, textarea, contenteditable) with text, by [ref=…] or selector. ' +
        'This always overwrites; use browser_press for keys like Enter or Escape.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string('Page handle.'),
          ref: string('Element ref from the latest snapshot, or a unique selector.'),
          text: string('Text to fill in.'),
          submit: boolean('Press Enter after filling.'),
        },
        required: ['pageId', 'ref', 'text'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            result: string(),
          },
          required: ['pageId'],
        },
        render: renderWith((value) => `Filled ${value.result || 'ok'}.`),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(
          await runtime.fill({
            pageId: args.pageId,
            ref: args.ref,
            text: args.text,
            submit: args.submit === true,
            sessionId,
            signal: exec.signal,
          }),
        );
      },
    },

    {
      name: 'browser_press',
      description: 'Press one keyboard key in a page, e.g. Enter, Tab, Escape, ArrowDown, or a single character.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string('Page handle.'),
          key: string('Key name, e.g. Enter.'),
        },
        required: ['pageId', 'key'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            result: string(),
          },
          required: ['pageId'],
        },
        render: renderWith((value) => `Pressed ${value.result || 'ok'}.`),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(await runtime.press({ pageId: args.pageId, key: args.key, sessionId, signal: exec.signal }));
      },
    },

    {
      name: 'browser_goto',
      description:
        'Navigate a controlled page to another URL in its existing tab. This is the default way to change ' +
        'address: it costs no new tab, and the page handle stays valid because the marker is re-applied after ' +
        'the navigation. The tab is brought to the front first, so the user can see it. ' +
        'The previous page state is not preserved — DOM, scroll and form input are gone after the navigation. ' +
        'When that state matters (you will come back to it, or the user is working in it), open a second tab ' +
        'with browser_open and leave this one untouched.',      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string('Page handle.'),
          url: string('Absolute http(s) or file URL.'),
        },
        required: ['pageId', 'url'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            url: string(),
            title: string(),
          },
          required: ['pageId', 'url'],
        },
        render: renderWith((value) => `Navigated to ${value.url}${value.title ? ` — ${value.title}` : ''}.`),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(await runtime.goto({ pageId: args.pageId, url: args.url, sessionId, signal: exec.signal }));
      },
    },

    {
      name: 'browser_reload',
      description:
        'Reload one sidebar browser page by pageId: it navigates that tab to its own current URL, after bringing the ' +
        'tab to the front so the user can see it. It never uses the CLI reload command, which reloads the ' +
        'whole DSH page whatever tab is selected. The tab stays the same tab, so pageId still resolves.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string('Page handle. Must be a sidebar browser page, never the DSH application.'),
        },
        required: ['pageId'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            url: string(),
            title: string(),
          },
          required: ['pageId', 'url'],
        },
        render: renderWith((value) => `Reloaded ${value.url}${value.title ? ` — ${value.title}` : ''}.`),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(await runtime.reload({ pageId: args.pageId, sessionId, signal: exec.signal }));
      },
    },

    {
      name: 'browser_run_code',
      description:
        'Run a Playwright snippet against a page. The code is a function body invoked with `page` in scope. ' +
        'This is also the read-only workhorse: there is no separate evaluate tool, so read a value with ' +
        '`return await page.evaluate(() => document.title)` and read elements with ' +
        "`return await page.locator('a').allTextContents()`. Return a string (JSON.stringify it yourself when you " +
        'need structure back); the snippet output is what comes back. ' +
        'Choose per step: if the next action depends on what the previous step returned, stay on single-step tools ' +
        '(snapshot → click/fill → snapshot); reach for run_code when the path can be written in advance — ' +
        'regression flows, batch extraction, or capturing a transient state atomically. ' +
        'When a script fails, go back to browser_snapshot and re-explore instead of retrying the script blindly. ' +
        'History navigation lives here too: page.goBack() / page.goForward() (same as the sidebar buttons); they are ' +
        'deliberately not separate tools. ' +
        'Do not change the page geometry in a snippet: page.setViewportSize() and body zoom belong to the sidebar, ' +
        'which DSH sizes. A page laid out wider than the sidebar comes back as a tiled screenshot (the page drawn ' +
        'twice), so leave the viewport alone and screenshots stay clean.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string('Page handle.'),
          code: string('Playwright code body, e.g. "async page => { await page.click(\'#go\'); return page.url() }".'),
        },
        required: ['pageId', 'code'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            output: string('playwright-cli output.'),
          },
          required: ['pageId', 'output'],
        },
        render: renderWith((value) => value.output),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(await runtime.runCode({ pageId: args.pageId, code: args.code, sessionId, signal: exec.signal }));
      },
    },

    {
      name: 'browser_console',
      description:
        'Read the browser console messages of a page, most recent last. Useful when a click did nothing: ' +
        'a JavaScript error usually explains it faster than another snapshot.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string('Page handle.'),
          level: string('Minimum level: error, warning, info (default) or debug.', {
            enum: ['error', 'warning', 'info', 'debug'],
          }),
          limit: integer('Keep only the last N lines. Defaults to 50.'),
        },
        required: ['pageId'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            messages: string(),
          },
          required: ['pageId', 'messages'],
        },
        render: renderWith((value) => value.messages || '(no console messages)'),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(
          await runtime.consoleMessages({
            pageId: args.pageId,
            level: args.level,
            limit: args.limit,
            sessionId,
            signal: exec.signal,
          }),
        );
      },
    },

    {
      name: 'browser_status',
      description:
        'Report the connection between this plugin, playwright-cli and the DSH page, and (optionally) attach, detach or open the panel. ' +
        'Call it when a browser_* tool reports a connection problem. ' +
        'action="panel" opens the read-only status panel as a right-sidebar tab (for the user, not for you). ' +
        'action="detach" releases playwright-cli without closing DSH; that is the way to end an automation run.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: string('status (default), attach, detach or panel.', {
            enum: ['status', 'attach', 'detach', 'panel'],
          }),
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: string(),
            attached: boolean(),
            cdpUrl: string(),
            cli: {
              type: 'object',
              additionalProperties: true,
              description:
                'How the CLI is started: command, the shared -s= session name, and resolved {node, entry}.',
            },
            bridge: {
              type: 'object',
              additionalProperties: true,
              description:
                'The Host<->page channel: state (live/stale/never), clients[], and pendingRequests/queuedCommands/heldPolls.',
            },
            bridgeError: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              description: 'Why the page bridge could not mount, when it failed.',
            },
            autoAttach: {
              type: 'object',
              additionalProperties: true,
              description:
                'Outcome of the startup attach: {ok, at, error, attempts, skipped?}. ok=false means the CLI could not attach at boot; browser_open/claim will retry on demand.',
            },
            currentIndex: integer('The tab index playwright-cli currently points at, or -1.'),
            pages: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description:
                'Every CDP tab the CLI sees, each annotated with pageId/session/mine/source. The only tab list.',
            },
            modes: {
              type: 'object',
              additionalProperties: false,
              properties: {
                open: boolean('True when browser_open can work right now (a page half is listening).'),
                claim: boolean('True when browser_claim can work right now (a browser page is visible).'),
              },
              required: ['open', 'claim'],
            },
            note: string(),
          },
          required: ['action', 'attached', 'cdpUrl', 'modes'],
        },
        render: renderWith((value) => JSON.stringify(value, null, 2)),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        const requested = args.action ?? 'status';
        if (requested === 'panel') await runtime.openPanel();
        const snapshot = await runtime.status({
          sessionId,
          action: requested === 'panel' ? 'status' : requested,
          signal: exec.signal,
        });
        if (requested !== 'panel') return sanitize(snapshot);
        // Keep any note status produced (e.g. an attach failure) and add our own.
        return sanitize({
          ...snapshot,
          action: 'panel',
          note: snapshot.note ?? 'Opened the status panel in the right sidebar.',
        });
      },
    },
  ];
}

/** @param {{ agent?: { id?: string } }} exec */
function requireSession(exec) {
  const sessionId = exec?.agent?.id;
  if (!sessionId) {
    throw new Error(
      'This tool needs an owning DSH session (it isolates pages per session); call it from a normal conversation turn.',
    );
  }
  return String(sessionId);
}

/** Read a packaged locale file, used by the plugin entry for display metadata. */
export function readLocale(name) {
  const url = new URL(`../locale/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}







