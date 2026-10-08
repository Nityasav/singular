// lib/config.js — skill-scout configuration.
//
//   loadConfig(env)            -> Config (DEFAULTS merged with $SKILL_SCOUT_HOME/config.json; created on first run)
//   DEFAULTS                   -> the built-in defaults (frozen)
//   configPath(env)            -> absolute path of config.json
//   homeDir(env)               -> $SKILL_SCOUT_HOME (absolute only) or ~/.claude/skill-scout (mkdir -p)
//   defaultHomeDir(env)        -> ~/.claude/skill-scout regardless of SKILL_SCOUT_HOME
//   isAllowlisted(source, list)-> owner or owner/repo match, case-insensitive
//   validateConfig(raw)        -> {config, warnings}   (pure; used by loadConfig and scout-status)
//   hardenEnv(env, {cwd})      -> copy of env with untrusted SKILL_SCOUT_HOME / HOME / TMPDIR overrides removed
//   testSeams(env, {cwd})      -> the test-only seams (docs/testing.md), validated; never a user feature
//   tmpdirOf(env)              -> the temp base for clones and npx runs, from the (hardened) env, never process.env alone
//
// Environment variables reach the hook process from the user's shell AND from a repository's committed
// `.claude/settings.json` `env` block, so the environment is treated as untrusted and can only LOWER
// privilege (docs/security.md §1):
//   SKILL_SCOUT_HOME  state directory: honoured only when absolute and (in hook mode) neither inside nor an
//                     ancestor of the project cwd (an ancestor would let a checkout named `cache` be the cache dir)
//   TMPDIR/TMP/TEMP   a value inside the project cwd is replaced by the platform default (the temp cwd of a clone or
//                     `npx skills` run must never sit inside the repository: npm would read its .npmrc)
//   SKILL_SCOUT_MODE  can only downgrade the file's mode (off < local < suggest < auto); never raises it
//   mode "auto"       is honoured only when it comes from the default ~/.claude/skill-scout/config.json
//
// Test seams (docs/testing.md; NOT user features; every honoured seam is logged as a warning and listed by
// /scout-status, and production behaviour is byte-identical when they are unset):
//   SKILL_SCOUT_REGISTRY_BASE  http(s)://localhost|127.0.0.1|[::1][:port][/path] replaces https://skills.sh
//   SKILL_SCOUT_GIT_BASE       absolute local path or file:// URL (neither inside nor above the project) replaces
//                              https://github.com, and skill text is then fetched with git instead of `npx skills use`
//   SKILL_SCOUT_SKILLS_DIR     absolute path (neither inside nor above the project) replaces ~/.claude/skills for /scout-add
//   SKILL_SCOUT_TEST_ALLOW_AUTO=1  honours mode "auto" in a redirected SKILL_SCOUT_HOME (still never from the env)
// Remote http(s) git bases and non-loopback registry hosts are refused: a repository's env block must not be
// able to redirect a trusted ref to another host.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MODES = Object.freeze(['off', 'local', 'suggest', 'auto']);
export const SEAM_VARS = Object.freeze(['SKILL_SCOUT_REGISTRY_BASE', 'SKILL_SCOUT_GIT_BASE', 'SKILL_SCOUT_SKILLS_DIR', 'SKILL_SCOUT_TEST_ALLOW_AUTO']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const DEFAULTS = Object.freeze({
  mode: 'suggest',
  allowlist: Object.freeze(['anthropics', 'vercel-labs', 'microsoft', 'multica-ai']),
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
  blockedRefs: Object.freeze([]),
  pinnedSkills: Object.freeze([]),
  prefetch: true,
});

const CLI_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function realHome() {
  try {
    const h = os.userInfo().homedir;
    if (h && path.isAbsolute(h)) return h;
  } catch {
    /* no passwd entry */
  }
  return os.homedir();
}

/**
 * Resolve symlinks in `p` as far as the path exists (the longest existing ancestor is realpath'd, the
 * rest re-joined), so `/tmp/x` and `/private/tmp/x`, or `<repo>/alias -> <repo>`, compare equal.
 */
function realResolve(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...rest.reverse());
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isInside(child, parent) {
  const c = realResolve(child);
  const p = realResolve(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** `p` is the project, inside it, or an ancestor of it: a path a repository could reach or be checked out under. */
function touchesProject(p, cwd) {
  return isInside(p, cwd) || isInside(cwd, p);
}

/** The platform's default temp directory, independent of TMPDIR/TMP/TEMP. */
function platformTmpdir(env = process.env) {
  if (process.platform === 'win32') return path.join(env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows', 'Temp');
  return '/tmp';
}

/**
 * Temp base for pinned clones and `npx skills use` runs: TMPDIR (TEMP/TMP on Windows) from the given env when it is
 * an absolute path, else os.tmpdir(). Callers pass the hardened env, in which an in-project value has already been
 * replaced, so a repository's env block can never place the work dir (and npm's config walk-up) inside itself.
 */
export function tmpdirOf(env = process.env) {
  const keys = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR', 'TMP', 'TEMP'];
  for (const k of keys) {
    const v = env && env[k] != null ? String(env[k]).trim() : '';
    if (v && path.isAbsolute(v)) return path.resolve(v);
  }
  return os.tmpdir();
}

/** ~/.claude/skill-scout for the given env (HOME override honoured; SKILL_SCOUT_HOME ignored). */
export function defaultHomeDir(env = process.env) {
  return path.join(env.HOME || os.homedir(), '.claude', 'skill-scout');
}

/** Is SKILL_SCOUT_HOME usable? Only absolute paths count; relative values are ignored (they would resolve against the project cwd). */
export function redirectedHome(env = process.env) {
  const raw = env.SKILL_SCOUT_HOME && String(env.SKILL_SCOUT_HOME).trim();
  if (!raw) return null;
  if (!path.isAbsolute(raw)) return null;
  return path.resolve(raw);
}

export function homeDir(env = process.env) {
  const dir = redirectedHome(env) ?? defaultHomeDir(env);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* read-only FS: callers still get a path */
  }
  return dir;
}

export function configPath(env = process.env) {
  return path.join(homeDir(env), 'config.json');
}

/**
 * Copy of `env` with environment overrides that could hand a repository control of skill-scout removed:
 * a relative SKILL_SCOUT_HOME, a SKILL_SCOUT_HOME inside `cwd` (the project) or an ancestor of it (the cache
 * or state dir would then be a sibling checkout), a HOME that differs from the account's real home AND lies
 * inside `cwd`, and a TMPDIR/TMP/TEMP inside `cwd` (replaced by the platform default: a clone or npx work dir
 * inside the repository would hand npm the repository's .npmrc). Invalid test seams are removed too; honoured
 * ones are reported as warnings so every entrypoint logs them. Returns {env, warnings, seams}. Pure; never throws.
 */
export function hardenEnv(env = process.env, { cwd } = {}) {
  const out = { ...env };
  const warnings = [];
  const raw = out.SKILL_SCOUT_HOME && String(out.SKILL_SCOUT_HOME).trim();
  if (raw) {
    if (!path.isAbsolute(raw)) {
      warnings.push(`SKILL_SCOUT_HOME=${raw} ignored (must be an absolute path)`);
      delete out.SKILL_SCOUT_HOME;
    } else if (cwd && isInside(raw, cwd)) {
      warnings.push(`SKILL_SCOUT_HOME=${raw} ignored (inside the project directory ${cwd})`);
      delete out.SKILL_SCOUT_HOME;
    } else if (cwd && isInside(cwd, raw)) {
      warnings.push(`SKILL_SCOUT_HOME=${raw} ignored (an ancestor of the project directory ${cwd})`);
      delete out.SKILL_SCOUT_HOME;
    }
  }
  if (cwd) {
    for (const k of ['TMPDIR', 'TMP', 'TEMP']) {
      const v = out[k] && String(out[k]).trim();
      if (!v) continue;
      if (!path.isAbsolute(v) || isInside(v, cwd)) {
        const fallback = platformTmpdir(out);
        warnings.push(`${k}=${v} ignored (${path.isAbsolute(v) ? 'inside the project directory' : 'relative; would resolve inside the project directory'} ${cwd}); using ${fallback}`);
        out[k] = fallback;
      }
    }
  }
  const home = out.HOME && String(out.HOME).trim();
  if (home && cwd) {
    const real = realHome();
    if (path.resolve(home) !== path.resolve(real) && isInside(home, cwd)) {
      warnings.push(`HOME=${home} ignored (inside the project directory ${cwd}); using ${real}`);
      out.HOME = real;
    }
  }
  const seams = testSeams(out, { cwd });
  for (const v of seams.invalid) delete out[v];
  warnings.push(...seams.warnings);
  return { env: out, warnings, seams };
}

/**
 * Parse and validate the test-only seams (see the header). Each is honoured only in its narrow form:
 *   registryBase  http(s) URL whose host is loopback (a fixture server); trailing slash dropped
 *   gitBase       absolute local path or file:// URL, neither inside nor an ancestor of `cwd` when given; never http(s)
 *                 (an ancestor base would resolve <base>/<owner>/<repo> to a sibling or the project checkout itself)
 *   skillsDir     absolute path, neither inside nor an ancestor of `cwd` when given
 *   allowAuto     the literal value "1"
 * Returns {registryBase, gitBase, skillsDir, allowAuto, active, invalid, warnings}; `invalid` names the
 * variables that must be dropped, `warnings` explains every drop and announces every active seam. Pure.
 */
export function testSeams(env = process.env, { cwd } = {}) {
  const out = { registryBase: null, gitBase: null, skillsDir: null, allowAuto: false, active: [], invalid: [], warnings: [] };
  const note = 'test seam, see docs/testing.md';
  const get = (k) => (env && env[k] != null ? String(env[k]).trim() : '');
  const outsideProject = (p) => !cwd || !touchesProject(p, cwd);

  const reg = get('SKILL_SCOUT_REGISTRY_BASE');
  if (reg) {
    let ok = false;
    try {
      const u = new URL(reg);
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname) && !u.search && !u.hash;
      if (ok) out.registryBase = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      ok = false;
    }
    if (ok) out.active.push('SKILL_SCOUT_REGISTRY_BASE');
    else {
      out.invalid.push('SKILL_SCOUT_REGISTRY_BASE');
      out.warnings.push(`SKILL_SCOUT_REGISTRY_BASE=${reg} ignored (${note}: only http(s)://localhost, 127.0.0.1 or [::1] is honoured)`);
    }
  }

  const git = get('SKILL_SCOUT_GIT_BASE');
  if (git) {
    let local = null;
    if (/^file:\/\//i.test(git)) {
      try {
        const u = new URL(git);
        if (u.protocol === 'file:' && (!u.hostname || u.hostname === 'localhost')) local = decodeURIComponent(u.pathname);
      } catch {
        local = null;
      }
    } else if (path.isAbsolute(git)) local = git;
    if (local && path.isAbsolute(local) && outsideProject(local)) {
      out.gitBase = /^file:\/\//i.test(git) ? `file://${path.resolve(local).replace(/\/+$/, '')}` : path.resolve(local).replace(/\/+$/, '');
      out.active.push('SKILL_SCOUT_GIT_BASE');
    } else {
      out.invalid.push('SKILL_SCOUT_GIT_BASE');
      out.warnings.push(`SKILL_SCOUT_GIT_BASE=${git} ignored (${note}: must be an absolute local path or file:// URL neither inside nor above the project directory; remote hosts are never honoured)`);
    }
  }

  const skills = get('SKILL_SCOUT_SKILLS_DIR');
  if (skills) {
    if (path.isAbsolute(skills) && outsideProject(skills)) {
      out.skillsDir = path.resolve(skills);
      out.active.push('SKILL_SCOUT_SKILLS_DIR');
    } else {
      out.invalid.push('SKILL_SCOUT_SKILLS_DIR');
      out.warnings.push(`SKILL_SCOUT_SKILLS_DIR=${skills} ignored (${note}: must be an absolute path neither inside nor above the project directory)`);
    }
  }

  const auto = get('SKILL_SCOUT_TEST_ALLOW_AUTO');
  if (auto) {
    if (auto === '1') {
      out.allowAuto = true;
      out.active.push('SKILL_SCOUT_TEST_ALLOW_AUTO');
    } else {
      out.invalid.push('SKILL_SCOUT_TEST_ALLOW_AUTO');
      out.warnings.push(`SKILL_SCOUT_TEST_ALLOW_AUTO=${auto} ignored (${note}: only "1" is honoured)`);
    }
  }
  for (const v of out.active) out.warnings.push(`TEST SEAM ACTIVE: ${v}=${get(v)} (${note}; never set this in a real shell)`);
  return out;
}

/** The honoured registry base URL (no trailing slash) or null when the seam is unset / invalid. */
export function seamRegistryBase(env = process.env) {
  return testSeams(env).registryBase;
}

/** The honoured git base (absolute path or file:// URL, no trailing slash) or null. */
export function seamGitBase(env = process.env) {
  return testSeams(env).gitBase;
}

/** The honoured /scout-add target directory or null. */
export function seamSkillsDir(env = process.env) {
  return testSeams(env).skillsDir;
}

/** `source` is owner/repo (or a bare owner); entries are `owner` or `owner/repo`, exact, case-insensitive. */
export function isAllowlisted(source, allowlist) {
  const src = String(source ?? '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!src) return false;
  const owner = src.split('/')[0];
  for (const raw of Array.isArray(allowlist) ? allowlist : []) {
    const entry = String(raw ?? '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
    if (!entry) continue;
    if (entry.includes('/')) {
      if (entry === src) return true;
    } else if (entry === owner) {
      return true;
    }
  }
  return false;
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Merge a raw object over DEFAULTS, type-checking every known key (a wrong type
 * falls back to the default and yields a warning). Unknown keys are kept as-is.
 */
export function validateConfig(raw) {
  const warnings = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (src !== raw) warnings.push('config is not a JSON object; using defaults');
  const cfg = { ...src };
  const fallback = (key, why) => {
    warnings.push(`${key}: ${why}; using default ${JSON.stringify(DEFAULTS[key])}`);
    cfg[key] = Array.isArray(DEFAULTS[key]) ? [...DEFAULTS[key]] : DEFAULTS[key];
  };
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (!(key in src)) {
      cfg[key] = Array.isArray(def) ? [...def] : def;
      continue;
    }
    const v = src[key];
    if (key === 'mode') {
      if (typeof v !== 'string' || !MODES.includes(v.toLowerCase())) fallback(key, `must be one of ${MODES.join('|')}`);
      else cfg.mode = v.toLowerCase();
    } else if (key === 'skillsCliVersion') {
      if (typeof v !== 'string' || !CLI_VERSION_RE.test(v)) fallback(key, 'must be a semver string like "1.5.26"');
    } else if (Array.isArray(def)) {
      if (!isStringArray(v)) fallback(key, 'must be an array of strings');
      else cfg[key] = v.map((s) => s.trim()).filter(Boolean);
    } else if (typeof def === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fallback(key, 'must be a non-negative number');
    } else if (typeof def === 'boolean') {
      if (typeof v !== 'boolean') fallback(key, 'must be true or false');
    } else if (typeof v !== typeof def) {
      fallback(key, `must be a ${typeof def}`);
    }
  }
  return { config: cfg, warnings };
}

/**
 * Load the config. Creates config.json from DEFAULTS on first run. Never throws:
 * an unreadable or corrupt file yields DEFAULTS plus `warnings`.
 * The result carries non-enumerable `warnings`, `path`, `fileMode` and `redirected` for diagnostics.
 */
export function loadConfig(env = process.env) {
  const file = configPath(env);
  const redirected = redirectedHome(env) !== null;
  let raw = null;
  const warnings = [];
  let missing = false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    try {
      raw = JSON.parse(text);
    } catch (err) {
      warnings.push(`config.json is not valid JSON (${err.message}); using defaults`);
    }
  } catch (err) {
    // Only a genuinely missing file is created from the defaults; anything else (EISDIR, EACCES, ...) is
    // reported so /scout-status shows a "!" line instead of silently pretending the file is absent.
    if (err && err.code === 'ENOENT') missing = true;
    else warnings.push(`config.json unreadable (${err?.code ?? err?.message ?? 'unknown error'}); using defaults`);
  }
  if (missing) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(DEFAULTS, null, 2)}\n`, { flag: 'wx' });
    } catch {
      /* raced or read-only: fine */
    }
  }
  const { config, warnings: w2 } = validateConfig(raw ?? {});
  warnings.push(...w2);
  const fileMode = config.mode;
  if (config.mode === 'auto' && redirected) {
    if (testSeams(env).allowAuto) {
      warnings.push(`TEST SEAM: SKILL_SCOUT_TEST_ALLOW_AUTO=1 honours mode "auto" in the redirected ${homeDir(env)} (test-only; never set this in a real shell)`);
    } else {
      warnings.push(`mode "auto" ignored: it is honoured only in the default ${defaultHomeDir(env)}/config.json, not in a SKILL_SCOUT_HOME redirect; using "suggest"`);
      config.mode = 'suggest';
    }
  }
  if (env.SKILL_SCOUT_HOME && !redirected && String(env.SKILL_SCOUT_HOME).trim()) {
    warnings.push(`SKILL_SCOUT_HOME=${env.SKILL_SCOUT_HOME} ignored (must be an absolute path)`);
  }
  if (env.SKILL_SCOUT_MODE) {
    const m = String(env.SKILL_SCOUT_MODE).trim().toLowerCase();
    if (!MODES.includes(m)) warnings.push(`SKILL_SCOUT_MODE=${env.SKILL_SCOUT_MODE} ignored (not one of ${MODES.join('|')})`);
    else if (MODES.indexOf(m) > MODES.indexOf(config.mode)) warnings.push(`SKILL_SCOUT_MODE=${m} ignored (the environment can only lower the mode below "${config.mode}")`);
    else config.mode = m;
  }
  Object.defineProperty(config, 'warnings', { value: warnings, enumerable: false });
  Object.defineProperty(config, 'path', { value: file, enumerable: false });
  Object.defineProperty(config, 'fileMode', { value: fileMode, enumerable: false });
  Object.defineProperty(config, 'redirected', { value: redirected, enumerable: false });
  return config;
}
