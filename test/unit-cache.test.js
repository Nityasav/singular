// test/unit-cache.test.js — node --test test/unit-cache.test.js
// Exhaustive unit tests for lib/cache.js: key hashing, TTL arithmetic, corrupt files, atomic writes,
// stats and clear. No network. Every path is under a throwaway SINGULAR_HOME; the real ~/.claude is
// never read or written (a relative SINGULAR_HOME is only exercised with HOME redirected too).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRATCH_ROOT = process.env.SINGULAR_TEST_TMP
  || '/private/tmp/claude-501/-Users-nitya--superset-projects-claude-skills/cfa575e5-ae3c-4522-b59f-cd3623c88bf0/scratchpad';

function mkTmp(label) {
  let base = SCRATCH_ROOT;
  try { fs.mkdirSync(base, { recursive: true }); } catch { base = os.tmpdir(); }
  return fs.mkdtempSync(path.join(base, `unit-cache-${label}-`));
}

// Throwaway state dir BEFORE the first import (lib/cache.js imports lib/config.js, which reads env lazily,
// but the default-env tests below rely on process.env.SINGULAR_HOME being set).
// The account's real home, captured BEFORE process.env.HOME is redirected: on POSIX os.homedir() follows $HOME, so
// the isolation assertion at the end must not consult it after the redirect.
const REAL_HOME = (() => { try { return os.userInfo().homedir || os.homedir(); } catch { return os.homedir(); } })();
const ROOT = mkTmp('state');
const FAKE_HOME = path.join(ROOT, 'fakehome');
fs.mkdirSync(FAKE_HOME, { recursive: true });
process.env.SINGULAR_HOME = path.join(ROOT, 'singular-home');
process.env.HOME = FAKE_HOME;

const { cacheGet, cacheSet, cacheFile, cacheStats, cacheClear, cacheDir } = await import('../lib/cache.js');

after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

let n = 0;
/** A fresh env whose SINGULAR_HOME is an unused absolute dir (not created yet). */
function freshEnv(label = 'h') {
  n++;
  return { SINGULAR_HOME: path.join(ROOT, `${label}-${n}`), HOME: FAKE_HOME };
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const listTmp = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')) : []);

// ---------------------------------------------------------------------------

describe('cacheDir / cacheFile', () => {
  test('cacheDir is <home>/cache and cacheFile is <dir>/<sha256(key)>.json; the key is coerced to a string', () => {
    const env = freshEnv();
    assert.equal(cacheDir(env), path.join(env.SINGULAR_HOME, 'cache'));
    assert.equal(cacheFile('search:react', env), path.join(cacheDir(env), `${sha256('search:react')}.json`));
    assert.equal(cacheFile(123, env), cacheFile('123', env), 'numbers hash like their string form');
    assert.equal(cacheFile(null, env), cacheFile('null', env));
    assert.equal(cacheFile(undefined, env), cacheFile('undefined', env));
    assert.equal(cacheFile({ a: 1 }, env), cacheFile('[object Object]', env));
  });

  test('hostile keys never escape the cache directory and never collide with each other', () => {
    const env = freshEnv();
    const dir = cacheDir(env);
    const keys = ['../../etc/passwd', '/abs/path', 'a/b/c', '..', '.', '', 'x'.repeat(20000), 'ünïcødé ✓', 'k\0null', 'k\nnl', 'catalog:anthropics', 'catalog:Anthropics'];
    const files = new Set();
    for (const k of keys) {
      const f = cacheFile(k, env);
      assert.equal(path.dirname(f), dir, `key ${JSON.stringify(k.slice(0, 30))} stays inside the dir`);
      assert.match(path.basename(f), /^[0-9a-f]{64}\.json$/);
      files.add(f);
    }
    assert.equal(files.size, keys.length, 'distinct keys map to distinct files (case-sensitive)');
    assert.ok(!fs.existsSync(dir), 'cacheFile is pure: nothing is created');
  });

  test('default env is process.env; a relative SINGULAR_HOME is ignored in favour of $HOME/.claude/singular', () => {
    assert.equal(cacheDir(), path.join(process.env.SINGULAR_HOME, 'cache'));
    assert.equal(cacheFile('k'), path.join(process.env.SINGULAR_HOME, 'cache', `${sha256('k')}.json`));
    const rel = { SINGULAR_HOME: 'relative/dir', HOME: FAKE_HOME };
    assert.equal(cacheDir(rel), path.join(FAKE_HOME, '.claude', 'singular', 'cache'));
    const blank = { SINGULAR_HOME: '   ', HOME: FAKE_HOME };
    assert.equal(cacheDir(blank), path.join(FAKE_HOME, '.claude', 'singular', 'cache'));
  });
});

// ---------------------------------------------------------------------------

describe('cacheSet / cacheGet round trip', () => {
  test('stores {ts, value} as JSON, creates the directory, returns true, and reads every JSON value type back', () => {
    const env = freshEnv();
    const values = { obj: { a: [1, 2, { b: 'c' }] }, arr: [1, 'two', null], str: 'text', zero: 0, neg: -1.5, bool: false, empty: '', emptyObj: {} };
    for (const [k, v] of Object.entries(values)) assert.equal(cacheSet(k, v, env), true, k);
    assert.ok(fs.existsSync(cacheDir(env)), 'directory created on first set');
    for (const [k, v] of Object.entries(values)) assert.deepEqual(cacheGet(k, 1, env), v, k);
    const raw = JSON.parse(fs.readFileSync(cacheFile('obj', env), 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), ['ts', 'value']);
    assert.equal(typeof raw.ts, 'number');
    assert.ok(Math.abs(Date.now() - raw.ts) < 5000, 'ts is wall-clock ms');
    assert.deepEqual(raw.value, values.obj);
  });

  test('a stored null and a stored undefined both read back as null (indistinguishable from a miss)', () => {
    const env = freshEnv();
    assert.equal(cacheSet('nil', null, env), true);
    assert.equal(cacheGet('nil', 1, env), null);
    assert.equal(cacheSet('undef', undefined, env), true);
    assert.equal(cacheGet('undef', 1, env), null);
    assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile('undef', env), 'utf8')).value, undefined, 'JSON drops undefined');
  });

  test('overwriting a key replaces the value and leaves exactly one file (no temp residue)', () => {
    const env = freshEnv();
    for (let i = 0; i < 25; i++) assert.equal(cacheSet('k', { i }, env), true);
    assert.deepEqual(cacheGet('k', 1, env), { i: 24 });
    assert.deepEqual(fs.readdirSync(cacheDir(env)), [path.basename(cacheFile('k', env))]);
    assert.deepEqual(listTmp(cacheDir(env)), []);
  });

  test('a miss is null: missing key, missing directory, key coerced forms share one entry', () => {
    const env = freshEnv();
    assert.equal(cacheGet('nothing', 24, env), null, 'no directory yet');
    cacheSet(42, 'answer', env);
    assert.equal(cacheGet('42', 24, env), 'answer');
    assert.equal(cacheGet(42, 24, env), 'answer');
    assert.equal(cacheGet('43', 24, env), null);
  });
});

// ---------------------------------------------------------------------------

describe('TTL', () => {
  const writeRaw = (key, env, raw) => {
    fs.mkdirSync(cacheDir(env), { recursive: true });
    fs.writeFileSync(cacheFile(key, env), typeof raw === 'string' ? raw : JSON.stringify(raw));
  };

  test('fresh within ttlHours is a hit; older than ttlHours is a miss; the boundary is strict (age > ttl)', () => {
    const env = freshEnv();
    const h = 3600 * 1000;
    writeRaw('fresh', env, { ts: Date.now() - 0.5 * h, value: 'v' });
    assert.equal(cacheGet('fresh', 1, env), 'v');
    writeRaw('old', env, { ts: Date.now() - 2 * h, value: 'v' });
    assert.equal(cacheGet('old', 1, env), null);
    assert.equal(cacheGet('old', 3, env), 'v', 'same file, longer ttl -> hit');
    writeRaw('exact', env, { ts: Date.now() - 24 * h + 60 * 1000, value: 'v' });
    assert.equal(cacheGet('exact', 24, env), 'v', 'one minute inside a 24 h ttl');
    writeRaw('justover', env, { ts: Date.now() - 24 * h - 60 * 1000, value: 'v' });
    assert.equal(cacheGet('justover', 24, env), null, 'one minute past a 24 h ttl');
  });

  test('ttlHours 0, negative, NaN, undefined or a non-numeric string all mean "expired unless written this very ms"', () => {
    const env = freshEnv();
    writeRaw('k', env, { ts: Date.now() - 1, value: 'v' });
    for (const ttl of [0, -5, NaN, undefined, null, 'abc', '', {}]) assert.equal(cacheGet('k', ttl, env), null, `ttl ${String(ttl)}`);
    assert.equal(cacheGet('k', '1', env), 'v', 'numeric string ttl is honoured');
    assert.equal(cacheGet('k', 0.001, env), 'v', 'fractional hours (3.6 s) still fresh');
  });

  test('a future ts (clock skew) is treated as fresh, never as an error', () => {
    const env = freshEnv();
    writeRaw('future', env, { ts: Date.now() + 10 * 3600 * 1000, value: 'v' });
    assert.equal(cacheGet('future', 0, env), 'v');
  });

  test('a huge ttl never overflows into a miss', () => {
    const env = freshEnv();
    const nineteenYears = 19 * 365 * 24 * 3600 * 1000;
    writeRaw('k', env, { ts: Date.now() - nineteenYears, value: 'old' });
    assert.equal(cacheGet('k', 24 * 365 * 20, env), 'old', 'the "forever" text-cache ttl (20 y) covers a 19-year-old entry');
    writeRaw('epoch', env, { ts: 0, value: 'epoch' });
    assert.equal(cacheGet('epoch', 24 * 365 * 20, env), null, 'but not the epoch (56 y): the ttl is real arithmetic, not a sentinel');
    assert.equal(cacheGet('epoch', Number.MAX_SAFE_INTEGER, env), 'epoch', 'a huge ttl never overflows into a miss');
  });
});

// ---------------------------------------------------------------------------

describe('corrupt or unexpected files', () => {
  const writeRaw = (key, env, text) => {
    fs.mkdirSync(cacheDir(env), { recursive: true });
    fs.writeFileSync(cacheFile(key, env), text);
  };

  test('every malformed shape reads as null and never throws', () => {
    const env = freshEnv();
    const cases = {
      garbage: 'not json at all',
      truncated: '{"ts": 123, "value": {"a": ',
      empty: '',
      nul: '\0\0\0',
      jsonNull: 'null',
      jsonString: '"a string"',
      jsonNumber: '42',
      jsonTrue: 'true',
      jsonArray: '[1,2,3]',
      noTs: JSON.stringify({ value: 'v' }),
      tsString: JSON.stringify({ ts: String(Date.now()), value: 'v' }),
      tsNull: JSON.stringify({ ts: null, value: 'v' }),
      tsNaNString: JSON.stringify({ ts: 'NaN', value: 'v' }),
      noValue: JSON.stringify({ ts: Date.now() }),
      valueNull: JSON.stringify({ ts: Date.now(), value: null }),
      bom: `﻿${JSON.stringify({ ts: Date.now(), value: 'v' })}`,
    };
    for (const [name, text] of Object.entries(cases)) {
      writeRaw(name, env, text);
      assert.equal(cacheGet(name, 24, env), null, name);
    }
    writeRaw('okay', env, JSON.stringify({ ts: Date.now(), value: 'v', extra: 'ignored' }));
    assert.equal(cacheGet('okay', 24, env), 'v', 'extra keys are ignored');
  });

  test('a directory where the entry file should be is a miss (EISDIR), and cacheSet then fails cleanly', () => {
    const env = freshEnv();
    fs.mkdirSync(cacheFile('dir', env), { recursive: true });
    assert.equal(cacheGet('dir', 24, env), null);
    assert.equal(cacheSet('dir', 'v', env), false, 'rename onto a directory fails -> false');
    assert.equal(listTmp(cacheDir(env)).length, 1, 'the temp file is left behind (cacheSet does not clean up after a failed rename; cacheClear removes *.tmp)');
    assert.equal(cacheClear(env), 1);
    assert.deepEqual(listTmp(cacheDir(env)), []);
  });

  test('an unreadable entry (mode 000) is a miss, not an exception', (t) => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) { t.skip('permissions not enforced'); return; }
    const env = freshEnv();
    cacheSet('locked', 'v', env);
    fs.chmodSync(cacheFile('locked', env), 0o000);
    try {
      assert.equal(cacheGet('locked', 24, env), null);
    } finally {
      fs.chmodSync(cacheFile('locked', env), 0o644);
    }
    assert.equal(cacheGet('locked', 24, env), 'v');
  });
});

// ---------------------------------------------------------------------------

describe('atomicity and failure of cacheSet', () => {
  test('writes go through a sibling .tmp file that is renamed into place; a reader never sees a partial file', () => {
    const env = freshEnv();
    const dir = cacheDir(env);
    const big = { payload: 'x'.repeat(512 * 1024) };
    // Interleave sets and gets: every get must be either the previous complete value or the new one.
    let prev = null;
    for (let i = 0; i < 10; i++) {
      assert.equal(cacheSet('big', { ...big, i }, env), true);
      const got = cacheGet('big', 1, env);
      assert.ok(got && (got.i === i || got.i === prev), 'complete value only');
      prev = i;
    }
    assert.deepEqual(listTmp(dir), []);
    const names = fs.readdirSync(dir);
    assert.deepEqual(names, [path.basename(cacheFile('big', env))]);
  });

  test('temp names carry the pid and a random suffix (two processes cannot clobber each other)', () => {
    const env = freshEnv();
    const dir = cacheDir(env);
    fs.mkdirSync(dir, { recursive: true });
    // Observe the temp name by making the final rename fail: the target is a non-empty directory, so the
    // .tmp survives; cacheSet reports false and the temp file is the only new entry.
    fs.mkdirSync(cacheFile('blocked', env));
    fs.writeFileSync(path.join(cacheFile('blocked', env), 'child'), '');
    assert.equal(cacheSet('blocked', 'v', env), false);
    const tmps = listTmp(dir);
    assert.equal(tmps.length, 1);
    assert.match(tmps[0], new RegExp(`^${path.basename(cacheFile('blocked', env)).replace('.', '\\.')}\\.${process.pid}\\.[a-z0-9]{1,6}\\.tmp$`));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, tmps[0]), 'utf8')).value, 'v');
  });

  test('unserialisable values (BigInt, cyclic) return false, leave no temp file and keep the previous entry', () => {
    const env = freshEnv();
    assert.equal(cacheSet('k', 'before', env), true);
    assert.equal(cacheSet('k', 10n, env), false, 'BigInt');
    const cyc = {}; cyc.self = cyc;
    assert.equal(cacheSet('k', cyc, env), false, 'cyclic');
    assert.equal(cacheGet('k', 1, env), 'before');
    assert.deepEqual(listTmp(cacheDir(env)), [], 'JSON.stringify threw before any file was created');
  });

  test('an unwritable home (a regular file in the way) makes cacheSet return false and cacheGet null', () => {
    const env = freshEnv();
    fs.mkdirSync(path.dirname(env.SINGULAR_HOME), { recursive: true });
    fs.writeFileSync(env.SINGULAR_HOME, 'not a directory');
    assert.equal(cacheSet('k', 'v', env), false);
    assert.equal(cacheGet('k', 1, env), null);
    assert.deepEqual(cacheStats(env), { dir: path.join(env.SINGULAR_HOME, 'cache'), entries: 0, bytes: 0, oldestTs: null, newestTs: null });
    assert.equal(cacheClear(env), 0);
  });

  test('a read-only cache directory makes cacheSet return false (the mkdir succeeds, the write does not)', (t) => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) { t.skip('permissions not enforced'); return; }
    const env = freshEnv();
    fs.mkdirSync(cacheDir(env), { recursive: true });
    fs.chmodSync(cacheDir(env), 0o500);
    try {
      assert.equal(cacheSet('k', 'v', env), false);
    } finally {
      fs.chmodSync(cacheDir(env), 0o700);
    }
    assert.equal(cacheGet('k', 1, env), null);
  });
});

// ---------------------------------------------------------------------------

describe('cacheStats', () => {
  test('empty or missing directory -> zero entries, null timestamps', () => {
    const env = freshEnv();
    assert.deepEqual(cacheStats(env), { dir: cacheDir(env), entries: 0, bytes: 0, oldestTs: null, newestTs: null });
    fs.mkdirSync(cacheDir(env), { recursive: true });
    assert.deepEqual(cacheStats(env), { dir: cacheDir(env), entries: 0, bytes: 0, oldestTs: null, newestTs: null });
  });

  test('counts only *.json, sums their bytes and reports oldest/newest mtime; non-json, .tmp and dangling entries are ignored', () => {
    const env = freshEnv();
    const dir = cacheDir(env);
    cacheSet('a', 'aaaa', env);
    cacheSet('b', { long: 'b'.repeat(100) }, env);
    cacheSet('c', 1, env);
    const bytes = ['a', 'b', 'c'].reduce((s, k) => s + fs.statSync(cacheFile(k, env)).size, 0);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(dir, 'leftover.json.123.abc.tmp'), 'x'.repeat(1000));
    fs.symlinkSync(path.join(dir, 'does-not-exist'), path.join(dir, 'dangling.json'));
    const t0 = new Date('2020-01-01T00:00:00Z');
    const t1 = new Date('2021-06-15T12:00:00Z');
    const t2 = new Date('2022-12-31T23:59:59Z');
    fs.utimesSync(cacheFile('a', env), t1, t1);
    fs.utimesSync(cacheFile('b', env), t0, t0);
    fs.utimesSync(cacheFile('c', env), t2, t2);
    const st = cacheStats(env);
    assert.equal(st.dir, dir);
    assert.equal(st.entries, 3);
    assert.equal(st.bytes, bytes);
    assert.equal(Math.round(st.oldestTs), t0.getTime());
    assert.equal(Math.round(st.newestTs), t2.getTime());
  });

  test('a single entry is both oldest and newest', () => {
    const env = freshEnv();
    cacheSet('only', 'v', env);
    const st = cacheStats(env);
    assert.equal(st.entries, 1);
    assert.equal(st.oldestTs, st.newestTs);
    assert.ok(st.bytes > 0);
  });
});

// ---------------------------------------------------------------------------

describe('cacheClear', () => {
  test('removes *.json and *.tmp, keeps everything else, returns the count; missing dir -> 0', () => {
    const env = freshEnv();
    assert.equal(cacheClear(env), 0, 'no directory');
    const dir = cacheDir(env);
    cacheSet('a', 1, env);
    cacheSet('b', 2, env);
    fs.writeFileSync(path.join(dir, 'stale.json.1.x.tmp'), '');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(dir, 'README'), 'keep');
    assert.equal(cacheClear(env), 3);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['README', 'keep.txt']);
    assert.equal(cacheGet('a', 24, env), null);
    assert.equal(cacheClear(env), 0, 'idempotent');
  });

  test('an entry that cannot be unlinked (a directory named *.json) is skipped and not counted', () => {
    const env = freshEnv();
    const dir = cacheDir(env);
    cacheSet('a', 1, env);
    fs.mkdirSync(path.join(dir, 'subdir.json'));
    fs.writeFileSync(path.join(dir, 'subdir.json', 'inner.json'), '{}');
    assert.equal(cacheClear(env), 1);
    assert.ok(fs.existsSync(path.join(dir, 'subdir.json')), 'directory survives');
    assert.equal(cacheStats(env).entries, 1, 'stats counts it (statSync succeeds on a directory); only unlink refuses');
  });
});

// ---------------------------------------------------------------------------

describe('default env (process.env) and isolation', () => {
  test('without an env argument every function uses process.env.SINGULAR_HOME (the throwaway dir)', () => {
    assert.equal(cacheSet('default-key', { ok: true }, undefined), true);
    assert.deepEqual(cacheGet('default-key', 1), { ok: true });
    assert.ok(cacheFile('default-key').startsWith(process.env.SINGULAR_HOME));
    assert.ok(cacheStats().entries >= 1);
    assert.ok(cacheClear() >= 1);
    assert.equal(cacheGet('default-key', 1), null);
  });

  test('no cache entry was ever written under the fake $HOME/.claude (SINGULAR_HOME wins over HOME when absolute)', () => {
    // homeDir() mkdirs the fallback home when a relative SINGULAR_HOME is probed (see cacheDir tests), but no
    // cache directory or entry may appear there: every write went to an absolute SINGULAR_HOME.
    assert.ok(!fs.existsSync(path.join(FAKE_HOME, '.claude', 'singular', 'cache')));
    assert.notEqual(REAL_HOME, FAKE_HOME, 'the captured real home is not the fake one');
    assert.equal(os.homedir(), FAKE_HOME, 'os.homedir() follows the redirected $HOME, which is why REAL_HOME was captured first');
    assert.ok(!fs.existsSync(path.join(REAL_HOME, '.claude', 'singular', 'cache', `${sha256('default-key')}.json`)), 'the real home never saw this suite\'s key');
  });
});
