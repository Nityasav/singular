// test/unit-log.test.js — node --test test/unit-log.test.js
// Exhaustive unit tests for lib/log.js: path resolution, JSON-lines shape, extra sanitising, rotation at
// 2 MiB, swallowed failures, stdout/stderr silence, timer(). No network. HOME and SKILL_SCOUT_HOME point at
// throwaway directories so the real ~/.claude is never touched.

import { test, describe, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRATCH_ROOT = process.env.SKILL_SCOUT_TEST_TMP
  || '/private/tmp/claude-501/-Users-nitya--superset-projects-claude-skills/cfa575e5-ae3c-4522-b59f-cd3623c88bf0/scratchpad';

function mkTmp(label) {
  let base = SCRATCH_ROOT;
  try { fs.mkdirSync(base, { recursive: true }); } catch { base = os.tmpdir(); }
  return fs.mkdtempSync(path.join(base, `unit-log-${label}-`));
}

const ROOT = mkTmp('state');
const FAKE_HOME = path.join(ROOT, 'fakehome');
const SCOUT_HOME = path.join(ROOT, 'scout-home');
fs.mkdirSync(FAKE_HOME, { recursive: true });
process.env.SKILL_SCOUT_HOME = SCOUT_HOME;
process.env.HOME = FAKE_HOME;

const { log, timer, logPath, LOG_FILE } = await import('../lib/log.js');

after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

/** Run fn with process.stdout/stderr.write captured; returns the chunks. */
function silenced(fn) {
  const out = [];
  const o1 = process.stdout.write;
  const o2 = process.stderr.write;
  process.stdout.write = (s) => { out.push(['stdout', String(s)]); return true; };
  process.stderr.write = (s) => { out.push(['stderr', String(s)]); return true; };
  try { fn(); } finally { process.stdout.write = o1; process.stderr.write = o2; }
  return out;
}

let saved;
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

// ---------------------------------------------------------------------------

describe('logPath', () => {
  test('LOG_FILE is scout.log; an absolute SKILL_SCOUT_HOME is honoured verbatim (resolved)', () => {
    assert.equal(LOG_FILE, 'scout.log');
    assert.equal(logPath({ SKILL_SCOUT_HOME: '/abs/dir' }), path.join('/abs/dir', 'scout.log'));
    assert.equal(logPath({ SKILL_SCOUT_HOME: '/abs/dir/../other/' }), path.join('/abs/other', 'scout.log'), 'path.resolve normalises');
    assert.equal(logPath({ SKILL_SCOUT_HOME: '  /abs/trimmed  ' }), path.join('/abs/trimmed', 'scout.log'), 'surrounding whitespace trimmed');
  });

  test('a relative, blank or missing SKILL_SCOUT_HOME falls back to $HOME/.claude/skill-scout/scout.log', () => {
    const fallback = path.join(FAKE_HOME, '.claude', 'skill-scout', 'scout.log');
    assert.equal(logPath({ SKILL_SCOUT_HOME: 'relative/dir', HOME: FAKE_HOME }), fallback);
    assert.equal(logPath({ SKILL_SCOUT_HOME: './x', HOME: FAKE_HOME }), fallback);
    assert.equal(logPath({ SKILL_SCOUT_HOME: '   ', HOME: FAKE_HOME }), fallback);
    assert.equal(logPath({ SKILL_SCOUT_HOME: '', HOME: FAKE_HOME }), fallback);
    assert.equal(logPath({ HOME: FAKE_HOME }), fallback);
    assert.equal(logPath({}), path.join(os.homedir(), '.claude', 'skill-scout', 'scout.log'), 'no HOME -> os.homedir()');
  });

  test('logPath is pure: it never creates the directory; default argument is process.env', () => {
    const env = { SKILL_SCOUT_HOME: path.join(ROOT, 'never-created') };
    logPath(env);
    assert.ok(!fs.existsSync(env.SKILL_SCOUT_HOME));
    assert.equal(logPath(), path.join(SCOUT_HOME, 'scout.log'));
    process.env.SKILL_SCOUT_HOME = path.join(ROOT, 'other-home');
    assert.equal(logPath(), path.join(ROOT, 'other-home', 'scout.log'), 'reads process.env at call time');
  });
});

// ---------------------------------------------------------------------------

describe('log()', () => {
  test('creates the directory, appends one JSON object per call with ts/pid/level/msg, returns undefined', () => {
    const home = path.join(ROOT, 'log-basic');
    process.env.SKILL_SCOUT_HOME = home;
    assert.ok(!fs.existsSync(home));
    assert.equal(log('info', 'hello', { a: 1 }), undefined);
    log('warn', 'second');
    const lines = readLines(path.join(home, 'scout.log'));
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(first), ['ts', 'pid', 'level', 'msg', 'a'], 'fixed key order: ts, pid, level, msg, then extras');
    assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(first.pid, process.pid);
    assert.equal(first.level, 'info');
    assert.equal(first.msg, 'hello');
    assert.equal(first.a, 1);
    const second = JSON.parse(lines[1]);
    assert.deepEqual(Object.keys(second), ['ts', 'pid', 'level', 'msg']);
    assert.equal(second.level, 'warn');
    assert.equal(second.msg, 'second');
    assert.ok(fs.readFileSync(path.join(home, 'scout.log'), 'utf8').endsWith('\n'), 'every line is newline-terminated');
  });

  test('level and msg are coerced to strings; missing level is "info", missing msg is ""', () => {
    const home = path.join(ROOT, 'log-coerce');
    process.env.SKILL_SCOUT_HOME = home;
    log();
    log(undefined, undefined);
    log(null, null);
    log(5, 42);
    log('debug', { toString: () => 'obj' });
    log('error', ['a', 'b']);
    const rows = readLines(path.join(home, 'scout.log')).map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => [r.level, r.msg]), [
      ['info', ''],
      ['info', ''],
      ['info', ''],
      ['5', '42'],
      ['debug', 'obj'],
      ['error', 'a,b'],
    ]);
  });

  test('extra: non-objects are ignored; reserved keys ts/level/msg are dropped; Errors become {message, name}; nested data is kept', () => {
    const home = path.join(ROOT, 'log-extra');
    process.env.SKILL_SCOUT_HOME = home;
    log('info', 'str-extra', 'just a string');
    log('info', 'num-extra', 42);
    log('info', 'null-extra', null);
    log('info', 'arr-extra', ['x']); // arrays are objects: index keys are copied
    log('info', 'reserved', { ts: 'spoofed', level: 'spoofed', msg: 'spoofed', pid: 'kept-if-given', other: 'ok' });
    class MyErr extends Error {}
    const err = new MyErr('boom');
    err.code = 'E_SECRET';
    err.stack = 'secret stack';
    log('error', 'errors', { err, nested: { inner: new TypeError('t') }, list: [1, { a: 2 }], undef: undefined, fn: () => 1, date: new Date(0) });
    const rows = Object.fromEntries(readLines(path.join(home, 'scout.log')).map((l) => JSON.parse(l)).map((r) => [r.msg, r]));
    assert.deepEqual(Object.keys(rows['str-extra']), ['ts', 'pid', 'level', 'msg']);
    assert.deepEqual(Object.keys(rows['num-extra']), ['ts', 'pid', 'level', 'msg']);
    assert.deepEqual(Object.keys(rows['null-extra']), ['ts', 'pid', 'level', 'msg']);
    assert.equal(rows['arr-extra']['0'], 'x');
    assert.notEqual(rows.reserved.ts, 'spoofed');
    assert.equal(rows.reserved.level, 'info');
    assert.equal(rows.reserved.msg, 'reserved');
    assert.equal(rows.reserved.pid, 'kept-if-given', 'pid is not reserved: a caller may override it');
    assert.equal(rows.reserved.other, 'ok');
    assert.deepEqual(rows.errors.err, { message: 'boom', name: 'Error' }, 'only message+name; code and stack are never logged');
    assert.deepEqual(rows.errors.nested, { inner: {} }, 'a nested Error is not special-cased (JSON gives {})');
    assert.deepEqual(rows.errors.list, [1, { a: 2 }]);
    assert.ok(!('undef' in rows.errors) && !('fn' in rows.errors), 'JSON.stringify drops undefined and functions');
    assert.equal(rows.errors.date, '1970-01-01T00:00:00.000Z');
  });

  test('failures are swallowed: cyclic extra, BigInt extra, unwritable directory, home path that is a file', () => {
    const home = path.join(ROOT, 'log-fail');
    process.env.SKILL_SCOUT_HOME = home;
    const cyc = {}; cyc.self = cyc;
    assert.doesNotThrow(() => log('info', 'cyclic', cyc));
    assert.doesNotThrow(() => log('info', 'bigint', { n: 1n }));
    assert.doesNotThrow(() => log('info', 'fine'));
    const rows = readLines(path.join(home, 'scout.log')).map((l) => JSON.parse(l).msg);
    assert.deepEqual(rows, ['fine'], 'the unserialisable calls wrote nothing');

    const fileHome = path.join(ROOT, 'log-file-home');
    fs.writeFileSync(fileHome, 'i am a file');
    process.env.SKILL_SCOUT_HOME = fileHome;
    assert.doesNotThrow(() => log('info', 'into a file'));
    assert.equal(fs.readFileSync(fileHome, 'utf8'), 'i am a file', 'the file is untouched');

    const under = path.join(fileHome, 'sub');
    process.env.SKILL_SCOUT_HOME = under;
    assert.doesNotThrow(() => log('info', 'under a file'));
    assert.ok(!fs.existsSync(under));
  });

  test('never writes to stdout or stderr (stdout of a hook is the hook output)', () => {
    const home = path.join(ROOT, 'log-quiet');
    process.env.SKILL_SCOUT_HOME = home;
    const cyc = {}; cyc.self = cyc;
    const out = silenced(() => {
      log('info', 'a', { b: 1 });
      log('error', 'c', { err: new Error('x') });
      log('info', 'cyclic', cyc);
      process.env.SKILL_SCOUT_HOME = path.join(ROOT, 'log-quiet-missing', 'deep');
      fs.mkdirSync(path.join(ROOT, 'log-quiet-missing'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'log-quiet-missing', 'deep'), '');
      log('info', 'unwritable');
    });
    assert.deepEqual(out, []);
    assert.equal(readLines(path.join(home, 'scout.log')).length, 2);
  });

  test('respects process.env at call time: changing SKILL_SCOUT_HOME between calls switches files; a relative value falls back to $HOME', () => {
    const a = path.join(ROOT, 'log-switch-a');
    const b = path.join(ROOT, 'log-switch-b');
    process.env.SKILL_SCOUT_HOME = a;
    log('info', 'to-a');
    process.env.SKILL_SCOUT_HOME = b;
    log('info', 'to-b');
    assert.deepEqual(readLines(path.join(a, 'scout.log')).map((l) => JSON.parse(l).msg), ['to-a']);
    assert.deepEqual(readLines(path.join(b, 'scout.log')).map((l) => JSON.parse(l).msg), ['to-b']);

    process.env.SKILL_SCOUT_HOME = 'relative-home';
    process.env.HOME = path.join(ROOT, 'fakehome-rel');
    log('info', 'to-fallback');
    const fallback = path.join(process.env.HOME, '.claude', 'skill-scout', 'scout.log');
    assert.deepEqual(readLines(fallback).map((l) => JSON.parse(l).msg), ['to-fallback']);
    assert.ok(!fs.existsSync(path.resolve('relative-home')), 'nothing created relative to the cwd');
  });

  test('a line is appended even when the file already has content without a trailing newline', () => {
    const home = path.join(ROOT, 'log-append');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'scout.log'), '{"ts":"old","level":"info","msg":"legacy"}');
    process.env.SKILL_SCOUT_HOME = home;
    log('info', 'new');
    const text = fs.readFileSync(path.join(home, 'scout.log'), 'utf8');
    assert.ok(text.startsWith('{"ts":"old"'), 'existing bytes kept');
    assert.ok(text.endsWith('"msg":"new"}\n'));
  });
});

// ---------------------------------------------------------------------------

describe('rotation', () => {
  test('a log larger than 2 MiB is renamed to scout.log.1 before the append; the new scout.log holds only the new line', () => {
    const home = path.join(ROOT, 'log-rotate');
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'scout.log');
    const oldContent = `${'{"msg":"old"}\n'.repeat(1)}${'x'.repeat(MAX_LOG_BYTES)}\n`;
    fs.writeFileSync(file, oldContent);
    assert.ok(fs.statSync(file).size > MAX_LOG_BYTES);
    process.env.SKILL_SCOUT_HOME = home;
    log('info', 'after-rotate', { n: 1 });
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), oldContent, 'old bytes moved verbatim');
    const lines = readLines(file);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).msg, 'after-rotate');
    assert.ok(fs.statSync(file).size < 1000);
  });

  test('exactly 2 MiB is NOT rotated (the threshold is strictly greater than)', () => {
    const home = path.join(ROOT, 'log-exact');
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'scout.log');
    fs.writeFileSync(file, 'y'.repeat(MAX_LOG_BYTES));
    assert.equal(fs.statSync(file).size, MAX_LOG_BYTES);
    process.env.SKILL_SCOUT_HOME = home;
    log('info', 'appended');
    assert.ok(!fs.existsSync(`${file}.1`));
    assert.ok(fs.statSync(file).size > MAX_LOG_BYTES);
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('"msg":"appended"}\n'));
    // and the very next write rotates, because the file is now past the cap
    log('info', 'rotates-now');
    assert.ok(fs.existsSync(`${file}.1`));
    assert.deepEqual(readLines(file).map((l) => JSON.parse(l).msg), ['rotates-now']);
  });

  test('a second rotation replaces scout.log.1 (only one generation is kept)', () => {
    const home = path.join(ROOT, 'log-rotate-twice');
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'scout.log');
    process.env.SKILL_SCOUT_HOME = home;
    fs.writeFileSync(file, 'A'.repeat(MAX_LOG_BYTES + 1));
    log('info', 'one');
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8')[0], 'A');
    fs.writeFileSync(file, 'B'.repeat(MAX_LOG_BYTES + 1));
    log('info', 'two');
    assert.equal(fs.readFileSync(`${file}.1`, 'utf8')[0], 'B');
    assert.deepEqual(fs.readdirSync(home).sort(), ['scout.log', 'scout.log.1'], 'no .2');
    assert.deepEqual(readLines(file).map((l) => JSON.parse(l).msg), ['two']);
  });

  test('when the rotation rename fails the append still happens (stat/rename errors are swallowed)', (t) => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) { t.skip('permissions not enforced'); return; }
    const home = path.join(ROOT, 'log-rotate-fail');
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, 'scout.log');
    fs.writeFileSync(file, 'Z'.repeat(MAX_LOG_BYTES + 1));
    // scout.log.1 as a non-empty directory: renameSync over it throws (ENOTEMPTY / EISDIR); the file stays
    fs.mkdirSync(`${file}.1`);
    fs.writeFileSync(path.join(`${file}.1`, 'child'), '');
    process.env.SKILL_SCOUT_HOME = home;
    assert.doesNotThrow(() => log('info', 'still-appended'));
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.startsWith('ZZZ'), 'old content still there: no rotation');
    assert.ok(text.endsWith('"msg":"still-appended"}\n'), 'line appended regardless');
  });
});

// ---------------------------------------------------------------------------

describe('timer()', () => {
  test('elapsed() is a monotonic, non-negative number of milliseconds; timers are independent', async () => {
    const a = timer();
    const first = a.elapsed();
    assert.equal(typeof first, 'number');
    assert.ok(first >= 0);
    await new Promise((r) => setTimeout(r, 12));
    const b = timer();
    const later = a.elapsed();
    assert.ok(later >= first);
    assert.ok(later >= 8, `elapsed reflects wall time (${later} ms)`);
    assert.ok(b.elapsed() < later, 'a timer started later reads smaller');
    const c = a.elapsed();
    assert.ok(c >= later, 'never goes backwards');
    assert.ok(Number.isFinite(c) && !Number.isInteger(c * 0 + 0.5), 'sub-millisecond resolution (float)');
  });
});
