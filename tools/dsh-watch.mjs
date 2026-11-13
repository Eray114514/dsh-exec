#!/usr/bin/env node
/*
 * dsh-watch — external process watchdog, independent of DSH.
 *
 * The in-process lifecycle probe (lifecycle.js) needs a host restart to load.
 * This script starts recording immediately: it samples every DSH process and
 * appends pid/RSS snapshots, so a disappearance leaves a timestamp and a memory
 * curve behind. It cannot name the killer (Windows never tells the victim), but
 * it separates "main process died" from "only a renderer died" and shows
 * whether the process was already huge.
 *
 *   node bin/dsh-watch.mjs            run in the foreground
 *   node bin/dsh-watch.mjs --status   print the tail
 *   node bin/dsh-watch.mjs --stop     stop the background instance
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const IMAGE = 'DeepSeek Harness.exe';
const SAMPLE_MS = 5_000;
const HEARTBEAT_MS = 60_000;
const MAX_BYTES = 1024 * 1024;

const home = process.env.DSH_HOME && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : path.join(homedir(), '.dsh');
const dir = path.join(home, 'storages');
const logPath = path.join(dir, 'dsh-watch.jsonl');
const pidPath = path.join(dir, 'dsh-watch.pid');

function ensureDir() {
  mkdirSync(dir, { recursive: true });
}

function append(record) {
  ensureDir();
  try {
    if (existsSync(logPath) && statSync(logPath).size > MAX_BYTES) renameSync(logPath, `${logPath}.1`);
  } catch {
    /* rotation is best effort */
  }
  try {
    appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch {
    /* keep watching even if the disk hiccups */
  }
}

function readTail(limit = 20) {
  if (!existsSync(logPath)) return [];
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Snapshot every DSH process: pid, RSS bytes, session (Console) column. */
function sample() {
  let out;
  try {
    out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${IMAGE}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch {
    return [];
  }
  const rows = [];
  for (const line of out.split('\n')) {
    const cells = line.trim().match(/"([^"]*)"/g)?.map((cell) => cell.slice(1, -1));
    if (!cells || cells.length < 5) continue;
    const pid = Number(cells[1]);
    const rssKb = Number(cells[4].replace(/[^0-9]/g, ''));
    if (!Number.isFinite(pid) || pid <= 0) continue;
    rows.push({ pid, rss: Number.isFinite(rssKb) ? rssKb * 1024 : null });
  }
  rows.sort((a, b) => a.pid - b.pid);
  return rows;
}

const signature = (rows) => rows.map((row) => row.pid).join(',');

function run() {
  ensureDir();
  writeFileSync(pidPath, `${process.pid}\n`);
  append({
    at: Date.now(),
    kind: 'watch-start',
    watcherPid: process.pid,
    image: IMAGE,
    sampleMs: SAMPLE_MS,
  });

  let previous = [];
  let previousSignature = '';
  let lastHeartbeat = 0;

  const tick = () => {
    const rows = sample();
    const now = Date.now();
    const sig = signature(rows);

    if (sig !== previousSignature) {
      const before = new Set(previous.map((row) => row.pid));
      const after = new Set(rows.map((row) => row.pid));
      const appeared = rows.filter((row) => !before.has(row.pid)).map((row) => row.pid);
      const vanished = previous.filter((row) => !after.has(row.pid)).map((row) => row.pid);
      append({
        at: now,
        kind: rows.length === 0 ? 'vanished' : appeared.length > 0 && vanished.length === 0 ? 'started' : 'changed',
        pids: rows.map((row) => ({ pid: row.pid, rss: row.rss })),
        appeared,
        vanished,
        previous: previous.map((row) => ({ pid: row.pid, rss: row.rss })),
        totalRss: rows.reduce((sum, row) => sum + (row.rss ?? 0), 0),
      });
      previous = rows;
      previousSignature = sig;
      lastHeartbeat = now;
      return;
    }

    if (rows.length > 0 && now - lastHeartbeat >= HEARTBEAT_MS) {
      lastHeartbeat = now;
      append({
        at: now,
        kind: 'heartbeat',
        count: rows.length,
        pids: rows.map((row) => ({ pid: row.pid, rss: row.rss })),
        totalRss: rows.reduce((sum, row) => sum + (row.rss ?? 0), 0),
      });
    }
  };

  tick();
  // Deliberately NOT unref'd: this script has no other handles, so an unref'd
  // timer would let the event loop drain and the watcher would exit at once.
  setInterval(tick, SAMPLE_MS);

  const stop = (signal) => {
    append({ at: Date.now(), kind: 'watch-stop', signal });
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

const args = process.argv.slice(2);
if (args.includes('--status')) {
  const tail = readTail(20);
  for (const record of tail) {
    const stamp = new Date(record.at).toISOString().slice(11, 19);
    if (record.kind === 'heartbeat') {
      console.log(`${stamp}  heartbeat  ${record.count} procs, ${(record.totalRss / 1048576).toFixed(0)} MB`);
    } else if (record.kind === 'watch-start') {
      console.log(`${stamp}  watcher    pid ${record.watcherPid}, every ${record.sampleMs / 1000}s`);
    } else if (record.kind === 'watch-stop') {
      console.log(`${stamp}  watcher    stopped (${record.signal ?? 'exit'})`);
    } else if (record.kind === 'started') {
      console.log(`${stamp}  started    pids ${record.pids.map((p) => p.pid).join(',')}`);
    } else if (record.kind === 'vanished') {
      const mb = (record.previous.reduce((s, p) => s + (p.rss ?? 0), 0) / 1048576).toFixed(0);
      console.log(`${stamp}  VANISHED   all DSH processes gone (last total ${mb} MB)`);
    } else {
      console.log(`${stamp}  ${record.kind.padEnd(10)} ${JSON.stringify(record.vanished ?? record.pids ?? '').slice(0, 100)}`);
    }
  }
  if (tail.length === 0) console.log('no records yet');
} else if (args.includes('--stop')) {
  if (!existsSync(pidPath)) {
    console.log('no watcher pid file');
  } else {
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    try {
      process.kill(pid);
      console.log(`stopped watcher ${pid}`);
    } catch (error) {
      console.log(`watcher ${pid} is not running (${error.code ?? error.message})`);
    }
  }
} else {
  run();
}
