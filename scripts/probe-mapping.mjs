import { CliBridge } from '../src/cli.js';
import { PageDriver } from '../src/driver.js';

/**
 * Throwaway live check for stage B (docs/run-code-migration-plan.md): reads the real
 * daemon through the new mapping without going through the plugin.
 *
 * Usage: node scripts/probe-mapping.mjs [pageId]
 *
 * Deliberately read-only: it calls `catalog()` / `resolveTabIndex()` / `resolvePageId()`
 * and runs `eval` directly instead of `driver.evaluate()`. `driver.evaluate()` resolves
 * through `resolvePage()`, which probes `ensureAttached()` — and before the adoption fix
 * that probe could attach over a live session and strand every open sidebar page.
 * Keeping this script read-only means a diagnostic run can never cost the user tabs.
 */
const pageId = process.argv[2];
const cli = new CliBridge({ session: 'dsh', command: 'playwright-cli', timeoutMs: 30_000, log: () => {} });
const driver = new PageDriver(cli, { cdpUrl: 'http://127.0.0.1:9222', log: (message) => console.error(`[log] ${message}`) });

const catalog = await driver.catalog();
console.log('catalog:', JSON.stringify(catalog.map((entry) => ({ i: entry.index, id: entry.pageId, current: entry.current }))));

if (pageId) {
  const hit = await driver.resolveTabIndex(pageId);
  console.log('resolveTabIndex:', JSON.stringify({ index: hit.index, current: hit.current, addressedBy: hit.addressedBy, url: hit.url }));
  const back = await driver.resolvePageId(hit.index);
  console.log('resolvePageId:', JSON.stringify({ pageId: back.pageId, addressedBy: back.addressedBy }));
  if (!hit.current) await cli.run(['--raw', 'tab-select', String(hit.index)]);
  const { stdout } = await cli.run([
    '--raw',
    'eval',
    'JSON.stringify({ href: location.href, inPageId: window.__dshBrowserAutomation && window.__dshBrowserAutomation.pageId })',
  ]);
  console.log('eval:', String(stdout).trim());
}
