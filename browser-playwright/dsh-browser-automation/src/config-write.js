/**
 * Configuration writes for this plugin's own Loader row.
 *
 * The settings UI is not the writer here: `ctx.configEditor` is the Host service
 * that persists a complete raw config and re-applies it through the normal Loader
 * path, which is also what a hand edit of the profile's `cordis.patch.yml` does.
 * Going through it means no second source of truth and no hand-written YAML.
 *
 * Everything in this module is pure except the two `apply*` helpers, which take an
 * editor so the tests can drive them with a fake.
 */

/** Every key the card may write, with the type it is stored as. */
export const EDITABLE_KEYS = {
  nodePath: 'string',
  command: 'string',
  session: 'string',
  cdpUrl: 'string',
  timeoutMs: 'number',
  requestTimeoutMs: 'number',
  screenshotSettleMs: 'number',
  debug: 'boolean',
};

/** @param {string} key */
const kindOf = (key) => (Object.hasOwn(EDITABLE_KEYS, key) ? EDITABLE_KEYS[key] : undefined);

/**
 * Validate and convert one value coming from the page.
 *
 * @param {string} key
 * @param {unknown} raw
 * @returns {{ ok: true, value: string | number | boolean } | { ok: false, error: string }}
 */
export function coerceConfigValue(key, raw) {
  const kind = kindOf(key);
  if (!kind) return { ok: false, error: `"${key}" is not a configurable field` };
  if (kind === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (raw === 'true') return { ok: true, value: true };
    if (raw === 'false') return { ok: true, value: false };
    return { ok: false, error: `"${key}" must be true or false` };
  }
  if (kind === 'number') {
    const numeric = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
    if (!Number.isFinite(numeric) || numeric < 0) return { ok: false, error: `"${key}" must be a non-negative number` };
    return { ok: true, value: Math.round(numeric) };
  }
  const text = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw);
  if (text.length === 0) return { ok: false, error: `"${key}" must not be empty` };
  return { ok: true, value: text };
}

/**
 * The profile row this plugin owns.
 *
 * `entries()` returns active rows by their resolved patch id, and a row inserted by
 * a bundle patch resolves as `include:<id>` — so this matches either spelling. A
 * missing row means the configuration is not addressable right now (a `--patch`
 * overlay composed the plugin, for example), and the card is read-only.
 *
 * @param {{ entries(): Array<{ id?: string }> }} editor
 * @param {string} rowId
 */
export function findRow(editor, rowId) {
  try {
    const rows = editor.entries();
    if (!Array.isArray(rows)) return null;
    const wanted = new Set([rowId, `include:${rowId}`]);
    return rows.find((row) => row && wanted.has(row.id)) ?? null;
  } catch {
    return null;
  }
}

/**
 * The profile's own override layer for one row.
 *
 * `edit`'s `change` receives the entry's *current* config, which for a row inserted
 * by a bundle patch already contains that bundle's values — merging into it would
 * copy every inherited default into this profile's patch and freeze it there. The
 * override layer is the right base: it holds only what this profile decided.
 *
 * @param {any} editor
 * @param {any} row
 * @returns {Record<string, unknown>}
 */
function overrideLayer(editor, row) {
  try {
    const layers = editor.configuration();
    if (Array.isArray(layers)) {
      const mine = layers.find((layer) => layer && (layer.entry === row || layer.entry?.id === row?.id));
      if (mine && mine.override && typeof mine.override === 'object') return { ...mine.override };
    }
  } catch {
    /* fall back to the current config below */
  }
  return null;
}

/**
 * Write one key into the profile layer.
 *
 * @param {{ editor: any, rowId: string, key: string, value: unknown }} input
 */
export async function applyConfigChange({ editor, rowId, key, value }) {
  const coerced = coerceConfigValue(key, value);
  if (!coerced.ok) throw new Error(coerced.error);
  const row = findRow(editor, rowId);
  if (!row) throw new Error(`this plugin has no addressable row "${rowId}"`);
  await editor.edit(row, (current) => {
    const base = overrideLayer(editor, row) ?? current ?? {};
    return { ...base, [key]: coerced.value };
  });
  return coerced.value;
}

/**
 * Remove one override so the key falls back to the bundle default again.
 *
 * @param {{ editor: any, rowId: string, key: string }} input
 */
export async function resetConfigKey({ editor, rowId, key }) {
  if (!kindOf(key)) throw new Error(`"${key}" is not a configurable field`);
  const row = findRow(editor, rowId);
  if (!row) throw new Error(`this plugin has no addressable row "${rowId}"`);
  await editor.edit(row, (current) => {
    const next = { ...(overrideLayer(editor, row) ?? current ?? {}) };
    delete next[key];
    return next;
  });
}
