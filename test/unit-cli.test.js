// test/unit-cli.test.js — node --test test/unit-cli.test.js
//
// lib/cli-core.js (the `singular` binary) driven entirely through its injectable deps: a fake `claude` behind
// execFileImpl that keeps marketplace + plugin state in memory and answers exactly like Claude Code 2.1.296 does
// (text and --json forms captured on 2026-10-13), a fake spawn for the proxies, a fixture package directory under
// the scratch dir, and HOME pointed at scratch homes. No real `claude`, no network; nothing under the real
// ~/.claude is read or written (HOME is overridden in every env handed to the code, and lib/log.js is never called).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRATCH_ROOT = process.env.SINGULAR_TEST_TMP
  || '/private/tmp/claude-501/-Users-nitya--superset-projects-claude-skills/cfa575e5-ae3c-4522-b59f-cd3623c88bf0/scratchpad';

function mkTmp(label) {
  let base = SCRATCH_ROOT;
  try { fs.mkdirSync(base, { recursive: true }); } catch { base = os.tmpdir(); }
  return fs.mkdtempSync(path.join(base, `unit-cli-${label}-`));
}
const AGENT = mkTmp('world');
// lib/config.js and lib/log.js resolve paths from the env they are handed; the CLI hands them deps.env, never
// process.env. Point process.env at scratch anyway so nothing could ever reach the real ~/.claude.
process.env.HOME = path.join(AGENT, 'process-home');
process.env.SINGULAR_HOME = path.join(AGENT, 'process-state');
fs.mkdirSync(process.env.HOME, { recursive: true });

after(() => {
  try { fs.rmSync(AGENT, { recursive: true, force: true }); } catch { /* ignore */ }
});

const core = await import('../lib/cli-core.js');
const {
  runCli, parseArgs, parseVersion, compareVersions, checkEnvironment, statePaths, guardPayloadDir, copyPayload, install, uninstall,
  collectCliStatus, formatCliStatus, diagnose, doctor, status, proxy, proxyTarget, marketplaceState, pluginState, parseJsonLoose,
  PAYLOAD_ENTRIES, REQUIRED_ENTRIES, DONE_LINE, PLUGIN_ID, MARKETPLACE, MIN_CLAUDE_VERSION, HELP, CliError,
} = core;

// ---------------------------------------------------------------------------
// fixtures: a package directory, fresh homes, the fake claude, output capture
// ---------------------------------------------------------------------------

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

let pkgN = 0;
/** A minimal but complete singular package directory (what npm installs), with a test/ folder that must never be copied. */
function makePackage(label, { version = '0.2.0', omit = [], pluginName = 'singular', marketplaceName = 'singular' } = {}) {
  const root = path.join(AGENT, 'pkg', `${label}-${++pkgN}`);
  write(path.join(root, '.claude-plugin', 'plugin.json'), { name: pluginName, displayName: 'Singular', version, hooks: './hooks/hooks.json' });
  write(path.join(root, '.claude-plugin', 'marketplace.json'), { name: marketplaceName, owner: { name: 't' }, plugins: [{ name: pluginName, source: './', version }] });
  write(path.join(root, 'hooks', 'hooks.json'), { hooks: {} });
  write(path.join(root, 'skills', 'singular', 'SKILL.md'), '---\nname: singular\n---\n# singular\n');
  write(path.join(root, 'bin', 'singular.js'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  write(path.join(root, 'bin', 'on-expand.js'), '#!/usr/bin/env node\nconsole.log("expand " + process.argv.slice(2).join(" "));\n');
  write(path.join(root, 'bin', 'on-prompt.js'), '// hook\n');
  write(path.join(root, 'lib', 'x.js'), 'export const x = 1;\n');
  write(path.join(root, 'package.json'), { name: 'singular-skill', version, type: 'module' });
  write(path.join(root, 'LICENSE'), 'MIT\n');
  write(path.join(root, 'README.md'), '# singular\n');
  write(path.join(root, 'config.example.json'), '{}\n');
  write(path.join(root, 'test', 'never-copied.test.js'), '// not payload\n');
  write(path.join(root, 'research', 'notes.md'), '# not payload\n');
  for (const o of omit) fs.rmSync(path.join(root, o), { recursive: true, force: true });
  return root;
}

let homeN = 0;
function freshHome(label) {
  const dir = path.join(AGENT, 'homes', `${label}-${++homeN}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * In-memory Claude Code: marketplaces {name: path}, plugins {id: {version, enabled, path}}, every call recorded.
 * `fail(cmdString)` injects a failure for matching commands; `missing` simulates no `claude` on PATH;
 * `jsonLists=false` answers the --json listings the way an older CLI would (unknown option, exit 1).
 */
function fakeClaude(state) {
  state.calls = [];
  state.marketplaces ??= {};
  state.plugins ??= {};
  state.version ??= '2.1.296';
  const manifestOf = (dir) => { try { return readJson(path.join(dir, '.claude-plugin', 'plugin.json')); } catch { return null; } };
  return function execFileImpl(file, args, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    state.calls.push({ file, args: [...args], env: opts?.env });
    const done = (code, stdout = '', stderr = '') => {
      const err = code === 0 ? null : Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}`), { code });
      setImmediate(() => cb(err, stdout, stderr));
      return {};
    };
    if (file !== 'claude') return done(127, '', `${file}: not a fake`);
    if (state.missing) {
      setImmediate(() => cb(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawn claude', path: 'claude' }), '', ''));
      return {};
    }
    const cmd = args.join(' ');
    if (typeof state.fail === 'function' && state.fail(cmd)) return done(1, '', `✘ Failed: injected failure for \`claude ${cmd}\``);
    if (cmd === '--version') return done(0, state.versionText ?? `${state.version} (Claude Code)\n`);
    const [a0, a1, a2, a3] = args;
    if (a0 !== 'plugin') return done(1, '', `error: unknown command '${a0}'`);
    const mkEntries = () => Object.entries(state.marketplaces);
    if (a1 === 'marketplace') {
      if (a2 === 'list' && a3 === '--json') {
        if (state.jsonLists === false) return done(1, '', "error: unknown option '--json'");
        return done(0, `${JSON.stringify(mkEntries().map(([name, p]) => ({ name, source: 'directory', path: p, installLocation: p })), null, 2)}\n`);
      }
      if (a2 === 'list') return done(0, `Configured marketplaces:\n\n  ❯ anthropic-plugin-directory\n    Source: Built in (Anthropic Directory)\n\n${mkEntries().map(([n, p]) => `  ❯ ${n}\n    Source: Folder (${p})\n`).join('\n')}\n`);
      if (a2 === 'add') {
        const p = a3;
        if (!fs.existsSync(path.join(p, '.claude-plugin', 'marketplace.json'))) return done(1, '', `✘ Failed to add marketplace: ${p} has no .claude-plugin/marketplace.json`);
        const name = readJson(path.join(p, '.claude-plugin', 'marketplace.json')).name;
        const prev = state.marketplaces[name];
        state.marketplaces[name] = p;
        if (prev && prev === p) return done(0, `Adding marketplace…✔ Marketplace '${name}' already on disk — declared in user settings\n`);
        if (prev) return done(0, `Adding marketplace…✔ Successfully added marketplace: ${name} (declared in user settings)\n  Marketplace '${name}' was already added from dir:${prev} and now points at dir:${p}.\n  Plugins already installed from it now update from the new source. To undo, add the previous source again.\n`);
        return done(0, `Adding marketplace…✔ Successfully added marketplace: ${name} (declared in user settings)\n`);
      }
      if (a2 === 'update') {
        if (!state.marketplaces[a3]) return done(1, '', `✘ Failed to update marketplace(s): Marketplace '${a3}' not found. Available marketplaces: ${Object.keys(state.marketplaces).join(', ')}, anthropic-plugin-directory\n`);
        if (!fs.existsSync(state.marketplaces[a3])) return done(1, '', `✘ Failed to update marketplace(s): Failed to refresh marketplace '${a3}': ENOENT: no such file or directory, open '${state.marketplaces[a3]}'\n`);
        return done(0, `Updating marketplace: ${a3}...Validating local marketplace\n✔ Successfully updated marketplace: ${a3}\n`);
      }
      if (a2 === 'remove') {
        if (!state.marketplaces[a3]) return done(1, '', `✘ Failed to remove marketplace: Marketplace '${a3}' not found\n`);
        delete state.marketplaces[a3];
        return done(0, `✔ Successfully removed marketplace: ${a3}\n`);
      }
      return done(1, '', `error: unknown command '${cmd}'`);
    }
    const plEntries = () => Object.entries(state.plugins);
    if (a1 === 'list' && a2 === '--json') {
      if (state.jsonLists === false) return done(1, '', "error: unknown option '--json'");
      return done(0, `${JSON.stringify(plEntries().map(([id, p]) => ({ id, version: p.version, scope: 'user', enabled: p.enabled, installPath: `/cfg/plugins/cache/${id.replace('@', '/')}/${p.version}`, readFromFolder: p.path, folderVersion: p.version, projectEnabled: false, ...(p.errors ? { errors: p.errors } : {}) })), null, 2)}\n`);
    }
    if (a1 === 'list') return done(0, `Installed plugins:\n\n${plEntries().map(([id, p]) => `  ❯ ${id}\n    Version: ${p.version}\n    Read from: ${p.path}\n    Scope: user\n    Status: ${p.enabled ? '✔ enabled' : '✘ disabled'}\n`).join('\n')}\n`);
    const id = a2;
    const [name, mk] = String(id ?? '').split('@');
    if (a1 === 'install') {
      if (!state.marketplaces[mk]) return done(1, '', `✘ Failed to install plugin "${id}": Marketplace "${mk}" not found\n`);
      const dir = state.marketplaces[mk];
      const manifest = manifestOf(dir);
      if (!manifest || manifest.name !== name) return done(1, '', `✘ Failed to install plugin "${id}": Plugin "${name}" not found in marketplace "${mk}". Your local copy may be out of date — try \`claude plugin marketplace update ${mk}\`.\n`);
      if (state.plugins[id]) return done(0, `Plugin "${id}" is already installed (scope: user) — it loads in place from ${dir}, so edits there take effect at the next session start or /reload-plugins\n`);
      state.plugins[id] = { version: manifest.version, enabled: true, path: dir };
      return done(0, `Installing plugin "${id}"...✔ Successfully installed plugin: ${id} (scope: user)\n`);
    }
    if (a1 === 'update') {
      if (!state.plugins[id]) return done(1, '', `✘ Failed to update plugin "${id}": Plugin "${name}" not found\n`);
      const manifest = manifestOf(state.plugins[id].path);
      if (!manifest) return done(1, '', `✘ Failed to update plugin "${id}": Plugin "${name}" not found\n`);
      state.plugins[id].version = manifest.version;
      return done(0, `Checking for updates for plugin "${id}"…\n${name} is read from its folder, ${state.plugins[id].path}: nothing to update. Edits there take effect at the next session start or /reload-plugins.\n✔ ${name} is already at the latest version (${manifest.version}).\n`);
    }
    if (a1 === 'uninstall') {
      if (!state.plugins[id]) return done(1, '', `✘ Failed to uninstall plugin "${id}": Plugin "${id}" not found in installed plugins\n`);
      delete state.plugins[id];
      return done(0, `✔ Successfully uninstalled plugin: ${name} (scope: user)\n`);
    }
    if (a1 === 'enable' || a1 === 'disable') {
      if (!state.plugins[id]) return done(1, '', `✘ Failed to ${a1} plugin "${id}": Plugin "${id}" not found\n`);
      state.plugins[id].enabled = a1 === 'enable';
      return done(0, `✔ Successfully ${a1}d plugin: ${name} (scope: user)\n`);
    }
    return done(1, '', `error: unknown command '${cmd}'`);
  };
}

/** A fake spawn for the proxies: records argv, emits `close` with the configured code. */
function fakeSpawn(record, { code = 0, error = null } = {}) {
  return function spawnImpl(file, argv, opts) {
    record.push({ file, argv: [...argv], opts });
    const handlers = {};
    const child = { on(ev, fn) { handlers[ev] = fn; return child; } };
    setImmediate(() => {
      if (error) handlers.error?.(error);
      else handlers.close?.(code, null);
    });
    return child;
  };
}

/** deps for one scenario: scratch HOME, the fake claude, captured output. Returns {deps, state, out, err, home, pkg, calls()}. */
function scenario(label, { pkg, state = {}, nodeVersion = '26.5.0', env = {}, spawnRecord = [], spawnOpts = {}, fsOverrides = null } = {}) {
  const home = freshHome(label);
  const root = pkg ?? makePackage(label);
  const out = [];
  const err = [];
  const execFileImpl = fakeClaude(state);
  const deps = {
    env: { HOME: home, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: path.join(home, 'cfg'), ...env },
    fs,
    execFileImpl,
    spawnImpl: fakeSpawn(spawnRecord, spawnOpts),
    execPath: '/fake/node',
    nodeVersion,
    packageRoot: root,
    homedir: () => home,
    stdout: (s) => out.push(String(s)),
    stderr: (s) => err.push(String(s)),
    ...(fsOverrides ? { fs: { ...fs, ...fsOverrides } } : {}),
  };
  return { deps, state, home, pkg: root, spawnRecord, stdout: () => out.join(''), stderr: () => err.join(''), calls: () => state.calls.map((c) => `${c.file} ${c.args.join(' ')}`), payload: path.join(home, '.claude', 'singular', 'plugin') };
}

const MUTATING_RE = /^claude plugin (marketplace (add|update|remove)|install|update|uninstall|enable|disable)\b/;

// ---------------------------------------------------------------------------

describe('argv', () => {
  test('commands, flags, proxies pass their arguments through verbatim, unknown input is an error', () => {
    assert.equal(parseArgs([]).help, true);
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['help']).help, true);
    assert.equal(parseArgs(['-v']).version, true);
    assert.deepEqual(parseArgs(['install', '--dir', '/x', '--dry-run', '--json']), { command: 'install', dir: '/x', dryRun: true, json: true, purge: false, help: false, version: false, rest: [], errors: [] });
    assert.equal(parseArgs(['install', '--dir=/y']).dir, '/y');
    assert.deepEqual(parseArgs(['uninstall', '--purge']).errors, []);
    assert.deepEqual(parseArgs(['find', 'playwright', 'flaky', '--limit', '3', '--json']).rest, ['playwright', 'flaky', '--limit', '3', '--json']);
    assert.deepEqual(parseArgs(['load', 'a/b@c', '--update']).rest, ['a/b@c', '--update']);
    assert.deepEqual(parseArgs(['add', 'a/b@c', '--yes']).rest, ['a/b@c', '--yes']);
    assert.deepEqual(parseArgs(['mode']).rest, []);
    assert.deepEqual(parseArgs(['init', '--apply', '1,3', '--project', '--cwd', '/p']).rest, ['--apply', '1,3', '--project', '--cwd', '/p'], 'init is proxied verbatim (its options are not CLI options)');
    assert.match(parseArgs(['bogus']).errors[0], /unknown command "bogus"/);
    assert.match(parseArgs(['--bogus']).errors[0], /unknown option --bogus/);
    assert.match(parseArgs(['status', '--purge']).errors[0], /--purge applies to uninstall only/);
    assert.match(parseArgs(['status', '--dry-run']).errors[0], /--dry-run applies to install/);
    assert.match(parseArgs(['install', '--dir']).errors[0], /--dir needs a path/);
    assert.match(parseArgs(['install', 'extra']).errors[0], /unexpected argument "extra"/);
  });

  test('runCli: --help prints the usage (exit 0), -v the package version, an unknown command exits 1 with the usage on stderr', async () => {
    const s = scenario('argv');
    assert.equal(await runCli(['--help'], s.deps), 0);
    assert.equal(s.stdout(), HELP);
    for (const re of [/^Usage: singular <command> \[options\]$/m, /^  install \[--dir <path>\] \[--dry-run\] \[--json\]/m, /^  update\b/m, /^  uninstall \[--purge\]/m, /^  status \[--json\]/m, /^  doctor\b/m, /^  find <query>/m, /^  add <owner\/repo\[#sha\]@skill> \[--yes\]/m, /^  mode \[off\|local\|suggest\|auto\]/m, /^  init \[--no-remote\] \[--json\] \[--cwd <dir>\]/m, /^  init --apply <1,3\|1-3\|all> \[--project\]/m, /^  load <owner\/repo\[#sha\]@skill> \[--update\]/m, /CLAUDE_CONFIG_DIR is passed through/]) assert.match(HELP, re);
    const v = scenario('argv-v');
    assert.equal(await runCli(['-v'], v.deps), 0);
    assert.equal(v.stdout(), '0.2.0\n');
    const b = scenario('argv-bad');
    assert.equal(await runCli(['bogus'], b.deps), 1);
    assert.match(b.stderr(), /^singular: unknown command "bogus"\n\nsingular — install/);
    assert.equal(b.stdout(), '');
    assert.deepEqual(b.calls(), [], 'nothing runs for a bad command');
  });
});

describe('versions', () => {
  test('parseVersion / compareVersions', () => {
    assert.deepEqual(parseVersion('2.1.296 (Claude Code)'), { major: 2, minor: 1, patch: 296, text: '2.1.296' });
    assert.equal(parseVersion('v26.5.0').text, '26.5.0');
    assert.equal(parseVersion('nope'), null);
    assert.ok(compareVersions('2.1.296', '2.1.282') > 0);
    assert.equal(compareVersions('2.1.282', '2.1.282'), 0);
    assert.ok(compareVersions('2.0.999', '2.1.282') < 0);
    assert.ok(compareVersions('1.9.9', '2.1.282') < 0);
    assert.ok(Number.isNaN(compareVersions('x', '2.1.282')));
    assert.equal(MIN_CLAUDE_VERSION, '2.1.282');
  });

  test('checkEnvironment: node too old, claude missing, claude too old, claude unparseable, all good', async () => {
    const old = scenario('env-node', { nodeVersion: '18.20.4' });
    let r = await checkEnvironment(old.deps);
    assert.equal(r.node.ok, false);
    assert.match(r.problems[0], /Node >= 20 is required \(found 18\.20\.4\)/);
    assert.equal(r.claude.ok, true, 'claude is still probed so every problem is reported at once');

    const missing = scenario('env-missing', { state: { missing: true } });
    r = await checkEnvironment(missing.deps);
    assert.equal(r.claude.found, false);
    assert.match(r.problems[0], /claude is not on PATH\. Install Claude Code first/);

    const tooOld = scenario('env-old', { state: { version: '2.1.100' } });
    r = await checkEnvironment(tooOld.deps);
    assert.equal(r.claude.found, true);
    assert.equal(r.claude.version, '2.1.100');
    assert.equal(r.claude.ok, false);
    assert.match(r.problems[0], /Claude Code >= 2\.1\.282 is required \(found 2\.1\.100\)\. Run `claude update`/);

    const weird = scenario('env-weird', { state: { versionText: 'Claude Code\n' } });
    r = await checkEnvironment(weird.deps);
    assert.equal(r.claude.found, true);
    assert.equal(r.claude.version, null);
    assert.match(r.problems[0], /could not parse `claude --version` output/);

    const ok = scenario('env-ok');
    r = await checkEnvironment(ok.deps);
    assert.deepEqual(r.problems, []);
    assert.equal(r.claude.version, '2.1.296');
    assert.equal(r.claude.ok, true);
    assert.deepEqual(ok.calls(), ['claude --version']);
    assert.equal(ok.state.calls[0].env.CLAUDE_CONFIG_DIR, ok.deps.env.CLAUDE_CONFIG_DIR, 'the environment is passed through to claude unchanged');
    assert.equal(ok.state.calls[0].env.HOME, ok.home);
  });
});

describe('payload copy', () => {
  test('statePaths: ~/.claude/singular/plugin from HOME; --dir overrides the payload only', () => {
    const s = scenario('paths');
    const p = statePaths(s.deps);
    assert.equal(p.stateDir, path.join(s.home, '.claude', 'singular'));
    assert.equal(p.payloadDir, path.join(s.home, '.claude', 'singular', 'plugin'));
    assert.equal(p.tmpDir, `${p.payloadDir}.tmp`);
    assert.equal(p.prevDir, `${p.payloadDir}.prev`);
    const q = statePaths(s.deps, { dir: path.join(s.home, 'elsewhere') });
    assert.equal(q.payloadDir, path.join(s.home, 'elsewhere'));
    assert.equal(q.stateDir, p.stateDir);
  });

  test('guardPayloadDir refuses the root, the home (or an ancestor of it), the package itself and a foreign non-empty folder', () => {
    const s = scenario('guard');
    const home = s.home;
    assert.throws(() => guardPayloadDir(s.deps, statePaths(s.deps, { dir: '/' })), /filesystem root/);
    assert.throws(() => guardPayloadDir(s.deps, statePaths(s.deps, { dir: home })), /home directory/);
    assert.throws(() => guardPayloadDir(s.deps, statePaths(s.deps, { dir: path.dirname(home) })), /home directory/);
    assert.throws(() => guardPayloadDir(s.deps, statePaths(s.deps, { dir: s.pkg })), /onto itself/);
    assert.throws(() => guardPayloadDir(s.deps, statePaths(s.deps, { dir: path.join(s.pkg, 'bin') })), /onto itself/);
    assert.throws(() => guardPayloadDir(s.deps, statePaths(s.deps, { dir: path.dirname(s.pkg) })), /onto itself/);
    const foreign = path.join(home, 'foreign');
    write(path.join(foreign, 'notes.txt'), 'mine');
    assert.throws(() => guardPayloadDir(s.deps, statePaths(s.deps, { dir: foreign })), /not a singular payload/);
    fs.mkdirSync(path.join(home, 'empty'));
    assert.doesNotThrow(() => guardPayloadDir(s.deps, statePaths(s.deps, { dir: path.join(home, 'empty') })), 'an empty folder is fine');
    assert.doesNotThrow(() => guardPayloadDir(s.deps, statePaths(s.deps)), 'the default location is fine');
  });

  test('first copy: every payload entry lands in ~/.claude/singular/plugin, test/ and research/ do not, no .prev, .tmp gone', () => {
    const s = scenario('copy');
    const paths = statePaths(s.deps);
    const plan = copyPayload(s.deps, paths);
    assert.deepEqual(plan.entries, [...PAYLOAD_ENTRIES]);
    assert.deepEqual(plan.skipped, []);
    assert.equal(plan.replaced, false);
    assert.equal(plan.previousVersion, null);
    assert.equal(plan.newVersion, '0.2.0');
    for (const e of PAYLOAD_ENTRIES) assert.ok(fs.existsSync(path.join(s.payload, e)), e);
    assert.ok(!fs.existsSync(path.join(s.payload, 'test')), 'test/ is not payload');
    assert.ok(!fs.existsSync(path.join(s.payload, 'research')), 'research/ is not payload');
    assert.ok(!fs.existsSync(paths.tmpDir));
    assert.ok(!fs.existsSync(paths.prevDir));
    assert.equal(readJson(path.join(s.payload, '.claude-plugin', 'plugin.json')).name, 'singular');
    assert.equal(readJson(path.join(s.payload, '.claude-plugin', 'marketplace.json')).name, 'singular');
    assert.equal(fs.readFileSync(path.join(s.payload, 'skills', 'singular', 'SKILL.md'), 'utf8').includes('name: singular'), true);
  });

  test('second copy is atomic: the previous payload moves to .prev (kept), the new one replaces it, stale files disappear', () => {
    const s = scenario('copy2');
    const paths = statePaths(s.deps);
    copyPayload(s.deps, paths);
    write(path.join(s.payload, 'lib', 'stale.js'), '// from an older version\n');
    const pkg2 = makePackage('copy2-new', { version: '0.3.0' });
    s.deps.packageRoot = pkg2;
    const plan = copyPayload(s.deps, paths);
    assert.equal(plan.replaced, true);
    assert.equal(plan.previousVersion, '0.2.0');
    assert.equal(plan.newVersion, '0.3.0');
    assert.equal(readJson(path.join(s.payload, '.claude-plugin', 'plugin.json')).version, '0.3.0');
    assert.ok(!fs.existsSync(path.join(s.payload, 'lib', 'stale.js')), 'a replace, not a merge');
    assert.ok(fs.existsSync(path.join(paths.prevDir, 'lib', 'stale.js')), 'the previous copy is kept whole at .prev');
    assert.equal(readJson(path.join(paths.prevDir, '.claude-plugin', 'plugin.json')).version, '0.2.0');
    assert.ok(!fs.existsSync(paths.tmpDir));
  });

  test('a failed final rename restores the previous payload from .prev and reports it', () => {
    const s = scenario('copy-fail');
    const paths = statePaths(s.deps);
    copyPayload(s.deps, paths);
    const realRename = fs.renameSync;
    let failed = false;
    s.deps.fs = { ...fs, renameSync: (a, b) => { if (b === paths.payloadDir && a === paths.tmpDir && !failed) { failed = true; throw new Error('EXDEV injected'); } return realRename(a, b); } };
    assert.throws(() => copyPayload(s.deps, paths), (err) => err instanceof CliError && /could not move .*plugin\.tmp into place .*EXDEV injected \(previous payload restored\)/.test(err.message));
    assert.equal(readJson(path.join(s.payload, '.claude-plugin', 'plugin.json')).version, '0.2.0', 'the old payload is back in place');
    assert.ok(!fs.existsSync(paths.tmpDir));
  });

  test('an incomplete package (no hooks/) or a package that is not singular is refused before anything is written', () => {
    const s = scenario('copy-incomplete', { pkg: makePackage('no-hooks', { omit: ['hooks'] }) });
    assert.throws(() => copyPayload(s.deps, statePaths(s.deps)), /package at .* is incomplete: missing hooks\. Reinstall singular-skill/);
    assert.ok(!fs.existsSync(s.payload));
    const t = scenario('copy-foreign-pkg', { pkg: makePackage('other', { pluginName: 'other' }) });
    assert.throws(() => copyPayload(t.deps, statePaths(t.deps)), /does not name the "singular" plugin/);
    assert.deepEqual(REQUIRED_ENTRIES, ['.claude-plugin', 'hooks', 'skills', 'bin', 'lib', 'package.json']);
  });

  test('the real repository is a complete payload source (every PAYLOAD_ENTRIES item exists at the repo root)', () => {
    for (const e of REQUIRED_ENTRIES) assert.ok(fs.existsSync(path.join(ROOT, e)), `${e} exists in the repo`);
    const manifest = readJson(path.join(ROOT, '.claude-plugin', 'plugin.json'));
    assert.equal(manifest.name, 'singular');
    assert.equal(readJson(path.join(ROOT, '.claude-plugin', 'marketplace.json')).name, 'singular');
    const pkg = readJson(path.join(ROOT, 'package.json'));
    assert.equal(pkg.name, 'singular-skill');
    assert.equal(pkg.private, false);
    assert.deepEqual(pkg.bin, { singular: 'bin/singular-cli.js' });
    for (const f of ['bin', 'lib', 'hooks', 'skills', '.claude-plugin', 'README.md', 'LICENSE', 'config.example.json', 'docs/security.md', 'docs/spec.md', 'docs/testing.md']) assert.ok(pkg.files.includes(f), `files whitelist has ${f}`);
    assert.ok(!pkg.files.some((f) => /^test|^research|scratch/.test(f)));
    assert.equal(pkg.scripts.prepublishOnly, 'npm test');
    assert.match(pkg.repository.url, /github\.com\/Nityasav\/singular/);
    assert.ok(fs.statSync(path.join(ROOT, 'bin', 'singular-cli.js')).mode & 0o111, 'bin/singular-cli.js is executable');
    assert.match(fs.readFileSync(path.join(ROOT, 'bin', 'singular-cli.js'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  });
});

describe('state detection', () => {
  test('marketplaceState: --json, the text listing when --json is unsupported, and an outright failure', async () => {
    const s = scenario('mk-json', { state: { marketplaces: { singular: '/some/path' } } });
    assert.deepEqual(await marketplaceState(s.deps), { known: true, registered: true, path: '/some/path', via: 'json' });
    const n = scenario('mk-none');
    assert.deepEqual(await marketplaceState(n.deps), { known: true, registered: false, path: null, via: 'json' });
    const t = scenario('mk-text', { state: { jsonLists: false, marketplaces: { singular: '/text/path' } } });
    assert.deepEqual(await marketplaceState(t.deps), { known: true, registered: true, path: '/text/path', via: 'text' });
    assert.deepEqual(t.calls(), ['claude plugin marketplace list --json', 'claude plugin marketplace list']);
    const t2 = scenario('mk-text-none', { state: { jsonLists: false } });
    assert.deepEqual(await marketplaceState(t2.deps), { known: true, registered: false, path: null, via: 'text' });
    const f = scenario('mk-fail', { state: { fail: (c) => /marketplace list/.test(c) } });
    const r = await marketplaceState(f.deps);
    assert.equal(r.known, false);
    assert.match(r.error, /injected failure/);
  });

  test('pluginState: --json (enabled flag, version, errors), the text listing, and an outright failure', async () => {
    const s = scenario('pl-json', { state: { plugins: { 'singular@singular': { version: '0.2.0', enabled: false, path: '/p', errors: ['Marketplace singular failed to load: cache-miss'] } } } });
    const r = await pluginState(s.deps);
    assert.equal(r.installed, true);
    assert.equal(r.enabled, false);
    assert.equal(r.version, '0.2.0');
    assert.equal(r.readFromFolder, '/p');
    assert.deepEqual(r.errors, ['Marketplace singular failed to load: cache-miss']);
    const n = scenario('pl-none');
    assert.equal((await pluginState(n.deps)).installed, false);
    const t = scenario('pl-text', { state: { jsonLists: false, plugins: { 'singular@singular': { version: '0.2.0', enabled: true, path: '/text/p' } } } });
    const tr = await pluginState(t.deps);
    assert.deepEqual([tr.installed, tr.enabled, tr.version, tr.readFromFolder, tr.scope, tr.via], [true, true, '0.2.0', '/text/p', 'user', 'text']);
    const td = scenario('pl-text-disabled', { state: { jsonLists: false, plugins: { 'singular@singular': { version: '0.2.0', enabled: false, path: '/text/p' } } } });
    assert.equal((await pluginState(td.deps)).enabled, false);
    const f = scenario('pl-fail', { state: { fail: (c) => /^plugin list/.test(c) } });
    assert.equal((await pluginState(f.deps)).known, false);
  });

  test('parseJsonLoose tolerates progress text around the JSON', () => {
    assert.deepEqual(parseJsonLoose('Listing…\n[{"id":"a"}]\n'), [{ id: 'a' }]);
    assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
    assert.equal(parseJsonLoose('nothing here'), null);
    assert.equal(parseJsonLoose(''), null);
  });
});

describe('singular install', () => {
  test('node too old: exit 1, the message, nothing copied, no mutating claude call', async () => {
    const s = scenario('inst-node', { nodeVersion: '18.19.0' });
    assert.equal(await runCli(['install'], s.deps), 1);
    assert.match(s.stderr(), /^singular install: step 1\/5 \(environment\) failed:\n  Node >= 20 is required \(found 18\.19\.0\)/);
    assert.match(s.stderr(), /Retry: singular install/);
    assert.ok(!fs.existsSync(s.payload));
    assert.deepEqual(s.calls(), ['claude --version']);
  });

  test('claude missing: exit 1 with the install hint; claude too old: exit 1 with `claude update`; nothing written either way', async () => {
    const m = scenario('inst-missing', { state: { missing: true } });
    assert.equal(await runCli(['install'], m.deps), 1);
    assert.match(m.stderr(), /claude is not on PATH\. Install Claude Code first/);
    assert.ok(!fs.existsSync(m.payload));
    const o = scenario('inst-old', { state: { version: '2.1.281' } });
    assert.equal(await runCli(['install'], o.deps), 1);
    assert.match(o.stderr(), /Claude Code >= 2\.1\.282 is required \(found 2\.1\.281\)\. Run `claude update`/);
    assert.ok(!fs.existsSync(o.payload));
    assert.deepEqual(o.calls(), ['claude --version']);
  });

  test('fresh machine: payload copied, marketplace add, plugin install, verify; the exact command sequence and the final line', async () => {
    const s = scenario('inst-fresh');
    assert.equal(await runCli(['install'], s.deps), 0);
    assert.equal(s.stderr(), '');
    const out = s.stdout();
    assert.match(out, /^\[1\/5\] environment: node 26\.5\.0, claude 2\.1\.296 \(ok\)\n/);
    assert.match(out, /\n\[2\/5\] payload: copied 9 entries to .*\/\.claude\/singular\/plugin \(version 0\.2\.0\)\n/);
    assert.match(out, /\n\[3\/5\] marketplace: `claude plugin marketplace add .*\/\.claude\/singular\/plugin` ok\n  ✔ Successfully added marketplace: singular/);
    assert.match(out, /\n\[4\/5\] plugin: `claude plugin install singular@singular` ok\n  ✔ Successfully installed plugin: singular@singular \(scope: user\)\n/);
    assert.match(out, /\n\[5\/5\] verify: singular@singular installed, enabled, version 0\.2\.0\n/);
    assert.ok(out.endsWith(`${DONE_LINE}\n`), out);
    assert.equal(DONE_LINE, 'Installed. Open a new Claude Code session (or run /reload-plugins) and type /singular');
    assert.deepEqual(s.calls(), [
      'claude --version',
      'claude plugin marketplace list --json',
      `claude plugin marketplace add ${s.payload}`,
      'claude plugin list --json',
      'claude plugin install singular@singular',
      'claude plugin list --json',
    ]);
    assert.deepEqual(s.state.marketplaces, { singular: s.payload });
    assert.deepEqual(Object.keys(s.state.plugins), ['singular@singular']);
    assert.equal(s.state.plugins['singular@singular'].enabled, true);
    for (const e of PAYLOAD_ENTRIES) assert.ok(fs.existsSync(path.join(s.payload, e)), e);
    assert.ok(!fs.existsSync(`${s.payload}.prev`));
    assert.ok(s.state.calls.every((c) => c.env.CLAUDE_CONFIG_DIR === s.deps.env.CLAUDE_CONFIG_DIR && c.env.HOME === s.home), 'every claude call gets the caller environment');
    // state files that the hooks read are untouched by install (config.json is created by the hooks on first run)
    assert.ok(!fs.existsSync(path.join(s.home, '.claude', 'singular', 'config.json')));
  });

  test('re-run (and `singular update`): marketplace update + plugin update, .prev backup kept, idempotent end state', async () => {
    const s = scenario('inst-again');
    assert.equal(await runCli(['install'], s.deps), 0);
    s.state.calls = [];
    const pkg2 = makePackage('inst-again-new', { version: '0.2.1' });
    s.deps.packageRoot = pkg2;
    assert.equal(await runCli(['update'], s.deps), 0);
    assert.deepEqual(s.calls(), [
      'claude --version',
      'claude plugin marketplace list --json',
      'claude plugin marketplace update singular',
      'claude plugin list --json',
      'claude plugin update singular@singular',
      'claude plugin list --json',
    ]);
    const out = s.stdout();
    assert.match(out, /\[2\/5\] payload: copied 9 entries to .* \(0\.2\.0 -> 0\.2\.1; previous copy kept at .*plugin\.prev\)/);
    assert.match(out, /\[3\/5\] marketplace: `claude plugin marketplace update singular` ok\n  Updating marketplace: singular\.\.\.Validating local marketplace\n  ✔ Successfully updated marketplace: singular/);
    assert.match(out, /\[4\/5\] plugin: `claude plugin update singular@singular` ok/);
    assert.match(out, /\[5\/5\] verify: singular@singular installed, enabled, version 0\.2\.1/);
    assert.equal(readJson(path.join(s.payload, '.claude-plugin', 'plugin.json')).version, '0.2.1');
    assert.equal(readJson(path.join(`${s.payload}.prev`, '.claude-plugin', 'plugin.json')).version, '0.2.0');
    assert.deepEqual(Object.keys(s.state.plugins), ['singular@singular']);
    assert.equal(s.state.plugins['singular@singular'].version, '0.2.1');
  });

  test('marketplace "singular" registered at another path (an old clone): add re-points it and says so', async () => {
    const old = makePackage('old-clone');
    const s = scenario('inst-repoint', { state: { marketplaces: { singular: old }, plugins: { 'singular@singular': { version: '0.1.0', enabled: true, path: old } } } });
    assert.equal(await runCli(['install'], s.deps), 0);
    assert.deepEqual(s.calls().slice(1, 3), ['claude plugin marketplace list --json', `claude plugin marketplace add ${s.payload}`]);
    assert.match(s.stdout(), /\[3\/5\] marketplace: `claude plugin marketplace add .*` ok \(marketplace "singular" was registered at .*old-clone.*; re-pointing it at the payload\)\n  ✔ Successfully added marketplace: singular \(declared in user settings\)\n  Marketplace 'singular' was already added from dir:.* and now points at dir:/);
    assert.equal(s.state.marketplaces.singular, s.payload);
    assert.match(s.calls()[4], /^claude plugin update singular@singular$/, 'the plugin was installed already: update, not install');
  });

  test('--dir: the payload lands there, the marketplace is added from there; --dir inside the package is refused', async () => {
    const s = scenario('inst-dir');
    const dir = path.join(s.home, 'custom', 'singular-payload');
    assert.equal(await runCli(['install', '--dir', dir], s.deps), 0);
    assert.ok(fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json')));
    assert.ok(!fs.existsSync(s.payload));
    assert.equal(s.calls()[2], `claude plugin marketplace add ${dir}`);
    const bad = scenario('inst-dir-bad');
    assert.equal(await runCli(['install', '--dir', bad.pkg], bad.deps), 1);
    assert.match(bad.stderr(), /refusing to copy the payload onto itself/);
    assert.deepEqual(bad.calls(), ['claude --version']);
  });

  test('--dry-run prints the plan (what would be copied, which commands would run) and changes nothing', async () => {
    const s = scenario('inst-dry');
    assert.equal(await runCli(['install', '--dry-run'], s.deps), 0);
    const out = s.stdout();
    assert.match(out, /\[2\/5\] payload: would copy \.claude-plugin, hooks, skills, bin, lib, package\.json, LICENSE, README\.md, config\.example\.json from .* to .*\/\.claude\/singular\/plugin \(version 0\.2\.0\)/);
    assert.match(out, /\[3\/5\] marketplace: would run `claude plugin marketplace add .*\/\.claude\/singular\/plugin`/);
    assert.match(out, /\[4\/5\] plugin: would run `claude plugin install singular@singular`/);
    assert.match(out, /\[5\/5\] verify: skipped \(dry run\)\nDry run: nothing was changed\. Run `singular install` to apply\.\n$/);
    assert.ok(!fs.existsSync(s.payload), 'nothing copied');
    assert.ok(!fs.existsSync(path.join(s.home, '.claude', 'singular')), 'no state dir created');
    assert.ok(s.calls().every((c) => !MUTATING_RE.test(c)), `read-only calls only: ${s.calls().join(', ')}`);
    assert.deepEqual(s.state.marketplaces, {});
    assert.deepEqual(s.state.plugins, {});
    // dry-run on an installed machine says update/update
    const t = scenario('inst-dry-installed');
    assert.equal(await runCli(['install'], t.deps), 0);
    t.state.calls = [];
    assert.equal(await runCli(['update', '--dry-run'], t.deps), 0);
    assert.match(t.stdout(), /would run `claude plugin marketplace update singular`[\s\S]*would run `claude plugin update singular@singular` \(singular@singular 0\.2\.0 is installed\)/);
    assert.ok(t.calls().every((c) => !MUTATING_RE.test(c)));
  });

  test('--json: one JSON object with the steps, the payload dir and the versions', async () => {
    const s = scenario('inst-json');
    assert.equal(await runCli(['install', '--json'], s.deps), 0);
    const j = JSON.parse(s.stdout());
    assert.equal(j.ok, true);
    assert.equal(j.command, 'install');
    assert.equal(j.payloadDir, s.payload);
    assert.deepEqual(j.versions, { node: '26.5.0', claude: '2.1.296' });
    assert.deepEqual(j.steps.map((x) => x.name), ['environment', 'payload', 'marketplace', 'plugin', 'verify']);
    assert.equal(j.steps[2].detail, `claude plugin marketplace add ${s.payload}`);
    assert.equal(j.message, DONE_LINE);
    const f = scenario('inst-json-fail', { state: { fail: (c) => /^plugin install/.test(c) } });
    assert.equal(await runCli(['install', '--json'], f.deps), 1);
    const fj = JSON.parse(f.stdout());
    assert.equal(fj.ok, false);
    assert.match(fj.error, /step 4\/5 \(plugin\) failed/);
    assert.equal(fj.failedCommand, 'claude plugin install singular@singular');
    assert.equal(f.stderr(), '');
  });

  test('step 3 fails (marketplace add): exit 1, names the command, retry hint, payload stays, plugin install never attempted', async () => {
    const s = scenario('inst-fail-mk', { state: { fail: (c) => /^plugin marketplace add/.test(c) } });
    assert.equal(await runCli(['install'], s.deps), 1);
    const err = s.stderr();
    assert.match(err, /^singular install: step 3\/5 \(marketplace\) failed: `claude plugin marketplace add .*\/\.claude\/singular\/plugin` exited 1\n  ✘ Failed: injected failure/);
    assert.match(err, /\n  The payload copy at .* is complete; nothing was registered\.\nRetry: singular install   \(or run `claude plugin marketplace add .*` yourself and then `singular install` again\)\n$/);
    assert.ok(fs.existsSync(path.join(s.payload, '.claude-plugin', 'plugin.json')));
    assert.ok(!s.calls().some((c) => /^claude plugin install/.test(c)));
    assert.deepEqual(s.state.marketplaces, {});
    assert.deepEqual(s.state.plugins, {});
  });

  test('step 4 fails (plugin install): the marketplace this run added is removed again; a pre-existing marketplace is left alone', async () => {
    const s = scenario('inst-fail-pl', { state: { fail: (c) => /^plugin install/.test(c) } });
    assert.equal(await runCli(['install'], s.deps), 1);
    const err = s.stderr();
    assert.match(err, /^singular install: step 4\/5 \(plugin\) failed: `claude plugin install singular@singular` exited 1\n  ✘ Failed: injected failure/);
    assert.match(err, /\n  Marketplace "singular" added by this run was removed again \(nothing is half-registered\)\.\n  The payload copy at .* is complete and harmless; re-running registers it\.\nRetry: singular install/);
    assert.ok(s.calls().includes('claude plugin marketplace remove singular'));
    assert.deepEqual(s.state.marketplaces, {}, 'rolled back');
    assert.deepEqual(s.state.plugins, {});
    // pre-existing marketplace at the payload path: no rollback
    const pre = scenario('inst-fail-pl-pre');
    assert.equal(await runCli(['install'], pre.deps), 0);
    delete pre.state.plugins['singular@singular'];
    pre.state.fail = (c) => /^plugin install/.test(c);
    pre.state.calls = [];
    assert.equal(await runCli(['install'], pre.deps), 1);
    assert.ok(!pre.calls().includes('claude plugin marketplace remove singular'));
    assert.deepEqual(pre.state.marketplaces, { singular: pre.payload });
    assert.doesNotMatch(pre.stderr(), /removed again/);
  });

  test('step 5: a plugin that ends up disabled is enabled; a plugin that is not listed afterwards fails verify', async () => {
    const s = scenario('inst-verify-enable');
    const real = s.deps.execFileImpl;
    s.deps.execFileImpl = (file, args, opts, cb) => real(file, args, opts, (e, o, r) => {
      if (args.join(' ') === 'plugin install singular@singular') s.state.plugins['singular@singular'].enabled = false;
      cb(e, o, r);
    });
    assert.equal(await runCli(['install'], s.deps), 0);
    assert.ok(s.calls().includes('claude plugin enable singular@singular'));
    assert.match(s.stdout(), /\[5\/5\] verify: singular@singular installed, enabled, version 0\.2\.0 \(was disabled; enabled it\)/);
    assert.equal(s.state.plugins['singular@singular'].enabled, true);

    const v = scenario('inst-verify-missing');
    const realV = v.deps.execFileImpl;
    v.deps.execFileImpl = (file, args, opts, cb) => realV(file, args, opts, (e, o, r) => {
      if (args.join(' ') === 'plugin install singular@singular') delete v.state.plugins['singular@singular'];
      cb(e, o, r);
    });
    assert.equal(await runCli(['install'], v.deps), 1);
    assert.match(v.stderr(), /step 5\/5 \(verify\) failed: `claude plugin list --json` does not list singular@singular after `claude plugin install singular@singular`/);
  });

  test('when the --json listings are unsupported (older CLI), the text listings drive the same add/install vs update/update decisions', async () => {
    const s = scenario('inst-text', { state: { jsonLists: false } });
    assert.equal(await runCli(['install'], s.deps), 0);
    assert.deepEqual(s.calls(), [
      'claude --version',
      'claude plugin marketplace list --json',
      'claude plugin marketplace list',
      `claude plugin marketplace add ${s.payload}`,
      'claude plugin list --json',
      'claude plugin list',
      'claude plugin install singular@singular',
      'claude plugin list --json',
      'claude plugin list',
    ]);
    s.state.calls = [];
    assert.equal(await runCli(['install'], s.deps), 0);
    assert.ok(s.calls().includes('claude plugin marketplace update singular'));
    assert.ok(s.calls().includes('claude plugin update singular@singular'));
  });
});

describe('singular uninstall', () => {
  test('after an install: plugin uninstall, marketplace remove, payload (+ .prev) removed, config kept; exit 0', async () => {
    const s = scenario('uninst');
    assert.equal(await runCli(['install'], s.deps), 0);
    assert.equal(await runCli(['update'], s.deps), 0);
    write(path.join(s.home, '.claude', 'singular', 'config.json'), { mode: 'local' });
    write(path.join(s.home, '.claude', 'singular', 'loaded.json'), {});
    s.state.calls = [];
    assert.equal(await runCli(['uninstall'], s.deps), 0);
    assert.deepEqual(s.calls(), ['claude --version', 'claude plugin uninstall singular@singular', 'claude plugin marketplace remove singular']);
    const out = s.stdout();
    assert.match(out, /\[1\/3\] plugin: `claude plugin uninstall singular@singular` ok\n\[2\/3\] marketplace: `claude plugin marketplace remove singular` ok\n\[3\/3\] files: removed .*plugin, .*plugin\.prev\nUninstalled\. State kept at .*\/\.claude\/singular \(config, cache, log, pins\); `singular uninstall --purge` removes it too\.\n$/);
    assert.ok(!fs.existsSync(s.payload));
    assert.ok(!fs.existsSync(`${s.payload}.prev`));
    assert.deepEqual(readJson(path.join(s.home, '.claude', 'singular', 'config.json')), { mode: 'local' }, 'config survives a plain uninstall');
    assert.deepEqual(s.state.plugins, {});
    assert.deepEqual(s.state.marketplaces, {});
  });

  test('--purge removes ~/.claude/singular entirely (config, cache, log, pins) and says ~/.claude/skills is left alone', async () => {
    const s = scenario('uninst-purge');
    assert.equal(await runCli(['install'], s.deps), 0);
    const state = path.join(s.home, '.claude', 'singular');
    write(path.join(state, 'config.json'), { mode: 'suggest' });
    write(path.join(state, 'cache', 'x.json'), '{}');
    write(path.join(state, 'singular.log'), '{"msg":"x"}\n');
    write(path.join(state, 'loaded.json'), {});
    write(path.join(s.home, '.claude', 'skills', 'kept', 'SKILL.md'), '---\nname: kept\n---\n');
    assert.equal(await runCli(['uninstall', '--purge'], s.deps), 0);
    assert.ok(!fs.existsSync(state));
    assert.ok(fs.existsSync(path.join(s.home, '.claude', 'skills', 'kept', 'SKILL.md')), 'never touches ~/.claude/skills');
    assert.match(s.stdout(), /Uninstalled and purged\. Skills installed earlier with \/singular add stay in ~\/\.claude\/skills/);
  });

  test('nothing installed: both claude steps are skipped gracefully, exit 0; a real failure exits 1 naming the command', async () => {
    const s = scenario('uninst-none');
    assert.equal(await runCli(['uninstall'], s.deps), 0);
    assert.match(s.stdout(), /\[1\/3\] plugin: singular@singular is not installed \(skipped\)\n\[2\/3\] marketplace: "singular" is not registered \(skipped\)\n\[3\/3\] files: nothing to remove\nUninstalled\.\n$/);
    const f = scenario('uninst-fail', { state: { plugins: { 'singular@singular': { version: '0.2.0', enabled: true, path: '/p' } }, fail: (c) => /^plugin uninstall/.test(c) } });
    assert.equal(await runCli(['uninstall'], f.deps), 1);
    assert.match(f.stderr(), /^singular uninstall: step 1\/3 \(plugin\) failed: `claude plugin uninstall singular@singular` exited 1\n  ✘ Failed: injected failure[\s\S]*Retry: singular uninstall/);
    assert.ok(!f.calls().includes('claude plugin marketplace remove singular'), 'stops at the failed step');
    const m = scenario('uninst-missing', { state: { missing: true } });
    assert.equal(await runCli(['uninstall', '--purge'], m.deps), 1);
    assert.match(m.stderr(), /claude is not on PATH, so the plugin cannot be unregistered/);
  });
});

describe('singular status / doctor', () => {
  test('status on a fresh machine and after an install; --json carries the same facts', async () => {
    const s = scenario('status');
    assert.equal(await runCli(['status'], s.deps), 0);
    let out = s.stdout();
    assert.match(out, /^singular CLI 0\.2\.0  \(package: .*\)\nnode:        26\.5\.0  ok \(>= 20\)\nclaude:      2\.1\.296  ok \(>= 2\.1\.282\)\npayload:     .*\/\.claude\/singular\/plugin  missing \(run: singular install\)\nmarketplace: "singular" not registered \(run: singular install\)\nplugin:      singular@singular not installed \(run: singular install\)\nconfig:      .*\/\.claude\/singular\/config\.json  mode: suggest\nenv:         CLAUDE_CONFIG_DIR=.*\nlog:         .*\/\.claude\/singular\/singular\.log \(empty\)\n$/);
    assert.equal(await runCli(['install'], s.deps), 0);
    write(path.join(s.home, '.claude', 'singular', 'singular.log'), Array.from({ length: 8 }, (_, i) => `{"msg":"line ${i}"}`).join('\n') + '\n');
    const t = scenario('status-2', { pkg: s.pkg, state: s.state });
    t.deps.env.HOME = s.home;
    t.deps.homedir = () => s.home;
    assert.equal(await runCli(['status'], t.deps), 0);
    out = t.stdout();
    assert.match(out, /payload:     .*\/plugin  version 0\.2\.0\nmarketplace: "singular" registered -> .*\/\.claude\/singular\/plugin\nplugin:      singular@singular installed, enabled, version 0\.2\.0 \(scope user\)\n/);
    assert.match(out, /log:         .*singular\.log \(last 5 lines\)\n  \{"msg":"line 3"\}\n  \{"msg":"line 4"\}\n  \{"msg":"line 5"\}\n  \{"msg":"line 6"\}\n  \{"msg":"line 7"\}\n$/);
    const j = scenario('status-json', { pkg: s.pkg, state: s.state });
    j.deps.env.HOME = s.home;
    assert.equal(await runCli(['status', '--json'], j.deps), 0);
    const parsed = JSON.parse(j.stdout());
    assert.equal(parsed.node.version, '26.5.0');
    assert.equal(parsed.claude.version, '2.1.296');
    assert.equal(parsed.payload.version, '0.2.0');
    assert.equal(parsed.marketplace.registered, true);
    assert.equal(parsed.marketplace.matchesPayload, true);
    assert.equal(parsed.plugin.installed, true);
    assert.equal(parsed.plugin.enabled, true);
    assert.equal(parsed.config.mode, 'suggest');
    assert.equal(parsed.log.tail.length, 5);
  });

  test('status when claude is missing or too old still prints (exit 0) and marks the lines', async () => {
    const m = scenario('status-missing', { state: { missing: true } });
    assert.equal(await runCli(['status'], m.deps), 0);
    assert.match(m.stdout(), /claude:      not found on PATH\n.*\nmarketplace: unknown \(claude not available\)\nplugin:      unknown \(claude not available\)\n/);
    const o = scenario('status-old', { state: { version: '2.0.5' }, nodeVersion: '18.0.0' });
    assert.equal(await runCli(['status'], o.deps), 0);
    assert.match(o.stdout(), /node:        18\.0\.0  TOO OLD \(need >= 20\)\nclaude:      2\.0\.5  TOO OLD \(need >= 2\.1\.282\)/);
  });

  test('doctor: every hint, and exit 1 while anything needs fixing, exit 0 with "No problems found" afterwards', async () => {
    const s = scenario('doctor-fresh');
    assert.equal(await runCli(['doctor'], s.deps), 1);
    let out = s.stdout();
    assert.match(out, /\nProblems \(3\):\n  - payload missing at .*\n    fix: run `singular install`\n  - marketplace "singular" is not registered\n    fix: run `singular install`\n  - singular@singular is not installed\n    fix: run `singular install`\n$/);
    assert.equal(await runCli(['install'], s.deps), 0);
    const ok = scenario('doctor-ok', { pkg: s.pkg, state: s.state });
    ok.deps.env.HOME = s.home;
    assert.equal(await runCli(['doctor'], ok.deps), 0);
    assert.match(ok.stdout(), /\nNo problems found\. Type \/singular in Claude Code\.\n$/);

    // disabled plugin, marketplace pointing elsewhere, version drift, mode auto, old node, missing claude
    const st = await collectCliStatus(ok.deps);
    const variants = [
      [{ ...st, plugin: { ...st.plugin, enabled: false } }, /singular@singular is disabled/, /claude plugin enable singular@singular/],
      [{ ...st, marketplace: { ...st.marketplace, path: '/elsewhere', matchesPayload: false } }, /points at \/elsewhere, not the payload/, /re-points the marketplace/],
      [{ ...st, plugin: { ...st.plugin, version: '0.1.0' } }, /plugin version 0\.1\.0 differs from the payload 0\.2\.0/, /singular update/],
      [{ ...st, plugin: { ...st.plugin, errors: ['Marketplace singular failed to load: cache-miss'] } }, /Claude Code reports: Marketplace singular failed to load/, /singular install/],
      [{ ...st, config: { ...st.config, mode: 'auto' } }, /mode is "auto"/, /singular mode suggest/],
      [{ ...st, config: { ...st.config, warnings: ['config.json is not valid JSON (x); using defaults'] } }, /config: config\.json is not valid JSON/, /fix .*config\.json by hand/],
      [{ ...st, node: { version: '18.0.0', ok: false } }, /Node 18\.0\.0 is too old/, /install Node >= 20/],
      [{ ...st, claude: { found: false, version: null, ok: false, raw: '' } }, /claude is not on PATH/, /install Claude Code/],
      [{ ...st, claude: { found: true, version: '2.1.1', ok: false, raw: '2.1.1' } }, /Claude Code 2\.1\.1 is too old/, /claude update/],
      [{ ...st, payload: { ...st.payload, valid: false } }, /is not a valid singular payload/, /singular install/],
      [{ ...st, marketplace: { known: false, registered: null, path: null, error: 'boom', matchesPayload: false } }, /cannot read the marketplace list \(boom\)/, /claude plugin marketplace list/],
      [{ ...st, plugin: { known: false, installed: null, enabled: null, version: null, errors: [], error: 'boom' } }, /cannot read the plugin list \(boom\)/, /claude plugin list/],
    ];
    for (const [snap, problemRe, hintRe] of variants) {
      const probs = diagnose(snap);
      assert.ok(probs.length >= 1, problemRe.toString());
      const hit = probs.find((p) => problemRe.test(p.problem));
      assert.ok(hit, `${problemRe} in ${JSON.stringify(probs)}`);
      assert.match(hit.hint, hintRe);
    }
    assert.deepEqual(diagnose(st), []);
    assert.match(formatCliStatus({ ...st, plugin: { ...st.plugin, enabled: false } }), /installed, DISABLED/);
    assert.match(formatCliStatus({ ...st, marketplace: { ...st.marketplace, path: '/elsewhere', matchesPayload: false } }), /registered -> \/elsewhere  \(NOT the payload above; run: singular install\)/);
    // doctor --json
    const dj = scenario('doctor-json');
    assert.equal(await runCli(['doctor', '--json'], dj.deps), 1);
    const parsed = JSON.parse(dj.stdout());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.problems.length, 3);
    assert.equal(typeof status, 'function');
    assert.equal(typeof doctor, 'function');
  });
});

describe('proxies: find / add / mode / init -> bin/singular.js, load -> bin/on-expand.js', () => {
  test('argv shapes', () => {
    const s = scenario('proxy-target');
    assert.deepEqual(proxyTarget(s.deps, 'find', ['playwright', 'flaky', '--limit', '3']), { file: path.join(s.pkg, 'bin', 'singular.js'), argv: [path.join(s.pkg, 'bin', 'singular.js'), 'find', 'playwright', 'flaky', '--limit', '3'] });
    assert.deepEqual(proxyTarget(s.deps, 'add', ['a/b@c']).argv, [path.join(s.pkg, 'bin', 'singular.js'), 'add', 'a/b@c']);
    assert.deepEqual(proxyTarget(s.deps, 'mode', []).argv, [path.join(s.pkg, 'bin', 'singular.js'), 'mode']);
    assert.deepEqual(proxyTarget(s.deps, 'init', ['--apply', 'all', '--project']).argv, [path.join(s.pkg, 'bin', 'singular.js'), 'init', '--apply', 'all', '--project']);
    assert.deepEqual(proxyTarget(s.deps, 'load', ['a/b@c', '--update']).argv, [path.join(s.pkg, 'bin', 'on-expand.js'), 'a/b@c', '--update']);
  });

  test('runCli spawns node with stdio inherited and the caller env, and returns the child exit code', async () => {
    const s = scenario('proxy-run', { spawnOpts: { code: 3 } });
    assert.equal(await runCli(['find', 'playwright', 'flaky', '--json'], s.deps), 3);
    assert.equal(s.spawnRecord.length, 1);
    assert.equal(s.spawnRecord[0].file, '/fake/node');
    assert.deepEqual(s.spawnRecord[0].argv, [path.join(s.pkg, 'bin', 'singular.js'), 'find', 'playwright', 'flaky', '--json']);
    assert.equal(s.spawnRecord[0].opts.stdio, 'inherit');
    assert.equal(s.spawnRecord[0].opts.env, s.deps.env);
    assert.deepEqual(s.calls(), [], 'no claude call for a proxy');
    const l = scenario('proxy-load');
    assert.equal(await runCli(['load', 'anthropics/skills@pdf', '--update'], l.deps), 0);
    assert.deepEqual(l.spawnRecord[0].argv, [path.join(l.pkg, 'bin', 'on-expand.js'), 'anthropics/skills@pdf', '--update']);
    const m = scenario('proxy-mode');
    assert.equal(await runCli(['mode', 'local'], m.deps), 0);
    assert.deepEqual(m.spawnRecord[0].argv.slice(1), ['mode', 'local']);
    const a = scenario('proxy-add');
    assert.equal(await runCli(['add', 'anthropics/skills@pdf', '--yes'], a.deps), 0);
    assert.deepEqual(a.spawnRecord[0].argv.slice(1), ['add', 'anthropics/skills@pdf', '--yes']);
    const i = scenario('proxy-init');
    assert.equal(await runCli(['init', '--no-remote', '--json'], i.deps), 0);
    assert.deepEqual(i.spawnRecord[0].argv.slice(1), ['init', '--no-remote', '--json']);
    assert.deepEqual(i.calls(), [], 'no claude call for the init proxy');
  });

  test('a missing script or a spawn error is a clear exit 1', async () => {
    const s = scenario('proxy-missing', { pkg: makePackage('no-singular-js') });
    fs.rmSync(path.join(s.pkg, 'bin', 'singular.js'));
    assert.equal(await runCli(['find', 'x'], s.deps), 1);
    assert.match(s.stderr(), /singular find: .*bin\/singular\.js is missing from this package; reinstall singular-skill/);
    assert.equal(s.spawnRecord.length, 0);
    const e = scenario('proxy-err', { spawnOpts: { error: new Error('spawn EACCES') } });
    assert.equal(await runCli(['mode'], e.deps), 1);
    assert.match(e.stderr(), /singular mode: could not start node: spawn EACCES/);
  });

  test('the real bin/singular-cli.js proxies to the real bin/singular.js (child process; no claude involved)', async () => {
    const { spawnSync } = await import('node:child_process');
    // cwd must be neither the HOME nor an ancestor of the state dir: lib/config.js hardenEnv would otherwise ignore
    // both overrides and fall back to the real ~/.claude/singular (read-only for `mode`, but still off limits).
    const home = freshHome('proxy-real');
    const cwd = path.join(AGENT, 'proxy-real-cwd');
    fs.mkdirSync(cwd, { recursive: true });
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'singular-cli.js'), 'mode'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, SINGULAR_HOME: path.join(home, 'state') }, cwd });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\[singular\] mode: suggest  \(config file: .*\/proxy-real-\d+\/state\/config\.json\)/);
    assert.doesNotMatch(r.stdout, /ignored/, 'no override was ignored');
    assert.ok(fs.existsSync(path.join(home, 'state', 'config.json')), 'the scratch state dir got the config');
  });
});

test('install/uninstall/status never read or write outside the scratch HOME (the real ~/.claude is untouched by construction)', async () => {
  const s = scenario('isolation');
  assert.equal(await runCli(['install'], s.deps), 0);
  assert.equal(await runCli(['status'], s.deps), 0);
  assert.equal(await runCli(['uninstall', '--purge'], s.deps), 0);
  const real = path.join(os.homedir(), '.claude', 'singular');
  assert.ok(!s.stdout().includes(real) || real === path.join(s.home, '.claude', 'singular'), 'no real-home path in the output');
  assert.ok(s.state.calls.every((c) => c.env.HOME === s.home));
  assert.equal(MARKETPLACE, 'singular');
  assert.equal(PLUGIN_ID, 'singular@singular');
  assert.equal(typeof install, 'function');
  assert.equal(typeof uninstall, 'function');
  assert.equal(typeof proxy, 'function');
});
