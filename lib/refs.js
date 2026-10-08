// lib/refs.js — skill references: owner/repo@skill and owner/repo#<40-hex-sha>@skill
//
//   REF_RE                              strict grammar (anchored)
//   parseRef(str)                       -> {owner, repo, sha|null, skill} | null
//   formatRef(ref)                      -> "owner/repo#sha@skill" (sha omitted when null)
//   unpinnedRef(ref)                    -> "owner/repo@skill"
//   shortSha(sha)                       -> first 7 chars
//   isSha(s)                            -> 40 lowercase hex
//   normalizeRefCase(ref)               -> same ref with owner/repo lowercased (GitHub is case-insensitive there; the skill is not)
//   resolveHeadSha(owner, repo, {timeoutMs}, deps) -> sha via `git ls-remote https://github.com/o/r HEAD`
//                                          (the base is the SKILL_SCOUT_GIT_BASE test seam when set, see lib/git.js)
//
// Owner/repo/skill are validated by REF_RE before they ever reach an argv array;
// git runs through execFile with an args array (no shell), GIT_TERMINAL_PROMPT=0 and the allowlisted child
// environment of lib/git.js childEnv (no inherited GIT_CONFIG_* / proxy-command / ssh-command variables).
//
// Grammar (tightened 2026-09-24): every segment must START with an alphanumeric, so a skill or repo
// named "-y" / "--skill" can never be read as a CLI flag by a subprocess, and "." / ".." can never be
// a path segment. GitHub applies the same first-character rule to owners and repos.

import { execFile as nodeExecFile } from 'node:child_process';

import { childEnv, describeGitFailure, repoUrl, runExecFile } from './git.js';

export const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(#[0-9a-f]{40})?@[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PARTS_RE = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:#([0-9a-f]{40}))?@([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_SEGMENT = 100;

/** A segment is safe as a path component and as an argv element: starts alphanumeric, not "." / "..", bounded length. */
export function isSafeSegment(s, re = SKILL_RE) {
  const v = String(s ?? '');
  return v.length > 0 && v.length <= MAX_SEGMENT && re.test(v) && v !== '.' && v !== '..' && !v.startsWith('-');
}

export function isSha(s) {
  return typeof s === 'string' && SHA_RE.test(s);
}

export function shortSha(sha) {
  return isSha(sha) ? sha.slice(0, 7) : '';
}

export function parseRef(str) {
  const m = PARTS_RE.exec(String(str ?? '').trim());
  if (!m) return null;
  if (!isSafeSegment(m[1], OWNER_RE) || !isSafeSegment(m[2], REPO_RE) || !isSafeSegment(m[4], SKILL_RE)) return null;
  return { owner: m[1], repo: m[2], sha: m[3] ?? null, skill: m[4] };
}

export function formatRef(ref) {
  if (!ref || typeof ref !== 'object') return '';
  const sha = ref.sha ? `#${ref.sha}` : '';
  return `${ref.owner}/${ref.repo}${sha}@${ref.skill}`;
}

export function unpinnedRef(ref) {
  const r = typeof ref === 'string' ? parseRef(ref) : ref;
  if (!r) return '';
  return `${r.owner}/${r.repo}@${r.skill}`;
}

/**
 * Lowercase the owner and repo segments (GitHub resolves them case-insensitively, so `MULTICA-AI/x@s`
 * and `multica-ai/x@s` are the same source and must share one pin and one text-cache entry); the skill
 * segment is kept as typed because /scout-add matches it case-sensitively.
 */
export function normalizeRefCase(ref) {
  const r = typeof ref === 'string' ? parseRef(ref) : ref;
  if (!r || typeof r !== 'object') return null;
  return { ...r, owner: String(r.owner).toLowerCase(), repo: String(r.repo).toLowerCase() };
}

/**
 * Resolve the current HEAD commit of https://github.com/<owner>/<repo>.
 * deps.execFileImpl / deps.env are injectable for tests.
 */
export async function resolveHeadSha(owner, repo, opts = {}, deps = {}) {
  const { timeoutMs = 8000 } = opts;
  const execFileImpl = deps.execFileImpl ?? nodeExecFile;
  const env = deps.env ?? process.env;
  if (!isSafeSegment(owner, OWNER_RE) || !isSafeSegment(repo, REPO_RE)) {
    throw new Error(`invalid owner/repo: ${owner}/${repo}`);
  }
  const url = repoUrl(owner, repo, env);
  const r = await runExecFile(execFileImpl, 'git', ['ls-remote', url, 'HEAD'], {
    env: childEnv(env),
    timeout: Math.max(1, Math.floor(Number(timeoutMs) || 8000)),
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (r.killed || r.signal) throw new Error(`git ls-remote ${url} timed out after ${timeoutMs}ms`);
  if (r.error || r.code !== 0) throw new Error(describeGitFailure(`git ls-remote ${url}`, r, timeoutMs));
  const m = /^([0-9a-f]{40})\s+HEAD\b/m.exec(r.stdout);
  if (!m) throw new Error(`could not parse HEAD sha from git ls-remote output for ${url}`);
  return m[1];
}
