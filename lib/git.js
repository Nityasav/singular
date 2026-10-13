// lib/git.js — the few git operations singular performs, shared by lib/refs.js, lib/registry.js and
// lib/commands/add.js (/singular add). Zero dependencies; every call is execFile with an argument array (no shell),
// GIT_TERMINAL_PROMPT=0, LC_ALL=C, an allowlisted child environment (childEnv), hard timeouts with SIGKILL.
//
//   GITHUB_BASE                         'https://github.com'
//   gitBase(env)                        -> GITHUB_BASE, or the SINGULAR_GIT_BASE test seam (local path / file:// only)
//   repoUrl(owner, repo, env)           -> `${gitBase}/${owner}/${repo}`
//   childEnv(env, extra)                -> the minimal, fixed environment every git / npx child gets (allowlist, never the
//                                          inherited env: a repository's .claude/settings.json env block reaches hook
//                                          processes, and GIT_CONFIG_* / npm_config_* there would redirect clones and npx)
//   describeGitFailure(what, r, ms)     -> one-line error text; credential prompts become "repository not found or private"
//   runExecFile(impl, file, args, opts) -> Promise<{error, code, signal, killed, stdout, stderr}> (never rejects)
//   cloneAtSha({...})                   -> fetch exactly one commit into an empty dir (init / remote add / fetch --depth 1 / checkout)
//   findSkillDirs(root)                 -> every SKILL.md folder under root as {dir, rel, name}
//
// The owner/repo segments are validated by the callers (lib/refs.js grammar) before they reach an argv.

import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { seamGitBase } from './config.js';
import { parseFrontmatter } from './skill-index.js';

export const GITHUB_BASE = 'https://github.com';

// The only variables a git or npx child inherits from singular's own environment. That environment is
// untrusted (docs/security.md section 4: a repository's committed `.claude/settings.json` `env` block is
// applied to every hook process), and git honours GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n
// (`url.<elsewhere>.insteadOf=https://github.com/` would make a trusted ref fetch attacker-chosen text under an
// allowlisted owner), GIT_SSL_NO_VERIFY, GIT_SSH_COMMAND, GIT_PROXY_COMMAND, GIT_EXEC_PATH, GIT_DIR, XDG_CONFIG_HOME
// (a config file inside the repository), while npm honours npm_config_registry (`npx skills` would download and run
// a package from an attacker registry), npm_config_cache / npm_config_userconfig, NODE_OPTIONS, NODE_PATH,
// NODE_TLS_REJECT_UNAUTHORIZED and NODE_EXTRA_CA_CERTS / SSL_CERT_FILE (an attacker CA inside the repository).
// None of those are copied. PATH, HOME and the proxy variables are: a proxy cannot forge a verified TLS peer, and
// a corporate CA or registry mirror belongs in ~/.gitconfig (http.sslCAInfo) / ~/.npmrc (cafile, registry), which
// git and npm still read from HOME.
export const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  // Windows: git and node need these to start at all
  'SYSTEMROOT', 'SystemRoot', 'SYSTEMDRIVE', 'SystemDrive', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP',
]);
// What every child gets regardless of the caller: no credential prompts, stable English messages, no colour.
export const CHILD_ENV_FIXED = Object.freeze({ GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', NO_COLOR: '1' });

/**
 * The environment for a git / npx child: the allowlisted keys of `env` (strings only), the fixed values, then
 * `extra` (TMPDIR=<work dir>, DISABLE_TELEMETRY=1, ...). Everything else in `env` is dropped. Pure.
 */
export function childEnv(env = process.env, extra = {}) {
  const out = {};
  const src = env && typeof env === 'object' ? env : {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    if (src[k] != null && String(src[k]) !== '') out[k] = String(src[k]);
  }
  return { ...out, ...CHILD_ENV_FIXED, ...extra };
}
// What git prints when GitHub answers a request for a missing or private repository with a credential
// prompt (which GIT_TERMINAL_PROMPT=0 turns into an error), or when it names the condition itself.
export const CREDENTIAL_PROMPT_RE = /could not read Username|Repository not found|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)/i;
const MAX_SKILL_MD_SCAN = 2000;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

export function gitBase(env = process.env) {
  return seamGitBase(env) ?? GITHUB_BASE;
}

export function repoUrl(owner, repo, env = process.env) {
  return `${gitBase(env)}/${owner}/${repo}`;
}

/** Promise wrapper over an execFile-shaped function; closes the child's stdin; never rejects. */
export function runExecFile(execFileImpl, file, args, options) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (error, stdout, stderr) => {
      if (done) return;
      done = true;
      resolve({
        error: error ?? null,
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        signal: error?.signal ?? null,
        killed: Boolean(error?.killed || error?.signal),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    };
    let child;
    try {
      child = execFileImpl(file, args, options, finish);
    } catch (err) {
      finish(err, '', '');
      return;
    }
    try {
      child?.stdin?.end?.();
    } catch {
      /* ignore */
    }
  });
}

/**
 * One-line description of a failed git run. A credential prompt (what GitHub does for a missing or
 * private repository) is named as such, with the raw detail kept after it.
 */
export function describeGitFailure(what, r, timeoutMs) {
  if (r.killed || r.signal) return `${what} timed out after ${timeoutMs}ms`;
  const err = String(r.stderr ?? '').trim() || r.error?.message || '';
  const detail = err.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300);
  const code = r.code ?? r.error?.code ?? 'unknown';
  const hint = CREDENTIAL_PROMPT_RE.test(err) ? 'repository not found or private (GitHub asked for credentials)' : '';
  const tail = [hint, detail].filter(Boolean).join(': ');
  return `${what} failed (exit ${code})${tail ? `: ${tail}` : ''}`;
}

/**
 * Fetch exactly one commit of <base>/<owner>/<repo> into `dest` (an existing, empty directory), the way
 * the skills CLI's cloneAtSha does: git init, remote add, fetch --depth 1 <sha>, checkout FETCH_HEAD.
 * Returns {ok: true, steps} or {ok: false, step, message}. Never throws.
 */
export async function cloneAtSha({ owner, repo, sha, dest, timeoutMs = 90000, execFileImpl = nodeExecFile, env = process.env, tmpdir } = {}) {
  const url = repoUrl(owner, repo, env);
  const gitEnv = childEnv(env, tmpdir ? { TMPDIR: tmpdir } : {});
  const steps = [
    ['init', ['init', '-q']],
    ['remote add', ['remote', 'add', 'origin', url]],
    ['fetch', ['fetch', '--depth', '1', 'origin', sha]],
    ['checkout', ['-c', 'core.symlinks=true', 'checkout', '-q', 'FETCH_HEAD']],
  ];
  for (const [label, args] of steps) {
    const r = await runExecFile(execFileImpl, 'git', args, { cwd: dest, env: gitEnv, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    if (r.killed) return { ok: false, step: label, message: `git ${label} timed out after ${timeoutMs}ms` };
    if (r.error || r.code !== 0) return { ok: false, step: label, message: `${describeGitFailure(`git ${label}`, r, timeoutMs)} — could not fetch ${owner}/${repo} at ${sha}` };
  }
  return { ok: true, url, env: gitEnv };
}

/** Every SKILL.md under `root` (depth-limited, skipping .git/node_modules), as {dir, rel, name} sorted by rel. */
export function findSkillDirs(root, maxDepth = 6) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  let scanned = 0;
  while (stack.length && scanned < MAX_SKILL_MD_SCAN) {
    const { dir, depth } = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      scanned++;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name) && depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (ent.isFile() && ent.name === 'SKILL.md') {
        let name = null;
        try {
          name = parseFrontmatter(fs.readFileSync(full, 'utf8')).name;
        } catch {
          name = null;
        }
        out.push({ dir, rel: path.relative(root, dir) || '.', name: name ? String(name).trim() : null });
      }
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}
