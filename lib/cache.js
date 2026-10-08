// lib/cache.js — tiny on-disk TTL cache: $SKILL_SCOUT_HOME/cache/<sha256(key)>.json = {ts, value}
//
//   cacheGet(key, ttlHours, env?) -> value | null   (null when missing, expired, or unreadable)
//   cacheSet(key, value, env?)                (atomic: write tmp + rename; never throws)
//   cacheDir(env?)          -> absolute dir
//   cacheStats()            -> {dir, entries, bytes, oldestTs, newestTs}
//   cacheClear()            -> number of files removed
//
// Synchronous on purpose: the per-prompt hook is a short-lived process and the
// registry awaits these calls, so sync values work for both callers.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { homeDir } from './config.js';

export function cacheDir(env = process.env) {
  return path.join(homeDir(env), 'cache');
}

export function cacheFile(key, env = process.env) {
  return path.join(cacheDir(env), `${createHash('sha256').update(String(key)).digest('hex')}.json`);
}

export function cacheGet(key, ttlHours, env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(key, env), 'utf8'));
    if (!raw || typeof raw !== 'object' || typeof raw.ts !== 'number') return null;
    const ttlMs = Math.max(0, Number(ttlHours) || 0) * 3600 * 1000;
    if (Date.now() - raw.ts > ttlMs) return null;
    return raw.value === undefined ? null : raw.value;
  } catch {
    return null;
  }
}

export function cacheSet(key, value, env = process.env) {
  try {
    const file = cacheFile(key, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ts: Date.now(), value }));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function cacheStats(env = process.env) {
  const dir = cacheDir(env);
  const out = { dir, entries: 0, bytes: 0, oldestTs: null, newestTs: null };
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      out.entries++;
      out.bytes += st.size;
      const ts = st.mtimeMs;
      if (out.oldestTs === null || ts < out.oldestTs) out.oldestTs = ts;
      if (out.newestTs === null || ts > out.newestTs) out.newestTs = ts;
    } catch {
      /* skip */
    }
  }
  return out;
}

export function cacheClear(env = process.env) {
  const dir = cacheDir(env);
  let n = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
        n++;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no dir */
  }
  return n;
}
