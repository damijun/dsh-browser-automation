/**
 * The model-facing contract for `browser_run_code`.
 *
 * playwright-cli's `run-code` accepts a **function expression** and invokes it
 * with `page`. The tool exposes the body instead: the wrapper is noise the model
 * should not have to reproduce, and wrapping an already-wrapped function again
 * is a syntax error inside the CLI. So the body is wrapped here, and a full
 * wrapper is rejected before anything runs.
 *
 * playwright-cli also JSON-encodes the return value exactly once
 * (`__end__.resolve(JSON.stringify(result))`). A body that returns
 * `JSON.stringify(...)` therefore produces JSON *text encoded as a JSON string*
 * — backslashes and all. The contract forbids it, and the pre-check rejects it
 * before the snippet runs: a failure after the snippet would leave its side
 * effects behind, so a retry would repeat them.
 *
 * @module run-code
 */

const IDENT = '[A-Za-z_$][\\w$]*';
/** `async page =>` / `page =>` / `(page) =>` / `async (page) =>`. */
const ARROW = `(?:async\\s+)?(?:${IDENT}\\s*=>|\\(\\s*page\\s*\\)\\s*=>)`;
/** `function (page)` / `async function named(page)`. */
const FUNCTION = `(?:async\\s+)?function\\s*(?:${IDENT}\\s*)?\\(\\s*page\\s*\\)`;
/**
 * A function expression at the start of the body, optionally parenthesised.
 * Requiring the parameter to be `page` keeps a legitimate body such as an IIFE
 * (`(async () => { … })()`) from being mistaken for the wrapper.
 */
const FUNCTION_WRAPPER = new RegExp(
  `^\\s*(?:${ARROW}|${FUNCTION}|\\(\\s*(?:${ARROW}|${FUNCTION}))`,
);

const JSON_STRINGIFY = /\bJSON\s*\??\.\s*stringify\b/;

/**
 * Replace comments and string/template literals with spaces, keeping the source
 * length and newlines. The result can be scanned for syntax without matching
 * words that only appear inside a comment or a string.
 *
 * @param {string} source
 * @returns {string}
 */
function maskLiteralsAndComments(source) {
  const out = source.split('');
  const length = source.length;
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== '\n' && out[index] !== '\r') out[index] = ' ';
    }
  };
  let index = 0;
  while (index < length) {
    const char = source[index];
    if (char === '/' && source[index + 1] === '/') {
      const start = index;
      index += 2;
      while (index < length && source[index] !== '\n' && source[index] !== '\r') index += 1;
      blank(start, index);
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const start = index;
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index = Math.min(length, index + 2);
      blank(start, index);
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      const start = index;
      index += 1;
      while (index < length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      blank(start, index);
      continue;
    }
    index += 1;
  }
  return out.join('');
}

/**
 * Whether any `return` in the body returns a `JSON.stringify(...)` value.
 *
 * The expression is read up to its statement end (`;` or the closing brace of
 * the enclosing block), tracking brackets so an object literal or a callback is
 * not cut short.
 *
 * @param {string} masked source with comments/literals blanked
 * @returns {boolean}
 */
function returnsJsonString(masked) {
  const returns = /\breturn\b/g;
  let match;
  while ((match = returns.exec(masked)) !== null) {
    const start = match.index + match[0].length;
    let depth = 0;
    let index = start;
    for (; index < masked.length; index += 1) {
      const char = masked[index];
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']') {
        if (depth > 0) depth -= 1;
      } else if (char === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (char === ';' && depth === 0) break;
    }
    if (JSON_STRINGIFY.test(masked.slice(start, index))) return true;
    returns.lastIndex = index;
  }
  return false;
}

/**
 * Validate a model-supplied body and wrap it into the function expression
 * playwright-cli expects.
 *
 * @param {unknown} code
 * @returns {string} `async page => { … }`
 */
export function wrapRunCodeBody(code) {
  if (typeof code !== 'string' || code.trim() === '') {
    throw new Error('browser_run_code needs code: the body of the Playwright snippet to run.');
  }
  const masked = maskLiteralsAndComments(code);
  if (FUNCTION_WRAPPER.test(masked)) {
    throw new Error(
      'browser_run_code takes the function body only; do not include "async page => { ... }". ' +
        'Pass the statements themselves (for example `return await page.title()`) — the tool wraps ' +
        'them in an async function with `page` in scope.',
    );
  }
  if (returnsJsonString(masked)) {
    throw new Error(
      'browser_run_code must return a value, not a JSON string: do not return JSON.stringify(...). ' +
        'playwright-cli already serializes the return value, so JSON.stringify would encode it twice. ' +
        'Return the value directly — `return rows`, not `return JSON.stringify(rows)`.',
    );
  }
  return `async page => {\n${code}\n}`;
}

/**
 * Turn playwright-cli's output into the text the model reads.
 *
 * `run-code` prints the return value as JSON exactly once. Decoding that one
 * layer only unquotes a returned string; an object or array keeps the compact
 * JSON the CLI printed, because indenting it would cost context without adding
 * data. It is deliberately **not** decoded a second time, so a body that still
 * returns JSON text is shown as that text rather than being guessed at.
 *
 * @param {unknown} raw playwright-cli stdout
 * @returns {string}
 */
export function formatRunCodeOutput(raw) {
  const output = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
  if (output === '') return '';
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    return output;
  }
  if (typeof value === 'string') return value;
  return output;
}
