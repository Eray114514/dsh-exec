# dsh-exec

[中文](README.md) | English

**Run DeepSeek Harness from a shell, a script or CI — and watch the session appear live in the desktop sidebar.**

```sh
dshx "Fix every lint error in this repo"
dshx --cwd D:/repo --mode ptc "Investigate the scroll flicker" > answer.txt
dshx --json "Run the test suite" | jq -r 'select(.type=="final") | .text'
```

The shape is `codex exec`, except the work runs in **your own desktop host**: your configured models, plugins, skills and permission policy, with the answer on stdout *and* the conversation left in the GUI.

## Why not `dsh --profile headless`

A headless profile writes a perfectly valid session file, but the sidebar does not scan that directory. It reads `ctx.workspaceRegistry`, whose index lives in memory, and only the process that **created** the session attaches it to a workspace. An external process editing `workspace.json` is overwritten by the desktop's in-memory copy.

So this plugin registers its control surface inside the desktop host and creates every session through `sessionController.create({ workspaceId, agentPreset })`: the workspace row is upserted, the session is attached in-process, and the UI follows its events from the first token.

The cost, stated plainly: **the desktop app must be running.** When it is not, `dshx` reports that the bridge file is missing instead of silently falling back to headless.

## Install

```sh
dsh plugin --profile desktop add dsh-exec
```

A plugin with a client half must be followed by a **full app restart** after install or update (HMR saying `applied` does not mean the next boot can load it).

Settings gains a "Command line" page. Both `dsh-exec` and `dshx` are installed as the same script.

> Naming note: the package `@why913/dshx` also claims the `dshx` command (MCP/skill management — unrelated feature). If both are installed globally, use the `dsh-exec` entry point to avoid the collision.

## CLI

| Command | Effect |
|---|---|
| `dshx "TASK"` | create a session, run the task, print the final answer to stdout |
| `dshx --cwd DIR "TASK"` | pin the working directory (decides the sidebar group) |
| `dshx --session ID "TASK"` | continue an existing session |
| `dshx --mode standard\|ptc\|minimal\|cordis "TASK"` | choose the agent preset |
| `dshx --model M --provider P --effort E "TASK"` | override the model for this run only |
| `dshx --permission P --approval A "TASK"` | override permission / approval for this run only |
| `dshx --task-file PATH` | read the task from a UTF-8 file (`-` = stdin); **required for multi-line prompts on Windows** |
| `dshx --json "TASK"` | NDJSON event stream on stdout (`codex exec --json` style) |
| `dshx --verbose "TASK"` | live execution trace on stderr (opt-in) |
| `dshx --log RUN_ID` | replay a run's buffered execution records (metadata only) |
| `dshx --status` / `--runs` / `--stop RUN_ID` | bridge state / run list / cancel |

**Default output is only the final answer**, stderr stays silent, so `dshx "TASK" > answer.txt` is clean. Execution records are strictly opt-in. Exit code 0 on a completed turn, 1 otherwise.

### Multi-line tasks on Windows

`cmd.exe` ends a command line at the first newline — a 7000-character prompt arrives as its first paragraph. That is a shell limit, not a plugin one:

```powershell
$path = Join-Path $env:TEMP 'task.txt'
[System.IO.File]::WriteAllText($path, $task, [System.Text.UTF8Encoding]::new($false))
dshx --cwd 'D:/repo' --task-file $path
```

## The four presets

The host ships four Agent presets — four plugin manifests, really. All of them are selectable here (`--mode` or the settings page):

| Mode | What it is | Good for |
|---|---|---|
| `standard` | Full coding agent: file editing, shell, search, skills, planning, subagents | Most work (default) |
| `ptc` | Standard plus the Code Mode SDK: the model writes one TypeScript program that dispatches many tool calls, turning five round-trips into one | Wide multi-step tasks |
| `minimal` | Persistent bash and an editor only, fixed prompt, no compaction, no subagents | Benchmarks and control runs |
| `cordis` | Standard plus the `cordis_*` self-inspection tools: it can inspect, mount and replace plugins in its own running tree | Writing plugins and custom presets |

The picker hides `ptc` and `minimal` behind the "code work tools" switch; the preset ids themselves are valid, so `--mode` reaches them directly.

**This is the most substantial difference from the official one-shot headless entry.** `dsh --profile headless "TASK"` runs `@deepseek-ai/dsh-headless` (a bundle that drives core Agent/Session directly, with no Host layer), and its composition has **no `agent-preset-registry`** — check it yourself:

```sh
dsh --profile headless --dump-config | grep preset   # permission-presets only
dsh --profile web      --dump-config | grep preset   # agent-preset-registry lives here
```

Presets exist only in the web/desktop composition. `dsh-exec` creates sessions inside the desktop process through `sessionController.create({ agentPreset })`, which is exactly how it borrows all four presets for the command line: same `dshx`, different `--mode`, a different agent.

## Compared with the other headless CLIs

| | `codex exec` | `claude -p` | `dsh --profile headless` | `dshx` |
|---|---|---|---|---|
| One command, final answer on stdout | yes | yes | yes | yes |
| Session stays in **the same** GUI, click through and continue | its own CLI session, not in DSH | its own CLI session, not in DSH | no — invisible in the sidebar | yes — live in the sidebar |
| Agent preset selectable | one fixed set | one fixed set | no — no preset registry in the composition | four: standard / ptc / minimal / cordis |
| Reuses the models, plugins, skills and permission policy already configured here | no | no | yes | yes |
| Streaming events for a program to consume | own JSON format | own stream-json | — | `--json` (NDJSON) |
| Heartbeat while a long turn goes quiet | — | — | — | `progress{alive:true}` |

"—" means the tool has no such concept, not that it is worse: `codex exec` and `claude -p` each have a mature session model of their own, it just is not DSH's. The last row is about providers that throttle for minutes (Gemini): whether five silent minutes mean "waiting" or "dead" is a question only a heartbeat can answer.

## Shipped defaults are neutral

This package lands on **other people's machines**, so the factory defaults do not encode the author's setup:

- **No model is pinned** (`defaultModel: ''`). Empty means "keep whatever the desktop would have used". A new session is pinned through `selectModel` only when you configure a model *and* turn on `enforceDefaults` — hard-coding a model that a machine does not have would fail every single run.
- **`workspace-write` + `never`**: enough to do real work, and it never blocks an unattended run on an approval prompt it has no UI to answer. `danger-full-access` is a **per-run choice** (`--permission danger-full-access`), not the default.
- Without `--model` / `--effort` nothing is sent at all, so no hidden default can override the host.

To change the defaults on your machine, open the settings page and save — you don't *have* to edit YAML. Values go to `<DSH_HOME>/plugin-data/dsh-exec/config.json`, layered over the profile's `cordis.patch.yml` ("Restore config defaults" deletes that file). Editing the YAML directly still works; that layer just sits below the settings file.

## Settings page

`Settings → Command line` (Chinese and English, follows the UI language):

- default mode (all four presets), default model / provider / reasoning effort
- whether new sessions are pinned to that model
- permission policy, approval policy, auto-create workspace
- heartbeat interval, concurrency limit
- save / restore config defaults

The same page shows bridge state: online, running, total runs, 429 retries, pid and port.

## HTTP API

Loopback only. Everything needs `Authorization: Bearer <token>` unless noted; the token sits in `<DSH_HOME>/storages/dsh-exec.json` (mode 0600) and never reaches the renderer.

| Route | Method | Purpose |
|---|---|---|
| `/dsh-exec/status.json` | GET | bridge state, counts, effective config (no token, no run details) |
| `/dsh-exec/runs.json` | GET | list runs |
| `/dsh-exec/runs.json` | POST | `{task, cwd?, sessionId?, mode?, model?, provider?, effort?, permission?, approval?}` → 202 + run |
| `/dsh-exec/runs.json` | POST | `{action:"stop", runId}` → cancel |
| `/dsh-exec/events.jsonl?runId=…&since=N` | GET | NDJSON stream, replayable from `since`; `snapshot=1` replays and closes |
| `/dsh-exec/config.json` | GET | effective config (no token) |
| `/dsh-exec/config.json` | PUT | save defaults; same-origin or bearer token required |

Responses never include the task text or the token.

## 429 is not a crash

Gemini throttles `gemini-4-*` aggressively. A `429 RESOURCE_EXHAUSTED` ends only that attempt: the retry layer waits 30–300 s and re-runs the same step inside the open turn. During the wait the session log barely moves, and that silence is easily misread as a dead worker.

So the bridge emits a `progress` frame every `heartbeatMs` (default 15 s) with `elapsedMs`, `silentMs`, `steps`, `retries` and `alive: true`, plus a `retry` frame carrying the provider code. `dshx` prints an explicit "normal for Gemini, turn still running" line. **Judge liveness by the heartbeat, never by a quiet log.**

## Exit forensics: who closed DSH?

The host writes two files under `<DSH_HOME>/storages/`:

| File | Behaviour |
|---|---|
| `dsh-exec-heartbeat.json` | overwritten every `lifecycle.heartbeatMs` (20 s): pid, ppid, uptime, RSS, heap, active runs |
| `dsh-exec-lifecycle.jsonl` | append-only key events, rotated at `lifecycle.maxLogBytes` (512 KB) |

Recorded events: `start`, `before-quit` (**with the caller's stack**), `window-close`, `window-all-closed`, `will-quit`, `quit`, `exit`, `signal`, `uncaught`, `unhandled-rejection`, `os-shutdown` / `os-suspend` / `os-resume`.

The next boot classifies the previous process:

| Verdict | Evidence | Meaning |
|---|---|---|
| `clean` | `before-quit` → `quit`/`exit` after the last heartbeat | normal quit; the stack names the caller (tray menu, updater, menu item) |
| `killed` | fresh heartbeat, **no** exit event | `TerminateProcess` (task manager / cleaner), hard crash, or power loss |
| `crashed` | an `uncaught` record | uncaught exception in the host |
| `unknown` | heartbeat much older than the next boot | machine slept or shut down, or heartbeats stopped |

Read it with `dshx --status` (`lastExit`). `TerminateProcess` cannot name the killer — Windows never tells the victim — but it does prove the app did not quit through its own menu, which is usually the distinction that matters.

## Known limits

- **Desktop profile only.** `sessionController` / `workspaceRegistry` / `webServer` / `agents` are not documented plugin APIs; the web, headless and acp profiles do not compose them, and the plugin then stays quietly inactive. They can break across versions, so `engines.dsh` only declares the range this was verified against (`0.2.x`).
- The event stream is in-memory with a bounded buffer (`maxEventBuffer`). Reconnect with `since` before it rolls over.
- `stop` asks the agent to cancel; a step already in flight may finish first.
- The desktop app must be running; there is no headless fallback.

## Development

```sh
node tests/offline.cjs     # fake ctx + fake webServer, no real desktop process
```

Covers: config normalization and layering, request validation, event projection, all four routes, token / loopback / same-origin authorization, workspace + preset + permission wiring, model override only when asked, live NDJSON, `final` on `turn/end`, token-free status redaction, bridge-file cleanup, and token reuse across an HMR reload.

## License

MIT
