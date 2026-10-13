// test/unit-config.test.js — node --test test/unit-config.test.js
//
// Unit tests for lib/config.js: DEFAULTS, validateConfig (every type class), loadConfig (first-run
// creation, merge, unknown keys, corrupt JSON, EISDIR/ENOTDIR/EACCES), the environment rules
// (SINGULAR_MODE can only lower, SINGULAR_HOME absolute-only), hardenEnv, the four test seams
// (docs/testing.md) and isAllowlisted in every form. No network, no subprocesses.

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
  return fs.mkdtempSync(path.join(base, `unit-config-${label}-`));
}

// Point the process at a throwaway state dir before the first import (lib/log.js reads process.env).
const ROOT = mkTmp('state');
process.env.SINGULAR_HOME = path.join(ROOT, 'singular-home');
process.env.HOME = path.join(ROOT, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

const cfg = await import('../lib/config.js');
const {
  DEFAULTS, MODES, SEAM_VARS, loadConfig, validateConfig, configPath, homeDir, defaultHomeDir, redirectedHome,
  hardenEnv, testSeams, seamRegistryBase, seamGitBase, seamSkillsDir, isAllowlisted,
} = cfg;

after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const plain = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------

describe('DEFAULTS / MODES / SEAM_VARS', () => {
  test('DEFAULTS is frozen, has exactly the documented keys and values, and its arrays are frozen too', () => {
    assert.ok(Object.isFrozen(DEFAULTS));
    assert.ok(Object.isFrozen(DEFAULTS.allowlist) && Object.isFrozen(DEFAULTS.blockedRefs) && Object.isFrozen(DEFAULTS.pinnedSkills));
    assert.deepEqual(Object.keys(DEFAULTS), [
      'mode', 'allowlist', 'installFloor', 'maxLocalSkills', 'maxCandidates', 'minPromptChars', 'remoteTimeoutMs', 'totalBudgetMs',
      'contextBudgetChars', 'cacheTtlHours', 'skillsCliVersion', 'requireAuditPass', 'stackDetection', 'blockedRefs', 'pinnedSkills', 'prefetch',
    ]);
    assert.deepEqual(plain(DEFAULTS), {
      mode: 'suggest',
      allowlist: ['anthropics', 'vercel-labs', 'microsoft', 'multica-ai'],
      installFloor: 1000,
      maxLocalSkills: 3,
      maxCandidates: 2,
      minPromptChars: 40,
      remoteTimeoutMs: 2500,
      totalBudgetMs: 6000,
      contextBudgetChars: 2000,
      cacheTtlHours: 24,
      skillsCliVersion: '1.5.26',
      requireAuditPass: true,
      stackDetection: true,
      blockedRefs: [],
      pinnedSkills: [],
      prefetch: true,
    });
    assert.throws(() => { DEFAULTS.mode = 'auto'; }, TypeError, 'frozen (strict mode ESM)');
    assert.equal(DEFAULTS.mode, 'suggest');
  });

  test('MODES is the privilege ladder off < local < suggest < auto; SEAM_VARS lists the four test seams', () => {
    assert.ok(Object.isFrozen(MODES));
    assert.deepEqual([...MODES], ['off', 'local', 'suggest', 'auto']);
    assert.deepEqual([...SEAM_VARS], ['SINGULAR_REGISTRY_BASE', 'SINGULAR_GIT_BASE', 'SINGULAR_SKILLS_DIR', 'SINGULAR_TEST_ALLOW_AUTO']);
  });
});

// ---------------------------------------------------------------------------

describe('validateConfig (pure)', () => {
  test('empty object -> a fresh copy of DEFAULTS (arrays are new, mutable instances) with no warnings', () => {
    const { config, warnings } = validateConfig({});
    assert.deepEqual(warnings, []);
    assert.deepEqual(plain(config), plain(DEFAULTS));
    assert.notEqual(config.allowlist, DEFAULTS.allowlist, 'not the frozen default array');
    config.allowlist.push('x');
    assert.equal(DEFAULTS.allowlist.length, 4, 'DEFAULTS untouched');
  });

  test('non-object input (null, array, string, number, undefined) -> defaults plus one warning', () => {
    for (const raw of [null, [], 'str', 42, undefined, true]) {
      const { config, warnings } = validateConfig(raw);
      assert.deepEqual(warnings, ['config is not a JSON object; using defaults'], String(raw));
      assert.deepEqual(plain(config), plain(DEFAULTS));
    }
  });

  test('mode: must be one of the four, case-insensitive, normalized to lowercase', () => {
    for (const [v, want] of [['OFF', 'off'], ['Local', 'local'], ['SUGGEST', 'suggest'], ['auto', 'auto']]) {
      const { config, warnings } = validateConfig({ mode: v });
      assert.equal(config.mode, want);
      assert.deepEqual(warnings, []);
    }
    for (const bad of ['yolo', '', 3, null, true, ['auto'], { mode: 'auto' }]) {
      const { config, warnings } = validateConfig({ mode: bad });
      assert.equal(config.mode, 'suggest', JSON.stringify(bad));
      assert.deepEqual(warnings, ['mode: must be one of off|local|suggest|auto; using default "suggest"']);
    }
  });

  test('skillsCliVersion: semver string only (prerelease allowed), never "latest" or a number', () => {
    for (const ok of ['1.5.26', '0.0.1', '2.0.0-beta.1', '10.20.30-rc.1']) {
      const { config, warnings } = validateConfig({ skillsCliVersion: ok });
      assert.equal(config.skillsCliVersion, ok);
      assert.deepEqual(warnings, []);
    }
    for (const bad of ['latest', '1.5', 'v1.5.26', '1.5.26 ', 1, null, '']) {
      const { config, warnings } = validateConfig({ skillsCliVersion: bad });
      assert.equal(config.skillsCliVersion, '1.5.26', JSON.stringify(bad));
      assert.deepEqual(warnings, ['skillsCliVersion: must be a semver string like "1.5.26"; using default "1.5.26"']);
    }
  });

  test('string arrays: trimmed, empties dropped; a non-array or an array with a non-string -> default + warning', () => {
    const { config, warnings } = validateConfig({ allowlist: [' a ', '', 'b/c', '   '], blockedRefs: ['x/y@z'], pinnedSkills: [] });
    assert.deepEqual(config.allowlist, ['a', 'b/c']);
    assert.deepEqual(config.blockedRefs, ['x/y@z']);
    assert.deepEqual(config.pinnedSkills, []);
    assert.deepEqual(warnings, []);
    for (const key of ['allowlist', 'blockedRefs', 'pinnedSkills']) {
      for (const bad of ['a', [1], ['a', null], { 0: 'a' }, null, 7]) {
        const r = validateConfig({ [key]: bad });
        assert.deepEqual(r.config[key], [...DEFAULTS[key]], `${key}=${JSON.stringify(bad)}`);
        assert.equal(r.warnings.length, 1);
        assert.match(r.warnings[0], new RegExp(`^${key}: must be an array of strings; using default `));
      }
    }
  });

  test('numbers: finite and >= 0 (0 allowed); negative, NaN, Infinity, numeric strings and booleans fall back', () => {
    const numeric = ['installFloor', 'maxLocalSkills', 'maxCandidates', 'minPromptChars', 'remoteTimeoutMs', 'totalBudgetMs', 'contextBudgetChars', 'cacheTtlHours'];
    for (const key of numeric) {
      assert.equal(validateConfig({ [key]: 0 }).config[key], 0, `${key}=0 is a valid number`);
      assert.equal(validateConfig({ [key]: 7.5 }).config[key], 7.5);
      assert.deepEqual(validateConfig({ [key]: 7.5 }).warnings, []);
      for (const bad of [-1, NaN, Infinity, -Infinity, '5', true, null, []]) {
        const r = validateConfig({ [key]: bad });
        assert.equal(r.config[key], DEFAULTS[key], `${key}=${String(bad)}`);
        assert.deepEqual(r.warnings, [`${key}: must be a non-negative number; using default ${DEFAULTS[key]}`]);
      }
    }
  });

  test('booleans: only true/false; "yes", 1, null fall back with a warning', () => {
    for (const key of ['requireAuditPass', 'stackDetection', 'prefetch']) {
      assert.equal(validateConfig({ [key]: false }).config[key], false);
      assert.deepEqual(validateConfig({ [key]: false }).warnings, []);
      for (const bad of ['yes', 'true', 1, 0, null, {}]) {
        const r = validateConfig({ [key]: bad });
        assert.equal(r.config[key], DEFAULTS[key], `${key}=${JSON.stringify(bad)}`);
        assert.deepEqual(r.warnings, [`${key}: must be true or false; using default ${DEFAULTS[key]}`]);
      }
    }
  });

  test('unknown keys are kept verbatim; one warning per bad known key, in DEFAULTS order', () => {
    const r = validateConfig({ custom: { nested: [1, 2] }, mode: 'nope', installFloor: 'x', prefetch: 'y', note: 'kept' });
    assert.deepEqual(r.config.custom, { nested: [1, 2] });
    assert.equal(r.config.note, 'kept');
    assert.deepEqual(r.warnings.map((w) => w.split(':')[0]), ['mode', 'installFloor', 'prefetch']);
  });
});

// ---------------------------------------------------------------------------

describe('homeDir / configPath / defaultHomeDir / redirectedHome', () => {
  test('redirectedHome: null when unset, blank or relative; resolved absolute path otherwise (trimmed)', () => {
    assert.equal(redirectedHome({}), null);
    assert.equal(redirectedHome({ SINGULAR_HOME: '' }), null);
    assert.equal(redirectedHome({ SINGULAR_HOME: '   ' }), null);
    assert.equal(redirectedHome({ SINGULAR_HOME: '.scout' }), null);
    assert.equal(redirectedHome({ SINGULAR_HOME: 'a/../../b' }), null);
    assert.equal(redirectedHome({ SINGULAR_HOME: `  ${path.join(ROOT, 'x', '..', 'y')}  ` }), path.join(ROOT, 'y'));
  });

  test('homeDir creates the directory (mkdir -p) and falls back to <HOME>/.claude/singular; mkdir failure still yields the path', () => {
    const dir = path.join(ROOT, 'deep', 'er', 'home');
    assert.equal(homeDir({ SINGULAR_HOME: dir }), dir);
    assert.ok(fs.statSync(dir).isDirectory());
    assert.equal(homeDir({ HOME: path.join(ROOT, 'fakehome') }), path.join(ROOT, 'fakehome', '.claude', 'singular'));
    assert.ok(fs.existsSync(path.join(ROOT, 'fakehome', '.claude', 'singular')));
    assert.equal(configPath({ SINGULAR_HOME: dir }), path.join(dir, 'config.json'));
    assert.equal(defaultHomeDir({ HOME: '/h', SINGULAR_HOME: dir }), path.join('/h', '.claude', 'singular'), 'defaultHomeDir ignores the redirect');
    // a file in the way: mkdir fails (ENOTDIR) but the path is still returned
    const file = path.join(ROOT, 'a-file');
    fs.writeFileSync(file, 'x');
    const under = path.join(file, 'sub');
    assert.equal(homeDir({ SINGULAR_HOME: under }), under);
    assert.ok(!fs.existsSync(under));
  });
});

// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  test('first run: config.json is created from DEFAULTS (pretty JSON + newline) and the result has the non-enumerable diagnostics', () => {
    const env = { SINGULAR_HOME: path.join(ROOT, 'first-run') };
    const c = loadConfig(env);
    assert.deepEqual(plain(c), plain(DEFAULTS));
    const text = fs.readFileSync(configPath(env), 'utf8');
    assert.equal(text, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
    assert.deepEqual(c.warnings, []);
    assert.equal(c.path, configPath(env));
    assert.equal(c.fileMode, 'suggest');
    assert.equal(c.redirected, true);
    for (const k of ['warnings', 'path', 'fileMode', 'redirected']) {
      assert.equal(Object.keys(c).includes(k), false, `${k} is non-enumerable`);
      assert.equal(JSON.stringify(c).includes(`"${k}"`), false);
    }
    // the default location is reported as not redirected
    const d = loadConfig({ HOME: path.join(ROOT, 'home-default') });
    assert.equal(d.redirected, false);
    assert.ok(fs.existsSync(path.join(ROOT, 'home-default', '.claude', 'singular', 'config.json')));
  });

  test('an existing file is never overwritten by the first-run write (flag wx), even when it is partial', () => {
    const env = { SINGULAR_HOME: path.join(ROOT, 'partial') };
    fs.mkdirSync(env.SINGULAR_HOME, { recursive: true });
    fs.writeFileSync(configPath(env), '{"mode":"local"}');
    const c = loadConfig(env);
    assert.equal(c.mode, 'local');
    assert.equal(c.installFloor, 1000, 'missing keys filled from DEFAULTS in memory');
    assert.equal(fs.readFileSync(configPath(env), 'utf8'), '{"mode":"local"}', 'file untouched');
  });

  test('merge: file values win, unknown keys survive, wrong types warn, mode is normalized', () => {
    const env = { SINGULAR_HOME: path.join(ROOT, 'merge') };
    fs.mkdirSync(env.SINGULAR_HOME, { recursive: true });
    fs.writeFileSync(configPath(env), JSON.stringify({ mode: 'LOCAL', allowlist: ['Me'], maxCandidates: 5, prefetch: 'nope', extra: [1] }));
    const c = loadConfig(env);
    assert.equal(c.mode, 'local');
    assert.equal(c.fileMode, 'local');
    assert.deepEqual(c.allowlist, ['Me']);
    assert.equal(c.maxCandidates, 5);
    assert.equal(c.prefetch, true);
    assert.deepEqual(c.extra, [1]);
    assert.deepEqual(c.warnings, ['prefetch: must be true or false; using default true']);
  });

  test('corrupt JSON -> defaults + "not valid JSON" warning; a JSON array -> defaults + "not a JSON object"; file left alone', () => {
    const env = { SINGULAR_HOME: path.join(ROOT, 'corrupt') };
    fs.mkdirSync(env.SINGULAR_HOME, { recursive: true });
    fs.writeFileSync(configPath(env), '{ "mode": ');
    const c = loadConfig(env);
    assert.deepEqual(plain(c), plain(DEFAULTS));
    assert.equal(c.warnings.length, 1);
    assert.match(c.warnings[0], /^config\.json is not valid JSON \(.+\); using defaults$/);
    assert.equal(fs.readFileSync(configPath(env), 'utf8'), '{ "mode": ');
    fs.writeFileSync(configPath(env), '["auto"]');
    const arr = loadConfig(env);
    assert.equal(arr.mode, 'suggest');
    assert.deepEqual(arr.warnings, ['config is not a JSON object; using defaults']);
  });

  test('unreadable config.json (EISDIR, ENOTDIR, EACCES) warns with the code, uses defaults and creates nothing', (t) => {
    const eisdir = path.join(ROOT, 'eisdir');
    fs.mkdirSync(path.join(eisdir, 'config.json'), { recursive: true });
    const c1 = loadConfig({ SINGULAR_HOME: eisdir });
    assert.deepEqual(c1.warnings, ['config.json unreadable (EISDIR); using defaults']);
    assert.ok(fs.statSync(path.join(eisdir, 'config.json')).isDirectory());
    assert.equal(c1.mode, 'suggest');

    const file = path.join(ROOT, 'enotdir-file');
    fs.writeFileSync(file, 'x');
    const c2 = loadConfig({ SINGULAR_HOME: path.join(file, 'home') });
    assert.deepEqual(c2.warnings, ['config.json unreadable (ENOTDIR); using defaults']);
    assert.equal(fs.readFileSync(file, 'utf8'), 'x', 'the file in the way is untouched');

    if (IS_ROOT) { t.diagnostic('running as root: EACCES case skipped'); return; }
    const eacces = path.join(ROOT, 'eacces');
    fs.mkdirSync(eacces, { recursive: true });
    fs.writeFileSync(path.join(eacces, 'config.json'), JSON.stringify({ mode: 'local' }));
    fs.chmodSync(path.join(eacces, 'config.json'), 0o000);
    try {
      const c3 = loadConfig({ SINGULAR_HOME: eacces });
      assert.deepEqual(c3.warnings, ['config.json unreadable (EACCES); using defaults']);
      assert.equal(c3.mode, 'suggest', 'the unreadable "local" is not applied');
    } finally {
      fs.chmodSync(path.join(eacces, 'config.json'), 0o644);
    }
  });

  test('SINGULAR_MODE: every lowering transition is honoured, every raise is refused with a warning, case/whitespace tolerated, invalid values warn', () => {
    const env = { SINGULAR_HOME: path.join(ROOT, 'env-mode') };
    fs.mkdirSync(env.SINGULAR_HOME, { recursive: true });
    for (const fileMode of MODES) {
      // "auto" in a redirected home is downgraded to suggest first; use SINGULAR_TEST_ALLOW_AUTO to test the real ladder
      fs.writeFileSync(configPath(env), JSON.stringify({ mode: fileMode }));
      const base = { ...env, SINGULAR_TEST_ALLOW_AUTO: '1' };
      for (const envMode of MODES) {
        const c = loadConfig({ ...base, SINGULAR_MODE: envMode });
        const lowering = MODES.indexOf(envMode) <= MODES.indexOf(fileMode);
        assert.equal(c.mode, lowering ? envMode : fileMode, `file=${fileMode} env=${envMode}`);
        assert.equal(c.fileMode, fileMode);
        const raiseWarn = c.warnings.find((w) => w.startsWith('SINGULAR_MODE='));
        if (lowering) assert.equal(raiseWarn, undefined, `no warning for file=${fileMode} env=${envMode}`);
        else assert.equal(raiseWarn, `SINGULAR_MODE=${envMode} ignored (the environment can only lower the mode below "${fileMode}")`);
      }
    }
    fs.writeFileSync(configPath(env), JSON.stringify({ mode: 'suggest' }));
    assert.equal(loadConfig({ ...env, SINGULAR_MODE: '  OFF ' }).mode, 'off');
    assert.equal(loadConfig({ ...env, SINGULAR_MODE: 'Local' }).mode, 'local');
    const bad = loadConfig({ ...env, SINGULAR_MODE: 'sometimes' });
    assert.equal(bad.mode, 'suggest');
    assert.deepEqual(bad.warnings, ['SINGULAR_MODE=sometimes ignored (not one of off|local|suggest|auto)']);
    assert.deepEqual(loadConfig({ ...env, SINGULAR_MODE: '' }).warnings, [], 'empty value is ignored silently');
  });

  test('mode "auto": honoured in the default home, downgraded (with a warning) in a redirect, restored only by the SINGULAR_TEST_ALLOW_AUTO=1 seam', () => {
    const home = path.join(ROOT, 'auto-home');
    fs.mkdirSync(path.join(home, '.claude', 'singular'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'singular', 'config.json'), JSON.stringify({ mode: 'auto' }));
    const def = loadConfig({ HOME: home });
    assert.equal(def.mode, 'auto');
    assert.deepEqual(def.warnings, []);
    const redirected = path.join(ROOT, 'auto-redirect');
    fs.mkdirSync(redirected, { recursive: true });
    fs.writeFileSync(path.join(redirected, 'config.json'), JSON.stringify({ mode: 'auto' }));
    const r = loadConfig({ HOME: home, SINGULAR_HOME: redirected });
    assert.equal(r.mode, 'suggest');
    assert.equal(r.fileMode, 'auto');
    assert.deepEqual(r.warnings, [`mode "auto" ignored: it is honoured only in the default ${path.join(home, '.claude', 'singular')}/config.json, not in a SINGULAR_HOME redirect; using "suggest"`]);
    const seamed = loadConfig({ HOME: home, SINGULAR_HOME: redirected, SINGULAR_TEST_ALLOW_AUTO: '1' });
    assert.equal(seamed.mode, 'auto');
    assert.equal(seamed.warnings.length, 1);
    assert.match(seamed.warnings[0], /^TEST SEAM: SINGULAR_TEST_ALLOW_AUTO=1 honours mode "auto" in the redirected .*\(test-only; never set this in a real shell\)$/);
    assert.equal(loadConfig({ HOME: home, SINGULAR_HOME: redirected, SINGULAR_TEST_ALLOW_AUTO: 'true' }).mode, 'suggest', 'only the literal "1"');
    assert.equal(loadConfig({ HOME: home, SINGULAR_HOME: redirected, SINGULAR_TEST_ALLOW_AUTO: '1', SINGULAR_MODE: 'local' }).mode, 'local', 'still lowerable');
  });

  test('SINGULAR_HOME: a relative value is ignored with a warning and the default home is used; whitespace-only is treated as unset', () => {
    const home = path.join(ROOT, 'rel-home');
    const c = loadConfig({ HOME: home, SINGULAR_HOME: 'rel/dir' });
    assert.equal(c.path, path.join(home, '.claude', 'singular', 'config.json'));
    assert.equal(c.redirected, false);
    assert.deepEqual(c.warnings, ['SINGULAR_HOME=rel/dir ignored (must be an absolute path)']);
    assert.ok(!fs.existsSync(path.join(process.cwd(), 'rel', 'dir')), 'nothing created relative to cwd');
    const blank = loadConfig({ HOME: home, SINGULAR_HOME: '   ' });
    assert.deepEqual(blank.warnings, []);
    assert.equal(blank.redirected, false);
  });
});

// ---------------------------------------------------------------------------

describe('hardenEnv', () => {
  test('is pure (input untouched), returns {env, warnings, seams}; nothing to harden -> identical copy and no warnings', () => {
    const input = { HOME: '/tmp/fake-home', SINGULAR_HOME: path.join(ROOT, 'abs'), OTHER: '1' };
    const frozen = JSON.stringify(input);
    const h = hardenEnv(input, { cwd: path.join(ROOT, 'proj') });
    assert.equal(JSON.stringify(input), frozen);
    assert.notEqual(h.env, input);
    assert.deepEqual(h.env, input);
    assert.deepEqual(h.warnings, []);
    assert.deepEqual(h.seams.active, []);
    assert.deepEqual(Object.keys(h).sort(), ['env', 'seams', 'warnings']);
  });

  test('drops a relative SINGULAR_HOME, one inside cwd (also via /tmp -> /private/tmp aliasing), and a foreign HOME inside cwd', () => {
    const proj = path.join(ROOT, 'harden-proj');
    fs.mkdirSync(proj, { recursive: true });
    const rel = hardenEnv({ SINGULAR_HOME: '.scout' }, { cwd: proj });
    assert.equal(rel.env.SINGULAR_HOME, undefined);
    assert.deepEqual(rel.warnings, ['SINGULAR_HOME=.scout ignored (must be an absolute path)']);
    const inside = hardenEnv({ SINGULAR_HOME: path.join(proj, 'state') }, { cwd: proj });
    assert.equal(inside.env.SINGULAR_HOME, undefined);
    assert.deepEqual(inside.warnings, [`SINGULAR_HOME=${path.join(proj, 'state')} ignored (inside the project directory ${proj})`]);
    // the same directory is the cwd itself
    assert.equal(hardenEnv({ SINGULAR_HOME: proj }, { cwd: proj }).env.SINGULAR_HOME, undefined);
    // a sibling that merely shares a prefix is NOT inside
    const sibling = `${proj}-sibling`;
    assert.equal(hardenEnv({ SINGULAR_HOME: sibling }, { cwd: proj }).env.SINGULAR_HOME, sibling);
    // macOS: /tmp is a symlink to /private/tmp; containment must see through it (documented pitfall in docs/testing.md)
    if (fs.existsSync('/tmp') && fs.lstatSync('/tmp').isSymbolicLink()) {
      const real = fs.realpathSync('/tmp');
      const h = hardenEnv({ SINGULAR_HOME: path.join(real, 'singular-x') }, { cwd: '/tmp' });
      assert.equal(h.env.SINGULAR_HOME, undefined, '/private/tmp/x is inside cwd /tmp');
      assert.match(h.warnings[0], /inside the project directory/);
    }
    const fakeHome = path.join(proj, 'fakehome');
    const h2 = hardenEnv({ HOME: fakeHome }, { cwd: proj });
    assert.notEqual(h2.env.HOME, fakeHome);
    assert.ok(path.isAbsolute(h2.env.HOME));
    assert.match(h2.warnings[0], new RegExp(`^HOME=${fakeHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ignored \\(inside the project directory .*\\); using `));
    // without cwd only the absolute-path rule applies
    assert.equal(hardenEnv({ SINGULAR_HOME: path.join(proj, 'state') }).env.SINGULAR_HOME, path.join(proj, 'state'));
    assert.equal(hardenEnv({ HOME: fakeHome }).env.HOME, fakeHome);
  });

  test('drops a SINGULAR_HOME that is an ANCESTOR of cwd (security review 2026-10-08: a checkout named cache or .claude would be the state dir); siblings and the real home stay', () => {
    const parent = path.join(ROOT, 'anc-root');
    const proj = path.join(parent, 'workspaces', 'cache');
    fs.mkdirSync(proj, { recursive: true });
    for (const anc of [path.join(parent, 'workspaces'), parent, '/']) {
      const h = hardenEnv({ SINGULAR_HOME: anc }, { cwd: proj });
      assert.equal(h.env.SINGULAR_HOME, undefined, anc);
      assert.deepEqual(h.warnings, [`SINGULAR_HOME=${anc} ignored (an ancestor of the project directory ${proj})`], anc);
    }
    const sibling = path.join(parent, 'workspaces', 'home');
    assert.equal(hardenEnv({ SINGULAR_HOME: sibling }, { cwd: proj }).env.SINGULAR_HOME, sibling, 'a sibling (the e2e layout) is kept');
    assert.deepEqual(hardenEnv({ SINGULAR_HOME: sibling }, { cwd: proj }).warnings, []);
    // the inside rule still wins its own message
    assert.match(hardenEnv({ SINGULAR_HOME: path.join(proj, 'x') }, { cwd: proj }).warnings[0], /inside the project directory/);
    // without cwd an ancestor cannot be judged: only the absolute rule applies
    assert.equal(hardenEnv({ SINGULAR_HOME: parent }).env.SINGULAR_HOME, parent);
  });

  test('replaces a TMPDIR / TMP / TEMP inside cwd (or relative) by the platform default, so a clone or npx work dir can never sit inside the repository; absolute values elsewhere are kept', () => {
    const proj = path.join(ROOT, 'tmp-proj');
    fs.mkdirSync(path.join(proj, 'tmp'), { recursive: true });
    const expected = process.platform === 'win32' ? undefined : '/tmp';
    for (const k of ['TMPDIR', 'TMP', 'TEMP']) {
      const inside = hardenEnv({ [k]: path.join(proj, 'tmp') }, { cwd: proj });
      if (expected) assert.equal(inside.env[k], expected, k);
      assert.notEqual(inside.env[k], path.join(proj, 'tmp'), k);
      assert.deepEqual(inside.warnings, [`${k}=${path.join(proj, 'tmp')} ignored (inside the project directory ${proj}); using ${inside.env[k]}`]);
      const rel = hardenEnv({ [k]: 'tmp' }, { cwd: proj });
      assert.notEqual(rel.env[k], 'tmp', k);
      assert.match(rel.warnings[0], new RegExp(`^${k}=tmp ignored \\(relative; would resolve inside the project directory `));
      const same = hardenEnv({ [k]: proj }, { cwd: proj });
      assert.notEqual(same.env[k], proj, `${k}: the project itself`);
    }
    const elsewhere = path.join(ROOT, 'tmp-elsewhere');
    assert.equal(hardenEnv({ TMPDIR: elsewhere }, { cwd: proj }).env.TMPDIR, elsewhere, 'an absolute temp dir outside the project is kept');
    assert.deepEqual(hardenEnv({ TMPDIR: elsewhere }, { cwd: proj }).warnings, []);
    assert.equal(hardenEnv({ TMPDIR: path.dirname(proj) }, { cwd: proj }).env.TMPDIR, path.dirname(proj), 'an ancestor is fine for a temp dir: the work dir becomes a sibling of the project, not part of it');
    assert.equal(hardenEnv({ TMPDIR: path.join(proj, 'tmp') }).env.TMPDIR, path.join(proj, 'tmp'), 'no cwd: untouched');
    assert.equal(hardenEnv({}, { cwd: proj }).env.TMPDIR, undefined, 'unset stays unset');
  });

  test('tmpdirOf: the first absolute TMPDIR/TMP/TEMP of the given env, else os.tmpdir(); never the project through a hardened env', () => {
    const { tmpdirOf } = cfg;
    const dir = path.join(ROOT, 'tmp-of');
    if (process.platform !== 'win32') {
      assert.equal(tmpdirOf({ TMPDIR: dir }), dir);
      assert.equal(tmpdirOf({ TMPDIR: `${dir}/` }), dir, 'resolved');
      assert.equal(tmpdirOf({ TMP: dir }), dir, 'TMP is the second choice');
      assert.equal(tmpdirOf({ TMPDIR: 'relative', TEMP: dir }), dir, 'a relative value is skipped');
    }
    assert.equal(tmpdirOf({}), os.tmpdir());
    assert.equal(tmpdirOf(null), os.tmpdir());
    const proj = path.join(ROOT, 'tmp-of-proj');
    fs.mkdirSync(proj, { recursive: true });
    const hardened = hardenEnv({ TMPDIR: path.join(proj, 't') }, { cwd: proj }).env;
    assert.ok(!tmpdirOf(hardened).startsWith(proj + path.sep) && tmpdirOf(hardened) !== proj, tmpdirOf(hardened));
  });

  test('invalid seams are removed from the env and explained; valid seams stay and are announced; both in order', () => {
    const proj = path.join(ROOT, 'seam-proj');
    fs.mkdirSync(proj, { recursive: true });
    const base = path.join(ROOT, 'seam-base'); // a sibling of the project (ROOT itself would be an ancestor and is refused)
    const h = hardenEnv({
      SINGULAR_REGISTRY_BASE: 'https://skills.sh',
      SINGULAR_GIT_BASE: base,
      SINGULAR_SKILLS_DIR: 'relative',
      SINGULAR_TEST_ALLOW_AUTO: '1',
    }, { cwd: proj });
    assert.equal(h.env.SINGULAR_REGISTRY_BASE, undefined);
    assert.equal(h.env.SINGULAR_GIT_BASE, base);
    assert.equal(h.env.SINGULAR_SKILLS_DIR, undefined);
    assert.equal(h.env.SINGULAR_TEST_ALLOW_AUTO, '1');
    assert.deepEqual(h.seams.active, ['SINGULAR_GIT_BASE', 'SINGULAR_TEST_ALLOW_AUTO']);
    assert.deepEqual(h.seams.invalid, ['SINGULAR_REGISTRY_BASE', 'SINGULAR_SKILLS_DIR']);
    assert.equal(h.warnings.length, 4);
    assert.match(h.warnings[0], /^SINGULAR_REGISTRY_BASE=https:\/\/skills\.sh ignored \(test seam, see docs\/testing\.md: only http\(s\):\/\/localhost, 127\.0\.0\.1 or \[::1\] is honoured\)$/);
    assert.match(h.warnings[1], /^SINGULAR_SKILLS_DIR=relative ignored \(test seam, see docs\/testing\.md: must be an absolute path neither inside nor above the project directory\)$/);
    assert.equal(h.warnings[2], `TEST SEAM ACTIVE: SINGULAR_GIT_BASE=${base} (test seam, see docs/testing.md; never set this in a real shell)`);
    assert.equal(h.warnings[3], 'TEST SEAM ACTIVE: SINGULAR_TEST_ALLOW_AUTO=1 (test seam, see docs/testing.md; never set this in a real shell)');
  });
});

// ---------------------------------------------------------------------------

describe('testSeams (docs/testing.md)', () => {
  test('nothing set -> the inert shape; the accessors return null/false', () => {
    assert.deepEqual(testSeams({}), { registryBase: null, gitBase: null, skillsDir: null, allowAuto: false, active: [], invalid: [], warnings: [] });
    assert.deepEqual(testSeams(undefined), testSeams({}));
    assert.deepEqual(testSeams({ SINGULAR_REGISTRY_BASE: '', SINGULAR_GIT_BASE: '  ', SINGULAR_SKILLS_DIR: '', SINGULAR_TEST_ALLOW_AUTO: '' }), testSeams({}), 'blank values are unset');
    assert.equal(seamRegistryBase({}), null);
    assert.equal(seamGitBase({}), null);
    assert.equal(seamSkillsDir({}), null);
  });

  test('SINGULAR_REGISTRY_BASE: loopback http(s) with optional port/path, normalized without a trailing slash; everything else refused', () => {
    const ok = {
      'http://127.0.0.1:4567': 'http://127.0.0.1:4567',
      'http://localhost:4567/': 'http://localhost:4567',
      'https://localhost': 'https://localhost',
      'HTTP://LOCALHOST:1/a/b//': 'http://localhost:1/a/b',
      'http://[::1]:8080/prefix/': 'http://[::1]:8080/prefix',
      '  http://127.0.0.1:9  ': 'http://127.0.0.1:9',
    };
    for (const [input, want] of Object.entries(ok)) {
      const s = testSeams({ SINGULAR_REGISTRY_BASE: input });
      assert.equal(s.registryBase, want, input);
      assert.deepEqual(s.active, ['SINGULAR_REGISTRY_BASE']);
      assert.deepEqual(s.invalid, []);
      assert.equal(seamRegistryBase({ SINGULAR_REGISTRY_BASE: input }), want);
    }
    for (const bad of ['https://skills.sh', 'http://evil.example', 'http://127.0.0.1.evil.example', 'http://localhost.evil', 'ftp://localhost', 'file:///tmp', 'localhost:4567', 'http://localhost/?x=1', 'http://localhost/#frag', 'http://user:pw@evil.example', 'nonsense', 'http://10.0.0.1', 'http://0.0.0.0']) {
      const s = testSeams({ SINGULAR_REGISTRY_BASE: bad });
      assert.equal(s.registryBase, null, bad);
      assert.deepEqual(s.active, [], bad);
      assert.deepEqual(s.invalid, ['SINGULAR_REGISTRY_BASE'], bad);
      assert.equal(s.warnings.length, 1);
      assert.match(s.warnings[0], /^SINGULAR_REGISTRY_BASE=.* ignored \(test seam, see docs\/testing\.md: only http\(s\):\/\/localhost, 127\.0\.0\.1 or \[::1\] is honoured\)$/, bad);
    }
  });

  test('SINGULAR_GIT_BASE: absolute local path or file:// URL (localhost host allowed), outside cwd, trailing slashes dropped; http(s) and in-project values refused', () => {
    const proj = path.join(ROOT, 'git-proj');
    const base = path.join(ROOT, 'git-base');
    fs.mkdirSync(path.join(proj, 'inner'), { recursive: true });
    fs.mkdirSync(base, { recursive: true });
    assert.equal(testSeams({ SINGULAR_GIT_BASE: base }, { cwd: proj }).gitBase, base);
    assert.equal(testSeams({ SINGULAR_GIT_BASE: `${base}///` }, { cwd: proj }).gitBase, base);
    assert.equal(testSeams({ SINGULAR_GIT_BASE: `file://${base}/` }, { cwd: proj }).gitBase, `file://${base}`);
    assert.equal(testSeams({ SINGULAR_GIT_BASE: `FILE://localhost${base}` }, { cwd: proj }).gitBase, `file://${base}`);
    assert.equal(testSeams({ SINGULAR_GIT_BASE: `file://${encodeURI(path.join(ROOT, 'with space'))}` }, { cwd: proj }).gitBase, `file://${path.join(ROOT, 'with space')}`, 'percent-decoded');
    assert.equal(testSeams({ SINGULAR_GIT_BASE: base }).gitBase, base, 'no cwd: only the absolute rule');
    assert.equal(seamGitBase({ SINGULAR_GIT_BASE: base }), base);
    const active = testSeams({ SINGULAR_GIT_BASE: base }, { cwd: proj });
    assert.deepEqual(active.active, ['SINGULAR_GIT_BASE']);
    assert.deepEqual(active.warnings, [`TEST SEAM ACTIVE: SINGULAR_GIT_BASE=${base} (test seam, see docs/testing.md; never set this in a real shell)`]);
    // Observation (not asserted): a bare "file://" normalizes to the filesystem root "/" and is accepted as a local base.
    // an ANCESTOR of the project is refused too (security review 2026-10-08): <base>/<owner>/<repo> could then be a sibling checkout
    // named after an allowlisted owner, or the project itself, and be served as that owner's repository
    for (const bad of ['https://github.com', 'http://localhost/git', 'https://evil.example/x', 'relative/dir', './here', 'file://evil.example/x', path.join(proj, 'inner'), proj, `file://${path.join(proj, 'inner')}`, 'git@github.com:a/b.git', path.dirname(proj), `file://${path.dirname(proj)}`, path.dirname(path.dirname(proj)), '/', 'file:///']) {
      const s = testSeams({ SINGULAR_GIT_BASE: bad }, { cwd: proj });
      assert.equal(s.gitBase, null, bad);
      assert.deepEqual(s.invalid, ['SINGULAR_GIT_BASE'], bad);
      assert.match(s.warnings[0], /^SINGULAR_GIT_BASE=.* ignored \(test seam, see docs\/testing\.md: must be an absolute local path or file:\/\/ URL neither inside nor above the project directory; remote hosts are never honoured\)$/, bad);
    }
    // the worked attack: base = the parent of the cwd, project checked out as <parent>/anthropics with skills/ inside
    const parent = path.join(ROOT, 'anc-workspaces');
    const checkout = path.join(parent, 'anthropics');
    fs.mkdirSync(path.join(checkout, 'skills'), { recursive: true });
    const anc = testSeams({ SINGULAR_GIT_BASE: parent }, { cwd: checkout });
    assert.equal(anc.gitBase, null, 'an ancestor base is refused');
    assert.deepEqual(anc.active, []);
    assert.equal(hardenEnv({ SINGULAR_GIT_BASE: parent }, { cwd: checkout }).env.SINGULAR_GIT_BASE, undefined, 'hardenEnv drops it');
    assert.equal(testSeams({ SINGULAR_GIT_BASE: path.join(parent, '..', 'sibling-base') }, { cwd: checkout }).gitBase, path.join(ROOT, 'sibling-base'), 'a sibling of the parent is still fine (where the e2e git base lives)');
  });

  test('SINGULAR_SKILLS_DIR: absolute and outside cwd (resolved); relative or in-project refused', () => {
    const proj = path.join(ROOT, 'skills-proj');
    fs.mkdirSync(proj, { recursive: true });
    const dir = path.join(ROOT, 'alt-skills');
    assert.equal(testSeams({ SINGULAR_SKILLS_DIR: `${dir}/` }, { cwd: proj }).skillsDir, dir);
    assert.equal(testSeams({ SINGULAR_SKILLS_DIR: path.join(dir, '..', 'alt-skills') }, { cwd: proj }).skillsDir, dir);
    assert.equal(seamSkillsDir({ SINGULAR_SKILLS_DIR: dir }), dir);
    for (const bad of ['skills', '../x', path.join(proj, 'skills'), proj, path.dirname(proj), '/']) {
      const s = testSeams({ SINGULAR_SKILLS_DIR: bad }, { cwd: proj });
      assert.equal(s.skillsDir, null, bad);
      assert.deepEqual(s.invalid, ['SINGULAR_SKILLS_DIR']);
      assert.match(s.warnings[0], /^SINGULAR_SKILLS_DIR=.* ignored \(test seam, see docs\/testing\.md: must be an absolute path neither inside nor above the project directory\)$/);
    }
  });

  test('SINGULAR_TEST_ALLOW_AUTO: only the literal "1"', () => {
    const on = testSeams({ SINGULAR_TEST_ALLOW_AUTO: '1' });
    assert.equal(on.allowAuto, true);
    assert.deepEqual(on.active, ['SINGULAR_TEST_ALLOW_AUTO']);
    assert.deepEqual(on.warnings, ['TEST SEAM ACTIVE: SINGULAR_TEST_ALLOW_AUTO=1 (test seam, see docs/testing.md; never set this in a real shell)']);
    assert.equal(testSeams({ SINGULAR_TEST_ALLOW_AUTO: ' 1 ' }).allowAuto, true, 'trimmed');
    for (const bad of ['true', 'yes', '0', '11', 'on']) {
      const s = testSeams({ SINGULAR_TEST_ALLOW_AUTO: bad });
      assert.equal(s.allowAuto, false, bad);
      assert.deepEqual(s.invalid, ['SINGULAR_TEST_ALLOW_AUTO']);
      assert.deepEqual(s.warnings, [`SINGULAR_TEST_ALLOW_AUTO=${bad} ignored (test seam, see docs/testing.md: only "1" is honoured)`]);
    }
  });

  test('all four at once: active list keeps variable order, one announcement per active seam, drops explained first', () => {
    const base = path.join(ROOT, 'all-base');
    fs.mkdirSync(base, { recursive: true });
    const s = testSeams({ SINGULAR_REGISTRY_BASE: 'http://localhost:1', SINGULAR_GIT_BASE: base, SINGULAR_SKILLS_DIR: 'bad', SINGULAR_TEST_ALLOW_AUTO: '1' });
    assert.deepEqual(s.active, ['SINGULAR_REGISTRY_BASE', 'SINGULAR_GIT_BASE', 'SINGULAR_TEST_ALLOW_AUTO']);
    assert.deepEqual(s.invalid, ['SINGULAR_SKILLS_DIR']);
    assert.equal(s.warnings.length, 4);
    assert.match(s.warnings[0], /^SINGULAR_SKILLS_DIR=bad ignored/);
    assert.deepEqual(s.warnings.slice(1).map((w) => w.split('=')[0]), ['TEST SEAM ACTIVE: SINGULAR_REGISTRY_BASE', 'TEST SEAM ACTIVE: SINGULAR_GIT_BASE', 'TEST SEAM ACTIVE: SINGULAR_TEST_ALLOW_AUTO']);
  });
});

// ---------------------------------------------------------------------------

describe('isAllowlisted', () => {
  test('owner entries match any repo of that owner; owner/repo entries match exactly; case-insensitive; slashes and whitespace trimmed', () => {
    const list = ['Anthropics', ' vercel-labs/Agent-Skills ', '/microsoft/', '', '   ', '//multica-ai//'];
    assert.equal(isAllowlisted('anthropics/skills', list), true);
    assert.equal(isAllowlisted('ANTHROPICS/anything', list), true);
    assert.equal(isAllowlisted('anthropics', list), true, 'bare owner as source');
    assert.equal(isAllowlisted(' /anthropics/skills/ ', list), true, 'source trimmed too');
    assert.equal(isAllowlisted('vercel-labs/agent-skills', list), true);
    assert.equal(isAllowlisted('VERCEL-LABS/AGENT-SKILLS', list), true);
    assert.equal(isAllowlisted('vercel-labs/other', list), false, 'repo entry does not cover the owner');
    assert.equal(isAllowlisted('vercel-labs', list), false, 'bare owner does not match a repo entry');
    assert.equal(isAllowlisted('microsoft/x', list), true);
    assert.equal(isAllowlisted('multica-ai/andrej-karpathy-skills', list), true);
    assert.equal(isAllowlisted('anthropics-evil/skills', list), false, 'prefix is not a match');
    assert.equal(isAllowlisted('evil/anthropics', list), false, 'owner position only');
    assert.equal(isAllowlisted('anthropics/skills/extra', list), true, 'an owner entry matches by owner segment');
    assert.equal(isAllowlisted('vercel-labs/agent-skills/extra', list), false, 'a repo entry needs an exact source');
  });

  test('degenerate inputs never throw: empty/null source, non-array or null allowlist, non-string entries', () => {
    assert.equal(isAllowlisted('', ['anthropics']), false);
    assert.equal(isAllowlisted('   ', ['anthropics']), false);
    assert.equal(isAllowlisted(null, ['anthropics']), false);
    assert.equal(isAllowlisted(undefined, ['anthropics']), false);
    assert.equal(isAllowlisted('/', ['anthropics']), false);
    assert.equal(isAllowlisted('anthropics/skills', null), false);
    assert.equal(isAllowlisted('anthropics/skills', 'anthropics'), false, 'a string is not a list');
    assert.equal(isAllowlisted('anthropics/skills', []), false);
    assert.equal(isAllowlisted('anthropics/skills', [null, 42, undefined, 'anthropics']), true, 'non-string entries skipped');
    assert.equal(isAllowlisted('42/x', [42]), true, 'a numeric entry is stringified');
  });
});
