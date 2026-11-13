/**
 * Lifecycle forensics for the desktop host.
 *
 * The question this answers: "who closed DSH?" A clean `app.quit()` runs
 * `before-quit` → `will-quit` → `quit` → `exit`, and the `before-quit` stack
 * names the caller (tray menu, updater, fatal recovery, menu item). A
 * `TerminateProcess` runs **none** of them, so the only trace is a fresh
 * heartbeat with no exit event — that is the "killed" verdict.
 *
 * Two files under <DSH_HOME>/storages:
 *   dsh-exec-heartbeat.json   overwritten every interval; survives a kill
 *   dsh-exec-lifecycle.jsonl  append-only key events, rotated by size
 *
 * The probe is process-global and installed at most once: HMR reloads must not
 * stack duplicate listeners or duplicate heartbeats.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

const INSTALLED = Symbol.for('dsh-exec.lifecycle');
const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const STACK_LIMIT = 2_400;

export function lifecycleDir(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : path.join(homedir(), '.dsh');
  return path.join(home, 'storages');
}

export function heartbeatPath(env = process.env) {
  return path.join(lifecycleDir(env), 'dsh-exec-heartbeat.json');
}

export function lifecyclePath(env = process.env) {
  return path.join(lifecycleDir(env), 'dsh-exec-lifecycle.jsonl');
}

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Append one JSON line, rotating the file first when it exceeds `maxBytes`. */
export function appendLifecycle(record, maxBytes = DEFAULT_MAX_BYTES, env = process.env) {
  const file = lifecyclePath(env);
  if (!ensureDir(lifecycleDir(env))) return false;
  try {
    if (existsSync(file) && statSync(file).size > maxBytes) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    /* rotation is best effort */
  }
  try {
    appendFileSync(file, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Read the newest lifecycle records (tail), tolerating a truncated last line. */
export function readLifecycle(limit = 40, env = process.env) {
  const file = lifecyclePath(env);
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a kill can leave a partial last line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function readHeartbeat(env = process.env) {
  const file = heartbeatPath(env);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeHeartbeat(payload, env = process.env) {
  const file = heartbeatPath(env);
  if (!ensureDir(lifecycleDir(env))) return;
  try {
    writeFileSync(file, `${JSON.stringify(payload)}\n`);
  } catch {
    /* best effort */
  }
}

/**
 * Decide how the *previous* process ended. Pure; exported for tests.
 *
 * @param heartbeat last heartbeat written by the previous process
 * @param records   lifecycle records from the previous run (tail is enough)
 * @param nowMs     current clock
 * @param intervalMs heartbeat cadence used by that process
 */
export function classifyPreviousExit(heartbeat, records, nowMs, intervalMs = DEFAULT_HEARTBEAT_MS) {
  if (heartbeat === undefined) return { verdict: 'unknown', detail: 'no heartbeat recorded' };
  const tail = Array.isArray(records) ? records : [];
  const after = tail.filter((record) => Number(record?.at ?? 0) >= Number(heartbeat.at ?? 0) - intervalMs);
  const uncaught = after.find((record) => record?.kind === 'uncaught');
  if (uncaught !== undefined) {
    return {
      verdict: 'crashed',
      detail: String(uncaught.message ?? 'uncaught exception').slice(0, 300),
      at: uncaught.at,
    };
  }
  const quit = after.find((record) => record?.kind === 'quit' || record?.kind === 'exit');
  if (quit !== undefined) {
    return {
      verdict: 'clean',
      detail: `exit code ${quit.code ?? 0}`,
      trigger: after.find((record) => record?.kind === 'before-quit')?.trigger ?? null,
      at: quit.at,
    };
  }
  const gapMs = Math.max(0, Number(nowMs) - Number(heartbeat.at ?? nowMs));
  // A heartbeat that stopped less than ~2 intervals before the next boot means
  // the process vanished without running any exit handler: TerminateProcess,
  // a hard crash, or power loss.
  if (gapMs <= intervalMs * 2 + 10_000) {
    return {
      verdict: 'killed',
      detail: `no exit event; last heartbeat ${Math.round(gapMs / 1000)}s before startup`,
      lastHeartbeatAt: heartbeat.at,
      gapMs,
      rss: heartbeat.rss ?? null,
    };
  }
  return {
    verdict: 'unknown',
    detail: `no exit event; last heartbeat ${Math.round(gapMs / 60000)}min before startup (sleep/shutdown?)`,
    lastHeartbeatAt: heartbeat.at,
    gapMs,
  };
}

function stackOf() {
  const stack = new Error().stack ?? '';
  return stack.split('\n').slice(1).join('\n').slice(0, STACK_LIMIT);
}

/**
 * Install the probe. Safe to call repeatedly; only the first call wins.
 * Returns the observed `lastExit` verdict for the current boot.
 */
export function installLifecycleProbe(options = {}) {
  const env = options.env ?? process.env;
  const intervalMs = Number.isFinite(options.heartbeatMs) && options.heartbeatMs > 0
    ? options.heartbeatMs
    : DEFAULT_HEARTBEAT_MS;
  const maxBytes = Number.isFinite(options.maxLogBytes) && options.maxLogBytes > 0
    ? options.maxLogBytes
    : DEFAULT_MAX_BYTES;

  const previous = classifyPreviousExit(readHeartbeat(env), readLifecycle(80, env), Date.now(), intervalMs);

  if (globalThis[INSTALLED] === true) return previous;
  globalThis[INSTALLED] = true;

  const base = { pid: process.pid, ppid: process.ppid, at: Date.now() };
  appendLifecycle({ ...base, kind: 'start', previous, argv: process.argv.slice(0, 12) }, maxBytes, env);
  if (previous.verdict !== 'clean' && previous.verdict !== 'unknown') {
    appendLifecycle({ at: Date.now(), kind: 'previous-exit', ...previous }, maxBytes, env);
  }

  // Electron APIs are optional: the same bundle can run under plain Node in
  // tests. Every hook is guarded so a probe can never take the host down.
  let electron;
  try {
    electron = createRequire(import.meta.url)('electron');
  } catch {
    electron = undefined;
  }
  const app = typeof electron?.app?.on === 'function' ? electron.app : undefined;

  const record = (kind, extra = {}) => {
    try {
      appendLifecycle({ at: Date.now(), kind, pid: process.pid, ...extra }, maxBytes, env);
    } catch {
      /* never throw from a hook */
    }
  };

  // Who asked to quit: the stack names the caller (tray menu, updater, ...).
  if (app !== undefined) {
    try {
      app.on('before-quit', () => record('before-quit', { trigger: stackOf() }));
      app.on('will-quit', () => record('will-quit'));
      app.on('quit', (_event, code) => record('quit', { code }));
      app.on('window-all-closed', () => record('window-all-closed'));
      app.on('browser-window-created', (_event, window) => {
        try {
          window.on('close', () => record('window-close', { windowId: window.id }));
          window.on('closed', () => record('window-closed', { windowId: window.id }));
        } catch {
          /* window already gone */
        }
      });
    } catch {
      /* electron surface changed */
    }
    try {
      const { powerMonitor } = electron;
      powerMonitor?.on?.('shutdown', () => record('os-shutdown'));
      powerMonitor?.on?.('suspend', () => record('os-suspend'));
      powerMonitor?.on?.('resume', () => record('os-resume'));
    } catch {
      /* powerMonitor is optional */
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, () => record('signal', { signal }));
    } catch {
      /* unsupported on this platform */
    }
  }
  try {
    process.on('uncaughtException', (error) => {
      record('uncaught', { message: String(error?.message ?? error).slice(0, 400), stack: String(error?.stack ?? '').slice(0, STACK_LIMIT) });
    });
    process.on('unhandledRejection', (reason) => {
      record('unhandled-rejection', { message: String(reason?.message ?? reason).slice(0, 400) });
    });
    process.on('exit', (code) => {
      // The last synchronous moment we control. A TerminateProcess never
      // reaches this, which is exactly what makes "no exit record" meaningful.
      record('exit', { code, uptimeMs: Math.round(process.uptime() * 1000) });
    });
  } catch {
    /* already registered by another instance */
  }

  let seq = 0;
  const beat = () => {
    try {
      seq += 1;
      const memory = process.memoryUsage();
      const activeRuns = typeof options.activeRuns === 'function' ? options.activeRuns() : undefined;
      writeHeartbeat({
        seq,
        at: Date.now(),
        pid: process.pid,
        ppid: process.ppid,
        uptimeMs: Math.round(process.uptime() * 1000),
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        activeRuns: activeRuns ?? null,
        lastEventAt: typeof options.lastEventAt === 'function' ? options.lastEventAt() : null,
      }, env);
    } catch {
      /* never throw from a timer */
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();

  return previous;
}

/** Public summary for `dshx --status`. */
export function lifecycleSummary(env = process.env) {
  const heartbeat = readHeartbeat(env);
  const records = readLifecycle(40, env);
  return {
    heartbeat: heartbeat ?? null,
    lastEvents: records.slice(-8),
  };
}
