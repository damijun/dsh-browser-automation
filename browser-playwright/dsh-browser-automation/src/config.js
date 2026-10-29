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

  cdpPort: z
    .number()
    .default(9222)
    .description(
      'Port of the CDP endpoint (Electron binds 127.0.0.1 only). It must match the ' +
        '--remote-debugging-port launch argument DSH Desktop was started with.',
    ),

  // Deprecated: older patches stored a full URL. Still accepted so an upgrade never
  // fails validation, and never shown in the form (it is not volatile).
  cdpUrl: z.string().description('Deprecated: use cdpPort.'),

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

/**
 * Resolve the CDP port from configuration.
 *
 * `cdpPort` is the setting, because the host half is fixed: Electron's debugging
 * port only ever binds loopback, so the user changes the number and nothing else.
 * A full URL set by an older patch still works — the port is read out of it — so
 * upgrading a profile never turns into a validation failure.
 *
 * @param {unknown} port
 * @param {unknown} legacyUrl
 * @returns {number}
 */
export function cdpPortOf(port, legacyUrl) {
  const direct = typeof port === 'number' ? port : Number(String(port ?? '').trim());
  if (Number.isInteger(direct) && direct > 0 && direct < 65_536) return direct;
  const fromUrl = String(legacyUrl ?? '').match(/:(\d{1,5})\/?$/);
  if (fromUrl) {
    const parsed = Number(fromUrl[1]);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65_536) return parsed;
  }
  return 9222;
}

/** Only these appear in the settings form; `cdpUrl` stays accepted but hidden. */
const VOLATILE = [
  'session',
  'command',
  'nodePath',
  'cdpPort',
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


