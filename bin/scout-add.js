#!/usr/bin/env node
// bin/scout-add.js — persistent, pinned install of one allowlisted skill with inspection BEFORE anything
// lands in ~/.claude/skills.
//
//   node bin/scout-add.js <owner/repo[#sha]@skill> [--yes] [--json]
//
// 1. ref must match REF_RE, owner must be allowlisted, ref must not be blocked
// 2. sha: from the ref, else `git ls-remote ... HEAD` (pin)
// 3. refuses if ~/.claude/skills/<skill> already exists (never overwrites)
// 4. pinned fetch into a fresh temp dir, exactly what the skills CLI's cloneAtSha does:
//      git init && git remote add origin https://github.com/<owner>/<repo> && git fetch --depth 1 origin <sha> && git checkout FETCH_HEAD
//    (execFile, args array, GIT_TERMINAL_PROMPT=0, no shell)
// 5. locate the skill folder: a SKILL.md whose directory name OR frontmatter `name` equals <skill> exactly
//    (the skills CLI matches case-insensitively; we do not, so `@DOCX` cannot install `docx`)
// 6. `git ls-tree -r <sha> -- <skill path>`: any 120000 (symlink), 100755 (exec bit) or 160000 (submodule)
//    entry rejects the skill before it is copied — the CLI's `fs.cp({dereference: true})` would otherwise
//    turn a symlink to a host file into a regular file that no later inspection could see
// 7. inspectSkillFolder(<checkout>/<skill path>) (plugin components, capability frontmatter, shell forms)
// 8. only then: fs.cpSync(checkout -> ~/.claude/skills/<skill>) with dereference: false, errorOnExist,
//    a snapshot diff of ~/.claude/skills (exactly one new entry: the target) and a post-copy re-inspection;
//    any failure removes exactly the folder we created (guarded three ways; other entries that appeared
//    meanwhile belong to someone else and are only reported) and prints REJECTED
// 9. otherwise INSTALLED <ref> sha <sha> + audit JSON + "Run /reload-skills or start a new session"

import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import { hardenEnv, homeDir, isAllowlisted, loadConfig, seamSkillsDir, tmpdirOf } from '../lib/config.js';
import { TAG } from '../lib/context.js';
import { childEnv, cloneAtSha, findSkillDirs, repoUrl, runExecFile } from '../lib/git.js';
import { inspectSkillFolder } from '../lib/inspect.js';
import { log, timer } from '../lib/log.js';
import { auditSkill } from '../lib/registry.js';
import { formatRef, parseRef, REF_RE, resolveHeadSha, unpinnedRef } from '../lib/refs.js';

export const ADD_TIMEOUT_MS = 90000;
export { findSkillDirs };

/** ~/.claude/skills, or the SKILL_SCOUT_SKILLS_DIR test seam (absolute, outside the project; docs/testing.md). */
export function skillsDir(env = process.env) {
  return seamSkillsDir(env) ?? path.join(env.HOME || os.homedir(), '.claude', 'skills');
}

const run = runExecFile;

/** The CLI prints an ANSI box before the JSON; find the last parseable JSON value in stdout. (Kept for tooling.) */
export function parseCliJson(stdout) {
  const s = String(stdout ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t !== '[' && t !== '{' && !t.startsWith('[{') && !t.startsWith('{"')) continue;
    const chunk = lines.slice(i).join('\n').trim();
    for (let end = chunk.length; end > 0; end--) {
      const c = chunk[end - 1];
      if (c !== ']' && c !== '}') continue;
      try {
        return JSON.parse(chunk.slice(0, end));
      } catch {
        /* keep shrinking */
      }
    }
  }
  return null;
}

function isBlockedRef(parsed, blockedRefs) {
  const src = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  const full = `${src}@${parsed.skill.toLowerCase()}`;
  for (const raw of Array.isArray(blockedRefs) ? blockedRefs : []) {
    const e = String(raw).trim().toLowerCase().replace(/#[0-9a-f]{40}(?=@)/, '');
    if (e && (e === full || e === src || e === parsed.owner.toLowerCase())) return true;
  }
  return false;
}

function recordInstall(env, entry) {
  const file = path.join(homeDir(env), 'installed.json');
  let map = {};
  try {
    map = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!map || typeof map !== 'object') map = {};
  } catch {
    map = {};
  }
  map[entry.key] = entry;
  try {
    fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
  } catch {
    /* ignore */
  }
}

/** Parse `git ls-tree -r` output; return entries whose mode is not a plain file (100644). */
export function unsafeTreeEntries(lsTreeOut) {
  const bad = [];
  for (const line of String(lsTreeOut ?? '').split('\n')) {
    if (!line.trim()) continue;
    const m = /^(\d{6})\s+(\S+)\s+([0-9a-f]{40})\t(.*)$/.exec(line);
    if (!m) {
      bad.push({ mode: '?', path: line.slice(0, 120), why: 'unparseable ls-tree line' });
      continue;
    }
    const [, mode, type, , p] = m;
    if (mode === '120000') bad.push({ mode, path: p, why: 'symlink' });
    else if (mode === '100755') bad.push({ mode, path: p, why: 'executable bit' });
    else if (mode === '160000' || type === 'commit') bad.push({ mode, path: p, why: 'git submodule' });
    else if (mode !== '100644' || type !== 'blob') bad.push({ mode, path: p, why: `unexpected mode/type ${mode} ${type}` });
  }
  return bad;
}

/**
 * @returns {Promise<{status:'installed'|'rejected'|'error', ref?, sha?, path?, problems?, audit?, message, files?}>}
 */
export async function runScoutAdd({ ref, env: rawEnv = process.env, deps = {}, config: cfgOverride, timeoutMs = ADD_TIMEOUT_MS } = {}) {
  const t = timer();
  const hardened = hardenEnv(rawEnv, { cwd: rawEnv.PWD || process.cwd() });
  const env = hardened.env;
  for (const w of hardened.warnings) log('warn', /TEST SEAM/.test(w) ? 'scout-add: test seam active' : 'scout-add: environment override ignored', { warning: w });
  const config = cfgOverride ?? loadConfig(env);
  const execFileImpl = deps.execFileImpl ?? nodeExecFile;
  const gitDeps = { ...deps, env };
  const raw = String(ref ?? '').trim();
  if (!REF_RE.test(raw)) return { status: 'error', message: `invalid ref "${raw.slice(0, 80)}": expected owner/repo@skill or owner/repo#<40-hex-sha>@skill` };
  const parsed = parseRef(raw);
  if (!parsed) return { status: 'error', message: `invalid ref "${raw.slice(0, 80)}": segments must start with a letter or digit` };
  const source = `${parsed.owner}/${parsed.repo}`;
  if (!isAllowlisted(source, config.allowlist)) {
    return { status: 'error', message: `REJECTED: owner "${parsed.owner}" is not allowlisted [${config.allowlist.join(', ')}]. Add it to "allowlist" in ${config.path ?? 'config.json'} if you trust it.` };
  }
  if (isBlockedRef(parsed, config.blockedRefs)) return { status: 'error', message: `REJECTED: ${unpinnedRef(parsed)} matches blockedRefs` };

  // --- the target must not exist: checked BEFORE any network round trip (a rerun used to pay a ls-remote first)
  const root = skillsDir(env);
  const target = path.join(root, parsed.skill);
  if (path.dirname(target) !== root || path.basename(target) !== parsed.skill) {
    return { status: 'error', message: `refusing unexpected target path ${target}` };
  }
  let pre = null;
  try {
    pre = fs.lstatSync(target);
  } catch {
    pre = null;
  }
  if (pre) return { status: 'error', message: `REFUSED: ${target} already exists (${pre.isSymbolicLink() ? 'symlink' : pre.isDirectory() ? 'directory' : 'file'}). Remove it yourself first; skill-scout never overwrites.` };

  let sha = parsed.sha;
  if (!sha) {
    try {
      sha = await resolveHeadSha(parsed.owner, parsed.repo, { timeoutMs: 8000 }, gitDeps);
    } catch (err) {
      return { status: 'error', message: `could not resolve HEAD of ${repoUrl(parsed.owner, parsed.repo, env)}: ${String(err?.message ?? err)}` };
    }
  }
  const pinned = formatRef({ ...parsed, sha });
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    return { status: 'error', message: `cannot create ${root}: ${err.message}` };
  }

  // --- pinned fetch into a temp dir (same steps as the skills CLI's cloneAtSha; lib/git.js)
  const base = path.resolve(deps.tmpdir ?? tmpdirOf(env));
  fs.mkdirSync(base, { recursive: true });
  const work = fs.mkdtempSync(path.join(base, 'skill-scout-add-'));
  const checkout = path.join(work, 'repo');
  fs.mkdirSync(checkout);
  const gitEnv = childEnv(env, { TMPDIR: work });
  const git = (args, extra = {}) => run(execFileImpl, 'git', args, { cwd: checkout, env: gitEnv, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...extra });
  const cleanup = () => {
    if (work.startsWith(base + path.sep)) fs.rmSync(work, { recursive: true, force: true });
  };
  const fail = (message) => {
    cleanup();
    return { status: 'error', message };
  };
  try {
    const cloned = await cloneAtSha({ owner: parsed.owner, repo: parsed.repo, sha, dest: checkout, timeoutMs, execFileImpl, env, tmpdir: work });
    if (!cloned.ok) return fail(cloned.message);

    // --- locate the skill folder (exact match on directory name or frontmatter name)
    const all = findSkillDirs(checkout);
    const matches = all.filter((s) => path.basename(s.dir) === parsed.skill || s.name === parsed.skill);
    if (matches.length === 0) {
      const label = (s) => {
        const dir = path.basename(s.dir);
        return s.name && s.name !== dir ? `${dir} (name: ${s.name})` : dir;
      };
      const names = [...new Set(all.map(label))].slice(0, 30);
      return fail(`no skill named "${parsed.skill}" in ${source} at ${sha.slice(0, 7)} (exact, case-sensitive). Found: ${names.join(', ') || 'none'}`);
    }
    if (matches.length > 1) return fail(`ambiguous: ${matches.length} folders match "${parsed.skill}" in ${source}: ${matches.map((m) => m.rel).join(', ')}`);
    const found = matches[0];
    const relPath = found.rel === '.' ? '' : found.rel.split(path.sep).join('/');

    // --- tree modes from git itself: symlinks / exec bits / submodules never reach the copy step
    const problems = [];
    const ls = await git(['ls-tree', '-r', 'FETCH_HEAD', '--', relPath || '.']);
    if (ls.error || ls.code !== 0) return fail(`git ls-tree failed (exit ${ls.code ?? 'unknown'}): ${ls.stderr.trim().slice(0, 300)}`);
    for (const e of unsafeTreeEntries(ls.stdout)) problems.push(`${e.why} in repository tree: ${e.path} (mode ${e.mode})`);

    // --- folder / frontmatter / shell-form inspection on the checkout (before anything is copied)
    const inspection = await inspectSkillFolder(found.dir);
    problems.push(...inspection.problems);
    if (problems.length > 0) {
      const unique = [...new Set(problems)];
      log('warn', 'scout-add rejected before copy', { ref: pinned, problems: unique });
      cleanup();
      return {
        status: 'rejected',
        ref: pinned,
        sha,
        path: target,
        problems: unique,
        removed: false,
        copied: false,
        message: `REJECTED: ${pinned}\n  ${unique.join('\n  ')}\nNothing was written to ${root}.`,
      };
    }

    // --- copy (no dereference; refuse to overwrite), verify exactly one new entry appeared, re-inspect
    let before;
    try {
      before = new Set(fs.readdirSync(root));
    } catch (err) {
      return fail(`cannot read ${root}: ${err.message}`);
    }
    let preCopy = null;
    try {
      preCopy = fs.lstatSync(target);
    } catch {
      preCopy = null;
    }
    if (preCopy) return fail(`REFUSED: ${target} appeared while fetching; not touching it.`);
    try {
      fs.cpSync(found.dir, target, { recursive: true, dereference: false, errorOnExist: true, force: false, verbatimSymlinks: true, filter: (src) => path.basename(src) !== '.git' });
    } catch (err) {
      const removed = removeCreated(target, root, parsed.skill, before);
      return fail(`copy into ${target} failed: ${err.message}${removed ? ' (partial copy removed)' : ''}`);
    }
    const after = new Set(fs.readdirSync(root));
    const created = [...after].filter((n) => !before.has(n));
    const post = await inspectSkillFolder(target);
    let postSt = null;
    try {
      postSt = fs.lstatSync(target);
    } catch {
      postSt = null;
    }
    const postProblems = [...post.problems];
    if (!postSt || postSt.isSymbolicLink() || !postSt.isDirectory()) postProblems.unshift(`${target} is not a plain directory after the copy`);
    if (created.length !== 1 || created[0] !== parsed.skill) postProblems.unshift(`expected exactly one new entry (${parsed.skill}) in ${root}, got: ${created.join(', ') || 'none'}`);
    if (postProblems.length > 0) {
      // Only the folder this run wrote is removed. fs.cpSync writes into `target` and nowhere else, so any other
      // entry that appeared meanwhile belongs to a concurrent writer (another install tool, a sync) and is left
      // alone; it is named in the problems so the user can look at it.
      const removed = removeCreated(target, root, parsed.skill, before);
      const others = created.filter((n) => n !== parsed.skill);
      if (others.length) postProblems.push(`other entries appeared in ${root} during the copy and were left untouched (not created by skill-scout): ${others.join(', ')}`);
      log('warn', 'scout-add rejected after copy', { ref: pinned, problems: postProblems, removed });
      cleanup();
      return {
        status: 'rejected',
        ref: pinned,
        sha,
        path: target,
        problems: postProblems,
        removed,
        copied: true,
        message: `REJECTED: ${pinned}\n  ${postProblems.join('\n  ')}\n${removed ? `Removed ${target}.` : `WARNING: ${target} was NOT removed; inspect it manually.`}`,
      };
    }

    cleanup();
    const audit = await auditSkill(source, parsed.skill, { timeoutMs: 5000 }, gitDeps);
    recordInstall(env, { key: unpinnedRef(parsed), ref: pinned, sha, path: target, ts: Date.now(), audit: audit.status, files: post.files, sourcePath: relPath || '.' });
    log('info', 'scout-add installed', { ref: pinned, path: target, audit: audit.status, ms: Math.round(t.elapsed()) });
    const auditJson = JSON.stringify({ status: audit.status, providers: audit.providers }, null, 2);
    return {
      status: 'installed',
      ref: pinned,
      sha,
      path: target,
      files: post.files,
      audit,
      message: `INSTALLED ${pinned} sha ${sha}\n  path: ${target} (${post.files} files, inspected before and after the copy: clean)\n  source: ${source} ${relPath || '.'}\n  audit: ${auditJson.replace(/\n/g, '\n  ')}\nRun /reload-skills or start a new session to use it.`,
    };
  } catch (err) {
    cleanup();
    return { status: 'error', message: `scout-add failed: ${String(err?.message ?? err)}` };
  }
}

/** Remove exactly the folder this run created: it must sit directly under root, be named after the skill, and not have existed before. */
function removeCreated(target, root, skill, before) {
  if (path.dirname(target) !== root || path.basename(target) !== skill || !target.startsWith(root + path.sep) || before.has(skill)) return false;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const yes = argv.includes('--yes') || argv.includes('-y');
  const positional = argv.filter((a) => !a.startsWith('-'));
  if (argv.includes('--help') || argv.includes('-h') || positional.length !== 1) {
    process.stderr.write('usage: scout-add.js <owner/repo[#sha]@skill> [--yes] [--json]\n');
    return positional.length === 1 ? 0 : 1;
  }
  const ref = positional[0];
  if (!yes) {
    const parsed = REF_RE.test(ref) ? parseRef(ref) : null;
    const ok = await confirm(`${TAG} install ${ref} into ${skillsDir()}${parsed ? `/${parsed.skill}` : ''} (pinned, inspected before it is copied)? [y/N] `);
    if (!ok) {
      process.stderr.write(`${TAG} not installed (pass --yes to skip this prompt; non-interactive runs require it)\n`);
      return 1;
    }
  }
  const result = await runScoutAdd({ ref, env: process.env });
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.message}\n`);
  return result.status === 'installed' ? 0 : 1;
}

const isEntrypoint = (() => {
  try {
    return process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      log('error', 'scout-add crashed', { error: String(err?.stack ?? err) });
      process.stderr.write(`${TAG} internal error: ${String(err?.message ?? err)}\n`);
      process.exit(1);
    },
  );
}
