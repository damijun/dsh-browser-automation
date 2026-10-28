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
        'Open an HTTP(S) URL in a new DSH right-sidebar browser tab and take control of it. ' +
        'This is the normal way to start browsing: it creates a real sidebar tab through the DSH UI, ' +
        'so the user can see the page and keep using it. ' +
        'Use browser_claim instead when the user already opened the page they want. ' +
        PAGE_ID_NOTE,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: string('Absolute http(s) URL. A bare host becomes https://<host>.'),
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
            index: integer('Current playwright-cli tab index (informational only; never cache it).'),
            how: string('new-tab when a sidebar tab was created, reused-tab when an existing tab was navigated.'),
            note: string('Present when the degraded path was used.'),
          },
          required: ['pageId', 'url', 'index', 'how'],
        },
        render: renderWith(
          (value) =>
            `Opened ${value.url}\npageId: ${value.pageId}\ntab index: ${value.index} (${value.how})` +
            (value.title ? `\ntitle: ${value.title}` : '') +
            (value.note ? `\nnote: ${value.note}` : ''),
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
        'Take over the sidebar browser tab the user is currently on (playwright-cli\'s current tab) and return its title and URL. ' +
        'SIDE EFFECT: this replaces the page marker on that tab, so any earlier pageId for the same tab stops resolving; ' +
        'the user may be actively using that page, so ask before claiming when the intent is unclear. ' +
        'Fails when the current tab is the DSH application page or a non-http(s) target.',
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
            index: integer('Current playwright-cli tab index (informational only).'),
            note: string('The note that was passed in, if any.'),
            replacedExistingPageId: string(
              'Present when the tab already carried a marker: the pageId it lost, now unregistered.',
            ),
          },
          required: ['pageId', 'url', 'index'],
        },
        render: renderWith(
          (value) =>
            `Claimed "${value.title ?? ''}" (${value.url})\npageId: ${value.pageId}\ntab index: ${value.index}`,
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
        'Always re-read this instead of reusing an index from an earlier call.',
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
            warning: string('Present when the tab list could not be read; explains why.'),
          },
          required: ['count', 'pages'],
        },
        render: renderWith((value) =>
          value.pages.length === 0
            ? 'No browser tabs are controlled by this session yet. Use browser_open to open one, or browser_claim to take over the tab the user has open.'
            : value.pages
                .map(
                  (page) =>
                    `[${page.index}]${page.current ? ' (current)' : ''} ${page.pageId ?? '(unmarked)'} — ${page.title ?? ''} — ${page.url}`,
                )
                .join('\n'),
        ),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(await runtime.listPages({ sessionId, scope: args.scope ?? 'session' }));
      },
    },

    {
      name: 'browser_close',
      description:
        'Close one sidebar browser tab by pageId. This closes the tab only; it never detaches playwright-cli and never closes DSH.',
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
            index: integer(),
          },
          required: ['pageId', 'closed'],
        },
        render: renderWith((value) => `Closed tab ${value.index} (pageId ${value.pageId}).`),
      },
      async execute(args, exec) {
        requireSession(exec);
        return sanitize(await runtime.closePage({ pageId: args.pageId, signal: exec.signal }));
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
            index: integer(),
            title: string(),
            url: string(),
            refCount: integer(),
            snapshot: string('The snapshot text, exactly as playwright-cli produced it.'),
          },
          required: ['pageId', 'index', 'refCount', 'snapshot'],
        },
        render: renderWith((value) => value.snapshot),
      },
      async execute(args, exec) {
        requireSession(exec);
        return sanitize(
          await runtime.snapshot({ pageId: args.pageId, depth: args.depth, signal: exec.signal }),
        );
      },
    },

    {
      name: 'browser_screenshot',
      description:
        'Save a PNG screenshot of a page to disk and return its absolute path. ' +
        'Screenshots are for judging layout, spacing, overflow and colour; read text with browser_snapshot instead.',
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
            index: integer('Current tab index (informational only).'),
            path: string('Absolute path of the written PNG.'),
          },
          required: ['pageId', 'index', 'path'],
        },
        render: renderWith((value) => `Screenshot saved to ${value.path}`),
      },
      async execute(args, exec) {
        requireSession(exec);
        return sanitize(
          await runtime.screenshot({
            pageId: args.pageId,
            fullPage: args.fullPage === true,
            target: args.target,
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
            index: integer(),
            result: string('playwright-cli output.'),
          },
          required: ['pageId', 'index'],
        },
        render: renderWith((value) => `Clicked ${value.result || 'ok'} on tab ${value.index}.`),
      },
      async execute(args, exec) {
        requireSession(exec);
        return sanitize(
          await runtime.click({
            pageId: args.pageId,
            ref: args.ref,
            button: args.button,
            double: args.double === true,
            modifiers: args.modifiers,
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
            index: integer(),
            result: string(),
          },
          required: ['pageId', 'index'],
        },
        render: renderWith((value) => `Filled ${value.result || 'ok'} on tab ${value.index}.`),
      },
      async execute(args, exec) {
        requireSession(exec);
        return sanitize(
          await runtime.fill({
            pageId: args.pageId,
            ref: args.ref,
            text: args.text,
            submit: args.submit === true,
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
            index: integer(),
            result: string(),
          },
          required: ['pageId', 'index'],
        },
        render: renderWith((value) => `Pressed ${value.result || 'ok'} on tab ${value.index}.`),
      },
      async execute(args, exec) {
        requireSession(exec);
        return sanitize(await runtime.press({ pageId: args.pageId, key: args.key, signal: exec.signal }));
      },
    },

    {
      name: 'browser_goto',
      description:
        'Navigate a controlled page to another URL. The page handle stays valid: the marker is re-applied after navigation and verified. ' +
        'Use this to move an existing tab; use browser_open to add a tab.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string('Page handle.'),
          url: string('Absolute http(s) URL.'),
        },
        required: ['pageId', 'url'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            index: integer(),
            url: string(),
            title: string(),
          },
          required: ['pageId', 'index', 'url'],
        },
        render: renderWith((value) => `Navigated to ${value.url}${value.title ? ` — ${value.title}` : ''}.`),
      },
      async execute(args, exec) {
        requireSession(exec);
        return sanitize(await runtime.goto({ pageId: args.pageId, url: args.url, signal: exec.signal }));
      },
    },

    {
      name: 'browser_evaluate',
      description:
        'Evaluate one JavaScript expression inside a page and return the JSON-stringified result. ' +
        'The expression must be a single expression or an IIFE — the CLI wraps it as () => (expression), so a statement list is a syntax error. ' +
        'Use it for one-off static extraction; use browser_run_code when the path can be written as code up front.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string('Page handle.'),
          expression: string('Single JavaScript expression or IIFE.'),
        },
        required: ['pageId', 'expression'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            index: integer(),
            result: string('JSON.stringify of the evaluated value.'),
          },
          required: ['pageId', 'index', 'result'],
        },
        render: renderWith((value) => value.result),
      },
      async execute(args, exec) {
        requireSession(exec);
        return sanitize(
          await runtime.evaluate({ pageId: args.pageId, expression: args.expression, signal: exec.signal }),
        );
      },
    },

    {
      name: 'browser_run_code',
      description:
        'Run a Playwright snippet against a page. The code is a function body invoked with `page` in scope. ' +
        'Choose per step: if the next action depends on what the previous step returned, stay on single-step tools ' +
        '(snapshot → click/fill → snapshot); reach for run_code when the path can be written in advance — ' +
        'regression flows, batch extraction, or capturing a transient state atomically. ' +
        'When a script fails, go back to browser_snapshot and re-explore instead of retrying the script blindly.',
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
            index: integer(),
            output: string('playwright-cli output.'),
          },
          required: ['pageId', 'index', 'output'],
        },
        render: renderWith((value) => value.output),
      },
      async execute(args, exec) {
        requireSession(exec);
        return sanitize(await runtime.runCode({ pageId: args.pageId, code: args.code, signal: exec.signal }));
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
            index: integer(),
            messages: string(),
          },
          required: ['pageId', 'index', 'messages'],
        },
        render: renderWith((value) => value.messages || '(no console messages)'),
      },
      async execute(args, exec) {
        requireSession(exec);
        return sanitize(
          await runtime.consoleMessages({
            pageId: args.pageId,
            level: args.level,
            limit: args.limit,
            signal: exec.signal,
          }),
        );
      },
    },

    {
      name: 'browser_status',
      description:
        'Report the connection between this plugin, playwright-cli and the DSH page, and (optionally) attach or detach the CLI session. ' +
        'Call it when a browser_* tool reports a connection problem. ' +
        'action="detach" releases playwright-cli without closing DSH; that is the way to end an automation run.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: string('status (default), attach or detach.', { enum: ['status', 'attach', 'detach'] }),
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
            cli: { type: 'object', additionalProperties: true },
            bridge: { type: 'object', additionalProperties: true },
            bridgeError: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              description: 'Why the page bridge could not mount, when it failed.',
            },
            currentIndex: integer('Current tab index, or -1 when nothing is attached.'),
            tabs: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pages: { type: 'array', items: { type: 'object', additionalProperties: true } },
            note: string(),
          },
          required: ['action', 'attached', 'cdpUrl'],
        },
        render: renderWith((value) => JSON.stringify(value, null, 2)),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(
          await runtime.status({ sessionId, action: args.action ?? 'status', signal: exec.signal }),
        );
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
