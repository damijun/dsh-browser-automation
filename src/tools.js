import { readFileSync } from 'node:fs';

import { formatRunCodeOutput, wrapRunCodeBody } from './run-code.js';

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

/**
 * Render a `browser_snapshot` result.
 *
 * The layout is fixed by the snapshot size-control design: pageId first, then the
 * raw snapshot when it fits; otherwise the over-limit banner, the absolute path of
 * the complete text, and the whole-line prefix that is actually shown. No title and
 * no URL are included — the model only needs the page content here.
 *
 * @param {{ pageId: string, snapshot: string, truncated: boolean, maxChars: number, snapshotPath?: string }} value
 */
function renderSnapshot(value) {
  const lines = [`pageId: ${value.pageId}`];
  if (value.truncated === true) {
    lines.push(
      'Snapshot exceeds the maximum output size.',
      'Full snapshot saved to:',
      String(value.snapshotPath ?? ''),
      `Showing the first ${value.maxChars} characters by complete lines:`,
    );
  }
  const snapshot = value.snapshot ?? '';
  lines.push('Snapshot:');
  if (snapshot !== '') lines.push(snapshot);
  return lines.join('\n');
}

/**
 * Every tool this plugin can register, in the order {@link createTools} emits them.
 *
 * Kept as data so the `disabledTools` config can be validated without building the
 * definitions, and so tests, README and the settings hint share one list.
 */
export const TOOL_NAMES = [
  'browser_open',
  'browser_claim',
  'browser_list',
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_click',
  'browser_fill',
  'browser_press',
  'browser_run_code',
  'browser_console',
  'browser_status',
];

/**
 * Apply the `disabledTools` configuration to a built tool list.
 *
 * Registration is the only switch the host offers: a disabled tool is never
 * registered, so its schema never reaches the model's context. There is no
 * per-call "this tool is off" answer to pay for — the model simply does not see
 * the tool. Unknown names are reported so a typo is visible instead of silent.
 *
 * @param {any[]} tools
 * @param {unknown} disabled comma-separated tool names
 * @returns {{ tools: any[], disabled: string[], unknown: string[] }}
 */
export function selectTools(tools, disabled = '') {
  const names = String(disabled ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const wanted = new Set(names);
  const known = new Set(TOOL_NAMES);
  return {
    tools: tools.filter((tool) => !wanted.has(tool.name)),
    disabled: names,
    unknown: names.filter((name) => !known.has(name)),
  };
}

/**
 * @param {import('./runtime.js').Runtime} runtime
 * @returns {any[]} tool definitions for ctx.tools.register
 */
export function createTools(runtime) {
  return [
    {
      name: 'browser_open',
      description:
        'Open a new browser page in the DSH right sidebar at the given URL and return its pageId. ' +
        'Prefer navigating a page you already control with browser_navigate; open a new one only when two ' +
        'pages must coexist. It never takes over an existing tab.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: string('Absolute http(s) or file URL. A bare host becomes https://<host>.'),
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
            title: string("The page's own title."),
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
        return sanitize(await runtime.openPage({ sessionId, url: args.url, signal: exec.signal }));
      },
    },

    {
      name: 'browser_claim',
      description:
        'Take over the browser page currently open in the DSH right sidebar and return its pageId. ' +
        'Requires the sidebar to be open with a browser tab selected.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string('Stable page handle for every later call.'),
            title: string('The page\'s own title.'),
            url: string('Current URL.'),
            replacedExistingPageId: string(
              'Present when the page already carried an identity: the pageId it lost (no longer resolvable).',
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
        return sanitize(await runtime.claimPage({ sessionId, signal: exec.signal }));
      },
    },

    {
      name: 'browser_list',
      description:
        'List the pages this session can control, with their pageIds. Reuse a pageId from context or an earlier ' +
        'tool result; call this only when you have no usable pageId.',
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
        // No tab index in the rendered output: the model addresses pages by pageId, and
        // the index is the one piece of a row it could never pass back to a tool. JSON
        // keeps the list scanable while leaving the pageId/title/url triple explicit.
        render: renderWith((value) => {
          const pages = value.pages.map((page) => ({
            pageId: page.pageId ?? null,
            title: page.title ?? '',
            url: page.url ?? '',
          }));
          const body = { count: value.count, pages };
          if (value.warning !== undefined) body.warning = value.warning;
          return JSON.stringify(body, null, 2);
        }),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(await runtime.listPages({ sessionId, scope: args.scope ?? 'session' }));
      },
    },

    {
      name: 'browser_snapshot',
      description:
        'Get an accessibility snapshot of the page, with [ref=…] handles for click and fill. ' +
        'Refs are valid only for this snapshot; take a new one after the page changes. ' +
        'Use this rather than a screenshot to read content. Output is capped at snapshotMaxChars ' +
        'characters: when the snapshot is longer, the complete text is saved to a file and only the ' +
        'leading whole lines are shown.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string(
            'Page ID from the conversation context or a previous browser tool output; it stays valid for the session.',
          ),
        },
        required: ['pageId'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            snapshot: string(
              'The snapshot text: complete when it fits the limit, otherwise the leading whole lines that fit.',
            ),
            truncated: boolean(
              'True when the snapshot exceeded the limit, so only a prefix is shown and the complete text is in snapshotPath.',
            ),
            maxChars: integer('The snapshot character limit used for this call (config snapshotMaxChars).'),
            totalChars: integer('Length of the complete snapshot in characters.'),
            snapshotPath: string(
              'Absolute path of the file holding the complete snapshot. Present only when truncated is true.',
            ),
          },
          required: ['pageId', 'snapshot', 'truncated', 'maxChars', 'totalChars'],
        },
        render: renderWith(renderSnapshot),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(
          await runtime.snapshot({
            pageId: args.pageId,
            sessionId,
            signal: exec.signal,
          }),
        );
      },
    },

    {
      name: 'browser_screenshot',
      description:
        'Capture a PNG screenshot of the page to disk and return its absolute path. ' +
        'Use it to judge layout, spacing and colour; use browser_snapshot to read content.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string(
            'Page ID from the conversation context or a previous browser tool output; it stays valid for the session.',
          ),
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
      description: 'Click an element in the page.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string(
            'Page ID from the conversation context or a previous browser tool output; it stays valid for the session.',
          ),
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
        'Replace the contents of an editable element with text. Use browser_press for individual keys.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string(
            'Page ID from the conversation context or a previous browser tool output; it stays valid for the session.',
          ),
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
      description: 'Press one keyboard key in the page.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string(
            'Page ID from the conversation context or a previous browser tool output; it stays valid for the session.',
          ),
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
      name: 'browser_navigate',
      description:
        'Navigate a browser page by URL, history, or reload. Prefer this to opening a new tab when the current ' +
        'page state is no longer needed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string(
            'Page ID from the conversation context or a previous browser tool output; it stays valid for the session.',
          ),
          type: string('Navigation type: url (default) to visit url, reload to refresh, back/forward for history.', {
            enum: ['url', 'reload', 'back', 'forward'],
          }),
          url: string('Absolute http(s) or file URL. Required when type is url.'),
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
            type: string('The navigation performed: url, reload, back or forward.'),
          },
          required: ['pageId', 'url'],
        },
        render: renderWith(
          (value) =>
            `Navigated (${value.type ?? 'url'}) to ${value.url}${value.title ? ` — ${value.title}` : ''}.`,
        ),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        return sanitize(
          await runtime.navigate({
            pageId: args.pageId,
            type: args.type,
            url: args.url,
            sessionId,
            signal: exec.signal,
          }),
        );
      },
    },

    {
      name: 'browser_run_code',
      description:
        'Run a Playwright code snippet against the page; use it only when the dedicated tools are insufficient. ' +
        'Do not call page.reload() or location.reload() — it reloads the DSH shell instead of the page; use ' +
        'browser_navigate instead.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string(
            'Page ID from the conversation context or a previous browser tool output; it stays valid for the session.',
          ),
          code: string(
            'Function body only — never the `async page => { … }` wrapper (the tool adds it). `page` is in scope. ' +
              '`return` the value to show, e.g. `return await page.title()`; return objects/arrays directly, never ' +
              '`JSON.stringify(...)` (playwright-cli serializes the value once already, so it would be encoded twice).',
          ),
        },
        required: ['pageId', 'code'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pageId: string(),
            output: string('Return value: strings as plain text, objects/arrays as compact JSON.'),
          },
          required: ['pageId', 'output'],
        },
        render: renderWith((value) => value.output),
      },
      async execute(args, exec) {
        const sessionId = requireSession(exec);
        const value = await runtime.runCode({
          pageId: args.pageId,
          code: wrapRunCodeBody(args.code),
          sessionId,
          signal: exec.signal,
        });
        return sanitize({ ...value, output: formatRunCodeOutput(value.output) });
      },
    },

    {
      name: 'browser_console',
      description:
        'Read the page\'s browser console messages, most recent last. Use it when an action had no visible ' +
        'effect and a JavaScript error may explain why.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: string(
            'Page ID from the conversation context or a previous browser tool output; it stays valid for the session.',
          ),
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
        'Report the connection between DSH, playwright-cli and the page. detach ends the automation session ' +
        'without closing DSH.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: string('status (default), attach or detach.', {
            enum: ['status', 'attach', 'detach'],
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
            cdpUrl: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              description:
                'The endpoint this call actually used (or looked for, when nothing answered). Null when no record ' +
                'resolved it.',
            },
            cdp: {
              oneOf: [
                { type: 'null' },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    url: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                    port: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                    diagnosis: string(
                      'serving = /json/version answered; absent = the recorded port is free and silent (DSH down, or started ' +
                        'without the flag); stale = the port is held but nothing answers (a leftover endpoint); no-record = ' +
                        'no DevToolsActivePort at all.',
                    ),
                    file: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  },
                  required: ['url', 'port', 'diagnosis'],
                },
              ],
              description:
                "The endpoint Chromium recorded, and — when nothing answered — which failure it was. The port is always " +
                "DSH's decision (launch argument); this plugin only finds it. stale means a leftover endpoint from a " +
                'previous run holds the port (restarting does not clear it; --remote-debugging-port=0 cannot hit it).',
            },
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
        const snapshot = await runtime.status({
          sessionId,
          action: args.action ?? 'status',
          signal: exec.signal,
        });
        return sanitize(snapshot);
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







