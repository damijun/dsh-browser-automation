import z from '@deepseek-ai/schemastery';

/**
 * The plugin's configuration, declared as a real schema.
 *
 * Two reasons this is not just a plain object inside `apply`:
 *
 *  - the Loader validates it and reports it, so a typo in `cordis.patch.yml` becomes
 *    a clear diagnostic instead of a silently ignored key;
 *  - the settings service renders a form only from fields marked `.volatile()`
 *    ("Forms expose only volatile fields from active, uniquely addressed profile
 *    entries"), and a form write persists through the profile's Cordis patch — so a
 *    form write and a hand edit of the patch are the same operation, with no second
 *    source of truth.
 *
 * `.volatile()` returns a copy of the field, so it is applied per field (the same
 * shape `dsh-better-sidebar` uses); the fields themselves stay ordinary otherwise.
 */
const fields = {
  session: z
    .string()
    .default('dsh')
    .description('playwright-cli session name (-s=). Shared by every DSH session.'),

  command: z
    .string()
    .default('playwright-cli')
    .description('playwright-cli command name or absolute path.'),

  nodePath: z
    .string()
    .default('auto')
    .description('Which Node runs the CLI: "auto", "path", or an absolute path.'),

  // Advanced, and hidden from the form: the file Chromium writes the port it really
  // bound. The plugin has no port setting at all — the launch argument decides the
  // port, and this file is how that decision reaches the plugin. Only needed when the
  // user-data directory moves.
  cdpPortFile: z
    .string()
    .default('auto')
    .description(
      'Where Chromium records the debugging port it actually bound ("auto" = ' +
        '%APPDATA%\\@deepseek-ai\\dsh-desktop\\DevToolsActivePort). Set an absolute path to override.',
    ),

  autoAttach: z
    .boolean()
    .default(true)
    .description(
      'Attach playwright-cli once at startup, so sidebar pages opened afterwards are adopted. ' +
        'A daemon process stays alive while DSH runs.',
    ),

  showSharedBadge: z
    .boolean()
    .default(true)
    .description(
      'Show a floating badge on every page this plugin controls. Painted inside the page ' +
        '(shadow DOM, pointer-events none) and re-applied after navigation.',
    ),

  timeoutMs: z
    .number()
    .default(20_000)
    .description('Per-call timeout for one playwright-cli invocation, in milliseconds.'),

  requestTimeoutMs: z
    .number()
    .default(20_000)
    .description('How long a tool waits for the DSH page to answer a bridge request, in milliseconds.'),

  attachTimeoutMs: z
    .number()
    .default(60_000)
    .description('How long playwright-cli attach may take before it is retried once and reported.'),

  screenshotTimeoutMs: z
    .number()
    .default(25_000)
    .description('Deadline for one screenshot capture, in milliseconds.'),

  screenshotSettleMs: z
    .number()
    .default(1_200)
    .description('Wait for a first frame after bringing a tab to the front for a screenshot, in milliseconds.'),

  debug: z.boolean().default(false).description('Print bridge and CLI diagnostics with console.debug.'),
};

/** Only these appear in the settings form; `cdpPortFile` stays accepted but hidden. */
const VOLATILE = [
  'session',
  'command',
  'nodePath',
  'autoAttach',
  'showSharedBadge',
  'timeoutMs',
  'requestTimeoutMs',
  'attachTimeoutMs',
  'screenshotTimeoutMs',
  'screenshotSettleMs',
  'debug',
];

export const Config = z.object(
  Object.fromEntries(
    Object.entries(fields).map(([key, field]) => [key, VOLATILE.includes(key) ? field.volatile() : field]),
  ),
);

export default Config;




