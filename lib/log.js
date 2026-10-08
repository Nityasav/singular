// lib/log.js — JSON-lines logging for skill-scout. Never writes to stdout
// (stdout of a hook is the hook's output) and never throws.
//
//   log(level, msg, extra?)  -> appends {ts, level, msg, ...extra} to $SKILL_SCOUT_HOME/scout.log
//   timer()                  -> { elapsed(): ms }
//   logPath(env?)            -> absolute path of the log file

import fs from 'node:fs';
import path from 'node:path';

import { defaultHomeDir, redirectedHome } from './config.js';

export const LOG_FILE = 'scout.log';
const MAX_LOG_BYTES = 2 * 1024 * 1024; // rotate to scout.log.1 past this

/** Same directory rule as lib/config.js homeDir(): SKILL_SCOUT_HOME only when absolute, else ~/.claude/skill-scout. */
export function logPath(env = process.env) {
  return path.join(redirectedHome(env) ?? defaultHomeDir(env), LOG_FILE);
}

function safeExtra(extra) {
  if (!extra || typeof extra !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'ts' || k === 'level' || k === 'msg') continue;
    if (v instanceof Error) out[k] = { message: v.message, name: v.name };
    else out[k] = v;
  }
  return out;
}

/**
 * Append one JSON line to the log. `level` is free-form ("debug" | "info" | "warn" | "error").
 * Failures (unwritable dir, disk full, cyclic extra) are swallowed.
 */
export function log(level, msg, extra) {
  try {
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no file yet */
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      level: String(level ?? 'info'),
      msg: String(msg ?? ''),
      ...safeExtra(extra),
    });
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    /* never throw from logging */
  }
}

/** Monotonic stopwatch. */
export function timer() {
  const start = process.hrtime.bigint();
  return {
    elapsed() {
      return Number(process.hrtime.bigint() - start) / 1e6;
    },
  };
}
