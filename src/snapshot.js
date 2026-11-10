import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Size control for `browser_snapshot`.
 *
 * The accessibility snapshot is the largest value this plugin puts in the model's
 * context, and a big page can make it tens of thousands of characters. The rule here
 * is deliberately mechanical: the tool keeps a *prefix of whole lines* and never
 * filters, re-orders or summarizes the tree. A snapshot that fits is returned as-is;
 * one that does not is written to a file in full, so the model can still ask for the
 * rest if it needs it.
 *
 * Keeping the whole thing in one module means the driver (which produces the text)
 * and the runtime (which owns the configured budget) share one definition of
 * "how much counts".
 */

/** The budget when the config is missing or unusable. */
export const DEFAULT_SNAPSHOT_MAX_CHARS = 5_000;

/** Directory (under the OS temp dir) that holds full snapshots. */
export const SNAPSHOT_DIR_NAME = 'dsh-browser-automation';

/**
 * Convert `snapshotMaxChars` from config into a usable character budget.
 *
 * The value arrives from a hand-editable YAML patch, so it can be a number, a
 * numeric string, or nonsense. Anything that is not a finite number >= 1 falls back
 * to the default: the alternative (throwing) would break every snapshot on a typo,
 * and `0` would turn every call into an empty result plus a file write. The returned
 * value is always a positive integer, so the truncation loop is always bounded.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function resolveSnapshotMaxChars(value) {
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(numeric) || numeric < 1) return DEFAULT_SNAPSHOT_MAX_CHARS;
  return Math.floor(numeric);
}

/**
 * Keep the longest prefix of `text` that fits in `maxChars`, cutting on line
 * boundaries only.
 *
 * This is the algorithm from docs/关于snapshot输出量的优化.md: append whole lines
 * while they fit, stop at the first line that would overflow. A single line longer
 * than the budget yields an empty string — cutting it in half would produce a
 * fragment no tool can use, and the full text is in the file anyway.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function truncateByLines(text, maxChars) {
  const limit = resolveSnapshotMaxChars(maxChars);
  const lines = String(text ?? '').split(/\r?\n/);
  const selected = [];
  let length = 0;

  for (const line of lines) {
    const addition = selected.length === 0 ? line : `\n${line}`;
    if (length + addition.length > limit) break;
    selected.push(line);
    length += addition.length;
  }

  return selected.join('\n');
}

/** Absolute path of the directory that receives full snapshot files. */
export function snapshotDirectory() {
  return path.join(tmpdir(), SNAPSHOT_DIR_NAME);
}

/**
 * Write the complete snapshot to a file and return its absolute path.
 *
 * The directory is created on demand. A write failure is thrown with the target in
 * the message: pretending a truncated answer is complete would lose the page content
 * the model was about to read.
 *
 * The name mirrors the screenshot convention (`<kind>-<timestamp>`) plus a short
 * random suffix, so two snapshots in the same millisecond cannot overwrite each
 * other.
 *
 * TODO: files accumulate under %TEMP%\dsh-browser-automation\. A future revision
 * should add a retention policy (delete by age or keep the newest N). Until then the
 * directory is left to the OS temp cleanup; this comment is the extension point.
 *
 * @param {string} text complete snapshot
 * @param {{ dir?: string }} [options] `dir` is a test seam; production uses the temp dir
 * @returns {Promise<string>} absolute path of the written file
 */
export async function saveSnapshotFile(text, options = {}) {
  const dir = options.dir ? String(options.dir) : snapshotDirectory();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomUUID().slice(0, 8);
  const file = path.join(dir, `snapshot-${stamp}-${suffix}.txt`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, String(text ?? ''), 'utf8');
  } catch (error) {
    throw new Error(`Could not save the full snapshot to ${file}: ${error.message}`);
  }
  return file;
}
