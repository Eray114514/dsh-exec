/* Offline host test: fake ctx + fake webServer, no real desktop process. */
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-exec-test-'));
process.env.DSH_HOME = HOME;
const PLUGIN = path.resolve(__dirname, '..', 'index.js');

const STATUS = '/dsh-exec/status.json';
const RUNS = '/dsh-exec/runs.json';
const EVENTS = '/dsh-exec/events.jsonl';
const CONFIG = '/dsh-exec/config.json';

class FakeReq extends EventEmitter {
  constructor(method, url, body, headers = {}) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.socket = { remoteAddress: '127.0.0.1' };
    this._body = body;
  }
  // readJsonBody() attaches data/end listeners; feed them on the next tick.
  on(event, listener) {
    super.on(event, listener);
    if (event === 'end' && this._body !== undefined && !this._fed) {
      this._fed = true;
      setImmediate(() => {
        this.emit('data', Buffer.from(JSON.stringify(this._body)));
        this.emit('end');
      });
    }
    return this;
  }
}

class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.chunks = [];
    this.ended = false;
  }
  writeHead(code, headers) {
    this.statusCode = code;
    Object.assign(this.headers, headers ?? {});
  }
  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }
  end(chunk) {
    if (chunk !== undefined) this.chunks.push(String(chunk));
    this.ended = true;
    this.emit('close');
  }
  get body() {
    return this.chunks.join('');
  }
  json() {
    return JSON.parse(this.body);
  }
  frames() {
    return this.body.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
}

/** A webServer that behaves like the real one: duplicate paths throw. */
function createWebServer(port = 18999) {
  const routes = [];
  const registered = new Map();
  return {
    port,
    routes,
    register(route) {
      if (registered.has(route.path)) {
        throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      }
      registered.set(route.path, route);
      routes.push(route);
      return () => {
        registered.delete(route.path);
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
}

function fakeHost(options = {}) {
  const webServer = options.webServer ?? createWebServer(options.port);
  const routes = webServer.routes;
  const calls = { create: [], prompt: [], selectModel: [], permissions: [], approval: [], attach: [] };
  let sessionListener;
  const workspace = {
    id: 'ws-1',
    path: 'D:\\repo',
    sessionIds: [],
    async attachSession(id) {
      calls.attach.push(id);
      this.sessionIds.push(id);
    },
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    on(name, listener) {
      if (name === 'session/event') sessionListener = listener;
      return () => {};
    },
    inject(names, fn) {
      assert.deepEqual(names, ['webServer', 'sessionController', 'workspaceRegistry', 'agents']);
      const dispose = fn({ ...ctx, webServer: webServer });
      ctx.dispose = dispose;
      return dispose;
    },
    get(name) {
      if (name === 'permissionPresets') return ctx.permissionPresets;
      if (name === 'approval') return ctx.approval;
      return undefined;
    },
    webServer: undefined,
    workspaceRegistry: {
      list: () => [workspace],
      create: async () => workspace,
    },
    sessionController: {
      async create(request) {
        calls.create.push(request);
        return { sessionId: `session-test-${calls.create.length}`, agentPreset: request.agentPreset };
      },
      async selectModel(request) {
        calls.selectModel.push(request);
      },
      async prompt(request, signal) {
        assert.equal(typeof signal.throwIfAborted, 'function', 'Remote prompt needs an AbortSignal');
        calls.prompt.push({ request, signal });
        return { accepted: true };
      },
      cancel(request) {
        calls.cancel = request;
        return { accepted: true };
      },
    },
    agents: {
      get: () => ({ session: { id: 'session-test-1' }, cancel() {} }),
    },
    permissionPresets: {
      set(session, mode) {
        calls.permissions.push(mode);
      },
    },
    approval: {
      setPolicy(agent, policy) {
        calls.approval.push(policy);
      },
    },
  };
  ctx.webServer = webServer;
  return {
    ctx,
    webServer,
    routes,
    calls,
    workspace,
    emitSession: (event) => sessionListener({ id: 'session-test-1' }, event),
  };
}

async function main() {
  const mod = await import(pathToFileURL(PLUGIN).href);
  const { apply, normalizeConfig, validateRunRequest, projectEvent, publicRun, bridgeFilePath, overridesPath, withOverrides, isLoopback } = mod;

  /* ------------------------------------------------------------ pure config */
  const defaults = normalizeConfig({});
  assert.equal(defaults.defaultMode, 'standard');
  assert.equal(defaults.defaultModel, undefined, 'no model is pinned by default');
  assert.equal(defaults.defaultProvider, undefined, 'no provider is pinned by default');
  assert.equal(defaults.defaultEffort, undefined, 'no effort is pinned by default');
  assert.equal(defaults.enforceDefaults, false, 'opt-in: a missing model must not break every run');
  assert.equal(defaults.defaultPermission, 'workspace-write', 'least privilege by default');
  assert.equal(defaults.defaultApproval, 'never');
  assert.equal(defaults.autoCreateWorkspace, true);
  assert.equal(defaults.heartbeatMs, 15000);
  assert.equal(normalizeConfig({ defaultMode: 'ptc', heartbeatMs: 2000 }).heartbeatMs, 2000);
  assert.equal(normalizeConfig({ defaultMode: 'nonsense' }).defaultMode, 'standard', 'bad mode falls back');
  assert.equal(normalizeConfig({ enabled: false }).enabled, false);
  // All four shipped presets are addressable, including the two the UI hides.
  for (const mode of ['standard', 'ptc', 'minimal', 'cordis']) {
    assert.equal(normalizeConfig({ defaultMode: mode }).defaultMode, mode, `${mode} accepted`);
    assert.equal(validateRunRequest({ task: 'hi', mode }).ok, true, `${mode} run request accepted`);
  }
  assert.equal(normalizeConfig({ defaultEffort: 'ludicrous' }).defaultEffort, undefined, 'bad effort falls back');
  assert.equal(normalizeConfig({ defaultEffort: 'xhigh' }).defaultEffort, 'xhigh');

  // Layering: the profile patch is the baseline, the settings file wins.
  fs.mkdirSync(path.dirname(overridesPath()), { recursive: true });
  fs.writeFileSync(overridesPath(), JSON.stringify({ defaultMode: 'minimal', lifecycle: { heartbeatMs: 9000 } }));
  assert.equal(normalizeConfig(withOverrides({ defaultMode: 'ptc' })).defaultMode, 'minimal', 'a saved override beats the patch');
  assert.equal(normalizeConfig(withOverrides({ defaultMode: 'ptc' })).lifecycle.heartbeatMs, 9000);
  assert.equal(
    normalizeConfig(withOverrides({ defaultMode: 'ptc', lifecycle: { maxLogBytes: 1234 } })).lifecycle.maxLogBytes,
    1234,
    'nested lifecycle keys must merge, not replace the whole block',
  );
  fs.rmSync(overridesPath(), { force: true });

  /* ------------------------------------------------------- request contract */
  assert.equal(validateRunRequest({}).ok, false);
  assert.match(validateRunRequest({}).error, /task/);
  assert.equal(validateRunRequest({ task: 'hi', mode: 'magic' }).ok, false);
  assert.match(validateRunRequest({ task: 'hi', mode: 'magic' }).error, /standard.*ptc/);
  const good = validateRunRequest({ task: 'hi' }, defaults);
  assert.equal(good.ok, true);
  assert.equal(good.value.mode, 'standard');
  assert.equal(good.value.model, undefined, 'no model override unless asked');
  assert.equal(validateRunRequest({ task: 'hi', permission: 'bogus' }, defaults).ok, false);
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.8'), false);
  assert.ok(bridgeFilePath().startsWith(HOME));

  /* -------------------------------------------------------- event projection */
  const fakeRun = { text: '', steps: 0, toolCalls: 0, retries: 0 };
  const textFrames = projectEvent(fakeRun, 'assistant/message', {
    message: { content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'PONG' }] },
  });
  assert.deepEqual(textFrames.map((f) => f.type), ['thinking', 'text']);
  assert.equal(fakeRun.text, 'PONG');
  assert.equal(projectEvent(fakeRun, 'step/start', { turn: 1, step: 2 }).phase, 'step_start');
  assert.equal(fakeRun.steps, 1);
  assert.equal(projectEvent(fakeRun, 'tool/call', { callId: 'c1', name: 'read' }).tool, 'read');
  const retry = projectEvent(fakeRun, 'llm/retry', { retry: 1, delayMs: 30000, failure: { code: 'RATE_LIMIT' } });
  assert.equal(retry.phase, 'retry');
  assert.equal(retry.code, 'RATE_LIMIT');
  assert.match(retry.note, /still running/, 'a retry must read as waiting, not as a failure');
  assert.equal(fakeRun.retries, 1);
  assert.equal(projectEvent(fakeRun, 'turn/end', { turn: 1, reason: { kind: 'completed' } }).phase, 'turn_end');
  assert.equal(projectEvent(fakeRun, 'unknown/thing', {}), undefined);

  /* ------------------------------------------------------------- host wiring */
  const host = fakeHost();
  apply(host.ctx, {});
  assert.equal(host.routes.length, 4, 'status / runs / events / config routes registered');
  assert.deepEqual(host.routes.map((r) => r.path).sort(), [STATUS, RUNS, EVENTS, CONFIG].sort());
  const bridge = JSON.parse(fs.readFileSync(bridgeFilePath(), 'utf8'));
  assert.equal(bridge.port, 18999);
  assert.equal(bridge.pid, process.pid);
  assert.equal(typeof bridge.token, 'string');
  assert.ok(bridge.token.length >= 32);
  const auth = { authorization: `Bearer ${bridge.token}` };

  const routeFor = (p) => host.routes.find((r) => r.path === p).handler;

  // Unauthenticated status is readable by the renderer but exposes no runs.
  let req = new FakeReq('GET', STATUS);
  let res = new FakeRes();
  await routeFor(STATUS)(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().authenticated, false);
  assert.equal(res.json().runs, undefined, 'token-free status must not leak run details');
  assert.equal(res.json().config.defaultModel, '', 'no model is shipped as a default');
  assert.equal(res.json().config.defaultEffort, '');
  assert.equal(res.json().config.defaultPermission, 'workspace-write');
  assert.deepEqual(res.json().config.modes, ['standard', 'ptc', 'minimal', 'cordis']);

  // A non-loopback caller is rejected even with the right token.
  req = new FakeReq('POST', RUNS, { task: 'hi' }, auth);
  req.socket.remoteAddress = '10.0.0.5';
  res = new FakeRes();
  await routeFor(RUNS)(req, res);
  assert.equal(res.statusCode, 401);

  // Start a run: preset, workspace and permission are all applied.
  req = new FakeReq('POST', RUNS, { task: 'Reply with exactly: PONG', cwd: 'D:\\repo' }, auth);
  res = new FakeRes();
  await routeFor(RUNS)(req, res);
  assert.equal(res.statusCode, 202, res.body);
  const run = res.json().run;
  assert.equal(run.sessionId, 'session-test-1');
  assert.equal(run.mode, 'standard');
  assert.equal(run.state, 'running');
  assert.deepEqual(host.calls.create[0], { workspaceId: 'ws-1', agentPreset: 'standard' });
  assert.deepEqual(host.calls.permissions, ['workspace-write']);
  assert.deepEqual(host.calls.approval, ['never']);
  assert.equal(host.calls.prompt.length, 1);
  assert.equal(host.calls.prompt[0].request.content[0].text, 'Reply with exactly: PONG');
  assert.equal(host.calls.selectModel.length, 0, 'nothing is pinned when no model was configured');

  // Explicit PTC + explicit model are honoured (only when the caller asks).
  req = new FakeReq('POST', RUNS, { task: 'second', mode: 'ptc', model: 'acme-model-1', effort: 'low' }, auth);
  res = new FakeRes();
  await routeFor(RUNS)(req, res);
  assert.equal(res.statusCode, 202, res.body);
  const secondRun = res.json().run;
  assert.equal(host.calls.create[1].agentPreset, 'ptc');
  assert.deepEqual(host.calls.selectModel[0], {
    sessionId: 'session-test-2',
    model: 'acme-model-1',
    reasoningEffort: 'low',
  }, 'an explicit model does not smuggle in a hard-coded provider');

  // A resumed session keeps its own model/effort; overriding is still allowed.
  const beforeResume = host.calls.selectModel.length;
  req = new FakeReq('POST', RUNS, { task: 'resume', sessionId: 'session-old-1', cwd: 'D:\\repo' }, auth);
  res = new FakeRes();
  await routeFor(RUNS)(req, res);
  assert.equal(res.statusCode, 202, res.body);
  assert.equal(host.calls.create.length, 2, 'resume must not create a new session');
  assert.equal(host.calls.selectModel.length, beforeResume, 'resume must not change the model');

  // Bad request -> 400, no run created.
  req = new FakeReq('POST', RUNS, { task: '' }, auth);
  res = new FakeRes();
  await routeFor(RUNS)(req, res);
  assert.equal(res.statusCode, 400);

  /* ------------------------------------------------------- settings (config) */
  // GET needs no token: the settings page renders defaults without one.
  req = new FakeReq('GET', CONFIG);
  res = new FakeRes();
  await routeFor(CONFIG)(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().config.modes, ['standard', 'ptc', 'minimal', 'cordis']);

  // A cross-origin write is refused; the app's own page is allowed.
  req = new FakeReq('PUT', CONFIG, { defaultMode: 'ptc' }, { origin: 'http://evil.example', host: '127.0.0.1:18999' });
  res = new FakeRes();
  await routeFor(CONFIG)(req, res);
  assert.equal(res.statusCode, 403, 'a foreign origin must not change defaults');

  req = new FakeReq('PUT', CONFIG, { defaultMode: 'cordis', defaultPermission: 'read-only' }, {
    origin: 'http://127.0.0.1:18999',
  });
  res = new FakeRes();
  await routeFor(CONFIG)(req, res);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().config.defaultMode, 'cordis');
  assert.equal(res.json().config.defaultPermission, 'read-only');
  assert.ok(fs.existsSync(overridesPath()), 'settings must persist to the plugin data directory');

  // The saved values apply to the next status read and to the next run.
  req = new FakeReq('GET', STATUS);
  res = new FakeRes();
  await routeFor(STATUS)(req, res);
  assert.equal(res.json().config.defaultMode, 'cordis', 'saved defaults reach the status payload');

  // An unknown key is an error, never a silent no-op.
  req = new FakeReq('PUT', CONFIG, { defaultmode: 'ptc' }, { origin: 'http://127.0.0.1:18999', host: '127.0.0.1:18999' });
  res = new FakeRes();
  await routeFor(CONFIG)(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /unknown config key/);

  // An invalid value keeps the old default instead of blanking it.
  req = new FakeReq('PUT', CONFIG, { defaultMode: 'magic' }, { origin: 'http://127.0.0.1:18999', host: '127.0.0.1:18999' });
  res = new FakeRes();
  await routeFor(CONFIG)(req, res);
  assert.equal(res.statusCode, 400);

  // reset:true drops the override file and re-reads the profile config.
  req = new FakeReq('PUT', CONFIG, { reset: true }, { origin: 'http://127.0.0.1:18999', host: '127.0.0.1:18999' });
  res = new FakeRes();
  await routeFor(CONFIG)(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(fs.existsSync(overridesPath()), false);
  assert.equal(res.json().config.defaultMode, 'standard', 'reset restores the patch value');

  // A bearer token also works for scripted setup.
  req = new FakeReq('PUT', CONFIG, { heartbeatMs: 3000 }, auth);
  res = new FakeRes();
  await routeFor(CONFIG)(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().config.heartbeatMs, 3000);
  fs.rmSync(overridesPath(), { force: true });

  /* ------------------------------------------------------------ event stream */
  req = new FakeReq('GET', `${EVENTS}?runId=${run.runId}&since=0`);
  req.headers = auth;
  res = new FakeRes();
  await routeFor(EVENTS)(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'].includes('application/x-ndjson'), true);
  assert.ok(res.frames().some((f) => f.type === 'session'), 'opening snapshot includes session');

  host.emitSession({ type: 'turn/start', data: { turn: 1 } });
  host.emitSession({ type: 'step/start', data: { turn: 1, step: 1 } });
  host.emitSession({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'PONG' }] } },
  });
  host.emitSession({
    type: 'llm/retry',
    data: { retry: 1, delayMs: 30000, failure: { code: 'RATE_LIMIT' } },
  });
  host.emitSession({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

  const frames = res.frames();
  assert.ok(frames.some((f) => f.type === 'text' && f.text === 'PONG'));
  assert.ok(frames.some((f) => f.phase === 'retry' && f.code === 'RATE_LIMIT'));
  const final = frames.find((f) => f.type === 'final');
  assert.ok(final, 'turn/end emits a final frame');
  assert.equal(final.text, 'PONG');
  assert.equal(final.metrics.retries, 1);
  assert.equal(res.ended, true, 'stream closes after final');
  const sampleRun = {
    runId: 'x', config: defaults, startedAt: Date.now(), lastEventAt: Date.now(),
    steps: 0, toolCalls: 0, retries: 0, text: 'SECRET TASK', seq: 1, state: 'completed', phase: 'done',
  };
  assert.equal(publicRun(sampleRun).runId, 'x');
  assert.equal(JSON.stringify(publicRun(sampleRun)).includes('SECRET'), false, 'publicRun must not leak task text');

  // `snapshot=1` replays and closes immediately even while a run is live.
  req = new FakeReq('GET', `${EVENTS}?runId=${secondRun.runId}&since=0&snapshot=1`);
  req.headers = auth;
  res = new FakeRes();
  await routeFor(EVENTS)(req, res);
  assert.equal(res.ended, true, 'snapshot must not wait for a live run');
  assert.ok(res.frames().some((f) => f.type === 'session'));

  // Stop routes through the Remote cancel method and closes the run.
  req = new FakeReq('POST', RUNS, { action: 'stop', runId: secondRun.runId }, auth);
  res = new FakeRes();
  await routeFor(RUNS)(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(host.calls.cancel, { sessionId: 'session-test-2' });
  assert.equal(res.json().run.state, 'stopped');

  // Authenticated status now lists runs.
  req = new FakeReq('GET', STATUS);
  req.headers = auth;
  res = new FakeRes();
  await routeFor(STATUS)(req, res);
  assert.equal(res.json().authenticated, true);
  assert.ok(res.json().runs.length >= 2);

  /* --------------------------------------------------- lifecycle forensics */
  const life = await import(pathToFileURL(path.resolve(__dirname, '..', 'lifecycle.js')).href);
  const now = 1_700_000_000_000;
  const interval = 20_000;

  assert.equal(
    life.classifyPreviousExit(
      { at: now - 1000 },
      [{ at: now - 900, kind: 'before-quit', trigger: 'at DesktopTray' }, { at: now - 800, kind: 'quit', code: 0 }],
      now,
      interval,
    ).verdict,
    'clean',
  );
  assert.equal(life.classifyPreviousExit({ at: now - 5000 }, [], now, interval).verdict, 'killed');
  assert.equal(
    life.classifyPreviousExit({ at: now - 5000 }, [{ at: now - 4000, kind: 'uncaught', message: 'boom' }], now, interval).verdict,
    'crashed',
  );
  assert.equal(life.classifyPreviousExit({ at: now - 3_600_000 }, [], now, interval).verdict, 'unknown');
  assert.equal(life.classifyPreviousExit(undefined, [], now, interval).verdict, 'unknown');

  // Rotation and tolerant tail reads.
  const logPath = life.lifecyclePath();
  fs.writeFileSync(logPath, 'x'.repeat(1000));
  life.appendLifecycle({ kind: 'start' }, 500);
  assert.ok(fs.existsSync(`${logPath}.1`), 'oversized log must rotate');
  fs.appendFileSync(logPath, '{"kind":"partial"');
  assert.ok(Array.isArray(life.readLifecycle(10)), 'a truncated last line must not throw');

  // The probe installs once and leaves a heartbeat behind.
  const firstProbe = life.installLifecycleProbe({ heartbeatMs: 1000 });
  const secondProbe = life.installLifecycleProbe({ heartbeatMs: 1000 });
  assert.equal(typeof firstProbe.verdict, 'string');
  assert.equal(secondProbe.verdict, firstProbe.verdict, 'probe must be idempotent');
  assert.ok(fs.existsSync(life.heartbeatPath()), 'heartbeat file must exist');
  const beat = JSON.parse(fs.readFileSync(life.heartbeatPath(), 'utf8'));
  assert.equal(beat.pid, process.pid);
  assert.equal(typeof beat.rss, 'number');

  // And the status route reports the previous exit.
  req = new FakeReq('GET', STATUS);
  req.headers = auth;
  res = new FakeRes();
  await routeFor(STATUS)(req, res);
  assert.equal(typeof res.json().lastExit, 'object');

  /* ------------------------------------------- HMR reload (the 401 regression) */
  // Reloading in the same process must not throw "duplicate route", must
  // replace the handlers, and must keep the token already on disk. A stale
  // closure must authenticate against the new state.
  const tokenBefore = JSON.parse(fs.readFileSync(bridgeFilePath(), 'utf8')).token;
  const staleStatus = host.routes.find((route) => route.path === STATUS).handler;
  const reloaded = fakeHost({ webServer: host.webServer });
  apply(reloaded.ctx, {});
  assert.equal(reloaded.routes.length, 4, 'reload must replace routes, not duplicate them');
  const tokenAfter = JSON.parse(fs.readFileSync(bridgeFilePath(), 'utf8')).token;
  assert.equal(tokenAfter, tokenBefore, 'a same-process reload must reuse the token');

  req = new FakeReq('GET', STATUS);
  req.headers = { authorization: `Bearer ${tokenAfter}` };
  res = new FakeRes();
  await staleStatus(req, res);
  assert.equal(res.json().authenticated, true, 'a stale route must read the live state');

  /* -------------------------------------------------------------- teardown */
  host.ctx.dispose();
  assert.equal(fs.existsSync(bridgeFilePath()), false, 'bridge file removed on dispose');
  fs.rmSync(HOME, { recursive: true, force: true });

  console.log('OK: dsh-exec offline assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
