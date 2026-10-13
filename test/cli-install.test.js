// test/cli-install.test.js — node --test test/cli-install.test.js
//
// REAL integration of the `singular` CLI against the real `claude` and npm:
//   npm pack (this checkout) -> npm install -g --prefix <scratch>/cli/prefix <tarball> -> <prefix>/bin/singular install
// with HOME=<scratch>/cli/home and CLAUDE_CONFIG_DIR=<scratch>/cli/cfg, so the payload lands in that fake home's
// .claude/singular/plugin and every `claude plugin ...` call writes under the scratch config dir (verified on
// Claude Code 2.1.296: marketplace add / install / list / uninstall need no login there). Then: `claude plugin list
// --json` shows singular@singular enabled, the payload manifests are checked, `singular status`, an idempotent
// `singular update`, and `singular uninstall --purge` leaves nothing behind.
//
// SKIPs (never fails) when `claude` or `npm` is not on PATH. Never touches the real ~/.claude: HOME and
// CLAUDE_CONFIG_DIR are overridden for every child, npm gets its own cache under the scratch dir, and the real
// ~/.claude/plugins/installed_plugins.json + settings.json are fingerprinted (read-only) before and after.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCRATCH_ROOT = (() => {
  const preferred = process.env.SINGULAR_TEST_TMP
    || '/private/tmp/claude-501/-Users-nitya--superset-projects-claude-skills/cfa575e5-ae3c-4522-b59f-cd3623c88bf0/scratchpad';
  try { fs.mkdirSync(preferred, { recursive: true }); return preferred; } catch { return os.tmpdir(); }
})();
const CLI_DIR = path.join(SCRATCH_ROOT, 'cli');
const PREFIX = path.join(CLI_DIR, 'prefix');
const HOME = path.join(CLI_DIR, 'home');
const CFG = path.join(CLI_DIR, 'cfg');
const NPM_CACHE = path.join(CLI_DIR, 'npm-cache');
// Every CLI / claude child runs here: a sibling of the fake HOME, so lib/config.js hardenEnv never sees HOME or
// SINGULAR_HOME inside the cwd (it would fall back to the real ~/.claude/singular) and `claude` finds no project settings.
const CWD = path.join(CLI_DIR, 'cwd');
const PAYLOAD = path.join(HOME, '.claude', 'singular', 'plugin');
const BIN = path.join(PREFIX, 'bin', 'singular');

const REAL_HOME = os.homedir();
const REAL_CLAUDE = process.env.CLAUDE_CONFIG_DIR && path.isAbsolute(process.env.CLAUDE_CONFIG_DIR) ? process.env.CLAUDE_CONFIG_DIR : path.join(REAL_HOME, '.claude');
const GUARDED = [path.join(REAL_CLAUDE, 'plugins', 'installed_plugins.json'), path.join(REAL_CLAUDE, 'plugins', 'known_marketplaces.json'), path.join(REAL_CLAUDE, 'settings.json'), path.join(REAL_CLAUDE, 'settings.local.json'), path.join(REAL_HOME, '.claude', 'singular', 'config.json')];

// known_marketplaces.json: Claude Code itself rewrites the `lastUpdated` stamp of an auto-updating marketplace
// (claude-plugins-official) when a session starts, so a concurrent session must not fail this guard (observed
// 2026-10-13 01:35:27: that stamp, and the plugin-directory cache next to it, changed while this file ran under
// coverage; the isolated config dir of this test never even held the official marketplace). The names, sources and
// paths are what the CLI must never touch, and those are hashed.
function guardedBytes(f) {
  const raw = fs.readFileSync(f);
  if (path.basename(f) !== 'known_marketplaces.json') return raw;
  try {
    const j = JSON.parse(raw.toString('utf8'));
    for (const v of Object.values(j)) if (v && typeof v === 'object') delete v.lastUpdated;
    return Buffer.from(JSON.stringify(j));
  } catch {
    return raw;
  }
}
function fingerprint() {
  return GUARDED.map((f) => {
    try { return `${f}:${createHash('sha256').update(guardedBytes(f)).digest('hex')}`; } catch { return `${f}:absent`; }
  });
}
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const onPath = (cmd) => {
  try { return spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 30000 }).status === 0; } catch { return false; }
};
const HAS_CLAUDE = onPath('claude');
const HAS_NPM = onPath('npm');
const SKIP = !HAS_CLAUDE ? 'claude is not on PATH' : !HAS_NPM ? 'npm is not on PATH' : null;

/** Environment for the CLI and for `claude`: fake HOME + isolated CLAUDE_CONFIG_DIR, node first on PATH, no SINGULAR_* leakage. */
function cliEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^SINGULAR_/.test(k) && k !== 'CLAUDE_CONFIG_DIR' && k !== 'HOME') env[k] = v;
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
  env.HOME = HOME;
  env.CLAUDE_CONFIG_DIR = CFG;
  return { ...env, ...extra };
}
function npmEnv() {
  return { ...process.env, npm_config_cache: NPM_CACHE, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_loglevel: 'error', npm_config_progress: 'false' };
}
function run(cmd, args, { env = cliEnv(), cwd = CWD, timeout = 180000, input } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, cwd, timeout, input: input ?? '', maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
}
const claude = (args) => run('claude', args);
const singular = (args, opts) => run(BIN, args, opts);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const expectedVersion = readJson(path.join(ROOT, 'package.json')).version;

describe('singular CLI integration (npm pack -> npm install -g --prefix -> singular install/status/update/uninstall against the real claude)', { skip: SKIP ?? false }, () => {
  let before_;
  let tarball;
  let packedFiles = [];

  before(() => {
    before_ = fingerprint();
    fs.rmSync(CLI_DIR, { recursive: true, force: true });
    for (const d of [CLI_DIR, PREFIX, HOME, CFG, NPM_CACHE, CWD]) fs.mkdirSync(d, { recursive: true });
  });

  after(() => {
    // Best effort: never leave anything registered in the scratch config dir, and never fail the run from here.
    try { if (fs.existsSync(BIN)) run(BIN, ['uninstall', '--purge']); } catch { /* ignore */ }
  });

  test('npm pack: the tarball holds the plugin payload and the CLI, and nothing from test/, research/ or scratch', () => {
    const r = run('npm', ['pack', '--json', '--pack-destination', CLI_DIR], { env: npmEnv(), cwd: ROOT });
    assert.equal(r.code, 0, r.stderr);
    const info = JSON.parse(r.stdout);
    assert.equal(info.length, 1);
    assert.equal(info[0].name, 'singular-skill');
    assert.equal(info[0].version, expectedVersion);
    tarball = path.join(CLI_DIR, info[0].filename);
    assert.ok(fs.existsSync(tarball), tarball);
    packedFiles = info[0].files.map((f) => f.path);
    for (const must of ['package.json', 'bin/singular-cli.js', 'bin/on-prompt.js', 'bin/on-expand.js', 'bin/on-subagent.js', 'lib/cli-core.js', 'lib/config.js', 'hooks/hooks.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'README.md', 'LICENSE', 'config.example.json', 'docs/security.md', 'docs/spec.md', 'docs/testing.md']) {
      assert.ok(packedFiles.includes(must), `${must} is packed`);
    }
    assert.ok(packedFiles.some((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f)), 'skills are packed');
    const stray = packedFiles.filter((f) => /^(test|research|scratch)(\/|$)|\.test\.(m?js)$|node_modules/.test(f));
    assert.deepEqual(stray, [], 'nothing from test/, research/ or scratch');
    const mode = info[0].files.find((f) => f.path === 'bin/singular-cli.js').mode;
    assert.ok(mode & 0o111, `bin/singular-cli.js keeps its executable bit in the tarball (mode ${mode.toString(8)})`);
  });

  test('npm install -g --prefix <scratch> <tarball> puts a working `singular` on <prefix>/bin', () => {
    const r = run('npm', ['install', '-g', '--prefix', PREFIX, tarball], { env: npmEnv(), cwd: CWD });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(BIN), `${BIN} exists`);
    const pkgDir = path.join(PREFIX, 'lib', 'node_modules', 'singular-skill');
    assert.ok(fs.existsSync(path.join(pkgDir, 'bin', 'singular-cli.js')));
    assert.ok(!fs.existsSync(path.join(pkgDir, 'test')), 'no test/ in the installed package');
    const h = singular(['--help']);
    assert.equal(h.code, 0, h.stderr);
    assert.match(h.stdout, /^singular — install and manage the Singular plugin for Claude Code/);
    const v = singular(['--version']);
    assert.equal(v.code, 0);
    assert.equal(v.stdout.trim(), expectedVersion);
  });

  test('singular status before: payload missing, nothing registered, config path under the fake HOME', () => {
    const r = singular(['status']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^singular CLI \d+\.\d+\.\d+  \(package: .*prefix\/lib\/node_modules\/singular-skill\)\nnode:        \d+\.\d+\.\d+  ok \(>= 20\)\nclaude:      \d+\.\d+\.\d+  ok \(>= 2\.1\.282\)\n/);
    assert.match(r.stdout, new RegExp(`payload:     ${PAYLOAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}  missing \\(run: singular install\\)`));
    assert.match(r.stdout, /marketplace: "singular" not registered/);
    assert.match(r.stdout, /plugin:      singular@singular not installed/);
    assert.match(r.stdout, new RegExp(`config:      ${path.join(HOME, '.claude', 'singular', 'config.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}  mode: suggest`));
    const list = claude(['plugin', 'list', '--json']);
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), [], 'the scratch config dir starts empty');
  });

  test('singular install --dry-run changes nothing', () => {
    const r = singular(['install', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[3\/5\] marketplace: would run `claude plugin marketplace add .*\/plugin`\n\[4\/5\] plugin: would run `claude plugin install singular@singular`\n\[5\/5\] verify: skipped \(dry run\)\nDry run: nothing was changed/);
    assert.ok(!fs.existsSync(PAYLOAD));
    assert.deepEqual(JSON.parse(claude(['plugin', 'list', '--json']).stdout), []);
    assert.deepEqual(JSON.parse(claude(['plugin', 'marketplace', 'list', '--json']).stdout), []);
  });

  test('singular install: payload copied, marketplace + plugin registered in the scratch config dir, final line printed', () => {
    const r = singular(['install']);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(r.stderr, '');
    assert.match(r.stdout, /\[1\/5\] environment: node \S+, claude \S+ \(ok\)\n\[2\/5\] payload: copied \d+ entries to .*\/\.claude\/singular\/plugin \(version \S+\)\n\[3\/5\] marketplace: `claude plugin marketplace add .*` ok\n  ✔ Successfully added marketplace: singular/);
    assert.match(r.stdout, /\[4\/5\] plugin: `claude plugin install singular@singular` ok\n  ✔ Successfully installed plugin: singular@singular \(scope: user\)\n\[5\/5\] verify: singular@singular installed, enabled, version \S+\n/);
    assert.ok(r.stdout.trimEnd().endsWith('Installed. Open a new Claude Code session (or run /reload-plugins) and type /singular'), r.stdout);
    // payload
    const plugin = readJson(path.join(PAYLOAD, '.claude-plugin', 'plugin.json'));
    const marketplace = readJson(path.join(PAYLOAD, '.claude-plugin', 'marketplace.json'));
    assert.equal(plugin.name, 'singular');
    assert.equal(plugin.version, expectedVersion);
    assert.equal(marketplace.name, 'singular');
    assert.equal(marketplace.plugins[0].name, 'singular');
    for (const f of ['hooks/hooks.json', 'bin/on-prompt.js', 'bin/on-expand.js', 'bin/on-subagent.js', 'lib/config.js', 'package.json', 'LICENSE', 'README.md', 'config.example.json']) assert.ok(fs.existsSync(path.join(PAYLOAD, f)), `${f} in the payload`);
    assert.ok(fs.readdirSync(path.join(PAYLOAD, 'skills')).length >= 1, 'skills copied');
    assert.ok(!fs.existsSync(path.join(PAYLOAD, 'test')));
    assert.ok(!fs.existsSync(`${PAYLOAD}.tmp`));
    assert.ok(!fs.existsSync(`${PAYLOAD}.prev`), 'first install: no backup');
    assert.equal(sha256(path.join(PAYLOAD, 'hooks', 'hooks.json')), sha256(path.join(PREFIX, 'lib', 'node_modules', 'singular-skill', 'hooks', 'hooks.json')), 'byte-identical to the installed package');
    // what Claude Code recorded (all under the scratch CLAUDE_CONFIG_DIR)
    const list = JSON.parse(claude(['plugin', 'list', '--json']).stdout);
    assert.equal(list.length, 1, JSON.stringify(list));
    assert.equal(list[0].id, 'singular@singular');
    assert.equal(list[0].enabled, true);
    assert.equal(list[0].version, expectedVersion);
    assert.equal(fs.realpathSync(list[0].readFromFolder), fs.realpathSync(PAYLOAD), 'Claude Code reads the plugin from the payload copy');
    assert.ok(!list[0].errors, `no load errors: ${JSON.stringify(list[0].errors)}`);
    const mk = JSON.parse(claude(['plugin', 'marketplace', 'list', '--json']).stdout);
    assert.equal(mk.length, 1);
    assert.equal(mk[0].name, 'singular');
    assert.equal(fs.realpathSync(mk[0].path), fs.realpathSync(PAYLOAD));
    assert.ok(fs.existsSync(path.join(CFG, 'plugins', 'installed_plugins.json')), 'state went to the scratch config dir');
    assert.ok(!fs.existsSync(path.join(HOME, '.claude', 'plugins')), 'and not into the fake HOME');
    // the plugin validates where Claude Code will load it from
    const val = claude(['plugin', 'validate', PAYLOAD]);
    assert.equal(val.code, 0, val.stdout + val.stderr);
    assert.match(val.stdout, /Validation passed/);
  });

  test('singular status / doctor after the install', () => {
    const s = singular(['status']);
    assert.equal(s.code, 0, s.stderr);
    assert.match(s.stdout, /payload:     .*\/\.claude\/singular\/plugin  version \S+\nmarketplace: "singular" registered -> .*\/\.claude\/singular\/plugin\nplugin:      singular@singular installed, enabled, version \S+ \(scope user\)\nconfig:      .*\/\.claude\/singular\/config\.json  mode: suggest\n/);
    assert.doesNotMatch(s.stdout, /NOT the payload/);
    const j = singular(['status', '--json']);
    assert.equal(j.code, 0, j.stderr);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.plugin.installed, true);
    assert.equal(parsed.plugin.enabled, true);
    assert.equal(parsed.marketplace.matchesPayload, true);
    assert.equal(parsed.payload.version, expectedVersion);
    assert.equal(parsed.config.mode, 'suggest');
    assert.equal(parsed.env.CLAUDE_CONFIG_DIR, CFG);
    const d = singular(['doctor']);
    assert.equal(d.code, 0, d.stdout + d.stderr);
    assert.match(d.stdout, /\nNo problems found\. Type \/singular in Claude Code\.\n$/);
  });

  test('singular update is idempotent: same one plugin, same marketplace, payload replaced with a .prev backup', () => {
    fs.writeFileSync(path.join(PAYLOAD, 'lib', 'stale-marker.js'), '// should be gone after update\n');
    const r = singular(['update']);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /\[2\/5\] payload: copied \d+ entries to .* \(\S+ -> \S+; previous copy kept at .*plugin\.prev\)\n\[3\/5\] marketplace: `claude plugin marketplace update singular` ok\n/);
    assert.match(r.stdout, /\[4\/5\] plugin: `claude plugin update singular@singular` ok\n/);
    assert.match(r.stdout, /\[5\/5\] verify: singular@singular installed, enabled, version \S+\nInstalled\. Open a new Claude Code session \(or run \/reload-plugins\) and type \/singular\n$/);
    assert.ok(fs.existsSync(`${PAYLOAD}.prev`), 'backup kept');
    assert.ok(fs.existsSync(path.join(`${PAYLOAD}.prev`, 'lib', 'stale-marker.js')), 'the old copy is whole in .prev');
    assert.ok(!fs.existsSync(path.join(PAYLOAD, 'lib', 'stale-marker.js')), 'a replace, not a merge');
    assert.ok(!fs.existsSync(`${PAYLOAD}.tmp`));
    const list = JSON.parse(claude(['plugin', 'list', '--json']).stdout);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'singular@singular');
    assert.equal(list[0].enabled, true);
    assert.equal(fs.realpathSync(list[0].readFromFolder), fs.realpathSync(PAYLOAD));
    assert.equal(JSON.parse(claude(['plugin', 'marketplace', 'list', '--json']).stdout).length, 1);
    const second = singular(['update']);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(JSON.parse(claude(['plugin', 'list', '--json']).stdout).length, 1, 'still exactly one');
  });

  test('singular mode / find proxies run from the terminal through the installed package (no network: mode only)', () => {
    const r = singular(['mode']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^\\[singular\\] mode: suggest  \\(config file: ${path.join(HOME, '.claude', 'singular', 'config.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    assert.doesNotMatch(r.stdout, /ignored/, 'HOME was honoured (cwd is not an ancestor of it)');
    const bad = singular(['mode', 'turbo']);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout + bad.stderr, /unknown mode "turbo"/);
  });

  test('singular uninstall --purge: plugin + marketplace gone from the scratch config dir, ~/.claude/singular removed', () => {
    const r = singular(['uninstall', '--purge']);
    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /\[1\/3\] plugin: `claude plugin uninstall singular@singular` ok\n\[2\/3\] marketplace: `claude plugin marketplace remove singular` ok\n\[3\/3\] files: removed .*\nUninstalled and purged\./);
    assert.ok(!fs.existsSync(PAYLOAD));
    assert.ok(!fs.existsSync(`${PAYLOAD}.prev`));
    assert.ok(!fs.existsSync(path.join(HOME, '.claude', 'singular')), 'purged');
    assert.deepEqual(JSON.parse(claude(['plugin', 'list', '--json']).stdout), []);
    assert.deepEqual(JSON.parse(claude(['plugin', 'marketplace', 'list', '--json']).stdout), []);
    const again = singular(['uninstall']);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /not installed \(skipped\)[\s\S]*not registered \(skipped\)[\s\S]*nothing to remove/);
    const d = singular(['doctor']);
    assert.equal(d.code, 1, 'doctor reports the missing install');
    assert.match(d.stdout, /Problems \(3\):/);
  });

  test('the real ~/.claude was not touched', () => {
    assert.deepEqual(fingerprint(), before_);
  });
});

if (SKIP) test(`SKIP cli-install: ${SKIP}`, { skip: SKIP }, () => {});
