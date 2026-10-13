// test/unit-git.test.js — node --test test/unit-git.test.js
// lib/git.js: the child environment allowlist (childEnv: what every git / npx child may inherit), gitBase/repoUrl,
// describeGitFailure, runExecFile, cloneAtSha (faked execFile) and findSkillDirs. No network; git is faked here
// (unit-refs.test.js and unit-registry.test.js drive REAL git against local bare repositories).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRATCH_ROOT = process.env.SINGULAR_TEST_TMP
  || '/private/tmp/claude-501/-Users-nitya--superset-projects-claude-skills/cfa575e5-ae3c-4522-b59f-cd3623c88bf0/scratchpad';

function mkTmp(label) {
  let base = SCRATCH_ROOT;
  try { fs.mkdirSync(base, { recursive: true }); } catch { base = os.tmpdir(); }
  return fs.mkdtempSync(path.join(base, `unit-git-${label}-`));
}

// Throwaway state dir before the first import (lib/log.js reads process.env).
const ROOT = mkTmp('state');
process.env.SINGULAR_HOME = path.join(ROOT, 'singular-home');
process.env.HOME = path.join(ROOT, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

const git = await import('../lib/git.js');
const { CHILD_ENV_ALLOWLIST, CHILD_ENV_FIXED, childEnv, GITHUB_BASE, gitBase, repoUrl, describeGitFailure, runExecFile, cloneAtSha, findSkillDirs, CREDENTIAL_PROMPT_RE } = git;

after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

const SHA = '2c606141936f1eeef17fa3043a72095b4765b9c2';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

/** An execFile-shaped fake: records calls, answers through `handler(file, args, opts)` -> {stdout, stderr} | Error. */
function fakeExec(handler = () => ({})) {
  const calls = [];
  const impl = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    process.nextTick(() => {
      const r = handler(file, args, opts) ?? {};
      if (r instanceof Error) cb(r, r.stdout ?? '', r.stderr ?? '');
      else cb(null, r.stdout ?? '', r.stderr ?? '');
    });
    return { stdin: { end() { calls[calls.length - 1].stdinClosed = true; } } };
  };
  return { impl, calls };
}

// ---------------------------------------------------------------------------

describe('childEnv: the environment every git / npx child gets (security review 2026-10-08)', () => {
  const HOSTILE = Object.freeze({
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.file:///evil/.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/',
    GIT_SSL_NO_VERIFY: '1', GIT_SSH_COMMAND: 'x', GIT_PROXY_COMMAND: 'x', GIT_EXEC_PATH: 'x', GIT_DIR: 'x', GIT_WORK_TREE: 'x', GIT_CONFIG_GLOBAL: 'x', GIT_CONFIG_SYSTEM: 'x', GIT_ASKPASS: 'x', SSH_ASKPASS: 'x', GIT_SSL_CAINFO: 'x',
    XDG_CONFIG_HOME: 'x', SSL_CERT_FILE: 'x', SSL_CERT_DIR: 'x', NODE_EXTRA_CA_CERTS: 'x', NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_OPTIONS: 'x', NODE_PATH: 'x',
    npm_config_registry: 'x', npm_config_cache: 'x', npm_config_userconfig: 'x', npm_config_globalconfig: 'x', npm_config_prefix: 'x', NPM_CONFIG_REGISTRY: 'x', NPM_CONFIG_USERCONFIG: 'x',
    LD_PRELOAD: 'x', LD_LIBRARY_PATH: 'x', DYLD_INSERT_LIBRARIES: 'x', DYLD_LIBRARY_PATH: 'x',
    SINGULAR_HOME: 'x', SINGULAR_GIT_BASE: 'x', SINGULAR_REGISTRY_BASE: 'x', SINGULAR_MODE: 'x', CLAUDE_PLUGIN_ROOT: 'x', CLAUDE_CONFIG_DIR: 'x',
    TMPDIR: 'x', TERM: 'x', SHELL: 'x', PWD: 'x', OLDPWD: 'x', EDITOR: 'x', DISABLE_TELEMETRY: '0', NO_UPDATE_NOTIFIER: '0', LC_ALL: 'de_DE', GIT_TERMINAL_PROMPT: '1', NO_COLOR: '',
  });

  test('copies only the allowlisted keys, adds the fixed values, then extra; every other key is dropped', () => {
    const env = { PATH: '/usr/bin', HOME: '/home/u', USER: 'u', LOGNAME: 'u', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://p:1', https_proxy: 'http://p:1', NO_PROXY: 'localhost', ...HOSTILE };
    const out = childEnv(env);
    assert.deepEqual(out, { PATH: '/usr/bin', HOME: '/home/u', USER: 'u', LOGNAME: 'u', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://p:1', NO_PROXY: 'localhost', https_proxy: 'http://p:1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', NO_COLOR: '1' });
    for (const k of Object.keys(HOSTILE)) {
      if (k in CHILD_ENV_FIXED) continue;
      assert.equal(out[k], undefined, `${k} dropped`);
    }
    assert.equal(Object.keys(out).filter((k) => /^(GIT_|npm_config_|NPM_CONFIG_|NODE_|SINGULAR_|CLAUDE_|LD_|DYLD_)/.test(k)).join(','), 'GIT_TERMINAL_PROMPT');
  });

  test('the allowlist is PATH, HOME, USER/LOGNAME, LANG, the proxy variables and the Windows system variables; nothing that configures git, npm, node, TLS or the loader', () => {
    assert.ok(Object.isFrozen(CHILD_ENV_ALLOWLIST));
    for (const k of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'SYSTEMROOT', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP']) assert.ok(CHILD_ENV_ALLOWLIST.includes(k), k);
    for (const k of CHILD_ENV_ALLOWLIST) assert.ok(!/^(GIT_|npm_config_|NPM_CONFIG_|NODE_|SSL_|LD_|DYLD_|XDG_|SINGULAR_|CLAUDE_)/.test(k) && k !== 'TMPDIR', `${k} must not be allowlisted`);
    assert.deepEqual(CHILD_ENV_FIXED, { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', NO_COLOR: '1' });
    assert.ok(Object.isFrozen(CHILD_ENV_FIXED));
  });

  test('values are stringified; empty, null and undefined values are dropped; a missing or non-object env yields the fixed values only', () => {
    assert.deepEqual(childEnv({ PATH: 123, HOME: '', USER: null, LOGNAME: undefined, LANG: false }), { PATH: '123', LANG: 'false', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', NO_COLOR: '1' });
    assert.deepEqual(childEnv({}), { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', NO_COLOR: '1' });
    assert.deepEqual(childEnv(null), { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', NO_COLOR: '1' });
    assert.deepEqual(childEnv('nope'), { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', NO_COLOR: '1' });
    const dflt = childEnv();
    assert.equal(dflt.PATH, process.env.PATH, 'default env is process.env');
    assert.equal(dflt.GIT_TERMINAL_PROMPT, '0');
  });

  test('the caller env can never override the fixed values; `extra` (TMPDIR=<work dir>, DISABLE_TELEMETRY=1) comes last and wins', () => {
    const out = childEnv({ GIT_TERMINAL_PROMPT: '1', LC_ALL: 'de_DE', NO_COLOR: '', TMPDIR: '/evil', PATH: '/p' }, { TMPDIR: '/work', DISABLE_TELEMETRY: '1', LC_ALL: 'C.UTF-8' });
    assert.deepEqual(out, { PATH: '/p', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8', NO_COLOR: '1', TMPDIR: '/work', DISABLE_TELEMETRY: '1' });
    assert.deepEqual(childEnv({ PATH: '/p' }, {}), { PATH: '/p', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', NO_COLOR: '1' });
  });

  test('pure: the input env is not modified and the result is a fresh object each call', () => {
    const env = Object.freeze({ PATH: '/p', GIT_DIR: '/x' });
    const a = childEnv(env);
    const b = childEnv(env);
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
    assert.deepEqual(env, { PATH: '/p', GIT_DIR: '/x' });
  });
});

// ---------------------------------------------------------------------------

describe('gitBase / repoUrl', () => {
  test('github.com by default; only a local SINGULAR_GIT_BASE seam (outside the project) replaces it', () => {
    assert.equal(GITHUB_BASE, 'https://github.com');
    assert.equal(gitBase({}), 'https://github.com');
    assert.equal(repoUrl('anthropics', 'skills', {}), 'https://github.com/anthropics/skills');
    assert.equal(repoUrl('a', 'b', { SINGULAR_GIT_BASE: '/abs/base/' }), '/abs/base/a/b');
    assert.equal(repoUrl('a', 'b', { SINGULAR_GIT_BASE: 'file:///abs/base/' }), 'file:///abs/base/a/b');
    assert.equal(repoUrl('a', 'b', { SINGULAR_GIT_BASE: 'https://evil.example' }), 'https://github.com/a/b', 'a remote base is never honoured');
    assert.equal(repoUrl('a', 'b', { SINGULAR_GIT_BASE: 'relative/base' }), 'https://github.com/a/b');
  });
});

describe('describeGitFailure / CREDENTIAL_PROMPT_RE', () => {
  test('timeout, credential prompt (GitHub for a missing or private repository) with the raw detail kept, plain failures, spawn errors', () => {
    assert.equal(describeGitFailure('git fetch', { killed: true, stderr: '' }, 90), 'git fetch timed out after 90ms');
    assert.equal(describeGitFailure('git fetch', { signal: 'SIGKILL', stderr: 'x' }, 5), 'git fetch timed out after 5ms');
    assert.equal(describeGitFailure('git ls-remote u', { code: 128, stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/x/y/' not found\n" }, 1), "git ls-remote u failed (exit 128): repository not found or private (GitHub asked for credentials): remote: Repository not found. | fatal: repository 'https://github.com/x/y/' not found");
    assert.equal(describeGitFailure('git ls-remote u', { code: 128, stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" }, 1), "git ls-remote u failed (exit 128): repository not found or private (GitHub asked for credentials): fatal: could not read Username for 'https://github.com': terminal prompts disabled");
    assert.equal(describeGitFailure('git fetch', { code: 128, stderr: "fatal: couldn't find remote ref 0000" }, 1), "git fetch failed (exit 128): fatal: couldn't find remote ref 0000");
    assert.equal(describeGitFailure('git x', { code: null, error: new Error('spawn git ENOENT'), stderr: '' }, 1), 'git x failed (exit unknown): spawn git ENOENT');
    assert.equal(describeGitFailure('git x', { code: 1, stderr: '' }, 1), 'git x failed (exit 1)');
    assert.equal(describeGitFailure('git x', { code: 1, stderr: `${'a'.repeat(400)}\nb` }, 1).length, 'git x failed (exit 1): '.length + 300, 'detail capped at 300 chars');
    for (const m of ['could not read Username', 'Repository not found', 'Authentication failed', 'terminal prompts disabled', 'Permission denied (publickey)']) assert.ok(CREDENTIAL_PROMPT_RE.test(m), m);
    assert.ok(!CREDENTIAL_PROMPT_RE.test('Could not resolve host'));
  });
});

describe('runExecFile', () => {
  test('resolves {error null, code 0, stdout, stderr} on success and closes the child stdin; never rejects', async () => {
    const exec = fakeExec(() => ({ stdout: 'out', stderr: 'err' }));
    const r = await runExecFile(exec.impl, 'git', ['x'], { timeout: 5 });
    assert.deepEqual(r, { error: null, code: 0, signal: null, killed: false, stdout: 'out', stderr: 'err' });
    assert.equal(exec.calls[0].stdinClosed, true);
    assert.deepEqual([exec.calls[0].file, exec.calls[0].args, exec.calls[0].opts], ['git', ['x'], { timeout: 5 }]);
  });

  test('a numeric exit code, a killed child and a signal are reported; a non-numeric code is null', async () => {
    const failed = await runExecFile(fakeExec(() => Object.assign(new Error('boom'), { code: 128, stderr: 'fatal' })).impl, 'git', []);
    assert.deepEqual([failed.code, failed.killed, failed.signal, failed.stderr, failed.error?.message], [128, false, null, 'fatal', 'boom']);
    const killed = await runExecFile(fakeExec(() => Object.assign(new Error('k'), { killed: true, signal: 'SIGKILL' })).impl, 'git', []);
    assert.deepEqual([killed.code, killed.killed, killed.signal], [null, true, 'SIGKILL']);
    const enoent = await runExecFile(fakeExec(() => Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })).impl, 'git', []);
    assert.deepEqual([enoent.code, enoent.killed], [null, false]);
  });

  test('an impl that throws synchronously, or returns no child, still resolves', async () => {
    const r = await runExecFile(() => { throw new Error('refused'); }, 'git', []);
    assert.equal(r.error.message, 'refused');
    assert.equal(r.code, null);
    const noChild = await runExecFile((f, a, o, cb) => { process.nextTick(() => cb(null, 'ok', '')); return undefined; }, 'git', []);
    assert.equal(noChild.stdout, 'ok');
    const badStdin = await runExecFile((f, a, o, cb) => { process.nextTick(() => cb(null, 'ok', '')); return { stdin: { end() { throw new Error('closed'); } } }; }, 'git', []);
    assert.equal(badStdin.stdout, 'ok');
  });

  test('only the first callback counts', async () => {
    const r = await runExecFile((f, a, o, cb) => { process.nextTick(() => { cb(null, 'first', ''); cb(new Error('second'), 'x', ''); }); return {}; }, 'git', []);
    assert.deepEqual([r.error, r.stdout], [null, 'first']);
  });
});

// ---------------------------------------------------------------------------

describe('cloneAtSha (faked execFile)', () => {
  test('runs init / remote add / fetch --depth 1 <sha> / checkout FETCH_HEAD in dest with the allowlisted child env (+TMPDIR), the timeout and SIGKILL; returns {ok, url, env}', async () => {
    const exec = fakeExec();
    const dest = path.join(ROOT, 'clone-dest');
    fs.mkdirSync(dest, { recursive: true });
    const env = { PATH: '/bin', HOME: '/h', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.file:///evil/.insteadOf', GIT_CONFIG_VALUE_0: 'https://github.com/', npm_config_registry: 'x', TMPDIR: '/evil' };
    const r = await cloneAtSha({ owner: 'a', repo: 'b', sha: SHA, dest, timeoutMs: 1234, execFileImpl: exec.impl, env, tmpdir: '/tmp/x' });
    assert.deepEqual(r, { ok: true, url: 'https://github.com/a/b', env: { PATH: '/bin', HOME: '/h', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', NO_COLOR: '1', TMPDIR: '/tmp/x' } });
    assert.deepEqual(exec.calls.map((c) => c.args.join(' ')), ['init -q', 'remote add origin https://github.com/a/b', `fetch --depth 1 origin ${SHA}`, '-c core.symlinks=true checkout -q FETCH_HEAD']);
    for (const c of exec.calls) {
      assert.equal(c.file, 'git');
      assert.deepEqual(c.opts, { cwd: dest, env: r.env, timeout: 1234, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
      assert.equal(c.opts.shell, undefined, 'never a shell');
      assert.equal(c.opts.env.GIT_CONFIG_COUNT, undefined, 'the insteadOf rewrite never reaches git');
    }
    // without tmpdir the child keeps no TMPDIR at all (the caller's is untrusted)
    const exec2 = fakeExec();
    const r2 = await cloneAtSha({ owner: 'a', repo: 'b', sha: SHA, dest, execFileImpl: exec2.impl, env: { TMPDIR: '/evil', PATH: '/bin' } });
    assert.deepEqual(r2.env, { PATH: '/bin', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', NO_COLOR: '1' });
    assert.equal(exec2.calls[0].opts.timeout, 90000, 'default timeout');
  });

  test('stops at the first failing step with a described message naming owner/repo and sha; a timeout names the step', async () => {
    const dest = path.join(ROOT, 'clone-fail');
    fs.mkdirSync(dest, { recursive: true });
    const failing = fakeExec((file, args) => (args[0] === 'fetch' ? Object.assign(new Error('x'), { code: 128, stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" }) : {}));
    const bad = await cloneAtSha({ owner: 'a', repo: 'b', sha: SHA, dest, execFileImpl: failing.impl, env: {} });
    assert.equal(bad.ok, false);
    assert.equal(bad.step, 'fetch');
    assert.equal(bad.message, `git fetch failed (exit 128): repository not found or private (GitHub asked for credentials): fatal: could not read Username for 'https://github.com': terminal prompts disabled — could not fetch a/b at ${SHA}`);
    assert.equal(failing.calls.length, 3, 'checkout never ran');
    const killed = fakeExec((file, args) => (args[0] === 'init' ? Object.assign(new Error('k'), { killed: true, signal: 'SIGKILL' }) : {}));
    const t = await cloneAtSha({ owner: 'a', repo: 'b', sha: SHA, dest, timeoutMs: 7, execFileImpl: killed.impl, env: {} });
    assert.deepEqual(t, { ok: false, step: 'init', message: 'git init timed out after 7ms' });
    const nonzero = fakeExec((file, args) => (args.includes('checkout') ? Object.assign(new Error('x'), { code: 1, stderr: 'error: pathspec' }) : {}));
    const c = await cloneAtSha({ owner: 'a', repo: 'b', sha: SHA, dest, execFileImpl: nonzero.impl, env: {} });
    assert.deepEqual([c.ok, c.step], [false, 'checkout']);
    assert.match(c.message, /^git checkout failed \(exit 1\): error: pathspec — could not fetch a\/b at /);
  });

  test('the SINGULAR_GIT_BASE seam changes the remote URL only (and only for a local base)', async () => {
    const base = path.join(ROOT, 'seam-base');
    const dest = path.join(ROOT, 'clone-seam');
    fs.mkdirSync(dest, { recursive: true });
    const exec = fakeExec();
    const r = await cloneAtSha({ owner: 'o', repo: 'r', sha: SHA, dest, execFileImpl: exec.impl, env: { SINGULAR_GIT_BASE: `file://${base}` } });
    assert.equal(r.url, `file://${base}/o/r`);
    assert.deepEqual(exec.calls[1].args, ['remote', 'add', 'origin', `file://${base}/o/r`]);
    assert.equal(exec.calls[1].opts.env.SINGULAR_GIT_BASE, undefined, 'the seam variable itself is not forwarded');
    const remote = fakeExec();
    await cloneAtSha({ owner: 'o', repo: 'r', sha: SHA, dest, execFileImpl: remote.impl, env: { SINGULAR_GIT_BASE: 'https://evil.example' } });
    assert.deepEqual(remote.calls[1].args, ['remote', 'add', 'origin', 'https://github.com/o/r']);
  });
});

// ---------------------------------------------------------------------------

describe('findSkillDirs', () => {
  test('lists every SKILL.md folder with its frontmatter name (null without one), sorted by rel, skipping .git and node_modules; the root itself is "."', () => {
    const root = path.join(ROOT, 'find-skills');
    for (const [rel, name] of [['skills/b-skill', 'b'], ['skills/a-skill', 'alpha'], ['deep/x/y/z', 'z'], ['.git/skills/hidden', 'hidden'], ['node_modules/pkg/skills/dep', 'dep']]) {
      fs.mkdirSync(path.join(root, rel), { recursive: true });
      fs.writeFileSync(path.join(root, rel, 'SKILL.md'), `---\nname: ${name}\n---\nbody\n`);
    }
    fs.mkdirSync(path.join(root, 'noname'), { recursive: true });
    fs.writeFileSync(path.join(root, 'noname', 'SKILL.md'), '# no frontmatter\n');
    fs.mkdirSync(path.join(root, 'not-a-skill'), { recursive: true });
    fs.writeFileSync(path.join(root, 'not-a-skill', 'README.md'), 'x');
    fs.writeFileSync(path.join(root, 'not-a-skill', 'skill.md'), 'lowercase is not SKILL.md');
    const out = findSkillDirs(root);
    assert.deepEqual(out.map((s) => [s.rel, s.name]), [['deep/x/y/z', 'z'], ['noname', null], ['skills/a-skill', 'alpha'], ['skills/b-skill', 'b']]);
    assert.ok(out.every((s) => s.dir === path.join(root, s.rel)));
    fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: top\n---\n');
    assert.deepEqual(findSkillDirs(root)[0], { dir: root, rel: '.', name: 'top' });
  });

  test('maxDepth bounds the walk; a missing root and an unreadable directory are tolerated', () => {
    const root = path.join(ROOT, 'find-depth');
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'SKILL.md'), '---\nname: a\n---\n');
    fs.writeFileSync(path.join(root, 'a', 'b', 'SKILL.md'), '---\nname: ab\n---\n');
    fs.writeFileSync(path.join(root, 'a', 'b', 'c', 'SKILL.md'), '---\nname: abc\n---\n');
    assert.deepEqual(findSkillDirs(root, 1).map((s) => s.rel), ['a']);
    assert.deepEqual(findSkillDirs(root, 2).map((s) => s.rel), ['a', 'a/b']);
    assert.deepEqual(findSkillDirs(root).map((s) => s.rel), ['a', 'a/b', 'a/b/c']);
    assert.deepEqual(findSkillDirs(path.join(ROOT, 'does-not-exist')), []);
    assert.deepEqual(findSkillDirs(path.join(root, 'a', 'SKILL.md')), [], 'a file as root: readdir fails, nothing found');
    if (!IS_ROOT && process.platform !== 'win32') {
      const locked = path.join(root, 'locked');
      fs.mkdirSync(locked, { recursive: true });
      fs.writeFileSync(path.join(locked, 'SKILL.md'), '---\nname: locked\n---\n');
      fs.chmodSync(locked, 0o000);
      try {
        assert.deepEqual(findSkillDirs(root).map((s) => s.rel), ['a', 'a/b', 'a/b/c'], 'the unreadable directory is skipped, the rest is listed');
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    }
  });

  test('a SKILL.md whose frontmatter cannot be parsed still lists the folder with name null', () => {
    const root = path.join(ROOT, 'find-bad-fm');
    fs.mkdirSync(path.join(root, 'odd'), { recursive: true });
    fs.writeFileSync(path.join(root, 'odd', 'SKILL.md'), Buffer.from([0xff, 0xfe, 0x00, 0x2d, 0x2d, 0x2d]));
    const out = findSkillDirs(root);
    assert.equal(out.length, 1);
    assert.equal(out[0].rel, 'odd');
    assert.ok(out[0].name === null || typeof out[0].name === 'string');
  });
});
