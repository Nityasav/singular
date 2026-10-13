// test/unit-refs.test.js — node --test test/unit-refs.test.js
// Exhaustive unit tests for lib/refs.js: the ref grammar (parse / format / unpin / case-normalise / sha
// helpers) against valid, malformed and hostile strings, and resolveHeadSha with a faked git (argv, env,
// timeout, failure classification) plus one real `git ls-remote` against a local bare repository through
// the SINGULAR_GIT_BASE seam. No network.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as nodeExecFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLEAN = path.join(HERE, 'fixtures', 'skill-folders', 'clean');
const SCRATCH_ROOT = process.env.SINGULAR_TEST_TMP
  || '/private/tmp/claude-501/-Users-nitya--superset-projects-claude-skills/cfa575e5-ae3c-4522-b59f-cd3623c88bf0/scratchpad';

function mkTmp(label) {
  let base = SCRATCH_ROOT;
  try { fs.mkdirSync(base, { recursive: true }); } catch { base = os.tmpdir(); }
  return fs.mkdtempSync(path.join(base, `unit-refs-${label}-`));
}

const ROOT = mkTmp('state');
const FAKE_HOME = path.join(ROOT, 'fakehome');
fs.mkdirSync(FAKE_HOME, { recursive: true });
process.env.SINGULAR_HOME = path.join(ROOT, 'singular-home');
process.env.HOME = FAKE_HOME;

const refs = await import('../lib/refs.js');
const { childEnv } = await import('../lib/git.js');
const { OWNER_RE, REPO_RE, SKILL_RE, REF_RE, isSafeSegment, isSha, shortSha, parseRef, formatRef, unpinnedRef, normalizeRefCase, resolveHeadSha } = refs;

after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

const SHA = '2c606141936f1eeef17fa3043a72095b4765b9c2';
const SHA2 = 'abcdef0123456789abcdef0123456789abcdef01';
/** A production-shaped env: no test seams, state under the scratch dir. */
const prodEnv = () => ({ SINGULAR_HOME: process.env.SINGULAR_HOME, HOME: FAKE_HOME, PATH: process.env.PATH ?? '' });

/** execFile mock: handler(file, args, opts) -> {stdout, stderr} | Error. Records calls; callback is async. */
function mockExec(handler, { child = () => ({ stdin: { end() {} } }) } = {}) {
  const calls = [];
  const fn = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    let r;
    try { r = handler(file, args, opts); } catch (e) { r = e; }
    queueMicrotask(() => {
      if (r instanceof Error) cb(r, r.stdout ?? '', r.stderr ?? '');
      else cb(null, r?.stdout ?? '', r?.stderr ?? '');
    });
    return child(file, args, opts);
  };
  fn.calls = calls;
  return fn;
}

function execError({ code = 1, stdout = '', stderr = '', killed = false, signal = null, message } = {}) {
  const e = new Error(message ?? `Command failed (${code})`);
  e.code = code;
  e.stdout = stdout;
  e.stderr = stderr;
  e.killed = killed;
  e.signal = signal;
  return e;
}

// ---------------------------------------------------------------------------

describe('grammar constants', () => {
  test('OWNER_RE / REPO_RE / SKILL_RE / REF_RE are anchored and require an alphanumeric first character', () => {
    for (const re of [OWNER_RE, REPO_RE, SKILL_RE, REF_RE]) {
      assert.ok(re.source.startsWith('^') && re.source.endsWith('$'), `${re} anchored`);
      assert.ok(!re.flags.includes('i'), 'case-sensitive');
    }
    assert.ok(OWNER_RE.test('a') && OWNER_RE.test('multica-ai') && OWNER_RE.test('A1-b2'));
    assert.ok(!OWNER_RE.test('-a') && !OWNER_RE.test('a.b') && !OWNER_RE.test('a_b') && !OWNER_RE.test('a/b') && !OWNER_RE.test(''));
    assert.ok(REPO_RE.test('andrej-karpathy-skills') && REPO_RE.test('x.y_z-1') && REPO_RE.test('1'));
    assert.ok(!REPO_RE.test('.hidden') && !REPO_RE.test('_x') && !REPO_RE.test('-x') && !REPO_RE.test('a b') && !REPO_RE.test('a/b'));
    assert.ok(SKILL_RE.test('karpathy-guidelines') && SKILL_RE.test('v1.2_beta'));
    assert.ok(!SKILL_RE.test('.x') && !SKILL_RE.test('x@y') && !SKILL_RE.test('x#y'));
    assert.ok(REF_RE.test('o/r@s') && REF_RE.test(`o/r#${SHA}@s`) && REF_RE.test('a1/b.c-d_e@f.g-h_i'));
    assert.ok(!REF_RE.test(`o/r#${SHA.toUpperCase()}@s`) && !REF_RE.test('o/r#abc@s') && !REF_RE.test('o/r@s@t') && !REF_RE.test('o/r/x@s') && !REF_RE.test('o@s') && !REF_RE.test(' o/r@s'));
  });
});

// ---------------------------------------------------------------------------

describe('isSafeSegment', () => {
  test('accepts plain segments and rejects ".", "..", a leading dash, empty, over-long and non-matching values', () => {
    assert.equal(isSafeSegment('skill'), true);
    assert.equal(isSafeSegment('a'), true);
    assert.equal(isSafeSegment('x'.repeat(100)), true, '100 chars is the cap');
    assert.equal(isSafeSegment('x'.repeat(101)), false, '101 chars is too long');
    for (const bad of ['.', '..', '', '-y', '--skill', '-', '.hidden', 'a/b', 'a b', 'a\nb', 'a\0b', 'a@b', 'ünï', 'a\tb', '…']) {
      assert.equal(isSafeSegment(bad), false, JSON.stringify(bad));
    }
  });

  test('uses the given regex (OWNER_RE forbids dots/underscores) and coerces non-strings', () => {
    assert.equal(isSafeSegment('a.b', SKILL_RE), true);
    assert.equal(isSafeSegment('a.b', OWNER_RE), false);
    assert.equal(isSafeSegment('a_b', REPO_RE), true);
    assert.equal(isSafeSegment('a_b', OWNER_RE), false);
    assert.equal(isSafeSegment(123), true, 'numbers coerce to "123"');
    assert.equal(isSafeSegment(null), false, '"null" would match the regex, but null -> "" first');
    assert.equal(isSafeSegment(undefined), false);
    assert.equal(isSafeSegment({ toString: () => 'ok' }), true);
    assert.equal(isSafeSegment(['a']), true, 'arrays stringify with commas only when > 1 element');
    assert.equal(isSafeSegment(['a', 'b']), false);
  });
});

// ---------------------------------------------------------------------------

describe('isSha / shortSha', () => {
  test('isSha: exactly 40 lowercase hex characters, strings only', () => {
    assert.equal(isSha(SHA), true);
    assert.equal(isSha(SHA.toUpperCase()), false);
    assert.equal(isSha(SHA.slice(0, 39)), false);
    assert.equal(isSha(`${SHA}0`), false);
    assert.equal(isSha(` ${SHA}`), false);
    assert.equal(isSha(`${SHA}\n`), false);
    assert.equal(isSha('g'.repeat(40)), false);
    assert.equal(isSha(null), false);
    assert.equal(isSha(undefined), false);
    assert.equal(isSha(12345), false);
    assert.equal(isSha({ toString: () => SHA }), false, 'objects never count');
    assert.equal(isSha(''), false);
  });

  test('shortSha: first 7 chars of a valid sha, empty string otherwise', () => {
    assert.equal(shortSha(SHA), '2c60614');
    assert.equal(shortSha(SHA.toUpperCase()), '');
    assert.equal(shortSha('2c60614'), '');
    assert.equal(shortSha(null), '');
    assert.equal(shortSha(), '');
  });
});

// ---------------------------------------------------------------------------

describe('parseRef', () => {
  test('parses the unpinned and pinned forms into {owner, repo, sha, skill}', () => {
    assert.deepEqual(parseRef('multica-ai/andrej-karpathy-skills@karpathy-guidelines'), { owner: 'multica-ai', repo: 'andrej-karpathy-skills', sha: null, skill: 'karpathy-guidelines' });
    assert.deepEqual(parseRef(`anthropics/skills#${SHA}@frontend-design`), { owner: 'anthropics', repo: 'skills', sha: SHA, skill: 'frontend-design' });
    assert.deepEqual(parseRef('a/b@c'), { owner: 'a', repo: 'b', sha: null, skill: 'c' });
    assert.deepEqual(parseRef('A1/B.c_d-e@F.g_h-i'), { owner: 'A1', repo: 'B.c_d-e', sha: null, skill: 'F.g_h-i' }, 'case and punctuation preserved');
  });

  test('surrounding whitespace is trimmed; interior whitespace is rejected; input is coerced to a string', () => {
    assert.deepEqual(parseRef('  o/r@s\n'), { owner: 'o', repo: 'r', sha: null, skill: 's' });
    assert.equal(parseRef('o/r @s'), null);
    assert.equal(parseRef('o/ r@s'), null);
    assert.equal(parseRef('o/r@s t'), null);
    assert.equal(parseRef(null), null);
    assert.equal(parseRef(undefined), null);
    assert.equal(parseRef(''), null);
    assert.equal(parseRef(42), null);
    assert.equal(parseRef({ toString: () => 'o/r@s' })?.skill, 's', 'objects are stringified');
    assert.equal(parseRef(['o/r@s'])?.skill, 's');
  });

  test('rejects every malformed or hostile shape (flags, traversal, shell, sha variants, over-long segments)', () => {
    const bad = [
      'o/r', 'o@s', 'r@s', '/o/r@s', 'o//r@s', 'o/r@', 'o/r@@s', 'o/r@s@t', 'o/r/x@s', 'o\\r@s',
      '-y/r@s', 'o/-r@s', 'o/r@-s', 'o/r@--skill', 'o/.@s', 'o/..@s', 'o/r@.', 'o/r@..',
      '../../etc/passwd', 'o/r@../../etc/passwd', 'o/r@s/../x', 'o/r@s; rm -rf ~', 'o/r@s && echo x', 'o/r@s|x', 'o/r@$(whoami)', 'o/r@`id`',
      `o/r#${SHA.toUpperCase()}@s`, `o/r#${SHA.slice(0, 39)}@s`, `o/r#${SHA}0@s`, 'o/r#HEAD@s', 'o/r#main@s', 'o/r#@s', `o/r#${SHA}`, `o/r@s#${SHA}`,
      `${'o'.repeat(101)}/r@s`, `o/${'r'.repeat(101)}@s`, `o/r@${'s'.repeat(101)}`,
      'o/r@s\u0000', 'o/r@s\u200b', 'ö/r@s', 'o/r@ß', 'https://github.com/o/r@s', 'github.com/o/r@s', 'o.x/r@s', 'o_x/r@s',
    ];
    for (const s of bad) assert.equal(parseRef(s), null, JSON.stringify(s));
    assert.deepEqual(parseRef('o/r.git@s'), { owner: 'o', repo: 'r.git', sha: null, skill: 's' }, 'a ".git" suffix is just part of a repo name');
    assert.deepEqual(parseRef(`o/${'r'.repeat(100)}@s`)?.repo, 'r'.repeat(100), '100-char segment accepted');
  });
});

// ---------------------------------------------------------------------------

describe('formatRef / unpinnedRef / normalizeRefCase', () => {
  test('formatRef round-trips parseRef and omits the sha when null/empty', () => {
    for (const s of ['o/r@s', `o/r#${SHA}@s`, 'multica-ai/andrej-karpathy-skills@karpathy-guidelines']) assert.equal(formatRef(parseRef(s)), s);
    assert.equal(formatRef({ owner: 'o', repo: 'r', sha: null, skill: 's' }), 'o/r@s');
    assert.equal(formatRef({ owner: 'o', repo: 'r', sha: '', skill: 's' }), 'o/r@s');
    assert.equal(formatRef({ owner: 'o', repo: 'r', sha: undefined, skill: 's' }), 'o/r@s');
    assert.equal(formatRef({ owner: 'o', repo: 'r', sha: SHA, skill: 's' }), `o/r#${SHA}@s`);
    assert.equal(formatRef({ owner: 'o', repo: 'r', skill: 's' }), 'o/r@s');
  });

  test('formatRef does not validate: it is a pure formatter (callers validate first)', () => {
    assert.equal(formatRef({ owner: 'o', repo: 'r', sha: 'notasha', skill: 's' }), 'o/r#notasha@s');
    assert.equal(formatRef({}), 'undefined/undefined@undefined');
  });

  test('formatRef on non-objects returns ""', () => {
    for (const v of [null, undefined, '', 'o/r@s', 42, true]) assert.equal(formatRef(v), '', String(v));
  });

  test('unpinnedRef drops the sha from strings and objects; invalid input -> ""', () => {
    assert.equal(unpinnedRef(`o/r#${SHA}@s`), 'o/r@s');
    assert.equal(unpinnedRef('o/r@s'), 'o/r@s');
    assert.equal(unpinnedRef(`  o/r#${SHA}@s  `), 'o/r@s', 'trimmed via parseRef');
    assert.equal(unpinnedRef({ owner: 'o', repo: 'r', sha: SHA, skill: 's' }), 'o/r@s');
    assert.equal(unpinnedRef({ owner: 'O', repo: 'R', sha: null, skill: 'S' }), 'O/R@S', 'case is not touched here');
    for (const v of ['bad', '', null, undefined, 0, false]) assert.equal(unpinnedRef(v), '', String(v));
    assert.equal(unpinnedRef(42), 'undefined/undefined@undefined', 'a truthy non-string is formatted blindly (callers validate first; parseRef/normalizeRefCase are the validators)');
  });

  test('normalizeRefCase lowercases owner and repo only, keeps the skill and sha, accepts strings and objects', () => {
    assert.deepEqual(normalizeRefCase('MULTICA-AI/Andrej-Karpathy-Skills@Karpathy-Guidelines'), { owner: 'multica-ai', repo: 'andrej-karpathy-skills', sha: null, skill: 'Karpathy-Guidelines' });
    assert.deepEqual(normalizeRefCase(`O/R#${SHA}@S`), { owner: 'o', repo: 'r', sha: SHA, skill: 'S' });
    assert.deepEqual(normalizeRefCase({ owner: 'O', repo: 'R', sha: SHA, skill: 'S', extra: 1 }), { owner: 'o', repo: 'r', sha: SHA, skill: 'S', extra: 1 }, 'extra keys are preserved');
    assert.deepEqual(normalizeRefCase({ owner: 'o', repo: 'r', sha: null, skill: 's' }), { owner: 'o', repo: 'r', sha: null, skill: 's' });
    const same = parseRef('o/r@s');
    assert.notEqual(normalizeRefCase(same), same, 'returns a new object');
    assert.equal(formatRef(normalizeRefCase(`O/R#${SHA}@S`)), `o/r#${SHA}@S`);
  });

  test('normalizeRefCase returns null for invalid strings and non-objects', () => {
    for (const v of ['not a ref', '', null, undefined, 42, true, `O/R#${SHA.toUpperCase()}@S`]) assert.equal(normalizeRefCase(v), null, String(v));
  });
});

// ---------------------------------------------------------------------------

describe('resolveHeadSha (faked git)', () => {
  const HEAD_OUT = `${SHA}\tHEAD\n${SHA2}\trefs/heads/main\n`;

  test('runs `git ls-remote https://github.com/<o>/<r> HEAD` through execFile with a hardened env and returns the HEAD sha', async () => {
    const exec = mockExec(() => ({ stdout: HEAD_OUT }));
    const env = { ...prodEnv(), GIT_TERMINAL_PROMPT: '1', LC_ALL: 'de_DE', KEEP: 'me' };
    const sha = await resolveHeadSha('multica-ai', 'andrej-karpathy-skills', { timeoutMs: 1234 }, { execFileImpl: exec, env });
    assert.equal(sha, SHA);
    assert.equal(exec.calls.length, 1);
    const c = exec.calls[0];
    assert.equal(c.file, 'git');
    assert.deepEqual(c.args, ['ls-remote', 'https://github.com/multica-ai/andrej-karpathy-skills', 'HEAD']);
    assert.equal(c.opts.env.GIT_TERMINAL_PROMPT, '0', 'credential prompts disabled even when the caller env enables them');
    assert.equal(c.opts.env.LC_ALL, 'C', 'stable English messages');
    assert.equal(c.opts.env.KEEP, undefined, 'nothing else from the caller env reaches git (allowlist: lib/git.js childEnv)');
    assert.equal(c.opts.env.NO_COLOR, '1');
    assert.deepEqual(c.opts.env, childEnv(env), 'exactly the allowlisted child environment');
    assert.equal(c.opts.timeout, 1234);
    assert.equal(c.opts.killSignal, 'SIGKILL');
    assert.equal(c.opts.maxBuffer, 1024 * 1024);
    assert.equal(c.opts.windowsHide, true);
    assert.equal(c.opts.shell, undefined, 'never a shell');
  });

  test('regression (security review 2026-10-08): a GIT_CONFIG_* url.insteadOf rewrite, GIT_SSL_NO_VERIFY, ssh/proxy commands, CA and NODE_* overrides in the caller env never reach git and never change the URL', async () => {
    const exec = mockExec(() => ({ stdout: HEAD_OUT }));
    const hostile = {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.file:///evil/.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/',
      GIT_SSL_NO_VERIFY: '1', GIT_SSH_COMMAND: '/evil/ssh', GIT_PROXY_COMMAND: '/evil/proxy', GIT_EXEC_PATH: '/evil/libexec', GIT_DIR: '/evil/.git', GIT_CONFIG_GLOBAL: '/evil/gitconfig',
      XDG_CONFIG_HOME: '/evil/xdg', SSL_CERT_FILE: '/evil/ca.pem', SSL_CERT_DIR: '/evil/certs', NODE_EXTRA_CA_CERTS: '/evil/ca.pem', NODE_TLS_REJECT_UNAUTHORIZED: '0',
      NODE_OPTIONS: '--require /evil/hook.js', NODE_PATH: '/evil/node_modules', LD_PRELOAD: '/evil/lib.so', DYLD_INSERT_LIBRARIES: '/evil/lib.dylib',
      npm_config_registry: 'http://evil.example/npm', NPM_CONFIG_USERCONFIG: '/evil/npmrc', TMPDIR: '/evil/tmp',
      HTTPS_PROXY: 'http://proxy.example:3128', no_proxy: 'localhost',
    };
    const env = { ...prodEnv(), ...hostile };
    const sha = await resolveHeadSha('anthropics', 'skills', {}, { execFileImpl: exec, env });
    assert.equal(sha, SHA);
    const c = exec.calls[0];
    assert.deepEqual(c.args, ['ls-remote', 'https://github.com/anthropics/skills', 'HEAD'], 'the production URL, unchanged');
    for (const k of Object.keys(hostile)) {
      if (k === 'HTTPS_PROXY' || k === 'no_proxy') continue;
      assert.equal(c.opts.env[k], undefined, `${k} must not reach git`);
    }
    assert.deepEqual(Object.keys(c.opts.env).filter((k) => /^GIT_/.test(k)), ['GIT_TERMINAL_PROMPT'], 'the only GIT_* variable is ours');
    assert.equal(c.opts.env.SINGULAR_HOME, undefined, 'the seams and state dir are not for git');
    assert.equal(c.opts.env.HTTPS_PROXY, 'http://proxy.example:3128', 'proxy variables pass (a proxy cannot forge a verified TLS peer)');
    assert.equal(c.opts.env.no_proxy, 'localhost');
    assert.equal(c.opts.env.HOME, FAKE_HOME, 'HOME passes: ~/.gitconfig is the user\'s own (http.sslCAInfo, insteadOf for mirrors)');
    assert.equal(c.opts.env.PATH, process.env.PATH ?? '', 'PATH passes');
    assert.deepEqual(c.opts.env, childEnv(env));
  });

  test('default timeout is 8000 ms; a NaN / 0 / negative / fractional timeout is normalised (floor, min 1, fallback 8000)', async () => {
    const run = async (opts) => {
      const exec = mockExec(() => ({ stdout: HEAD_OUT }));
      await resolveHeadSha('o', 'r', opts, { execFileImpl: exec, env: prodEnv() });
      return exec.calls[0].opts.timeout;
    };
    assert.equal(await run({}), 8000);
    assert.equal(await run(undefined), 8000);
    assert.equal(await run({ timeoutMs: NaN }), 8000);
    assert.equal(await run({ timeoutMs: 'abc' }), 8000);
    assert.equal(await run({ timeoutMs: 0 }), 8000, '0 is falsy -> fallback');
    assert.equal(await run({ timeoutMs: -5 }), 1, 'negative clamps to 1 ms');
    assert.equal(await run({ timeoutMs: 0.9 }), 1);
    assert.equal(await run({ timeoutMs: 2500.7 }), 2500);
    assert.equal(await run({ timeoutMs: '300' }), 300, 'numeric strings are honoured');
  });

  test('the HEAD line is matched anywhere in the output (any order, CRLF, extra refs) and must be a 40-hex sha', async () => {
    const outputs = [
      `${SHA2}\trefs/heads/main\n${SHA}\tHEAD\n`,
      `warning: something\r\n${SHA}\tHEAD\r\n`,
      `${SHA}    HEAD`,
      `${SHA}\tHEAD\n${SHA2}\tHEAD^{}\n`,
    ];
    for (const out of outputs) {
      const exec = mockExec(() => ({ stdout: out }));
      assert.equal(await resolveHeadSha('o', 'r', {}, { execFileImpl: exec, env: prodEnv() }), SHA, JSON.stringify(out));
    }
    for (const out of ['', `${SHA2}\trefs/heads/main\n`, `${SHA.toUpperCase()}\tHEAD\n`, `${SHA.slice(0, 39)}\tHEAD\n`, `${SHA}\tHEADS\n`, `x${SHA}\tHEAD\n`, `${SHA}\trefs/heads/HEAD\n`]) {
      const exec = mockExec(() => ({ stdout: out }));
      await assert.rejects(resolveHeadSha('o', 'r', {}, { execFileImpl: exec, env: prodEnv() }), /could not parse HEAD sha from git ls-remote output for https:\/\/github\.com\/o\/r/, JSON.stringify(out));
    }
  });

  test('invalid owner/repo throws BEFORE any subprocess (flags, traversal, shell metacharacters, over-long, empty)', async () => {
    const exec = mockExec(() => { throw new Error('must not run'); });
    const cases = [['-y', 'r'], ['o', '-r'], ['..', 'r'], ['o', '..'], ['o', '.'], ['o/x', 'r'], ['o', 'r/x'], ['o', 'r;rm'], ['o', 'r r'], ['o.x', 'r'], ['', 'r'], ['o', ''], [null, 'r'], ['o', undefined], ['o'.repeat(101), 'r'], ['o', 'r\n']];
    for (const [o, r] of cases) {
      await assert.rejects(resolveHeadSha(o, r, {}, { execFileImpl: exec, env: prodEnv() }), /^Error: invalid owner\/repo: /, `${o}/${r}`);
    }
    assert.equal(exec.calls.length, 0);
  });

  test('a killed or signalled process is reported as a timeout', async () => {
    const killed = mockExec(() => execError({ code: null, killed: true, signal: 'SIGKILL' }));
    await assert.rejects(resolveHeadSha('o', 'r', { timeoutMs: 42 }, { execFileImpl: killed, env: prodEnv() }), /^Error: git ls-remote https:\/\/github\.com\/o\/r timed out after 42ms$/);
    const signalled = mockExec(() => execError({ code: null, killed: false, signal: 'SIGTERM' }));
    await assert.rejects(resolveHeadSha('o', 'r', { timeoutMs: 7 }, { execFileImpl: signalled, env: prodEnv() }), /timed out after 7ms$/);
  });

  test('a non-zero exit is described with the exit code and the last two stderr lines (capped at 300 chars)', async () => {
    const exec = mockExec(() => execError({ code: 128, stderr: 'line one\nline two\n\nline three\n' }));
    await assert.rejects(resolveHeadSha('o', 'r', {}, { execFileImpl: exec, env: prodEnv() }), /^Error: git ls-remote https:\/\/github\.com\/o\/r failed \(exit 128\): line two \| line three$/);
    const long = mockExec(() => execError({ code: 2, stderr: 'x'.repeat(1000) }));
    await assert.rejects(resolveHeadSha('o', 'r', {}, { execFileImpl: long, env: prodEnv() }), (err) => {
      assert.match(err.message, /failed \(exit 2\): x{300}$/);
      return true;
    });
    const silent = mockExec(() => execError({ code: 3, stderr: '', message: 'spawn failure detail' }));
    await assert.rejects(resolveHeadSha('o', 'r', {}, { execFileImpl: silent, env: prodEnv() }), /failed \(exit 3\): spawn failure detail$/, 'falls back to the error message');
    const noCode = mockExec(() => execError({ code: null, stderr: '', message: '' }));
    await assert.rejects(resolveHeadSha('o', 'r', {}, { execFileImpl: noCode, env: prodEnv() }), /failed \(exit unknown\)$/);
  });

  test('a credential prompt (missing or private repository) is named as such, with the raw detail kept', async () => {
    const stderrs = [
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'remote: Repository not found.\nfatal: repository \'https://github.com/o/r/\' not found',
      'fatal: Authentication failed for \'https://github.com/o/r/\'',
      'git@github.com: Permission denied (publickey).',
    ];
    for (const stderr of stderrs) {
      const exec = mockExec(() => execError({ code: 128, stderr }));
      await assert.rejects(resolveHeadSha('o', 'r', {}, { execFileImpl: exec, env: prodEnv() }), (err) => {
        assert.match(err.message, /^git ls-remote https:\/\/github\.com\/o\/r failed \(exit 128\): repository not found or private \(GitHub asked for credentials\): /);
        assert.ok(err.message.includes(stderr.split('\n').filter(Boolean).slice(-1)[0]), 'raw detail kept');
        return true;
      }, stderr);
    }
  });

  test('an execFile that throws synchronously (ENOENT: no git) is a clean rejection, not an unhandled error', async () => {
    const exec = (file, args, opts, cb) => { const e = new Error('spawn git ENOENT'); e.code = 'ENOENT'; throw e; };
    await assert.rejects(resolveHeadSha('o', 'r', {}, { execFileImpl: exec, env: prodEnv() }), /git ls-remote https:\/\/github\.com\/o\/r failed \(exit ENOENT\): spawn git ENOENT/);
  });

  test('closes the child stdin; a child without stdin or whose stdin.end throws is tolerated', async () => {
    let ended = 0;
    const withStdin = mockExec(() => ({ stdout: HEAD_OUT }), { child: () => ({ stdin: { end() { ended++; } } }) });
    assert.equal(await resolveHeadSha('o', 'r', {}, { execFileImpl: withStdin, env: prodEnv() }), SHA);
    assert.equal(ended, 1);
    const noChild = mockExec(() => ({ stdout: HEAD_OUT }), { child: () => undefined });
    assert.equal(await resolveHeadSha('o', 'r', {}, { execFileImpl: noChild, env: prodEnv() }), SHA);
    const throwing = mockExec(() => ({ stdout: HEAD_OUT }), { child: () => ({ stdin: { end() { throw new Error('closed'); } } }) });
    assert.equal(await resolveHeadSha('o', 'r', {}, { execFileImpl: throwing, env: prodEnv() }), SHA);
  });

  test('deps default to process.env and the real execFile (observable: the seam var in process.env changes the URL)', async () => {
    const saved = process.env.SINGULAR_GIT_BASE;
    const localBase = path.join(ROOT, 'does-not-exist-base');
    process.env.SINGULAR_GIT_BASE = localBase;
    try {
      const exec = mockExec(() => ({ stdout: HEAD_OUT }));
      assert.equal(await resolveHeadSha('o', 'r', {}, { execFileImpl: exec }), SHA);
      assert.deepEqual(exec.calls[0].args, ['ls-remote', `${localBase}/o/r`, 'HEAD'], 'process.env seam honoured when deps.env is omitted');
    } finally {
      if (saved === undefined) delete process.env.SINGULAR_GIT_BASE; else process.env.SINGULAR_GIT_BASE = saved;
    }
  });

  test('SINGULAR_GIT_BASE seam: a local path or file:// URL replaces github.com; http(s) and relative values are refused (production URL)', async () => {
    const urlFor = async (base) => {
      const exec = mockExec(() => ({ stdout: HEAD_OUT }));
      await resolveHeadSha('o', 'r', {}, { execFileImpl: exec, env: { ...prodEnv(), SINGULAR_GIT_BASE: base } });
      return exec.calls[0].args[1];
    };
    assert.equal(await urlFor(`${ROOT}/gitbase/`), `${ROOT}/gitbase/o/r`, 'trailing slash dropped');
    assert.equal(await urlFor(`file://${ROOT}/gitbase`), `file://${ROOT}/gitbase/o/r`);
    assert.equal(await urlFor('https://evil.example/mirror'), 'https://github.com/o/r', 'a remote host never replaces github.com');
    assert.equal(await urlFor('http://127.0.0.1:9/mirror'), 'https://github.com/o/r', 'not even loopback over http');
    assert.equal(await urlFor('relative/dir'), 'https://github.com/o/r');
    assert.equal(await urlFor(''), 'https://github.com/o/r');
  });
});

// ---------------------------------------------------------------------------

describe('resolveHeadSha (REAL git against a local bare repository via SINGULAR_GIT_BASE)', () => {
  let gitRoot = null;
  let sha = null;
  const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

  before(() => {
    if (!gitOk) return;
    const src = path.join(ROOT, 'gitsrc');
    fs.mkdirSync(src, { recursive: true });
    fs.cpSync(CLEAN, path.join(src, 'skills', 'clean-one'), { recursive: true });
    const g = (args, cwd = src) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: FAKE_HOME, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    g(['init', '-q', '-b', 'main']);
    g(['add', '-A']);
    g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture']);
    sha = g(['rev-parse', 'HEAD']);
    gitRoot = path.join(ROOT, 'gitbase');
    fs.mkdirSync(path.join(gitRoot, 'local-owner'), { recursive: true });
    g(['clone', '-q', '--bare', src, path.join(gitRoot, 'local-owner', 'repo')]);
  });

  test('resolves the fixture HEAD through a file:// base and through a plain absolute path base, with the real execFile', async (t) => {
    if (!gitOk) { t.skip('git not on PATH'); return; }
    const calls = [];
    const recording = (file, args, opts, cb) => { calls.push({ file, args }); return nodeExecFile(file, args, opts, cb); };
    const viaFile = await resolveHeadSha('local-owner', 'repo', { timeoutMs: 20000 }, { execFileImpl: recording, env: { ...prodEnv(), SINGULAR_GIT_BASE: `file://${gitRoot}` } });
    assert.equal(viaFile, sha);
    assert.deepEqual(calls[0].args, ['ls-remote', `file://${gitRoot}/local-owner/repo`, 'HEAD']);
    const viaPath = await resolveHeadSha('local-owner', 'repo', { timeoutMs: 20000 }, { env: { ...prodEnv(), SINGULAR_GIT_BASE: gitRoot } });
    assert.equal(viaPath, sha);
  });

  test('a repository that does not exist under the base fails with a described git error (no hang, no prompt)', async (t) => {
    if (!gitOk) { t.skip('git not on PATH'); return; }
    await assert.rejects(resolveHeadSha('local-owner', 'missing', { timeoutMs: 20000 }, { env: { ...prodEnv(), SINGULAR_GIT_BASE: `file://${gitRoot}` } }), (err) => {
      assert.match(err.message, new RegExp(`^git ls-remote file://${gitRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/local-owner/missing failed \\(exit 128\\)`));
      return true;
    });
  });

  test('REAL git: a GIT_CONFIG_* url.insteadOf rewrite in the caller env is stripped, so ls-remote answers from the base, not from the rewrite target', async (t) => {
    if (!gitOk) { t.skip('git not on PATH'); return; }
    // a second bare repository with a different HEAD, where the rewrite would send every <base>/... URL
    const src2 = path.join(ROOT, 'gitsrc-other');
    fs.mkdirSync(path.join(src2, 'skills', 'other-one'), { recursive: true });
    fs.writeFileSync(path.join(src2, 'skills', 'other-one', 'SKILL.md'), '---\nname: other-one\ndescription: forged\n---\nforged text\n');
    const g = (args, cwd) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: FAKE_HOME, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    g(['init', '-q', '-b', 'main'], src2);
    g(['add', '-A'], src2);
    g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'forged'], src2);
    const sha2 = g(['rev-parse', 'HEAD'], src2);
    assert.notEqual(sha2, sha);
    const elsewhere = path.join(ROOT, 'elsewhere');
    fs.mkdirSync(path.join(elsewhere, 'local-owner'), { recursive: true });
    g(['clone', '-q', '--bare', src2, path.join(elsewhere, 'local-owner', 'repo')], src2);
    const rewrite = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${elsewhere}/.insteadOf`, GIT_CONFIG_VALUE_0: `file://${gitRoot}/` };
    // precondition: when the variables DO reach git, the rewrite wins (what a repository's env block would get)
    const raw = spawnSync('git', ['ls-remote', `file://${gitRoot}/local-owner/repo`, 'HEAD'], { encoding: 'utf8', env: { ...process.env, HOME: FAKE_HOME, GIT_TERMINAL_PROMPT: '0', ...rewrite } });
    assert.equal(raw.status, 0, raw.stderr);
    assert.equal(raw.stdout.slice(0, 40), sha2, 'precondition: git itself follows the insteadOf rewrite');
    // singular: the variables are stripped, the base repository answers
    const got = await resolveHeadSha('local-owner', 'repo', { timeoutMs: 20000 }, { env: { ...prodEnv(), SINGULAR_GIT_BASE: `file://${gitRoot}`, ...rewrite } });
    assert.equal(got, sha, 'the rewrite never reaches git');
  });

  test('a 1 ms timeout kills the real process and reports a timeout', async (t) => {
    if (!gitOk) { t.skip('git not on PATH'); return; }
    await assert.rejects(resolveHeadSha('local-owner', 'repo', { timeoutMs: 1 }, { env: { ...prodEnv(), SINGULAR_GIT_BASE: `file://${gitRoot}` } }), /timed out after 1ms|failed \(exit/);
  });
});
