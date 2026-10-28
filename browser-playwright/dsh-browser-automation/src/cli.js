import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Failure taxonomy the tool layer turns into model-readable messages. */
export class CliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CliError';
    this.code = details.code ?? 'CLI_FAILURE';
    Object.assign(this, details);
  }
}

export class CliTimeoutError extends CliError {
  constructor(message, details) {
    super(message, { ...details, code: 'CLI_TIMEOUT' });
    this.name = 'CliTimeoutError';
  }
}

export class CliUnavailableError extends CliError {
  constructor(message, details) {
    super(message, { ...details, code: 'CLI_UNAVAILABLE' });
    this.name = 'CliUnavailableError';
  }
}

const isFile = (candidate) => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

/**
 * `playwright-cli` is an npm shim: on Windows the extensionless file is a sh
 * script, `.cmd` is a batch file, and neither can be exec'd directly by
 * Node >= 18.20 without a shell. Spawning the batch file through a shell would
 * mean re-quoting a `document.title` expression by hand, so instead resolve the
 * JavaScript entry the shim points at and run it with the current Node binary.
 * Arguments then travel as an argv array and no quoting layer can corrupt them.
 *
 * @param {string} shim absolute path to a `.cmd`/`.ps1`/sh shim
 * @returns {string | undefined} absolute path to an existing `.js` entry
 */
function nodeEntryFromShim(shim) {
  let text;
  try {
    text = readFileSync(shim, 'utf8');
  } catch {
    return undefined;
  }
  const dir = path.dirname(shim);
  /** @type {string[]} */
  const candidates = [];
  const token = /"?([^"\r\n]*?\.c?js)"?/g;
  let match;
  while ((match = token.exec(text)) !== null) candidates.push(match[1]);
  for (const raw of candidates.reverse()) {
    const expanded = raw
      .replace(/%dp0%|%DP0%|\$basedir|\$\{basedir\}/g, dir)
      .replace(/%[^%]+%/g, '');
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(dir, expanded);
    if (isFile(absolute)) return absolute;
  }
  return undefined;
}

/**
 * Find the CLI once and describe how to start it.
 *
 * @param {object} options
 * @param {string} options.command  configured command name or path
 * @param {string} [options.nodePath] interpreter for the resolved `.js` entry
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{ file: string, prefix: string[], shim?: string }}
 */
export function resolveCli(options) {
  const { command, nodePath = process.execPath, env = process.env } = options;
  if (!command) throw new CliUnavailableError('No playwright-cli command configured.');

  // 1. An explicit path: a JS entry, a shim, or a real executable.
  if (command.includes('/') || command.includes('\\') || isFile(command)) {
    if (/\.c?js$/i.test(command)) {
      if (!isFile(command)) throw new CliUnavailableError(`playwright-cli entry not found at ${command}.`);
      return { file: nodePath, prefix: [command] };
    }
    if (/\.(cmd|bat|ps1)$/i.test(command)) {
      const entry = nodeEntryFromShim(command);
      if (entry) return { file: nodePath, prefix: [entry], shim: command };
      if (!isFile(command)) throw new CliUnavailableError(`playwright-cli shim not found at ${command}.`);
      return { file: command, prefix: [], shim: command };
    }
    if (!isFile(command)) throw new CliUnavailableError(`playwright-cli not found at ${command}.`);
    return { file: command, prefix: [] };
  }

  // 2. A bare command name: search PATH for a real executable or an npm shim.
  const win = process.platform === 'win32';
  const extensions = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const directories = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  /** @type {string[]} */
  const names = win ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command] : [command];

  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (!isFile(candidate)) continue;
      if (/\.(cmd|bat|ps1)$/i.test(candidate)) {
        const entry = nodeEntryFromShim(candidate);
        if (entry) return { file: nodePath, prefix: [entry], shim: candidate };
        continue;
      }
      if (win && !extensions.some((ext) => candidate.toLowerCase().endsWith(ext.toLowerCase()))) {
        // An extensionless npm shim (sh script). Keep looking for the .cmd.
        continue;
      }
      return { file: candidate, prefix: [], shim: candidate };
    }
  }

  throw new CliUnavailableError(
    `Could not find "${command}" on PATH. Install it (npm i -g @playwright/cli) or set ` +
      'the plugin\'s `command` config to the absolute path of playwright-cli.',
    { command },
  );
}

/**
 * Thin, quoting-free wrapper around the CLI's client process.
 *
 * Every invocation is one short-lived `playwright-cli` client call that talks to
 * the CLI's own per-session daemon. Nothing here keeps a handle alive, so a
 * failed call cannot leave state behind beyond the daemon (which is what
 * `detach` is for).
 */
export class CliBridge {
  /**
   * @param {object} options
   * @param {string} options.session          playwright-cli session name (`-s=`)
   * @param {string} options.command          CLI command or path
   * @param {string} [options.nodePath]
   * @param {string} [options.cwd]            working directory for CLI artifacts
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxOutputBytes]
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.session = options.session;
    this.command = options.command;
    this.nodePath = options.nodePath;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
    this.log = options.log ?? (() => {});
    /** @type {{ file: string, prefix: string[] } | undefined} */
    this.plan = undefined;
    /** @type {Set<import('node:child_process').ChildProcess>} */
    this.children = new Set();
  }

  get resolved() {
    if (!this.plan) {
      this.plan = resolveCli({ command: this.command, nodePath: this.nodePath });
      this.log(`playwright-cli resolved to ${this.plan.file} ${this.plan.prefix.join(' ')}`.trim());
    }
    return this.plan;
  }

  workdir() {
    const directory = this.cwd ?? path.join(os.tmpdir(), 'dsh-browser-automation');
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    return directory;
  }

  /** Kill any CLI client still running, so plugin unload does not leak processes. */
  disposeAll() {
    for (const child of this.children) {
      try {
        child.kill();
      } catch {
        // The process already exited.
      }
    }
    this.children.clear();
  }

  /**
   * Run one CLI invocation.
   *
   * @param {string[]} args        arguments after the session flag
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.retries] retries after a timeout only
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ stdout: string, stderr: string, code: number, truncated: boolean }>}
   */
  async run(args, options = {}) {
    const retries = options.retries ?? 0;
    let attempt = 0;
    for (;;) {
      try {
        return await this.runOnce(args, options);
      } catch (error) {
        const retryable = error instanceof CliTimeoutError && attempt < retries;
        if (!retryable) throw error;
        attempt += 1;
        this.log(`retrying ${args[0]} after a timeout (attempt ${attempt + 1})`);
      }
    }
  }

  /**
   * @param {string[]} args
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} options
   */
  runOnce(args, options) {
    const plan = this.resolved;
    const argv = [...plan.prefix, `-s=${this.session}`, ...args];
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const cwd = this.workdir();

    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new CliError('The operation was cancelled before playwright-cli started.', { code: 'CLI_ABORTED' }));
        return;
      }

      let child;
      try {
        child = spawn(plan.file, argv, {
          cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        });
      } catch (error) {
        reject(
          new CliUnavailableError(`Could not start playwright-cli (${plan.file}): ${error.message}`, {
            cause: error,
          }),
        );
        return;
      }

      this.children.add(child);
      /** @type {Buffer[]} */
      const out = [];
      /** @type {Buffer[]} */
      const err = [];
      let bytes = 0;
      let truncated = false;

      const collect = (sink) => (chunk) => {
        bytes += chunk.length;
        if (bytes > this.maxOutputBytes) {
          truncated = true;
          return;
        }
        sink.push(chunk);
      };

      child.stdout?.on('data', collect(out));
      child.stderr?.on('data', collect(err));

      let settled = false;
      let timer;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.children.delete(child);
        options.signal?.removeEventListener?.('abort', onAbort);
        fn(value);
      };

      const onAbort = () => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        finish(reject, new CliError('The operation was cancelled.', { code: 'CLI_ABORTED', args }));
      };
      options.signal?.addEventListener?.('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        finish(
          reject,
          new CliTimeoutError(
            `playwright-cli ${args[0]} did not answer within ${Math.round(timeoutMs / 1000)}s. ` +
              'The CLI daemon may be stuck; retrying once is worth it, then check `playwright-cli list`.',
            { args, timeoutMs, stdout: Buffer.concat(out).toString('utf8') },
          ),
        );
      }, timeoutMs);

      child.on('error', (error) => {
        finish(
          reject,
          new CliUnavailableError(`playwright-cli could not be started: ${error.message}`, { cause: error, args }),
        );
      });

      child.on('close', (code, signal) => {
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        if (code === 0) {
          finish(resolve, { stdout, stderr, code: 0, truncated });
          return;
        }
        finish(
          reject,
          new CliError(describeFailure(args, code, signal, stdout, stderr), {
            code: 'CLI_EXIT',
            args,
            exitCode: code,
            signal,
            stdout,
            stderr,
          }),
        );
      });
    });
  }
}

/**
 * The CLI writes user-facing errors to stdout (verified: an unattached session
 * prints "The browser 'x' is not open" on stdout and exits 1), and a daemon
 * startup failure dumps a Node stack. So: drop stack noise, then prefer an
 * explicit error line over the banner that precedes it.
 */
export function describeFailure(args, code, signal, stdout, stderr) {
  const command = args.find((arg) => !arg.startsWith('-')) ?? args[0] ?? 'command';
  const lines = [stderr, stdout]
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .filter((line) => !/^at\s/.test(line.trim()))
    .filter((line) => !/^\s*\^+\s*$/.test(line))
    .filter((line) => !/\.(c?js|mjs)\s*:\d+$/.test(line.trim()))
    .filter((line) => !/^[A-Za-z]:\\/.test(line.trim()));
  const interesting =
    lines.filter((line) => /\b(error|Error|refused|not open|invalid|unsupported)\b/.test(line)).slice(-1)[0] ??
    lines.slice(-1)[0];
  const context = lines.slice(0, 4).join('\n');
  const reason = signal ? `was killed by ${signal}` : `exited with code ${code}`;
  const detail = interesting && interesting.trim() !== '' ? interesting.trim() : context;
  return `playwright-cli ${command} ${reason}${detail ? `: ${detail}` : '.'}`;
}
