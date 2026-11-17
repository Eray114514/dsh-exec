/**
 * dsh-exec — external-agent control surface for DeepSeek Harness.
 *
 * Why this runs inside the *desktop* process instead of a headless worker:
 * the sidebar is backed by `ctx.workspaceRegistry`, which attaches a session
 * when that session is created in the same process. A headless process can
 * write the very same session.v4.jsonl.zstd to ~/.dsh/sessions, but no one
 * tells the desktop registry about it, so the conversation never appears in
 * the GUI. Here we call `sessionController.create({ workspaceId, agentPreset })`
 * in-process: the workspace row is upserted, the session is attached, and the
 * UI follows its live events from the moment the run starts.
 *
 * External contract (all loopback-only, token from the bridge file):
 *
 *   GET  /dsh-exec/status.json                 read bridge + run counts
 *   GET  /dsh-exec/runs.json                  list runs
 *   POST /dsh-exec/runs.json                  start a run (or stop one)
 *   GET  /dsh-exec/events.jsonl?runId=…&since=N   NDJSON event stream
 *   GET  /dsh-exec/config.json                effective defaults (no token)
 *   PUT  /dsh-exec/config.json                save defaults for this machine
 *
 * Settings written through the settings page land in
 * `<DSH_HOME>/plugin-data/dsh-exec/config.json` and are layered on top of the
 * profile's `cordis.patch.yml`, so a user never has to edit YAML by hand.
 *
 * NDJSON mirrors dsh-headless (`session` / `status` / `text` / `final`) and
 * adds `progress` heartbeats and `retry` frames. A provider that answers 429
 * (quota) makes the host wait out a backoff of 30-300 s inside the same turn:
 * during a retry wait the log goes quiet for 30-300 s, so a heartbeat is the
 * only way for a caller to distinguish "waiting" from "dead".
 *
 * Zero runtime dependencies: only Node built-ins and services reached through
 * `ctx`. This avoids the peerDependency/duplicate-instance trap that can stop
 * the official desktop profile from booting.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { installLifecycleProbe, lifecycleSummary } from './lifecycle.js';

const NS = 'dsh-exec';
const BASE = '/dsh-exec';
const STATUS_PATH = `${BASE}/status.json`;
const RUNS_PATH = `${BASE}/runs.json`;
const EVENTS_PATH = `${BASE}/events.jsonl`;
const CONFIG_PATH = `${BASE}/config.json`;
const BRIDGE_FILE_NAME = 'dsh-exec.json';
const MAX_BODY = 256 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_RUNS = 4;
const DEFAULT_MAX_EVENTS = 800;
const DEFAULT_LIFECYCLE_HEARTBEAT_MS = 20_000;
const DEFAULT_LIFECYCLE_MAX_BYTES = 512 * 1024;

/**
 * Every preset the host ships. `standard` and `ptc` are the two that show up in
 * the mode picker by default; `minimal` and `cordis` (the maker preset) exist
 * underneath and are addressed by the same `agentPreset` field, so an external
 * caller can pick any of the four even when the UI hides two of them.
 */
const MODES = ['standard', 'ptc', 'minimal', 'cordis'];
const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh'];
const PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVALS = ['ask', 'never', 'on-request'];
const LOOPBACK = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
/** Survives HMR reloads so a new apply() can retire the previous routes. */
const RUNTIME = Symbol.for('dsh-exec.runtime');

/** The live state. A stale route closure still authenticates against the new one. */
function liveState(fallback) {
  return globalThis[RUNTIME]?.state ?? fallback;
}

/* --------------------------------------------------------------- entrypoint */

/** Host plugin entry point. */
export function apply(ctx, rawConfig) {
  // Layering: the profile's cordis.patch.yml (rawConfig) is the machine
  // baseline; the settings page writes overrides on top of it. Deleting the
  // overrides file returns the plugin to exactly what the patch says.
  const baseConfig = rawConfig ?? {};
  const config = normalizeConfig(withOverrides(baseConfig));
  if (!config.enabled) {
    ctx.logger?.info?.(`${NS}: disabled by config`);
    return;
  }

  const state = createState(config);
  /** Re-read the override file into the SAME config object every holder sees. */
  const reloadConfig = () => {
    const next = normalizeConfig(withOverrides(baseConfig));
    Object.assign(config, next);
    state.config = config;
    return config;
  };

  // Exit forensics: record who asked to quit (stack) and, when the process
  // vanishes without any exit event, leave a heartbeat that proves it was
  // killed rather than closed.
  if (config.lifecycle.enabled) {
    try {
      state.lastExit = installLifecycleProbe({
        heartbeatMs: config.lifecycle.heartbeatMs,
        maxLogBytes: config.lifecycle.maxLogBytes,
        activeRuns: () => [...state.runs.values()].filter((run) => !isTerminal(run.state)).length,
        lastEventAt: () => Math.max(0, ...[...state.runs.values()].map((run) => run.lastEventAt ?? 0)),
      });
    } catch (error) {
      ctx.logger?.warn?.(`${NS}: lifecycle probe unavailable: ${errorMessage(error)}`);
    }
  }

  // One global listener covers every run; `ctx` owns it, so plugin disposal
  // removes it automatically.
  const stopEvents = ctx.on('session/event', (session, event) => {
    const run = state.bySession.get(session?.id);
    if (run !== undefined) ingest(state, run, event);
  }, { global: true });

  // Cordis services are only reachable inside a scope that declared them via
  // inject; reading `ctx.sessionController` from the outer scope throws
  // "cannot get property … without inject". Optional services are fetched with
  // ctx.get(), which returns undefined instead of throwing when absent.
  ctx.inject(['webServer', 'sessionController', 'workspaceRegistry', 'agents'], (child) => {
    const webServer = child.webServer;
    if (webServer === undefined || typeof webServer.register !== 'function') {
      child.logger?.warn?.(`${NS}: no webServer service; bridge unavailable`);
      return;
    }

    // An HMR reload runs apply() again in the same process. `register()` throws
    // on a duplicate path, so without this the new route silently lost the race
    // and the old closure kept serving with an old token — every request then
    // failed with 401 while the file advertised the new token.
    const previous = globalThis[RUNTIME];
    if (previous !== undefined && typeof previous.disposeRoutes === 'function') {
      try {
        previous.disposeRoutes();
      } catch {
        /* the old scope is already gone */
      }
    }

    // Reuse the token for the same process so a reload cannot invalidate a
    // caller that already read the bridge file. A fresh process gets a fresh
    // token, and the file is 0600 either way.
    const token = existingTokenFor(process.pid) ?? randomBytes(24).toString('hex');
    const port = resolvePort(webServer);
    state.token = token;
    state.port = port;
    state.startedAt = Date.now();
    writeBridgeFile(port, token);

    const routes = [
      { path: STATUS_PATH, handler: (req, res) => handleStatus(req, res, child, liveState(state), config) },
      { path: RUNS_PATH, handler: (req, res) => handleRuns(req, res, child, liveState(state), config) },
      { path: EVENTS_PATH, handler: (req, res) => handleEvents(req, res, liveState(state)) },
      { path: CONFIG_PATH, handler: (req, res) => handleConfig(req, res, liveState(state), reloadConfig) },
    ];
    const disposers = routes.map((route) =>
      webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
    );
    globalThis[RUNTIME] = {
      state,
      disposeRoutes: () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* already removed */
          }
        }
      },
    };
    child.logger?.info?.(
      `${NS}: bridge on 127.0.0.1:${port} (token in ${bridgeFilePath()}); ` +
        `default mode ${config.defaultMode}, ${config.defaultPermission}/${config.defaultApproval}`,
    );

    const heartbeat = setInterval(() => tick(state), config.heartbeatMs);
    heartbeat.unref?.();

    return () => {
      clearInterval(heartbeat);
      removeBridgeFile(token);
      stopEvents?.();
      for (const run of state.runs.values()) closeListeners(run);
      if (globalThis[RUNTIME]?.state === state) delete globalThis[RUNTIME];
    };
  });
}

function createState(config) {
  return {
    config,
    runs: new Map(),
    bySession: new Map(),
    token: undefined,
    port: 0,
    startedAt: Date.now(),
  };
}

/* ------------------------------------------------------------------- routes */

function handleStatus(req, res, ctx, state, config) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET');
  const authenticated = authorized(req, state);
  const runs = [...state.runs.values()];
  const body = {
    ok: true,
    plugin: NS,
    pid: process.pid,
    port: state.port,
    startedAt: new Date(state.startedAt).toISOString(),
    authenticated,
    config: publicConfig(config),
    counts: {
      runs: runs.length,
      running: runs.filter((run) => run.state === 'running' || run.state === 'starting').length,
      retries: runs.reduce((sum, run) => sum + run.retries, 0),
    },
    // How the previous host process ended. `killed` means it vanished without
    // running any exit handler — TerminateProcess, hard crash, or power loss.
    lastExit: state.lastExit
      ? { verdict: state.lastExit.verdict, detail: state.lastExit.detail }
      : null,
  };
  if (authenticated) {
    body.runs = runs.map((run) => publicRun(run));
    body.bridgeFile = bridgeFilePath();
    body.lifecycle = lifecycleSummary();
  }
  sendJson(res, 200, body);
}

/* ------------------------------------------------------------ config route */

/** The config the settings page renders. Never contains the token. */
export function publicConfig(config) {
  return {
    defaultMode: config.defaultMode,
    defaultModel: config.defaultModel ?? '',
    defaultProvider: config.defaultProvider ?? '',
    defaultEffort: config.defaultEffort ?? '',
    enforceDefaults: config.enforceDefaults,
    defaultPermission: config.defaultPermission,
    defaultApproval: config.defaultApproval,
    autoCreateWorkspace: config.autoCreateWorkspace,
    heartbeatMs: config.heartbeatMs,
    maxConcurrentRuns: config.maxConcurrentRuns,
    maxEventBuffer: config.maxEventBuffer,
    lifecycle: { ...config.lifecycle },
    modes: MODES,
    efforts: EFFORTS,
    permissions: PERMISSIONS,
    approvals: APPROVALS,
  };
}

/** Writable keys. A typo is an error, never a silent no-op. */
const CONFIG_PARSERS = {
  defaultMode: (v) => (MODES.includes(v) ? v : undefined),
  defaultModel: (v) => (v === '' || v === null ? '' : (typeof v === 'string' ? v.trim() : undefined)),
  defaultProvider: (v) => (v === '' || v === null ? '' : (typeof v === 'string' ? v.trim() : undefined)),
  defaultEffort: (v) => (v === '' || v === null ? '' : (EFFORTS.includes(v) ? v : undefined)),
  enforceDefaults: (v) => (typeof v === 'boolean' ? v : undefined),
  defaultPermission: (v) => (PERMISSIONS.includes(v) ? v : undefined),
  defaultApproval: (v) => (APPROVALS.includes(v) ? v : undefined),
  autoCreateWorkspace: (v) => (typeof v === 'boolean' ? v : undefined),
  heartbeatMs: (v) => positiveInt(v),
  maxConcurrentRuns: (v) => positiveInt(v),
  maxEventBuffer: (v) => positiveInt(v),
};

async function handleConfig(req, res, state, reload) {
  const remote = req.socket?.remoteAddress ?? '';
  if (!LOOPBACK.test(remote)) return sendJson(res, 403, { ok: false, error: 'loopback only' });
  if (req.method === 'GET' || req.method === 'HEAD') {
    sendJson(res, 200, {
      ok: true,
      config: publicConfig(state.config ?? normalizeConfig({})),
      overridesFile: overridesPath(),
    });
    return;
  }
  if (req.method !== 'PUT' && req.method !== 'POST') return methodNotAllowed(res, 'GET, PUT');

  // Two callers are legitimate: the settings page inside the app (same origin,
  // no token in the renderer by design) and a scripted setup (bearer token).
  if (!authorized(req, state) && !sameOrigin(req, state)) {
    return sendJson(res, 403, { ok: false, error: 'same-origin or bearer token required' });
  }

  const body = await readJsonBody(req);
  if (body === undefined) return sendJson(res, 400, { ok: false, error: 'request body must be JSON' });

  if (body.reset === true) {
    rmSync(overridesPath(), { force: true });
    const config = reload();
    return sendJson(res, 200, { ok: true, reset: true, config: publicConfig(config) });
  }

  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'lifecycle') {
      if (!isRecord(value)) return sendJson(res, 400, { ok: false, error: 'lifecycle must be an object' });
      const next = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === 'enabled') next.enabled = typeof v === 'boolean' ? v : undefined;
        else if (k === 'heartbeatMs' || k === 'maxLogBytes') next[k] = positiveInt(v);
        else return sendJson(res, 400, { ok: false, error: `unknown lifecycle key "${k}"` });
        if (next[k === 'enabled' ? 'enabled' : k] === undefined) {
          return sendJson(res, 400, { ok: false, error: `invalid lifecycle.${k}` });
        }
      }
      patch.lifecycle = next;
      continue;
    }
    const parse = CONFIG_PARSERS[key];
    if (parse === undefined) return sendJson(res, 400, { ok: false, error: `unknown config key "${key}"` });
    const parsed = parse(value);
    if (parsed === undefined) return sendJson(res, 400, { ok: false, error: `invalid value for "${key}"` });
    patch[key] = parsed;
  }
  if (Object.keys(patch).length === 0) {
    return sendJson(res, 400, { ok: false, error: 'nothing to save' });
  }

  try {
    writeOverrides(patch);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: `could not write overrides: ${errorMessage(error)}` });
  }
  const config = reload();
  sendJson(res, 200, { ok: true, config: publicConfig(config) });
}

/** Reject anything that is not the app's own page. */
function sameOrigin(req, state) {
  const origin = req.headers?.origin;
  const host = req.headers?.host;
  if (typeof origin !== 'string' || origin.length === 0) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') return false;
  // The renderer is served by this very webServer, so its Origin host must
  // equal the Host header the request arrived with — any port, no guessing.
  if (typeof host === 'string' && host.length > 0) return url.host === host;
  return state?.port !== undefined && url.port === String(state.port);
}

async function handleRuns(req, res, ctx, state, config) {
  if (!authorized(req, state)) return unauthorized(res);

  if (req.method === 'GET' || req.method === 'HEAD') {
    sendJson(res, 200, { ok: true, runs: [...state.runs.values()].map((run) => publicRun(run)) });
    return;
  }
  if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');

  const body = await readJsonBody(req);
  if (body === undefined) return sendJson(res, 400, { ok: false, error: 'request body must be JSON' });

  if (body.action === 'stop') {
    const run = state.runs.get(text(body.runId));
    if (run === undefined) return sendJson(res, 404, { ok: false, error: 'run not found' });
    stopRun(ctx, state, run);
    sendJson(res, 200, { ok: true, run: publicRun(run) });
    return;
  }

  const parsed = validateRunRequest(body, config);
  if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error });

  const active = [...state.runs.values()].filter(
    (run) => run.state === 'running' || run.state === 'starting',
  ).length;
  if (active >= config.maxConcurrentRuns) {
    return sendJson(res, 429, {
      ok: false,
      error: `too many concurrent runs (${active}/${config.maxConcurrentRuns})`,
    });
  }
  // Two live runs on one session would fight over the event stream: the newer
  // run replaces the bySession mapping and the older one never sees turn/end.
  const busy = parsed.value.sessionId !== undefined
    ? state.bySession.get(parsed.value.sessionId)
    : undefined;
  if (busy !== undefined && !isTerminal(busy.state)) {
    return sendJson(res, 409, {
      ok: false,
      error: `session ${parsed.value.sessionId} already has a live run (${busy.runId})`,
    });
  }

  const run = await startRun(ctx, state, config, parsed.value);
  sendJson(res, run.state === 'failed' ? 500 : 202, {
    ok: run.state !== 'failed',
    run: publicRun(run),
    ...(run.error === undefined ? {} : { error: run.error }),
  });
}

function handleEvents(req, res, state) {
  if (!authorized(req, state)) return unauthorized(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET');

  const url = new URL(req.url ?? EVENTS_PATH, 'http://127.0.0.1');
  const run = state.runs.get(url.searchParams.get('runId'));
  if (run === undefined) return sendJson(res, 404, { ok: false, error: 'run not found' });
  const since = Number(url.searchParams.get('since') ?? 0);
  // `snapshot=1` is the opt-in execution log: replay the buffered events and
  // close, even while the run is still working.
  const snapshot = url.searchParams.get('snapshot') === '1';

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  for (const event of run.events) {
    if (event.seq > since) res.write(`${JSON.stringify(event)}\n`);
  }
  if (snapshot || isTerminal(run.state)) {
    res.end();
    return;
  }
  run.listeners.add(res);
  // Only the response tells us the socket went away. IncomingMessage emits
  // `close` as soon as the (empty) request body is consumed, which would
  // unregister a perfectly healthy stream immediately.
  res.on('close', () => run.listeners.delete(res));
}

/* -------------------------------------------------------------- run lifecycle */

async function startRun(ctx, state, config, request) {
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const run = {
    runId,
    config,
    sessionId: undefined,
    cwd: request.cwd,
    mode: request.mode ?? config.defaultMode,
    permission: request.permission ?? config.defaultPermission,
    approval: request.approval ?? config.defaultApproval,
    requestedModel: request.model,
    requestedEffort: request.effort,
    startedAt: Date.now(),
    state: 'starting',
    phase: 'starting',
    seq: 0,
    events: [],
    listeners: new Set(),
    text: '',
    steps: 0,
    toolCalls: 0,
    retries: 0,
    lastEventAt: Date.now(),
    lastEventType: undefined,
    reason: undefined,
    error: undefined,
  };
  state.runs.set(runId, run);
  publish(run, { type: 'run', phase: 'starting', runId, mode: run.mode });

  try {
    const controller = ctx.sessionController;
    if (controller === undefined || typeof controller.create !== 'function') {
      throw new Error('sessionController is unavailable in this profile');
    }

    let sessionId = request.sessionId;
    const createdNew = sessionId === undefined;
    if (createdNew) {
      const workspaceId = await resolveWorkspaceId(ctx, config, request.cwd);
      const createRequest = {
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(workspaceId === undefined && request.cwd !== undefined ? { cwd: request.cwd } : {}),
        agentPreset: run.mode,
      };
      const created = await controller.create(createRequest);
      sessionId = created?.sessionId;
      if (typeof created?.agentPreset === 'string') run.mode = created.agentPreset;
      if (typeof sessionId !== 'string') throw new Error('sessionController.create returned no sessionId');
    } else {
      await ensureRegistered(ctx, config, sessionId, request.cwd);
    }

    run.sessionId = sessionId;
    run.state = 'running';
    run.phase = 'starting';
    state.bySession.set(sessionId, run);
    publish(run, {
      type: 'session',
      sessionId,
      cwd: request.cwd ?? null,
      mode: run.mode,
      permission: run.permission,
      approval: run.approval,
    });

    // Permission/approval are per-session. The desktop's own setting is left
    // untouched; only this delegated session is switched to full access.
    const agent = ctx.agents?.get?.(sessionId);
    if (agent !== undefined) {
      // `permissionPresets` / `approval` are optional services; ctx.get() is
      // safe even when a profile composes neither (unlike property access).
      const permissionPresets = ctx.get?.('permissionPresets');
      const approvalService = ctx.get?.('approval');
      try {
        permissionPresets?.set?.(agent.session, run.permission);
      } catch (error) {
        ctx.logger?.warn?.(`${NS}: could not set permission preset: ${errorMessage(error)}`);
      }
      try {
        approvalService?.setPolicy?.(agent, run.approval);
      } catch (error) {
        ctx.logger?.warn?.(`${NS}: could not set approval policy: ${errorMessage(error)}`);
      }
    }

    // A model is pinned only when someone asked for one: an explicit --model /
    // --effort on the run, or `enforceDefaults` plus a configured
    // `defaultModel`. With neither, the session keeps whatever the host would
    // have picked — which is what every other machine actually has installed.
    const wantsOverride = request.model !== undefined || request.effort !== undefined;
    // A resumed session keeps the model it was created with unless the caller
    // asks otherwise; `enforceDefaults` only applies to new sessions.
    const shouldPin = createdNew ? config.enforceDefaults || wantsOverride : wantsOverride;
    const pinnedModel = shouldPin ? (request.model ?? config.defaultModel) : undefined;
    const pinnedEffort = shouldPin ? (request.effort ?? config.defaultEffort) : undefined;
    if (pinnedModel !== undefined || pinnedEffort !== undefined) {
      if (typeof controller.selectModel !== 'function') {
        throw new Error('model selection requested but sessionController.selectModel is unavailable');
      }
      const provider = request.provider ?? config.defaultProvider;
      await controller.selectModel({
        sessionId,
        // Only forward a provider the caller named: hard-coding one here would
        // make the plugin useless on any machine without that provider.
        ...(provider === undefined ? {} : { provider }),
        ...(pinnedModel === undefined ? {} : { model: pinnedModel }),
        ...(pinnedEffort === undefined ? {} : { reasoningEffort: pinnedEffort }),
      });
    }

    // `sessionController.prompt(request, signal)` is the Remote entry: its
    // second argument is an AbortSignal, not a message source. It builds the
    // user-rpc source itself from request.requestId.
    const requestId = randomUUID();
    await controller.prompt(
      {
        sessionId,
        requestId,
        content: [{ type: 'text', text: request.task }],
        mode: request.steer === true ? 'steer' : 'followup',
      },
      new AbortController().signal,
    );
    publish(run, { type: 'status', phase: 'prompted', turn: 1 });
  } catch (error) {
    run.state = 'failed';
    run.error = errorMessage(error);
    publish(run, { type: 'error', message: run.error });
    publish(run, {
      type: 'final',
      sessionId: run.sessionId ?? null,
      runId,
      reason: { kind: 'error', message: run.error },
      text: run.text,
      metrics: metricsOf(run),
    });
    closeListeners(run);
  }
  return run;
}

/** Find (or optionally create) the workspace row whose path matches cwd. */
async function resolveWorkspaceId(ctx, config, cwd) {
  const registry = ctx.workspaceRegistry;
  if (registry === undefined || cwd === undefined) return undefined;

  let canonical;
  try {
    canonical = await realpath(cwd);
  } catch {
    canonical = path.resolve(cwd);
  }
  const wanted = normalizePath(canonical);
  const existing = (registry.list?.() ?? []).find(
    (workspace) => normalizePath(workspace.path) === wanted,
  );
  if (existing !== undefined) return existing.id;
  if (!config.autoCreateWorkspace || typeof registry.create !== 'function') return undefined;
  const created = await registry.create(canonical, path.basename(canonical) || canonical);
  return created?.id;
}

/** A resumed session may predate the bridge; attach it so it is visible. */
async function ensureRegistered(ctx, config, sessionId, cwd) {
  const registry = ctx.workspaceRegistry;
  if (registry === undefined || cwd === undefined) return;
  try {
    let canonical;
    try {
      canonical = await realpath(cwd);
    } catch {
      canonical = path.resolve(cwd);
    }
    const workspace = (registry.list?.() ?? []).find(
      (item) => normalizePath(item.path) === normalizePath(canonical),
    );
    const target = workspace ?? (config.autoCreateWorkspace
      ? await registry.create(canonical, path.basename(canonical) || canonical)
      : undefined);
    if (target !== undefined && !(target.sessionIds ?? []).includes(sessionId)) {
      await target.attachSession(sessionId);
    }
  } catch (error) {
    ctx.logger?.warn?.(`${NS}: could not attach resumed session: ${errorMessage(error)}`);
  }
}

function stopRun(ctx, state, run) {
  if (isTerminal(run.state)) return;
  try {
    const cancelled = ctx.sessionController?.cancel?.({ sessionId: run.sessionId });
    if (cancelled === undefined) {
      ctx.agents?.get?.(run.sessionId)?.cancel?.('user-cancel');
    } else if (typeof cancelled.catch === 'function') {
      // cancel() is a Remote method and returns a promise; a late rejection
      // must not turn into an unhandled rejection in the host.
      cancelled.catch((error) => ctx.logger?.warn?.(`${NS}: cancel rejected: ${errorMessage(error)}`));
    }
  } catch (error) {
    ctx.logger?.warn?.(`${NS}: cancel failed: ${errorMessage(error)}`);
  }
  run.state = 'stopped';
  run.reason = { kind: 'cancelled' };
  publish(run, { type: 'status', phase: 'stopped' });
  publish(run, {
    type: 'final',
    sessionId: run.sessionId ?? null,
    runId: run.runId,
    reason: run.reason,
    text: run.text,
    metrics: metricsOf(run),
  });
  closeListeners(run);
}

/* ------------------------------------------------------------ event pipeline */

/** Convert one durable session event into NDJSON frames and update metrics. */
function ingest(state, run, event) {
  if (event === undefined || event === null || isTerminal(run.state)) return;
  const type = event.type;
  if (typeof type !== 'string') return;

  run.lastEventAt = Date.now();
  run.lastEventType = type;
  const data = event.data ?? {};

  const projected = projectEvent(run, type, data, event);
  if (projected !== undefined) {
    for (const frame of Array.isArray(projected) ? projected : [projected]) publish(run, frame);
  }

  if (type === 'llm/retry') {
    run.phase = 'retry-wait';
  } else if (type === 'llm/retry-started') {
    run.phase = 'running';
  } else if (type === 'step/start') {
    run.phase = 'stepping';
  } else if (type === 'assistant/message') {
    run.phase = 'streaming';
  }

  if (type === 'turn/end') {
    run.state = 'completed';
    run.reason = data.reason ?? null;
    publish(run, {
      type: 'final',
      sessionId: run.sessionId ?? null,
      runId: run.runId,
      reason: run.reason,
      text: run.text,
      metrics: metricsOf(run),
    });
    closeListeners(run);
  }
}

/**
 * Pure projection, exported for tests. Mirrors `dsh-headless`'s NDJSON shape.
 * `run` is only mutated for text/metrics accumulation.
 */
export function projectEvent(run, type, data, event) {
  switch (type) {
    case 'turn/start':
      return { type: 'status', phase: 'turn_start', turn: data.turn };
    case 'step/start':
      run.steps += 1;
      return { type: 'status', phase: 'step_start', turn: data.turn, step: data.step };
    case 'step/end':
      return { type: 'status', phase: 'step_end', turn: data.turn, step: data.step };
    case 'assistant/message': {
      const blocks = data.message?.content;
      if (!Array.isArray(blocks)) return undefined;
      const frames = [];
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          run.text += block.text;
          frames.push({ type: 'text', text: block.text });
        } else if (block?.type === 'reasoning' && typeof block.text === 'string') {
          frames.push({ type: 'thinking', text: block.text });
        }
      }
      return frames;
    }
    case 'tool/call':
      run.toolCalls += 1;
      return { type: 'tool_call', callId: data.callId, tool: data.name };
    case 'tool/result':
      if (event?.surfaceOp !== 'append') return undefined;
      return { type: 'tool_result', status: data.message?.isError === true ? 'error' : 'completed' };
    case 'llm/retry':
      run.retries += 1;
      return {
        type: 'status',
        phase: 'retry',
        retry: data.retry ?? null,
        delayMs: data.delayMs ?? null,
        code: data.failure?.code ?? 'RATE_LIMIT',
        note: 'the provider asked us to back off; the turn is still running',
      };
    case 'turn/end':
      return { type: 'status', phase: 'turn_end', turn: data.turn, reason: data.reason ?? null };
    default:
      return undefined;
  }
}

function tick(state) {
  const now = Date.now();
  for (const run of state.runs.values()) {
    if (isTerminal(run.state)) continue;
    publish(run, {
      type: 'progress',
      phase: run.phase,
      elapsedMs: now - run.startedAt,
      silentMs: now - run.lastEventAt,
      steps: run.steps,
      toolCalls: run.toolCalls,
      retries: run.retries,
      lastEventType: run.lastEventType ?? null,
      alive: true,
      note: run.phase === 'retry-wait'
        ? 'waiting out a provider 429 — a quiet session log is expected, not a crash'
        : undefined,
    });
  }
}

function publish(run, event) {
  const framed = { ...event, seq: ++run.seq, at: Date.now() };
  run.events.push(framed);
  const overflow = run.events.length - run.config.maxEventBuffer;
  if (overflow > 0) run.events.splice(0, overflow);
  for (const res of run.listeners) {
    try {
      res.write(`${JSON.stringify(framed)}\n`);
    } catch {
      run.listeners.delete(res);
    }
  }
}

function closeListeners(run) {
  for (const res of run.listeners) {
    try {
      res.end();
    } catch {
      /* already closed */
    }
  }
  run.listeners.clear();
}

function metricsOf(run) {
  return {
    elapsedMs: Date.now() - run.startedAt,
    steps: run.steps,
    toolCalls: run.toolCalls,
    retries: run.retries,
  };
}

function isTerminal(state) {
  return state === 'completed' || state === 'failed' || state === 'stopped';
}

/** Run metadata safe to hand to a caller (no task text, no token). */
export function publicRun(run) {
  return {
    runId: run.runId,
    sessionId: run.sessionId ?? null,
    cwd: run.cwd ?? null,
    mode: run.mode,
    permission: run.permission,
    approval: run.approval,
    state: run.state,
    phase: run.phase,
    startedAt: new Date(run.startedAt).toISOString(),
    lastEventAt: new Date(run.lastEventAt).toISOString(),
    elapsedMs: Date.now() - run.startedAt,
    metrics: metricsOf(run),
    textLength: run.text.length,
    seq: run.seq,
    error: run.error ?? null,
  };
}

/* ------------------------------------------------------------- bridge file */

export function bridgeFilePath() {
  return path.join(dshHome(), 'storages', BRIDGE_FILE_NAME);
}

/** Token written by an earlier apply() in this process; undefined otherwise. */
function existingTokenFor(pid) {
  try {
    const current = JSON.parse(readFileSync(bridgeFilePath(), 'utf8'));
    if (current.pid === pid && typeof current.token === 'string' && current.token.length >= 32) {
      return current.token;
    }
  } catch {
    /* no file yet */
  }
  return undefined;
}

function writeBridgeFile(port, token) {
  const file = bridgeFilePath();
  const payload = {
    version: 1,
    plugin: NS,
    pid: process.pid,
    port,
    token,
    base: `http://127.0.0.1:${port}`,
    startedAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows has no POSIX modes; ACLs still restrict this to the user */
  }
}

/** Only remove our own file: a newer instance may have replaced it. */
function removeBridgeFile(token) {
  const file = bridgeFilePath();
  try {
    if (!existsSync(file)) return;
    const current = JSON.parse(readFileSync(file, 'utf8'));
    if (current.token !== token || current.pid !== process.pid) return;
    rmSync(file, { force: true });
  } catch {
    /* best effort */
  }
}

function resolvePort(webServer) {
  for (const key of ['port', 'listenedPort']) {
    const value = webServer[key];
    if (Number.isInteger(value) && value > 0) return value;
  }
  const address = webServer.server?.address?.();
  if (address !== null && typeof address === 'object' && Number.isInteger(address.port)) {
    return address.port;
  }
  return 0;
}

/* ------------------------------------------------------------------- helpers */

function authorized(req, state) {
  const remote = req.socket?.remoteAddress ?? '';
  if (!LOOPBACK.test(remote)) return false;
  const stateToken = state.token;
  if (typeof stateToken !== 'string' || stateToken.length === 0) return false;
  const raw = req.headers?.authorization ?? req.headers?.['x-dsh-exec-token'] ?? '';
  const given = typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : String(raw);
  const a = Buffer.from(given);
  const b = Buffer.from(stateToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isLoopback(address) {
  return LOOPBACK.test(address);
}

/**
 * Defaults are deliberately neutral: this package is installed on machines that
 * do not share the author's provider, model or permission policy. A model is
 * only pinned when the user configured one (settings page or patch), so a
 * missing `google-vertex-argon` provider can never break every new session.
 */
export function normalizeConfig(raw) {
  const value = raw ?? {};
  return {
    enabled: value.enabled !== false,
    defaultMode: MODES.includes(value.defaultMode) ? value.defaultMode : 'standard',
    defaultModel: text(value.defaultModel),
    defaultProvider: text(value.defaultProvider),
    defaultEffort: EFFORTS.includes(value.defaultEffort) ? value.defaultEffort : undefined,
    enforceDefaults: value.enforceDefaults === true,
    // Least privilege that still lets a delegated task do real work. Full
    // access exists as an explicit per-run flag, never as the shipped default.
    defaultPermission: PERMISSIONS.includes(value.defaultPermission)
      ? value.defaultPermission
      : 'workspace-write',
    defaultApproval: APPROVALS.includes(value.defaultApproval) ? value.defaultApproval : 'never',
    autoCreateWorkspace: value.autoCreateWorkspace !== false,
    heartbeatMs: positiveInt(value.heartbeatMs) ?? DEFAULT_HEARTBEAT_MS,
    maxConcurrentRuns: positiveInt(value.maxConcurrentRuns) ?? DEFAULT_MAX_RUNS,
    maxEventBuffer: positiveInt(value.maxEventBuffer) ?? DEFAULT_MAX_EVENTS,
    lifecycle: {
      enabled: value.lifecycle?.enabled !== false,
      heartbeatMs: positiveInt(value.lifecycle?.heartbeatMs) ?? DEFAULT_LIFECYCLE_HEARTBEAT_MS,
      maxLogBytes: positiveInt(value.lifecycle?.maxLogBytes) ?? DEFAULT_LIFECYCLE_MAX_BYTES,
    },
  };
}

/* ------------------------------------------------------ user config overrides */

/** `<DSH_HOME>` — the same root the host uses for sessions and storages. */
export function dshHome() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(homedir(), '.dsh');
}

/** Where the settings page persists what the user chose. */
export function overridesPath() {
  return path.join(dshHome(), 'plugin-data', NS, 'config.json');
}

/** Tolerant reader: a corrupt file must not take the plugin down. */
export function readOverrides() {
  try {
    const parsed = JSON.parse(readFileSync(overridesPath(), 'utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Patch config first, then whatever the settings page saved on top of it. */
export function withOverrides(raw) {
  const base = isRecord(raw) ? raw : {};
  const saved = readOverrides();
  const merged = { ...base, ...saved };
  if (isRecord(base.lifecycle) || isRecord(saved.lifecycle)) {
    merged.lifecycle = { ...(isRecord(base.lifecycle) ? base.lifecycle : {}), ...(isRecord(saved.lifecycle) ? saved.lifecycle : {}) };
  }
  return merged;
}

/** Merge one settings-page save into the file (partial saves stay partial). */
export function writeOverrides(patch) {
  const current = readOverrides();
  const next = { ...current, ...patch };
  if (isRecord(current.lifecycle) || isRecord(patch.lifecycle)) {
    next.lifecycle = { ...(isRecord(current.lifecycle) ? current.lifecycle : {}), ...(isRecord(patch.lifecycle) ? patch.lifecycle : {}) };
  }
  const file = overridesPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}

/** Validate an external run request. Pure; exported for tests. */
export function validateRunRequest(body, config = normalizeConfig({})) {
  if (!isRecord(body)) return { ok: false, error: 'request body must be an object' };
  if (body.action !== undefined && body.action !== 'run') {
    return { ok: false, error: `unknown action "${String(body.action)}"` };
  }
  const task = text(body.task);
  if (task === undefined || task.trim().length === 0) {
    return { ok: false, error: 'task must be a non-empty string' };
  }
  if (task.length > 200_000) return { ok: false, error: 'task is too long (200000 chars max)' };

  const mode = text(body.mode) ?? config.defaultMode;
  if (!MODES.includes(mode)) {
    return { ok: false, error: `mode must be one of ${MODES.join(' | ')} (a preset must be chosen)` };
  }
  const permission = text(body.permission) ?? config.defaultPermission;
  if (!PERMISSIONS.includes(permission)) {
    return { ok: false, error: `permission must be one of ${PERMISSIONS.join(' | ')}` };
  }
  const approval = text(body.approval) ?? config.defaultApproval;
  if (!APPROVALS.includes(approval)) {
    return { ok: false, error: `approval must be one of ${APPROVALS.join(' | ')}` };
  }

  return {
    ok: true,
    value: {
      task,
      cwd: text(body.cwd),
      sessionId: text(body.sessionId),
      mode,
      permission,
      approval,
      model: text(body.model),
      effort: text(body.effort),
      provider: text(body.provider),
      title: text(body.title),
      steer: body.steer === true,
    },
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function unauthorized(res) {
  sendJson(res, 401, { ok: false, error: 'loopback + bearer token required (see dsh-exec.json)' });
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow });
  res.end();
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        finish(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(undefined);
      }
    });
    req.on('error', () => finish(undefined));
  });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizePath(value) {
  return path.normalize(String(value)).replace(/[\\/]+$/, '').toLowerCase();
}

function errorMessage(error) {
  return String(error?.message ?? error ?? 'unknown error').slice(0, 600);
}
