// lib/cli-core.js — the `singular` command-line tool (bin/singular-cli.js, npm package singular-skill).
//
//   singular install [--dir <path>] [--dry-run] [--json]   copy the plugin payload to ~/.claude/singular/plugin and
//                                                           register it with Claude Code (marketplace + plugin)
//   singular update                                         same as install (re-copy, marketplace update, plugin update)
//   singular uninstall [--purge]                            unregister and remove the payload (--purge: config, cache, log, pins too)
//   singular status [--json] | doctor                       versions, payload, marketplace, plugin, config, log tail (+ hints)
//   singular find|add|mode|init|load ...                    proxies to bin/singular.js (load: bin/on-expand.js) for terminal use
//
// Zero dependencies. Every `claude ...` call goes through execFile with an argument array (never a shell string) and
// inherits the caller's environment unchanged, so CLAUDE_CONFIG_DIR / HOME redirect Claude Code's state exactly as
// they do for the user. Every side effect (subprocesses, the file system, versions, output) comes from an injectable
// `deps` object: test/unit-cli.test.js drives the whole flow with a fake `claude`; test/cli-install.test.js runs the
// packed tarball against the real CLI in an isolated CLAUDE_CONFIG_DIR + HOME.
//
// Why a copied payload: Claude Code loads a directory marketplace plugin IN PLACE from the registered folder. A
// global npm install moves with every Node / nvm upgrade, so the registered path is the stable copy under
// ~/.claude/singular/plugin (replaced atomically: plugin.tmp -> plugin, previous copy kept as plugin.prev).

import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configPath, DEFAULTS, loadConfig } from './config.js';
import { logPath } from './log.js';

export const PLUGIN_NAME = 'singular';
export const MARKETPLACE = 'singular';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE}`;
export const MIN_NODE_MAJOR = 20;
export const MIN_CLAUDE_VERSION = '2.1.282';
/** What `singular install` copies (in this order) from the package directory; missing optional entries are skipped. */
export const PAYLOAD_ENTRIES = Object.freeze(['.claude-plugin', 'hooks', 'skills', 'bin', 'lib', 'package.json', 'LICENSE', 'README.md', 'config.example.json']);
export const REQUIRED_ENTRIES = Object.freeze(['.claude-plugin', 'hooks', 'skills', 'bin', 'lib', 'package.json']);
export const DONE_LINE = 'Installed. Open a new Claude Code session (or run /reload-plugins) and type /singular';
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMMANDS = Object.freeze(['install', 'update', 'uninstall', 'status', 'doctor', 'find', 'add', 'mode', 'init', 'load']);
export const PROXY_COMMANDS = Object.freeze(['find', 'add', 'mode', 'init', 'load']);
const INSTALL_STEPS = 5;
const UNINSTALL_STEPS = 3;
const CLAUDE_TIMEOUT_MS = 120000;

export const HELP = `singular — install and manage the Singular plugin for Claude Code

Usage: singular <command> [options]

Setup
  install [--dir <path>] [--dry-run] [--json]  copy the plugin payload to ~/.claude/singular/plugin and register it
                                               with Claude Code (claude plugin marketplace add + claude plugin install)
  update                                       same as install: re-copy the payload, refresh the marketplace, update the plugin
  uninstall [--purge]                          unregister the plugin, remove the payload; --purge also removes
                                               ~/.claude/singular (config, cache, log, pins)
  status [--json]                              node/claude versions, payload, marketplace, plugin, config, last log lines
  doctor                                       status plus actionable hints; exit 1 when something needs fixing

Skills (the same commands as /singular inside Claude Code)
  find <query>                                 gated third-party candidates from skills.sh (never installs)
  add <owner/repo[#sha]@skill> [--yes]         pinned persistent install into ~/.claude/skills with folder inspection
  mode [off|local|suggest|auto]                show or set the mode in ~/.claude/singular/config.json
  init [--no-remote] [--json] [--cwd <dir>]    inspect the project in cwd: needs, coverage, pinned candidates; writes a plan, installs nothing
  init --apply <1,3|1-3|all> [--project]       install the approved candidates from that plan (pinned; --project: ./.claude/skills)
  load <owner/repo[#sha]@skill> [--update]     print a skill's sanitized text (what /singular load injects)

Options
  --dir <path>    payload directory (default ~/.claude/singular/plugin)
  --dry-run       install: print the plan and change nothing
  --json          install, uninstall, status, doctor: machine-readable output
  -h, --help      this text
  -v, --version   print the CLI version

Environment: CLAUDE_CONFIG_DIR is passed through to claude unchanged (an isolated config dir works);
HOME decides where ~/.claude/singular lives. No other variable is read.
`;

// ---------------------------------------------------------------------------
// deps, errors, small helpers
// ---------------------------------------------------------------------------

export class CliError extends Error {
  constructor(message, { retry = null, step = null, command = null, exitCode = null } = {}) {
    super(message);
    this.name = 'CliError';
    this.retry = retry;
    this.step = step;
    this.command = command;
    this.exitCode = exitCode;
  }
}

export function defaultDeps(overrides = {}) {
  return {
    env: process.env,
    fs: nodeFs,
    execFileImpl: nodeExecFile,
    spawnImpl: nodeSpawn,
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    packageRoot: PACKAGE_ROOT,
    homedir: () => os.homedir(),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    ...overrides,
  };
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function cleanLines(text) {
  return String(text ?? '')
    .replace(ANSI_RE, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[^\n]*?(?:…|\.\.\.)\s*(?=[✔✘])/u, '').trim()) // drop "Adding marketplace…✔" / "Installing plugin...✔" progress prefixes
    .filter(Boolean);
}

function firstLine(text) {
  return cleanLines(text)[0] ?? '';
}

export function readJson(fs, file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** JSON.parse, tolerating progress text before the first `[`/`{` and after the last `]`/`}`. */
export function parseJsonLoose(text) {
  const s = String(text ?? '').replace(ANSI_RE, '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  const starts = [s.indexOf('['), s.indexOf('{')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function tailLines(fs, file, n) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

function canon(fs, p) {
  const abs = path.resolve(p);
  try {
    return typeof fs.realpathSync?.native === 'function' ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Same directory after symlink resolution (/tmp vs /private/tmp on macOS). */
export function samePath(fs, a, b) {
  if (!a || !b) return false;
  return canon(fs, a) === canon(fs, b);
}

function isInsideOrEqual(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// ---------------------------------------------------------------------------
// subprocesses
// ---------------------------------------------------------------------------

/**
 * execFile with an argument array; never a shell. Resolves (never rejects) with
 * {code, signal, stdout, stderr, notFound, timedOut, error, command}.
 */
export function runExec(deps, file, args, { timeoutMs = CLAUDE_TIMEOUT_MS, cwd } = {}) {
  const command = `${file} ${args.join(' ')}`.trim();
  return new Promise((resolve) => {
    const finish = (error, stdout, stderr) => {
      const out = String(stdout ?? '');
      const errText = String(stderr ?? '');
      if (!error) return resolve({ code: 0, signal: null, stdout: out, stderr: errText, notFound: false, timedOut: false, error: null, command });
      const notFound = error.code === 'ENOENT';
      const timedOut = error.killed === true || error.signal === 'SIGTERM';
      const code = typeof error.code === 'number' ? error.code : null;
      return resolve({ code, signal: error.signal ?? null, stdout: out, stderr: errText || (notFound ? `${file}: not found on PATH` : error.message), notFound, timedOut, error, command });
    };
    try {
      deps.execFileImpl(file, args, { env: deps.env, cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, finish);
    } catch (err) {
      finish(err, '', '');
    }
  });
}

async function claude(deps, args, opts) {
  const r = await runExec(deps, 'claude', args, opts);
  return { ...r, command: `claude ${args.join(' ')}`, ok: r.code === 0 && !r.notFound };
}

// ---------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), text: `${m[1]}.${m[2]}.${m[3]}` };
}

/** <0, 0, >0 like a comparator; NaN when either side does not parse. */
export function compareVersions(a, b) {
  const pa = typeof a === 'string' ? parseVersion(a) : a;
  const pb = typeof b === 'string' ? parseVersion(b) : b;
  if (!pa || !pb) return NaN;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/**
 * Node >= 20 (from deps.nodeVersion) and `claude --version` >= 2.1.282 on PATH.
 * @returns {Promise<{node:{version,ok}, claude:{found,version,ok,raw}, problems:string[]}>}
 */
export async function checkEnvironment(deps) {
  const nodeV = parseVersion(deps.nodeVersion);
  const result = {
    node: { version: String(deps.nodeVersion), ok: !!nodeV && nodeV.major >= MIN_NODE_MAJOR },
    claude: { found: false, version: null, ok: false, raw: '' },
    problems: [],
  };
  if (!result.node.ok) result.problems.push(`Node >= ${MIN_NODE_MAJOR} is required (found ${deps.nodeVersion}). Install a newer Node (https://nodejs.org) and re-run.`);
  const r = await runExec(deps, 'claude', ['--version'], { timeoutMs: 30000 });
  if (r.notFound) {
    result.problems.push('claude is not on PATH. Install Claude Code first (https://docs.claude.com/en/docs/claude-code/setup), open a new terminal, then re-run.');
    return result;
  }
  result.claude.found = true;
  result.claude.raw = (r.stdout || r.stderr).replace(ANSI_RE, '').trim();
  const v = parseVersion(r.stdout) ?? parseVersion(r.stderr);
  if (!v) {
    result.problems.push(r.code === 0 ? `could not parse \`claude --version\` output: "${firstLine(result.claude.raw) || '(empty)'}"` : `\`claude --version\` failed (exit ${r.code ?? (r.timedOut ? 'timeout' : 'unknown')}): ${firstLine(r.stderr || r.stdout) || 'no output'}`);
    return result;
  }
  result.claude.version = v.text;
  result.claude.ok = compareVersions(v, MIN_CLAUDE_VERSION) >= 0;
  if (!result.claude.ok) result.problems.push(`Claude Code >= ${MIN_CLAUDE_VERSION} is required (found ${v.text}). Run \`claude update\` (or reinstall Claude Code) and re-run.`);
  return result;
}

// ---------------------------------------------------------------------------
// paths and the payload copy
// ---------------------------------------------------------------------------

/** ~/.claude/singular (HOME-based, like lib/config.js defaultHomeDir) and the payload dir (--dir overrides it). */
export function statePaths(deps, { dir = null } = {}) {
  const home = path.resolve(deps.env.HOME || deps.homedir());
  const stateDir = path.join(home, '.claude', PLUGIN_NAME);
  const payloadDir = dir ? path.resolve(dir) : path.join(stateDir, 'plugin');
  return { home, stateDir, payloadDir, tmpDir: `${payloadDir}.tmp`, prevDir: `${payloadDir}.prev` };
}

export function payloadManifest(fs, payloadDir) {
  return readJson(fs, path.join(payloadDir, '.claude-plugin', 'plugin.json'));
}

/** Refuse payload directories that could never be right: a root, the home or an ancestor of it, the package itself, a foreign non-empty folder. */
export function guardPayloadDir(deps, paths) {
  const { payloadDir, home } = paths;
  if (payloadDir === path.parse(payloadDir).root) throw new CliError(`refusing to use the filesystem root ${payloadDir} as the payload directory`);
  if (isInsideOrEqual(home, payloadDir)) throw new CliError(`refusing to use ${payloadDir} as the payload directory: it is your home directory or contains it`);
  if (isInsideOrEqual(payloadDir, deps.packageRoot) || isInsideOrEqual(deps.packageRoot, payloadDir)) {
    throw new CliError(`refusing to copy the payload onto itself: ${payloadDir} is inside, equal to, or contains the package directory ${deps.packageRoot}`);
  }
  if (deps.fs.existsSync(payloadDir)) {
    let entries = [];
    try {
      entries = deps.fs.readdirSync(payloadDir);
    } catch (err) {
      throw new CliError(`cannot read ${payloadDir}: ${err.message}`);
    }
    const manifest = payloadManifest(deps.fs, payloadDir);
    if (entries.length && (!manifest || manifest.name !== PLUGIN_NAME)) {
      throw new CliError(`refusing to replace ${payloadDir}: it is not a singular payload (no .claude-plugin/plugin.json with name "${PLUGIN_NAME}"). Pass another --dir or move that folder away.`);
    }
  }
}

/**
 * Validate the package directory and copy PAYLOAD_ENTRIES into paths.payloadDir atomically:
 * copy into <payload>.tmp, move the current payload to <payload>.prev (kept for rollback), rename .tmp into place;
 * a failed final rename restores .prev. With dryRun only the plan is returned and nothing is written.
 */
export function copyPayload(deps, paths, { dryRun = false } = {}) {
  const { fs, packageRoot } = deps;
  const missing = REQUIRED_ENTRIES.filter((e) => !fs.existsSync(path.join(packageRoot, e)));
  if (missing.length) throw new CliError(`the package at ${packageRoot} is incomplete: missing ${missing.join(', ')}. Reinstall singular-skill (npm install -g singular-skill) and re-run.`);
  const manifest = payloadManifest(fs, packageRoot);
  if (!manifest || manifest.name !== PLUGIN_NAME) throw new CliError(`${path.join(packageRoot, '.claude-plugin', 'plugin.json')} is missing or does not name the "${PLUGIN_NAME}" plugin; reinstall singular-skill`);
  const marketplace = readJson(fs, path.join(packageRoot, '.claude-plugin', 'marketplace.json'));
  if (!marketplace || marketplace.name !== MARKETPLACE) throw new CliError(`${path.join(packageRoot, '.claude-plugin', 'marketplace.json')} is missing or does not name the "${MARKETPLACE}" marketplace; reinstall singular-skill`);
  const entries = PAYLOAD_ENTRIES.filter((e) => fs.existsSync(path.join(packageRoot, e)));
  const skipped = PAYLOAD_ENTRIES.filter((e) => !entries.includes(e));
  const previous = payloadManifest(fs, paths.payloadDir);
  const plan = { from: packageRoot, to: paths.payloadDir, entries, skipped, previousVersion: previous?.version ?? null, newVersion: manifest.version ?? null, replaced: fs.existsSync(paths.payloadDir), dryRun };
  if (dryRun) return plan;

  const { payloadDir, tmpDir, prevDir } = paths;
  try {
    fs.mkdirSync(path.dirname(payloadDir), { recursive: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const e of entries) {
      fs.cpSync(path.join(packageRoot, e), path.join(tmpDir, e), { recursive: true, dereference: false, force: true, errorOnExist: false, filter: (src) => path.basename(src) !== '.DS_Store' && path.basename(src) !== 'node_modules' });
    }
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    throw new CliError(`could not copy the payload into ${tmpDir}: ${err.message}`);
  }
  const copied = payloadManifest(fs, tmpDir);
  if (!copied || copied.name !== PLUGIN_NAME) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new CliError(`the copied payload at ${tmpDir} has no valid .claude-plugin/plugin.json; nothing was replaced`);
  }
  if (plan.replaced) {
    try {
      fs.rmSync(prevDir, { recursive: true, force: true });
      fs.renameSync(payloadDir, prevDir);
    } catch (err) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw new CliError(`could not move the current payload ${payloadDir} aside to ${prevDir}: ${err.message} (nothing was replaced)`);
    }
  }
  try {
    fs.renameSync(tmpDir, payloadDir);
  } catch (err) {
    let restored = false;
    if (plan.replaced) {
      try {
        fs.renameSync(prevDir, payloadDir);
        restored = true;
      } catch {
        restored = false;
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    throw new CliError(`could not move ${tmpDir} into place at ${payloadDir}: ${err.message}${plan.replaced ? (restored ? ' (previous payload restored)' : ` (previous payload left at ${prevDir}; move it back by hand)`) : ''}`);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// what Claude Code knows: marketplace + plugin state
// ---------------------------------------------------------------------------

/** @returns {Promise<{known:boolean, registered:boolean|null, path:string|null, via:string, error?:string}>} */
export async function marketplaceState(deps) {
  const j = await claude(deps, ['plugin', 'marketplace', 'list', '--json']);
  const parsed = j.ok ? parseJsonLoose(j.stdout) : null;
  if (Array.isArray(parsed)) {
    const e = parsed.find((m) => m && m.name === MARKETPLACE);
    return { known: true, registered: !!e, path: e ? (e.path ?? e.installLocation ?? null) : null, via: 'json' };
  }
  // Older CLIs without --json, or non-JSON output: parse the text listing.
  const t = j.ok && /Configured marketplaces:/.test(j.stdout) ? j : await claude(deps, ['plugin', 'marketplace', 'list']);
  const plain = `${t.stdout}\n${t.stderr}`.replace(ANSI_RE, '');
  const m = new RegExp(`❯\\s*${escapeRe(MARKETPLACE)}\\s*\\n\\s*Source:\\s*[^(\\n]*\\(([^)\\n]*)\\)`, 'u').exec(plain) ?? new RegExp(`❯\\s*${escapeRe(MARKETPLACE)}\\s*\\n\\s*Source:\\s*([^\\n]*)`, 'u').exec(plain);
  if (m) return { known: true, registered: true, path: m[1].trim() || null, via: 'text' };
  if (t.ok || /Configured marketplaces:|No marketplaces/i.test(plain)) return { known: true, registered: false, path: null, via: 'text' };
  return { known: false, registered: null, path: null, via: 'error', error: firstLine(t.stderr || t.stdout) || `exit ${t.code ?? 'unknown'}` };
}

/** @returns {Promise<{known:boolean, installed:boolean|null, enabled:boolean|null, version:string|null, scope:string|null, readFromFolder:string|null, errors:string[], via:string, error?:string}>} */
export async function pluginState(deps) {
  const none = { known: true, installed: false, enabled: null, version: null, scope: null, readFromFolder: null, errors: [], via: 'json' };
  const j = await claude(deps, ['plugin', 'list', '--json']);
  const parsed = j.ok ? parseJsonLoose(j.stdout) : null;
  if (Array.isArray(parsed)) {
    const e = parsed.find((p) => p && p.id === PLUGIN_ID);
    if (!e) return none;
    return { known: true, installed: true, enabled: e.enabled !== false, version: e.version ?? e.folderVersion ?? null, scope: e.scope ?? null, readFromFolder: e.readFromFolder ?? e.installPath ?? null, errors: Array.isArray(e.errors) ? e.errors.map(String) : [], via: 'json' };
  }
  const t = j.ok && /Installed plugins:/.test(j.stdout) ? j : await claude(deps, ['plugin', 'list']);
  const plain = `${t.stdout}\n${t.stderr}`.replace(ANSI_RE, '');
  const block = new RegExp(`❯\\s*${escapeRe(PLUGIN_ID)}\\s*\\n((?:[ \\t]+\\S[^\\n]*\\n?)*)`, 'u').exec(plain);
  if (block) {
    const body = block[1];
    const version = /Version:\s*(\S+)/.exec(body)?.[1] ?? null;
    const scope = /Scope:\s*(\S+)/.exec(body)?.[1] ?? null;
    const from = /Read from:\s*([^\n]+)/.exec(body)?.[1]?.trim() ?? null;
    const status = /Status:\s*([^\n]+)/.exec(body)?.[1] ?? '';
    return { known: true, installed: true, enabled: !/disabled/i.test(status), version, scope, readFromFolder: from, errors: [], via: 'text' };
  }
  if (t.ok || /Installed plugins:|No plugins installed/i.test(plain)) return { ...none, via: 'text' };
  return { known: false, installed: null, enabled: null, version: null, scope: null, readFromFolder: null, errors: [], via: 'error', error: firstLine(t.stderr || t.stdout) || `exit ${t.code ?? 'unknown'}` };
}

function commandFailed(label, idx, total, stepName, r, notes = []) {
  const exitText = r.notFound ? 'not found on PATH' : r.timedOut ? 'timed out' : `exited ${r.code ?? 'unknown'}`;
  const lines = [`singular ${label}: step ${idx}/${total} (${stepName}) failed: \`${r.command}\` ${exitText}`, ...cleanLines(`${r.stdout}\n${r.stderr}`).map((l) => `  ${l}`), ...notes.map((n) => `  ${n}`)];
  return new CliError(lines.join('\n'), { retry: `Retry: singular ${label}   (or run \`${r.command}\` yourself and then \`singular ${label}\` again)`, step: stepName, command: r.command, exitCode: r.code });
}

function reportFailure(deps, label, err, { json, report }) {
  const e = err instanceof CliError ? err : new CliError(`singular ${label}: ${err?.message ?? String(err)}`);
  const message = e.message.startsWith('singular ') ? e.message : `singular ${label}: ${e.message}`;
  if (json) {
    deps.stdout(`${JSON.stringify({ ...report, ok: false, error: message, retry: e.retry, failedStep: e.step, failedCommand: e.command }, null, 2)}\n`);
  } else {
    deps.stderr(`${message}\n${e.retry ? `${e.retry}\n` : ''}`);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// install / update
// ---------------------------------------------------------------------------

/**
 * The five steps: (1) node + claude versions, (2) atomic payload copy, (3) marketplace add (or update when it is
 * already registered at that path; add also re-points a marketplace registered elsewhere), (4) plugin install (or
 * update when installed), (5) verify with `claude plugin list --json` (and enable if disabled). Any failure exits 1
 * with the exact command that failed; a marketplace this run added is removed again so nothing stays half-registered.
 */
export async function install(deps, { dryRun = false, json = false, dir = null, label = 'install' } = {}) {
  const total = INSTALL_STEPS;
  const report = { ok: false, command: label, dryRun, steps: [], payloadDir: null, versions: {}, plan: null };
  const say = (s) => {
    if (!json) deps.stdout(`${s}\n`);
  };
  const step = (name, detail, extra = {}) => report.steps.push({ name, detail, ...extra });
  let addedMarketplace = false;
  try {
    // 1. environment
    const envc = await checkEnvironment(deps);
    report.versions = { node: envc.node.version, claude: envc.claude.version };
    if (envc.problems.length) throw new CliError(`singular ${label}: step 1/${total} (environment) failed:\n${envc.problems.map((p) => `  ${p}`).join('\n')}`, { step: 'environment', retry: `Retry: singular ${label}` });
    say(`[1/${total}] environment: node ${envc.node.version}, claude ${envc.claude.version} (ok)`);
    step('environment', `node ${envc.node.version}, claude ${envc.claude.version}`);

    // 2. payload
    const paths = statePaths(deps, { dir });
    report.payloadDir = paths.payloadDir;
    guardPayloadDir(deps, paths);
    const plan = copyPayload(deps, paths, { dryRun });
    report.plan = plan;
    const versionNote = plan.previousVersion ? `${plan.previousVersion} -> ${plan.newVersion ?? '?'}` : `version ${plan.newVersion ?? '?'}`;
    if (dryRun) {
      say(`[2/${total}] payload: would copy ${plan.entries.join(', ')} from ${plan.from} to ${plan.to} (${versionNote}${plan.replaced ? `; current copy kept at ${paths.prevDir}` : ''})${plan.skipped.length ? `; not in this package: ${plan.skipped.join(', ')}` : ''}`);
    } else {
      say(`[2/${total}] payload: copied ${plan.entries.length} entries to ${plan.to} (${versionNote}${plan.replaced ? `; previous copy kept at ${paths.prevDir}` : ''})`);
    }
    step('payload', `${plan.entries.length} entries -> ${plan.to}`, { previousVersion: plan.previousVersion, newVersion: plan.newVersion, replaced: plan.replaced });

    // 3. marketplace
    const ms = await marketplaceState(deps);
    const samePlace = ms.registered === true && samePath(deps.fs, ms.path, paths.payloadDir);
    const mArgs = samePlace ? ['plugin', 'marketplace', 'update', MARKETPLACE] : ['plugin', 'marketplace', 'add', paths.payloadDir];
    const mNote = ms.registered && !samePlace ? ` (marketplace "${MARKETPLACE}" was registered at ${ms.path ?? 'an unknown path'}; re-pointing it at the payload)` : ms.known ? '' : ` (could not read the marketplace list: ${ms.error ?? 'unknown error'}; trying add)`;
    if (dryRun) {
      say(`[3/${total}] marketplace: would run \`claude ${mArgs.join(' ')}\`${mNote}`);
      step('marketplace', `would run claude ${mArgs.join(' ')}`, { registered: ms.registered, path: ms.path });
    } else {
      const r = await claude(deps, mArgs);
      if (!r.ok) throw commandFailed(label, 3, total, 'marketplace', r, [`The payload copy at ${paths.payloadDir} is complete; nothing was registered.`]);
      addedMarketplace = ms.registered !== true;
      say(`[3/${total}] marketplace: \`${r.command}\` ok${mNote}`);
      for (const l of cleanLines(r.stdout)) say(`  ${l}`);
      step('marketplace', r.command, { registered: ms.registered, path: ms.path, output: cleanLines(r.stdout) });
    }

    // 4. plugin
    const ps = await pluginState(deps);
    const pArgs = ps.installed === true ? ['plugin', 'update', PLUGIN_ID] : ['plugin', 'install', PLUGIN_ID];
    if (dryRun) {
      say(`[4/${total}] plugin: would run \`claude ${pArgs.join(' ')}\`${ps.installed ? ` (${PLUGIN_ID} ${ps.version ?? ''} is installed)` : ''}`);
      step('plugin', `would run claude ${pArgs.join(' ')}`, { installed: ps.installed, version: ps.version });
      say(`[5/${total}] verify: skipped (dry run)`);
      say(`Dry run: nothing was changed. Run \`singular ${label}\` to apply.`);
      report.ok = true;
      if (json) deps.stdout(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    const r = await claude(deps, pArgs);
    if (!r.ok) {
      const notes = [];
      if (addedMarketplace) {
        const rb = await claude(deps, ['plugin', 'marketplace', 'remove', MARKETPLACE]);
        notes.push(rb.ok ? `Marketplace "${MARKETPLACE}" added by this run was removed again (nothing is half-registered).` : `Marketplace "${MARKETPLACE}" added by this run could NOT be removed (\`${rb.command}\` ${rb.code === null ? 'failed' : `exited ${rb.code}`}); remove it with \`claude plugin marketplace remove ${MARKETPLACE}\` or just re-run.`);
      }
      notes.push(`The payload copy at ${paths.payloadDir} is complete and harmless; re-running registers it.`);
      throw commandFailed(label, 4, total, 'plugin', r, notes);
    }
    say(`[4/${total}] plugin: \`${r.command}\` ok`);
    for (const l of cleanLines(r.stdout)) say(`  ${l}`);
    step('plugin', r.command, { wasInstalled: ps.installed === true, output: cleanLines(r.stdout) });

    // 5. verify
    const after = await pluginState(deps);
    if (after.installed !== true) {
      throw new CliError(`singular ${label}: step 5/${total} (verify) failed: \`claude plugin list --json\` does not list ${PLUGIN_ID} after \`${r.command}\`${after.error ? ` (${after.error})` : ''}`, { retry: `Retry: singular ${label}   (or run \`claude plugin list\` to see what Claude Code has)`, step: 'verify', command: 'claude plugin list --json' });
    }
    let enabledNote = '';
    if (after.enabled === false) {
      const en = await claude(deps, ['plugin', 'enable', PLUGIN_ID]);
      if (!en.ok) throw commandFailed(label, 5, total, 'verify', en, [`${PLUGIN_ID} is installed but disabled.`]);
      enabledNote = ' (was disabled; enabled it)';
    }
    const folderNote = after.readFromFolder && !samePath(deps.fs, after.readFromFolder, paths.payloadDir) ? ` — note: Claude Code reads it from ${after.readFromFolder}, not ${paths.payloadDir}` : '';
    say(`[5/${total}] verify: ${PLUGIN_ID} installed, enabled, version ${after.version ?? '?'}${enabledNote}${folderNote}`);
    step('verify', `${PLUGIN_ID} version ${after.version ?? '?'}`, { enabled: true, readFromFolder: after.readFromFolder });
    if (after.errors.length) for (const e of after.errors) say(`  ! ${e}`);
    say(DONE_LINE);
    report.ok = true;
    report.message = DONE_LINE;
    if (json) deps.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (err) {
    return reportFailure(deps, label, err, { json, report });
  }
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

/** Remove `dir` only when it sits where this CLI would have put a payload (never the home, never the package). */
function safeRemoveDir(deps, dir, paths) {
  if (!deps.fs.existsSync(dir)) return false;
  if (dir === path.parse(dir).root || isInsideOrEqual(paths.home, dir) || isInsideOrEqual(deps.packageRoot, dir) || isInsideOrEqual(dir, deps.packageRoot)) {
    throw new CliError(`refusing to remove ${dir}`);
  }
  deps.fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export async function uninstall(deps, { purge = false, dir = null, json = false, label = 'uninstall' } = {}) {
  const total = UNINSTALL_STEPS;
  const report = { ok: false, command: label, purge, steps: [], removed: [], kept: [] };
  const say = (s) => {
    if (!json) deps.stdout(`${s}\n`);
  };
  try {
    const paths = statePaths(deps, { dir });
    const envc = await checkEnvironment(deps);
    if (!envc.claude.found) {
      throw new CliError(`singular ${label}: claude is not on PATH, so the plugin cannot be unregistered. Put claude on PATH (or install Claude Code) and re-run; the payload at ${paths.payloadDir} was left in place.`, { retry: `Retry: singular ${label}` });
    }
    // 1. plugin
    const u = await claude(deps, ['plugin', 'uninstall', PLUGIN_ID]);
    const uOut = `${u.stdout}\n${u.stderr}`;
    if (u.ok) {
      say(`[1/${total}] plugin: \`${u.command}\` ok`);
      report.steps.push({ name: 'plugin', command: u.command, outcome: 'removed' });
    } else if (/not found in installed plugins|not_installed|not installed/i.test(uOut)) {
      say(`[1/${total}] plugin: ${PLUGIN_ID} is not installed (skipped)`);
      report.steps.push({ name: 'plugin', command: u.command, outcome: 'not-installed' });
    } else {
      throw commandFailed(label, 1, total, 'plugin', u);
    }
    // 2. marketplace
    const m = await claude(deps, ['plugin', 'marketplace', 'remove', MARKETPLACE]);
    const mOut = `${m.stdout}\n${m.stderr}`;
    if (m.ok) {
      say(`[2/${total}] marketplace: \`${m.command}\` ok`);
      report.steps.push({ name: 'marketplace', command: m.command, outcome: 'removed' });
    } else if (/not found|not_configured/i.test(mOut)) {
      say(`[2/${total}] marketplace: "${MARKETPLACE}" is not registered (skipped)`);
      report.steps.push({ name: 'marketplace', command: m.command, outcome: 'not-registered' });
    } else {
      throw commandFailed(label, 2, total, 'marketplace', m);
    }
    // 3. files
    for (const d of [paths.payloadDir, paths.prevDir, paths.tmpDir]) {
      if (safeRemoveDir(deps, d, paths)) report.removed.push(d);
    }
    if (purge) {
      if (safeRemoveDir(deps, paths.stateDir, paths)) report.removed.push(paths.stateDir);
    } else if (deps.fs.existsSync(paths.stateDir)) {
      report.kept.push(paths.stateDir);
    }
    say(`[3/${total}] files: ${report.removed.length ? `removed ${report.removed.join(', ')}` : 'nothing to remove'}`);
    report.steps.push({ name: 'files', removed: report.removed });
    if (purge) {
      say(`Uninstalled and purged. Skills installed earlier with /singular add stay in ~/.claude/skills (remove them yourself if you want them gone).`);
    } else {
      say(`Uninstalled.${report.kept.length ? ` State kept at ${report.kept.join(', ')} (config, cache, log, pins); \`singular uninstall --purge\` removes it too.` : ''}`);
    }
    report.ok = true;
    if (json) deps.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (err) {
    return reportFailure(deps, label, err, { json, report });
  }
}

// ---------------------------------------------------------------------------
// status / doctor
// ---------------------------------------------------------------------------

export async function collectCliStatus(deps, { dir = null } = {}) {
  const envc = await checkEnvironment(deps);
  const paths = statePaths(deps, { dir });
  const manifest = payloadManifest(deps.fs, paths.payloadDir);
  const payload = { path: paths.payloadDir, exists: deps.fs.existsSync(paths.payloadDir), version: manifest?.version ?? null, valid: !!manifest && manifest.name === PLUGIN_NAME, backup: deps.fs.existsSync(paths.prevDir) ? paths.prevDir : null };
  let marketplace = { known: false, registered: null, path: null, via: 'skipped' };
  let plugin = { known: false, installed: null, enabled: null, version: null, scope: null, readFromFolder: null, errors: [], via: 'skipped' };
  if (envc.claude.found) {
    marketplace = await marketplaceState(deps);
    plugin = await pluginState(deps);
  }
  marketplace.matchesPayload = marketplace.registered === true && samePath(deps.fs, marketplace.path, paths.payloadDir);
  let config = { path: null, mode: null, fileMode: null, warnings: [], exists: null };
  try {
    const file = configPath(deps.env);
    if (!deps.fs.existsSync(file)) {
      // status/doctor are read-only: loadConfig would create config.json from the defaults on its first run
      // (the hooks do that on the first prompt); report the defaults instead of writing them here.
      config = { path: file, mode: DEFAULTS.mode, fileMode: DEFAULTS.mode, warnings: [], exists: false };
    } else {
      const c = loadConfig(deps.env);
      config = { path: c.path, mode: c.mode, fileMode: c.fileMode, warnings: [...(c.warnings ?? [])], exists: true };
    }
  } catch (err) {
    config.warnings.push(`config unreadable: ${err?.message ?? err}`);
  }
  const logFile = logPath(deps.env);
  const cliPkg = readJson(deps.fs, path.join(deps.packageRoot, 'package.json'));
  return {
    cli: { version: cliPkg?.version ?? null, packageRoot: deps.packageRoot },
    node: envc.node,
    claude: envc.claude,
    environmentProblems: envc.problems,
    stateDir: paths.stateDir,
    payload,
    marketplace,
    plugin,
    config,
    log: { path: logFile, tail: tailLines(deps.fs, logFile, 5) },
    env: { HOME: deps.env.HOME ?? null, CLAUDE_CONFIG_DIR: deps.env.CLAUDE_CONFIG_DIR ?? null, SINGULAR_HOME: deps.env.SINGULAR_HOME ?? null, SINGULAR_MODE: deps.env.SINGULAR_MODE ?? null },
  };
}

export function formatCliStatus(s) {
  const lines = [];
  lines.push(`singular CLI ${s.cli.version ?? '?'}  (package: ${s.cli.packageRoot})`);
  lines.push(`node:        ${s.node.version}  ${s.node.ok ? `ok (>= ${MIN_NODE_MAJOR})` : `TOO OLD (need >= ${MIN_NODE_MAJOR})`}`);
  if (!s.claude.found) lines.push('claude:      not found on PATH');
  else if (!s.claude.version) lines.push(`claude:      found, version unknown (${s.claude.raw.slice(0, 80) || 'no output'})`);
  else lines.push(`claude:      ${s.claude.version}  ${s.claude.ok ? `ok (>= ${MIN_CLAUDE_VERSION})` : `TOO OLD (need >= ${MIN_CLAUDE_VERSION})`}`);
  if (!s.payload.exists) lines.push(`payload:     ${s.payload.path}  missing (run: singular install)`);
  else if (!s.payload.valid) lines.push(`payload:     ${s.payload.path}  present but not a valid singular payload (run: singular install)`);
  else lines.push(`payload:     ${s.payload.path}  version ${s.payload.version ?? '?'}${s.payload.backup ? `  (previous copy at ${s.payload.backup})` : ''}`);
  const m = s.marketplace;
  if (m.via === 'skipped') lines.push('marketplace: unknown (claude not available)');
  else if (!m.known) lines.push(`marketplace: unknown (${m.error ?? 'could not list marketplaces'})`);
  else if (!m.registered) lines.push(`marketplace: "${MARKETPLACE}" not registered (run: singular install)`);
  else lines.push(`marketplace: "${MARKETPLACE}" registered -> ${m.path ?? '?'}${m.matchesPayload ? '' : '  (NOT the payload above; run: singular install)'}`);
  const p = s.plugin;
  if (p.via === 'skipped') lines.push('plugin:      unknown (claude not available)');
  else if (!p.known) lines.push(`plugin:      unknown (${p.error ?? 'could not list plugins'})`);
  else if (!p.installed) lines.push(`plugin:      ${PLUGIN_ID} not installed (run: singular install)`);
  else lines.push(`plugin:      ${PLUGIN_ID} installed, ${p.enabled ? 'enabled' : 'DISABLED'}, version ${p.version ?? '?'}${p.scope ? ` (scope ${p.scope})` : ''}${p.readFromFolder && !samePath(nodeFs, p.readFromFolder, s.payload.path) ? `, read from ${p.readFromFolder}` : ''}`);
  for (const e of p.errors ?? []) lines.push(`  ! ${e}`);
  lines.push(`config:      ${s.config.path ?? '?'}  mode: ${s.config.mode ?? '?'}${s.config.fileMode && s.config.fileMode !== s.config.mode ? ` (file says "${s.config.fileMode}")` : ''}`);
  for (const w of s.config.warnings) lines.push(`  ! ${w}`);
  const ov = Object.entries(s.env).filter(([k, v]) => v && k !== 'HOME');
  if (ov.length) lines.push(`env:         ${ov.map(([k, v]) => `${k}=${v}`).join(' ')}`);
  lines.push(`log:         ${s.log.path}${s.log.tail.length ? ` (last ${s.log.tail.length} line${s.log.tail.length === 1 ? '' : 's'})` : ' (empty)'}`);
  for (const l of s.log.tail) lines.push(`  ${l.slice(0, 200)}`);
  return lines.join('\n');
}

/** Problems with one actionable hint each; empty when everything is in order. */
export function diagnose(s) {
  const out = [];
  const add = (problem, hint) => out.push({ problem, hint });
  if (!s.node.ok) add(`Node ${s.node.version} is too old`, `install Node >= ${MIN_NODE_MAJOR} (https://nodejs.org); the hooks run with the node on PATH`);
  if (!s.claude.found) add('claude is not on PATH', 'install Claude Code (https://docs.claude.com/en/docs/claude-code/setup) and open a new terminal');
  else if (!s.claude.version) add('claude --version did not print a version', 'run `claude --version` yourself; reinstall Claude Code if it fails');
  else if (!s.claude.ok) add(`Claude Code ${s.claude.version} is too old`, `run \`claude update\` (needs >= ${MIN_CLAUDE_VERSION} for the UserPromptExpansion hook)`);
  if (!s.payload.exists) add(`payload missing at ${s.payload.path}`, 'run `singular install`');
  else if (!s.payload.valid) add(`${s.payload.path} is not a valid singular payload`, 'run `singular install` (it replaces the folder atomically)');
  if (s.claude.found) {
    if (!s.marketplace.known) add(`cannot read the marketplace list (${s.marketplace.error ?? 'unknown error'})`, 'run `claude plugin marketplace list` yourself and fix what it reports');
    else if (!s.marketplace.registered) add(`marketplace "${MARKETPLACE}" is not registered`, 'run `singular install`');
    else if (!s.marketplace.matchesPayload) add(`marketplace "${MARKETPLACE}" points at ${s.marketplace.path ?? '?'}, not the payload ${s.payload.path}`, 'run `singular install` (it re-points the marketplace at the payload)');
    if (!s.plugin.known) add(`cannot read the plugin list (${s.plugin.error ?? 'unknown error'})`, 'run `claude plugin list` yourself and fix what it reports');
    else if (!s.plugin.installed) add(`${PLUGIN_ID} is not installed`, 'run `singular install`');
    else {
      if (s.plugin.enabled === false) add(`${PLUGIN_ID} is disabled`, `run \`claude plugin enable ${PLUGIN_ID}\``);
      if (s.payload.version && s.plugin.version && s.payload.version !== s.plugin.version) add(`plugin version ${s.plugin.version} differs from the payload ${s.payload.version}`, 'run `singular update`, then start a new Claude Code session (or /reload-plugins)');
      for (const e of s.plugin.errors ?? []) add(`Claude Code reports: ${e}`, 'run `singular install` to re-register the payload');
    }
  }
  if (s.config.mode === 'auto') add('mode is "auto"', 'third-party skill text is injected without confirmation; `singular mode suggest` reverts it (see README "What auto actually costs")');
  for (const w of s.config.warnings) if (!/TEST SEAM/.test(w)) add(`config: ${w}`, `fix ${s.config.path ?? 'config.json'} by hand (singular keeps running on defaults meanwhile)`);
  return out;
}

export async function status(deps, { dir = null, json = false } = {}) {
  const s = await collectCliStatus(deps, { dir });
  if (json) deps.stdout(`${JSON.stringify(s, null, 2)}\n`);
  else deps.stdout(`${formatCliStatus(s)}\n`);
  return 0;
}

export async function doctor(deps, { dir = null, json = false } = {}) {
  const s = await collectCliStatus(deps, { dir });
  const problems = diagnose(s);
  if (json) {
    deps.stdout(`${JSON.stringify({ ...s, problems, ok: problems.length === 0 }, null, 2)}\n`);
  } else {
    const lines = [formatCliStatus(s), ''];
    if (!problems.length) lines.push('No problems found. Type /singular in Claude Code.');
    else {
      lines.push(`Problems (${problems.length}):`);
      for (const p of problems) lines.push(`  - ${p.problem}`, `    fix: ${p.hint}`);
    }
    deps.stdout(`${lines.join('\n')}\n`);
  }
  return problems.length ? 1 : 0;
}

// ---------------------------------------------------------------------------
// proxies: find / add / mode / init -> bin/singular.js, load -> bin/on-expand.js (direct CLI mode)
// ---------------------------------------------------------------------------

export function proxyTarget(deps, command, args) {
  const script = command === 'load' ? 'on-expand.js' : 'singular.js';
  const file = path.join(deps.packageRoot, 'bin', script);
  return { file, argv: command === 'load' ? [file, ...args] : [file, command, ...args] };
}

export function proxy(deps, command, args = []) {
  const { file, argv } = proxyTarget(deps, command, args);
  if (!deps.fs.existsSync(file)) {
    deps.stderr(`singular ${command}: ${file} is missing from this package; reinstall singular-skill (npm install -g singular-skill)\n`);
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = deps.spawnImpl(deps.execPath, argv, { stdio: 'inherit', env: deps.env, windowsHide: true });
    } catch (err) {
      deps.stderr(`singular ${command}: could not start node: ${err?.message ?? err}\n`);
      return resolve(1);
    }
    child.on('error', (err) => {
      deps.stderr(`singular ${command}: could not start node: ${err?.message ?? err}\n`);
      resolve(1);
    });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const a = Array.isArray(argv) ? [...argv] : [];
  const out = { command: null, dir: null, dryRun: false, json: false, purge: false, help: false, version: false, rest: [], errors: [] };
  if (a.length === 0) {
    out.help = true;
    return out;
  }
  const first = a[0];
  if (first === '-h' || first === '--help' || first === 'help') {
    out.help = true;
    return out;
  }
  if (first === '-v' || first === '--version' || first === 'version') {
    out.version = true;
    return out;
  }
  if (first.startsWith('-')) {
    out.errors.push(`unknown option ${first}`);
    return out;
  }
  out.command = first;
  if (PROXY_COMMANDS.includes(first)) {
    out.rest = a.slice(1); // passed through verbatim to the plugin scripts
    return out;
  }
  if (!COMMANDS.includes(first)) {
    out.errors.push(`unknown command "${first}"`);
    return out;
  }
  for (let i = 1; i < a.length; i++) {
    const t = a[i];
    if (t === '--dir') {
      const v = a[++i];
      if (!v || v.startsWith('-')) out.errors.push('--dir needs a path');
      else out.dir = v;
    } else if (t.startsWith('--dir=')) out.dir = t.slice('--dir='.length) || null;
    else if (t === '--dry-run') out.dryRun = true;
    else if (t === '--json') out.json = true;
    else if (t === '--purge') out.purge = true;
    else if (t === '-h' || t === '--help') out.help = true;
    else if (t.startsWith('-')) out.errors.push(`unknown option ${t}`);
    else out.errors.push(`unexpected argument "${t}"`);
  }
  if (out.dryRun && out.command !== 'install' && out.command !== 'update') out.errors.push(`--dry-run applies to install/update only`);
  if (out.purge && out.command !== 'uninstall') out.errors.push(`--purge applies to uninstall only`);
  return out;
}

/** The whole CLI: returns the exit code (never throws, never calls process.exit). */
export async function runCli(argv, overrides = {}) {
  const deps = defaultDeps(overrides);
  const args = parseArgs(argv);
  if (args.errors.length) {
    deps.stderr(`singular: ${args.errors.join('; ')}\n\n${HELP}`);
    return 1;
  }
  if (args.version) {
    deps.stdout(`${readJson(deps.fs, path.join(deps.packageRoot, 'package.json'))?.version ?? 'unknown'}\n`);
    return 0;
  }
  if (args.help) {
    deps.stdout(HELP);
    return 0;
  }
  try {
    switch (args.command) {
      case 'install':
        return await install(deps, { dryRun: args.dryRun, json: args.json, dir: args.dir, label: 'install' });
      case 'update':
        return await install(deps, { dryRun: args.dryRun, json: args.json, dir: args.dir, label: 'update' });
      case 'uninstall':
        return await uninstall(deps, { purge: args.purge, dir: args.dir, json: args.json });
      case 'status':
        return await status(deps, { dir: args.dir, json: args.json });
      case 'doctor':
        return await doctor(deps, { dir: args.dir, json: args.json });
      default:
        return await proxy(deps, args.command, args.rest);
    }
  } catch (err) {
    deps.stderr(`singular ${args.command}: ${err?.message ?? err}\n`);
    return 1;
  }
}
