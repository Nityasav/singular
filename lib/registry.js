// lib/registry.js — skills.sh registry client for singular.
//
// searchSkills   GET https://skills.sh/api/search?q=&limit=        (anonymous JSON)
// fetchCatalog   GET https://skills.sh/api/search?q=skill&owner=<o>&limit=200  (one request per allowlisted owner, cached 24 h)
// auditSkill     GET https://skills.sh/api/v1/skills/audit/{source}/{skill}
// gateCandidates allowlist / install floor / blockedRefs / fork dedupe (pure)
// rankCandidates BM25-lite of the prompt (+ intent terms) against catalog names, + log10(installs) (pure)
// fetchSkillText npx -y skills@<v> use owner/repo#<sha>@skill  (execFile, temp cwd, no shell; cached forever by pinned ref)
// sanitizeSkillText strip capability-carrying frontmatter keys (quoted / indented / flow forms too) and shell forms (pure)
// discover       keywords -> catalogs (cached) + <= 2 tech-noun searches (cached) -> gate -> rank -> audit -> top N
//
// Outbound data (see docs/security.md "Outbound data"): the per-prompt hook never sends free-form prompt
// words to skills.sh. It sends (1) each allowlisted owner's catalog request (`q=skill&owner=<o>`, no prompt
// content, cached cacheTtlHours), (2) at most MAX_KEYWORD_SEARCHES single words from the prompt that are in
// the built-in tech lexicon (`q=stripe`, `q=react`; never names, sentences or non-lexicon tokens; cached per
// word), and (3) audit lookups by `source/skill`. Only `/singular find <query>` (an explicit user search) sends
// the joined query string. The catalog alone is not enough: the API is lexical and capped at 200, so a repo
// whose name lacks "skill" (anthropics/claude-plugins-official@stripe-best-practices) only appears for `q=stripe`.
//
// Every network / subprocess call goes through the optional trailing `deps`
// parameter so unit tests never touch the network:
//   deps = { fetchImpl = globalThis.fetch, execFileImpl = child_process.execFile,
//            now = Date.now, tmpdir = tmpdirOf(env) (never inside the project), env = process.env,
//            keywords?, cacheGet?, cacheSet? }
//
// Test seams (docs/testing.md; validated in lib/config.js, byte-identical behaviour when unset):
//   SINGULAR_REGISTRY_BASE  replaces https://skills.sh for the search and audit endpoints (loopback only)
//   SINGULAR_GIT_BASE       replaces https://github.com AND makes fetchSkillText clone the pinned commit with
//                              git (lib/git.js cloneAtSha) and read SKILL.md itself instead of running npx
//
// A catalog or search request that times out / fails on transport is remembered for FAIL_MARKER_MS
// (`fail:<cache key>`) so a slow owner is not retried on every prompt; a stale cached copy (up to
// STALE_TTL_HOURS old) keeps ranking in the meantime (stale-while-revalidate).
//
// Registry responses and third-party SKILL.md contents are DATA, never instructions.

import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { cacheGet as diskCacheGet, cacheSet as diskCacheSet } from './cache.js';
import { seamGitBase, seamRegistryBase, tmpdirOf } from './config.js';
import { childEnv, cloneAtSha, findSkillDirs } from './git.js';
import { isSafeSegment, OWNER_RE, REF_RE, REPO_RE, resolveHeadSha as refsResolveHeadSha, SKILL_RE } from './refs.js';
import { expandIntent, extractKeywords, isWeakMatch, scoreSkills, TECH_LEXICON as SHAREABLE_LEXICON, tokenize } from './score.js';

export const SEARCH_URL = 'https://skills.sh/api/search';
export const AUDIT_URL = 'https://skills.sh/api/v1/skills/audit';
export const SKILLS_SITE = 'https://skills.sh';
export const FAIL_MARKER_MS = 5 * 60 * 1000; // a timed-out / failed catalog or search is not retried for 5 minutes
export const STALE_TTL_HOURS = 24 * 14; // a stale cached catalog still ranks while its owner is failing

/** Search / audit endpoints: production constants, or the loopback fixture server named by the test seam. */
export function endpoints(env = process.env) {
  const base = seamRegistryBase(env);
  if (!base) return { search: SEARCH_URL, audit: AUDIT_URL, base: SKILLS_SITE };
  return { search: `${base}/api/search`, audit: `${base}/api/v1/skills/audit`, base };
}
export const MAX_SEARCH_LIMIT = 200; // server hard-caps at 200 (verified 2026-09-24)
export const SKILL_TEXT_CAP = 9000;
export const DEFAULT_CLI_VERSION = '1.5.26';
export const MIN_SEARCH_MS = 200; // discover(): skip a request when less than this remains
export const MIN_AUDIT_MS = 400; // discover(): skip audits when less than this remains
export const MAX_DISCOVER_QUERIES = 8;
export const MAX_CONCURRENT_REQUESTS = 2;
export const MAX_KEYWORD_SEARCHES = 2; // per prompt: single tech-lexicon words only (`q=stripe`), cached per word
export const CATALOG_QUERY = 'skill'; // `q=skill&owner=<o>` returns the owner's whole catalog (154 anthropics, 72 vercel-labs; 200 cap)
export const COOLDOWN_KEY = 'cooldown:skills.sh';
export const COOLDOWN_MS = 5 * 60 * 1000; // after an HTTP 429, no skills.sh request for 5 minutes
export const TEXT_CACHE_TTL_HOURS = 24 * 365 * 20; // a `#sha` ref is immutable: cache its text forever
export const MIN_CATALOG_MATCH_SCORE = 1.5;

// Frontmatter keys that grant capability when a skill is *invoked*. Inert in
// injected text, but stripped anyway (defense in depth).
export const STRIPPED_FRONTMATTER_KEYS = [
  'allowed-tools',
  'disallowed-tools',
  'hooks',
  'context',
  'agent',
  'shell',
  'paths',
  'model',
];

const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const CLI_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// ---------------------------------------------------------------------------
// deps
// ---------------------------------------------------------------------------

function withDeps(deps = {}) {
  return {
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    execFileImpl: deps.execFileImpl ?? nodeExecFile,
    now: deps.now ?? Date.now,
    tmpdir: deps.tmpdir ?? tmpdirOf(deps.env ?? process.env),
    env: deps.env ?? process.env,
    keywords: typeof deps.keywords === 'function' ? deps.keywords : null,
    cacheGet: typeof deps.cacheGet === 'function' ? deps.cacheGet : null,
    cacheSet: typeof deps.cacheSet === 'function' ? deps.cacheSet : null,
  };
}

function getCache(d) {
  if (d.cacheGet && d.cacheSet) return { get: d.cacheGet, set: d.cacheSet, impl: 'deps' };
  return { get: (k, ttl) => diskCacheGet(k, ttl, d.env), set: (k, v) => diskCacheSet(k, v, d.env), impl: 'lib/cache.js' };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const lc = (s) => String(s ?? '').toLowerCase();

export function isValidSource(source) {
  const s = String(source ?? '');
  const parts = s.split('/');
  if (parts.length === 2) return isSafeSegment(parts[0], OWNER_RE) && isSafeSegment(parts[1], REPO_RE);
  if (parts.length === 1) return DOMAIN_RE.test(s); // well-known-domain sources (open.feishu.cn)
  return false;
}

export function isValidSkillName(skill) {
  return isSafeSegment(skill, SKILL_RE);
}

export function skillUrl(source, skill) {
  return `${SKILLS_SITE}/${source}/${skill}`;
}

export function candidateRef(cand) {
  return `${cand.source}@${cand.skill}`;
}

function byInstallsDesc(a, b) {
  return b.installs - a.installs || a.source.localeCompare(b.source) || a.skill.localeCompare(b.skill);
}

function isCandidate(c) {
  return (
    c &&
    typeof c === 'object' &&
    typeof c.source === 'string' &&
    typeof c.skill === 'string' &&
    isValidSource(c.source) &&
    isValidSkillName(c.skill)
  );
}

/** Match `owner/repo` against allowlist entries of the form `owner` or `owner/repo` (case-insensitive). */
export function isAllowlisted(source, allowlist) {
  const src = lc(source).trim();
  const owner = src.split('/')[0];
  if (!owner) return false;
  for (const raw of Array.isArray(allowlist) ? allowlist : []) {
    const entry = lc(raw).trim().replace(/^\/+|\/+$/g, '');
    if (!entry) continue;
    if (entry.includes('/')) {
      if (entry === src) return true;
    } else if (entry === owner) {
      return true;
    }
  }
  return false;
}

/** Distinct owners named by an allowlist (`owner` or `owner/repo` entries), validated, in order. */
export function allowlistOwners(allowlist, max = 8) {
  const owners = [];
  for (const entry of Array.isArray(allowlist) ? allowlist : []) {
    const owner = lc(entry).trim().replace(/^\/+/, '').split('/')[0];
    if (isSafeSegment(owner, OWNER_RE) && !owners.includes(owner)) owners.push(owner);
    if (owners.length >= max) break;
  }
  return owners;
}

function isBlocked(cand, blockedRefs) {
  const src = lc(cand.source);
  const owner = src.split('/')[0];
  const full = `${src}@${lc(cand.skill)}`;
  for (const raw of Array.isArray(blockedRefs) ? blockedRefs : []) {
    const entry = lc(raw).trim().replace(/#[0-9a-f]{40}(?=@)/, '');
    if (!entry) continue;
    if (entry === full || entry === src || entry === owner) return true;
  }
  return false;
}

async function fetchJson(url, { timeoutMs, fetchImpl }) {
  const ac = new AbortController();
  const ms = Math.max(1, Math.floor(Number(timeoutMs) || 0));
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${ms}ms`)), ms);
  timer.unref?.();
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: ac.signal,
      headers: { accept: 'application/json', 'user-agent': 'singular/0.2 (+node)' },
    });
    const status = Number(res?.status ?? 0);
    const ok = res?.ok ?? (status >= 200 && status < 300);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok, status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Promise wrapper over an execFile-shaped function. Never rejects. */
function run(execFileImpl, file, args, options) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      resolve({
        error: error ?? null,
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        signal: error?.signal ?? null,
        killed: Boolean(error?.killed),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      });
    };
    let child;
    try {
      child = execFileImpl(file, args, options, done);
    } catch (error) {
      done(error, '', '');
      return;
    }
    // The CLI must never wait on a TTY: close stdin (equivalent of `</dev/null`).
    try {
      child?.stdin?.end?.();
    } catch {
      /* ignore */
    }
  });
}

function describeRunFailure(what, r, timeoutMs) {
  if (r.killed || r.signal) return `${what} timed out after ${timeoutMs}ms (signal ${r.signal ?? 'unknown'})`;
  const err = r.stderr.trim() || r.error?.message || '';
  const detail = err.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);
  const code = r.code ?? r.error?.code ?? 'unknown';
  return `${what} failed (exit ${code})${detail ? `: ${detail}` : ''}`;
}

/** Run `fn(item)` over `items` with at most `limit` in flight; resolves to results in order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// searchSkills
// ---------------------------------------------------------------------------

/** Normalize raw /api/search entries into Candidate[] sorted by installs desc. */
export function normalizeSearchEntries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const source = typeof e.source === 'string' ? e.source.trim() : '';
    const skill =
      typeof e.skillId === 'string' && e.skillId.trim()
        ? e.skillId.trim()
        : typeof e.name === 'string'
          ? e.name.trim()
          : '';
    if (!source || !skill || !isValidSource(source) || !isValidSkillName(skill)) continue;
    const n = Number(e.installs);
    const installs = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    out.push({ source, skill, installs, url: skillUrl(source, skill), isDuplicate: e.isDuplicate === true });
  }
  out.sort(byInstallsDesc);
  return out;
}

/**
 * Detailed search: distinguishes "no results" from "request failed" (so callers
 * can avoid caching failures). Never throws. `status` carries the HTTP status (429 = rate limited).
 */
export async function searchSkillsRaw(query, opts = {}, deps = {}) {
  const d = withDeps(deps);
  const { limit = MAX_SEARCH_LIMIT, timeoutMs = 2500, owner = null } = opts;
  const q = String(query ?? '').trim();
  if (q.length < 2) return { ok: false, candidates: [], error: 'query must be at least 2 characters', status: 0 };
  const n = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(Number(limit) || MAX_SEARCH_LIMIT)));
  const params = new URLSearchParams({ q, limit: String(n) });
  if (owner) {
    if (!isSafeSegment(String(owner), OWNER_RE)) return { ok: false, candidates: [], error: 'invalid owner filter', status: 0 };
    params.set('owner', String(owner));
  }
  const url = `${endpoints(d.env).search}?${params.toString()}`;
  try {
    const { ok, status, body } = await fetchJson(url, { timeoutMs, fetchImpl: d.fetchImpl });
    if (!ok || !body || typeof body !== 'object') {
      return { ok: false, candidates: [], error: `http ${status}${body?.error ? `: ${String(body.error).slice(0, 120)}` : ''}`, status };
    }
    const candidates = normalizeSearchEntries(body.skills);
    return { ok: true, candidates, error: null, url, status, truncated: candidates.length >= n };
  } catch (err) {
    return { ok: false, candidates: [], error: String(err?.message ?? err), status: 0 };
  }
}

/**
 * searchSkills(query, {limit=200, timeoutMs}) -> Candidate[]
 * Candidate = {source: "owner/repo", skill, installs, url, isDuplicate}
 * Sorted by installs desc. Never throws; [] on any error.
 */
export async function searchSkills(query, opts = {}, deps = {}) {
  const r = await searchSkillsRaw(query, opts, deps);
  return r.candidates;
}

/**
 * fetchCatalog(owner, {timeoutMs}) -> {ok, candidates, error, status, truncated}
 * One request: every skill skills.sh lists for that owner (`q=skill&owner=<o>&limit=200`; the API's
 * 200 cap truncates very large owners such as microsoft). No prompt content is sent.
 */
export async function fetchCatalog(owner, opts = {}, deps = {}) {
  return searchSkillsRaw(CATALOG_QUERY, { limit: MAX_SEARCH_LIMIT, timeoutMs: opts.timeoutMs ?? 2500, owner }, deps);
}

export function catalogCacheKey(owner) {
  return `catalog:${lc(owner)}`;
}

/** Cooldown after a 429: {until} in the cache; `getCooldown` returns the `until` timestamp or 0. */
export async function getCooldown(cache, now = Date.now()) {
  try {
    const v = await cache.get(COOLDOWN_KEY, 1);
    const until = Number(v?.until);
    return Number.isFinite(until) && until > now ? until : 0;
  } catch {
    return 0;
  }
}

export async function setCooldown(cache, now = Date.now(), ms = COOLDOWN_MS) {
  const until = now + ms;
  try {
    await cache.set(COOLDOWN_KEY, { until, ts: now });
  } catch {
    /* ignore */
  }
  return until;
}

// ---------------------------------------------------------------------------
// auditSkill
// ---------------------------------------------------------------------------

function normStatus(s) {
  const v = lc(s).trim();
  if (v === 'pass' || v === 'passed' || v === 'safe' || v === 'ok') return 'pass';
  if (v === 'warn' || v === 'warning') return 'warn';
  if (v === 'fail' || v === 'failed' || v === 'error') return 'fail';
  return 'unknown';
}

/** Aggregate 3-5 provider verdicts: any fail (or CRITICAL risk) -> fail; any warn -> warn; else pass; none -> unknown. */
export function summarizeAudits(audits) {
  if (!Array.isArray(audits) || audits.length === 0) return { status: 'unknown', providers: [] };
  const providers = audits
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      provider: String(a.provider ?? a.slug ?? 'unknown'),
      status: normStatus(a.status),
      riskLevel: a.riskLevel != null ? String(a.riskLevel).toUpperCase() : null,
      summary: typeof a.summary === 'string' ? a.summary.slice(0, 200) : '',
    }));
  const counts = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const p of providers) {
    if (p.riskLevel === 'CRITICAL') counts.fail++;
    else counts[p.status]++;
  }
  let status = 'unknown';
  if (counts.fail > 0) status = 'fail';
  else if (counts.warn > 0) status = 'warn';
  else if (counts.pass > 0) status = 'pass';
  return { status, providers };
}

/**
 * auditSkill(source, skill, {timeoutMs}) -> {status: "pass"|"warn"|"fail"|"unknown", raw, providers}
 * 404 (no audits yet) and any transport error -> "unknown". Never throws.
 */
export async function auditSkill(source, skill, opts = {}, deps = {}) {
  const d = withDeps(deps);
  const { timeoutMs = 2500 } = opts;
  const src = String(source ?? '').trim();
  const sk = String(skill ?? '').trim();
  if (!isValidSource(src) || !isValidSkillName(sk)) {
    return { status: 'unknown', raw: { error: 'invalid_ref' }, providers: [] };
  }
  const url = `${endpoints(d.env).audit}/${src.split('/').map(encodeURIComponent).join('/')}/${encodeURIComponent(sk)}`;
  try {
    const { ok, status, body } = await fetchJson(url, { timeoutMs, fetchImpl: d.fetchImpl });
    if (status === 404) return { status: 'unknown', raw: body ?? { httpStatus: 404 }, providers: [] };
    if (!ok || !body || typeof body !== 'object') {
      return { status: 'unknown', raw: { httpStatus: status, error: body?.error ?? null, transient: true, rateLimited: status === 429 }, providers: [] };
    }
    const agg = summarizeAudits(body.audits);
    return { status: agg.status, raw: body, providers: agg.providers };
  } catch (err) {
    return { status: 'unknown', raw: { error: String(err?.message ?? err), transient: true }, providers: [] };
  }
}

// ---------------------------------------------------------------------------
// gateCandidates
// ---------------------------------------------------------------------------

/** Merge candidates from several searches: dedupe by source@skill, keep max installs. */
export function mergeCandidates(lists) {
  const map = new Map();
  for (const list of lists) {
    for (const c of Array.isArray(list) ? list : []) {
      if (!isCandidate(c)) continue;
      const key = lc(candidateRef(c));
      const prev = map.get(key);
      if (!prev) {
        map.set(key, {
          source: c.source,
          skill: c.skill,
          installs: Number(c.installs) || 0,
          url: c.url ?? skillUrl(c.source, c.skill),
          isDuplicate: c.isDuplicate === true,
        });
      } else {
        prev.installs = Math.max(prev.installs, Number(c.installs) || 0);
        prev.isDuplicate = prev.isDuplicate || c.isDuplicate === true;
      }
    }
  }
  return [...map.values()].sort(byInstallsDesc);
}

/**
 * gateCandidates(cands, config, extra={}) -> {accepted: Candidate[], rejected: {cand, reason}[]}
 * Applies: blockedRefs, already-installed (extra.installedNames), owner allowlist
 * (owner or owner/repo, case-insensitive), install floor, fork dedupe (same skill
 * name: allowlisted wins; among allowlisted, highest installs wins).
 * `isDuplicate: true` from the API is NOT a rejection reason (the canonical
 * entry is often the one flagged).
 */
export function gateCandidates(cands, config = {}, extra = {}) {
  const allowlist = extra.allowlist ?? config.allowlist ?? [];
  const installFloor = Number(extra.installFloor ?? config.installFloor ?? 0) || 0;
  const blockedRefs = extra.blockedRefs ?? config.blockedRefs ?? [];
  const installed = new Set((Array.isArray(extra.installedNames) ? extra.installedNames : []).map(lc));

  const rejected = [];
  const prelim = [];
  for (const cand of mergeCandidates([cands])) {
    const owner = cand.source.split('/')[0];
    if (isBlocked(cand, blockedRefs)) {
      rejected.push({ cand, reason: 'blocked by blockedRefs' });
      continue;
    }
    if (installed.has(lc(cand.skill))) {
      rejected.push({ cand, reason: `already installed locally (${cand.skill})` });
      continue;
    }
    if (!isAllowlisted(cand.source, allowlist)) {
      prelim.push({ cand, allow: false, owner });
      continue;
    }
    if (cand.installs < installFloor) {
      rejected.push({ cand, reason: `installs ${cand.installs} < floor ${installFloor}` });
      continue;
    }
    prelim.push({ cand, allow: true, owner });
  }

  const accepted = [];
  const bestByName = new Map();
  for (const { cand, allow } of prelim) {
    if (!allow) continue;
    const key = lc(cand.skill);
    const best = bestByName.get(key);
    if (!best) {
      bestByName.set(key, cand);
      accepted.push(cand);
    } else {
      rejected.push({ cand, reason: `duplicate skill name; kept ${candidateRef(best)} (${best.installs} installs)` });
    }
  }
  for (const { cand, allow, owner } of prelim) {
    if (allow) continue;
    const best = bestByName.get(lc(cand.skill));
    rejected.push({
      cand,
      reason: best
        ? `fork of ${candidateRef(best)} (owner ${owner} not allowlisted)`
        : `owner ${owner} not allowlisted`,
    });
  }
  rejected.sort((a, b) => byInstallsDesc(a.cand, b.cand));
  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// refs / sha resolution
// ---------------------------------------------------------------------------

/** Local ref parser (same grammar as lib/refs.js): owner/repo@skill | owner/repo#<40-hex>@skill */
export function parseRefLocal(str) {
  const m = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:#([0-9a-f]{40}))?@([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(String(str ?? '').trim());
  if (!m) return null;
  if (!isSafeSegment(m[1], OWNER_RE) || !isSafeSegment(m[2], REPO_RE) || !isSafeSegment(m[4], SKILL_RE)) return null;
  return { owner: m[1], repo: m[2], sha: m[3] ?? null, skill: m[4] };
}

function normalizeRef(ref) {
  if (typeof ref === 'string') return parseRefLocal(ref);
  if (!ref || typeof ref !== 'object') return null;
  let owner = ref.owner;
  let repo = ref.repo;
  if ((!owner || !repo) && typeof ref.source === 'string') {
    const parts = ref.source.split('/');
    if (parts.length === 2) [owner, repo] = parts;
  }
  const skill = ref.skill;
  const sha = ref.sha == null || ref.sha === '' ? null : String(ref.sha).toLowerCase();
  if (!isSafeSegment(owner, OWNER_RE) || !isSafeSegment(repo, REPO_RE) || !isSafeSegment(skill, SKILL_RE)) return null;
  if (sha !== null && !SHA_RE.test(sha)) return null;
  return { owner: String(owner), repo: String(repo), sha, skill: String(skill) };
}

/** resolveHeadSha(owner, repo, {timeoutMs}) via `git ls-remote <base>/<o>/<r> HEAD` (execFile, no shell); see lib/refs.js. */
export async function resolveHeadSha(owner, repo, opts = {}, deps = {}) {
  const d = withDeps(deps);
  return refsResolveHeadSha(owner, repo, opts, { execFileImpl: d.execFileImpl, env: d.env });
}

// ---------------------------------------------------------------------------
// fetchSkillText
// ---------------------------------------------------------------------------

/**
 * Strip the `skills use` wrapper prose. Verified markers (skills@1.5.26):
 *   PREFIX ends with "<SKILL.md>\n", SUFFIX is "\n</SKILL.md>\n".
 * Returns the raw SKILL.md text, or null when the markers are absent.
 */
export function stripCliWrapper(stdout) {
  const s = String(stdout ?? '');
  const open = '<SKILL.md>\n';
  const close = '\n</SKILL.md>';
  const a = s.indexOf(open);
  if (a < 0) return null;
  const b = s.lastIndexOf(close);
  if (b < a + open.length) return null;
  return s.slice(a + open.length, b);
}

export function textCacheKey(pinnedRef) {
  return `text:${pinnedRef}`;
}

/**
 * fetchSkillText(ref, {cliVersion, timeoutMs, cache}) -> {text, sha, ref, cached}
 * ref: "owner/repo@skill" | "owner/repo#<sha>@skill" | {owner, repo, sha|null, skill}
 * Runs `npx -y skills@<cliVersion> use owner/repo#<sha>@skill` with DISABLE_TELEMETRY=1,
 * cwd and TMPDIR = a fresh temp dir (removed afterwards; the CLI leaks
 * $TMPDIR/skills-use-* otherwise), execFile with an args array (no shell),
 * timeouts on everything. If ref.sha is null the HEAD sha is resolved first.
 * With `cache: true` the raw text is cached forever under `text:<pinned ref>` (a
 * `#sha` ref is immutable), so any ref is fetched at most once per machine.
 * Throws on invalid ref, bad sha, CLI failure, or missing wrapper markers.
 */
export async function fetchSkillText(ref, opts = {}, deps = {}) {
  const d = withDeps(deps);
  const { cliVersion = DEFAULT_CLI_VERSION, timeoutMs = 20000, cache: useCache = false } = opts;
  if (!CLI_VERSION_RE.test(String(cliVersion))) throw new Error(`invalid skills CLI version: ${String(cliVersion)}`);
  const parsed = normalizeRef(ref);
  if (!parsed) throw new Error(`invalid ref: ${typeof ref === 'string' ? ref : JSON.stringify(ref)}`);

  let sha = parsed.sha;
  if (!sha) sha = await resolveHeadSha(parsed.owner, parsed.repo, { timeoutMs: Math.min(timeoutMs, 8000) }, d);
  if (!SHA_RE.test(String(sha))) throw new Error(`resolved sha is not a 40-hex commit sha: ${String(sha)}`);

  const full = `${parsed.owner}/${parsed.repo}#${sha}@${parsed.skill}`;
  if (!REF_RE.test(full)) throw new Error(`ref failed validation: ${full}`);

  const cache = useCache ? getCache(d) : null;
  if (cache) {
    try {
      const hit = await cache.get(textCacheKey(full), TEXT_CACHE_TTL_HOURS);
      if (hit && typeof hit === 'object' && typeof hit.text === 'string') return { text: hit.text, sha, ref: full, cached: true };
    } catch {
      /* cache miss */
    }
  }

  const base = path.resolve(String(d.tmpdir));
  await fs.mkdir(base, { recursive: true });
  const work = await fs.mkdtemp(path.join(base, 'singular-use-'));
  try {
    let text;
    if (seamGitBase(d.env)) {
      // Test seam: no npx; clone the pinned commit from the local git base and read SKILL.md ourselves.
      text = await fetchSkillTextViaGit(parsed, sha, { work, timeoutMs, execFileImpl: d.execFileImpl, env: d.env });
    } else {
      // Allowlisted environment only (lib/git.js childEnv): no inherited npm_config_* (registry, cache,
      // userconfig), NODE_OPTIONS / NODE_PATH, GIT_* or CA overrides reach npx; cwd and TMPDIR are the fresh work
      // dir, which hardenEnv keeps outside the project so no repository .npmrc is picked up on the walk up.
      const env = childEnv(d.env, {
        DISABLE_TELEMETRY: '1',
        TMPDIR: work,
        NO_UPDATE_NOTIFIER: '1',
      });
      const args = ['-y', `skills@${cliVersion}`, 'use', full];
      const r = await run(d.execFileImpl, 'npx', args, {
        cwd: work,
        env,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      if (r.error || r.code !== 0) throw new Error(describeRunFailure(`skills use ${full}`, r, timeoutMs));
      text = stripCliWrapper(r.stdout);
      if (text === null) throw new Error(`unexpected skills CLI output for ${full}: SKILL.md markers not found`);
    }
    if (cache) {
      try {
        await cache.set(textCacheKey(full), { text, sha, ref: full, ts: d.now() });
      } catch {
        /* ignore */
      }
    }
    return { text, sha, ref: full, cached: false };
  } finally {
    if (work.startsWith(base + path.sep)) {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Git-based text fetch (SINGULAR_GIT_BASE seam only): clone `owner/repo` at `sha` into <work>/repo,
 * locate the skill by an exact directory or frontmatter name (same rule as /singular add) and return its
 * SKILL.md. Throws with the same message shapes as the npx path.
 */
async function fetchSkillTextViaGit(parsed, sha, { work, timeoutMs, execFileImpl, env }) {
  const dest = path.join(work, 'repo');
  await fs.mkdir(dest, { recursive: true });
  const cloned = await cloneAtSha({ owner: parsed.owner, repo: parsed.repo, sha, dest, timeoutMs, execFileImpl, env, tmpdir: work });
  if (!cloned.ok) throw new Error(`git fetch ${parsed.owner}/${parsed.repo}#${sha}@${parsed.skill}: ${cloned.message}`);
  const all = findSkillDirs(dest);
  const hit = all.filter((s) => path.basename(s.dir) === parsed.skill || s.name === parsed.skill);
  if (hit.length !== 1) {
    const names = [...new Set(all.map((s) => path.basename(s.dir)))].slice(0, 30).join(', ') || 'none';
    throw new Error(hit.length === 0 ? `No matching skill found for: ${parsed.skill} (found: ${names})` : `ambiguous skill name ${parsed.skill}: ${hit.map((h) => h.rel).join(', ')}`);
  }
  return fs.readFile(path.join(hit[0].dir, 'SKILL.md'), 'utf8');
}

// ---------------------------------------------------------------------------
// sanitizeSkillText
// ---------------------------------------------------------------------------

// Any indentation, optional matching quotes around the key: Claude Code honours `"allowed-tools":` and
// `  hooks:` (verified 2.1.282), so the sanitizer must too. Fail closed on anything the minimal parser
// cannot interpret (flow mappings `{`/`[` at line start are dropped).
export const FM_KEY_RE = /^(\s*)(["']?)([A-Za-z0-9_.-]+)\2\s*:(?:\s|$)/;
const FM_FLOW_RE = /^\s*[{[]/;
const FENCE_BANG_RE = /^\s*(`{3,}|~{3,})\s*!/;
const FENCE_CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;
const AT_REF_RE = /^\s*(?:[-*+]\s+)?@[^\s@]/;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function splitFrontmatter(lines) {
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return { fm: lines.slice(1, i), body: lines.slice(i + 1) };
  }
  return null;
}

function indentOf(line) {
  return /^\s*/.exec(line)[0].length;
}

/** Index of the first line after the block that `key` at `keyIndent` on line `i` owns (nested lines, list items, blanks). */
function skipNested(lines, i, keyIndent) {
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.trim() === '') {
      j++;
      continue;
    }
    const ind = indentOf(l);
    if (ind > keyIndent || (ind === keyIndent && /^\s*-\s/.test(l))) {
      j++;
      continue;
    }
    break;
  }
  return j;
}

/**
 * sanitizeSkillText(text) -> {text, stripped: string[]}
 * - removes frontmatter keys allowed-tools, disallowed-tools, hooks, context, agent, shell, paths, model
 *   (with nested lines) in plain, quoted (`"hooks":`) and indented (`  hooks:`) forms
 * - drops flow-mapping lines (`{` / `[` at line start) inside the frontmatter
 * - drops lines containing !`  and fenced ```! / ~~~! blocks (inclusive)
 * - drops @-file references at line start (also `- @path` list items)
 * - strips ANSI escapes / NUL, normalizes CRLF
 * - caps at 9,000 chars
 */
export function sanitizeSkillText(text) {
  const stripped = [];
  let s = String(text ?? '').replace(/^﻿/, '');
  const noCtl = s.replace(ANSI_RE, '').replace(/\0/g, '');
  if (noCtl !== s) stripped.push('control/ANSI escape sequences');
  s = noCtl.replace(/\r\n?/g, '\n');

  const lines = s.split('\n');
  const dropKeys = new Set(STRIPPED_FRONTMATTER_KEYS);
  const outLines = [];

  const fmSplit = splitFrontmatter(lines);
  let bodyLines = lines;
  if (fmSplit) {
    const kept = [];
    let i = 0;
    while (i < fmSplit.fm.length) {
      const line = fmSplit.fm[i];
      const m = FM_KEY_RE.exec(line);
      if (m && dropKeys.has(m[3].toLowerCase())) {
        const key = m[3].toLowerCase();
        i = skipNested(fmSplit.fm, i, m[1].length);
        stripped.push(`frontmatter: ${key}`);
        continue;
      }
      if (FM_FLOW_RE.test(line)) {
        stripped.push(`frontmatter: flow mapping line ${i + 1} removed`);
        i++;
        continue;
      }
      if (line.includes('!`')) {
        stripped.push(`frontmatter: inline shell (!\`) removed`);
        i++;
        continue;
      }
      kept.push(line);
      i++;
    }
    const meaningful = kept.some((l) => l.trim() !== '');
    if (meaningful) outLines.push('---', ...kept, '---');
    else stripped.push('frontmatter: emptied');
    bodyLines = fmSplit.body;
  }

  let inBangFence = null; // {start, marker}
  let fenceLines = 0;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const lineNo = i + 1;
    if (inBangFence) {
      fenceLines++;
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === inBangFence.marker) {
        stripped.push(`fenced shell block (\`\`\`!) lines ${inBangFence.start}-${lineNo} (${fenceLines} lines)`);
        inBangFence = null;
      }
      continue;
    }
    const open = FENCE_BANG_RE.exec(line);
    if (open) {
      inBangFence = { start: lineNo, marker: open[1][0] };
      fenceLines = 1;
      continue;
    }
    if (line.includes('!`')) {
      stripped.push(`inline shell (!\`) line ${lineNo}`);
      continue;
    }
    if (AT_REF_RE.test(line)) {
      stripped.push(`@-file reference line ${lineNo}: ${line.trim().slice(0, 60)}`);
      continue;
    }
    outLines.push(line);
  }
  if (inBangFence) stripped.push(`unterminated fenced shell block (\`\`\`!) from line ${inBangFence.start} (${fenceLines} lines)`);

  let out = outLines.join('\n');
  if (out.length > SKILL_TEXT_CAP) {
    const marker = '\n[singular: truncated]';
    const cut = out.length - (SKILL_TEXT_CAP - marker.length);
    out = out.slice(0, SKILL_TEXT_CAP - marker.length) + marker;
    stripped.push(`truncated ${cut} chars to ${SKILL_TEXT_CAP}`);
  }
  return { text: out, stripped };
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    'a an the and or but if then else of to in on at for with without from by as is are was were be been being ' +
    'it its this that these those i me my we our you your he she they them their what which who whom how when ' +
    'where why can could should would will shall may might must do does did done have has had having not no nor ' +
    'so than too very just also into over under again further once here there all any both each few more most ' +
    'other some such only own same now please help want need make build create add write fix use using get set ' +
    'let like new code file files project app thing things something way work working'
  ).split(' '),
);
const TECH_LEXICON = new Set(
  (
    'react nextjs next tailwind svelte vue nuxt astro remix angular django fastapi flask postgres postgresql ' +
    'supabase stripe playwright docker kubernetes k8s terraform rust go golang swift kotlin python typescript ' +
    'javascript node express hono nest prisma drizzle trpc vitest jest graphql redis mongodb sqlite mysql aws gcp ' +
    'azure vercel cloudflare lambda serverless webpack vite esbuild eslint prettier storybook electron tauri ' +
    'flutter dart android ios expo redux zustand tanstack shadcn radix chakra mui css sass html seo a11y ' +
    'accessibility auth oauth jwt websocket grpc openapi swagger cli git github ci cd pytest pandas numpy ' +
    'pytorch tensorflow llm openai anthropic claude agent mcp skill skills frontend backend fullstack design ' +
    'ui ux landing page component hooks form forms testing tests migration database schema api'
  ).split(' '),
);

/** Minimal keyword extractor (kept as an exported fallback; lib/score.js extractKeywords is the default). */
export function fallbackKeywords(prompt, { max = 4 } = {}) {
  const counts = new Map();
  for (const raw of String(prompt ?? '').toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const t = raw.replace(/^[.#+]+|[.#+]+$/g, '');
    if (t.length < 2 || STOPWORDS.has(t) || /^\d+$/.test(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => Number(TECH_LEXICON.has(b[0])) - Number(TECH_LEXICON.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map((e) => e[0]);
}

async function getKeywords(prompt, d) {
  let raw;
  if (d.keywords) raw = await d.keywords(prompt);
  else raw = extractKeywords(prompt, { max: 4 });
  const out = [];
  for (const k of Array.isArray(raw) ? raw : []) {
    const t = String(k ?? '').trim().toLowerCase();
    if (t.length >= 2 && !out.includes(t)) out.push(t);
    if (out.length >= 4) break;
  }
  return out;
}

function repoWords(source) {
  const repo = String(source).split('/')[1] ?? '';
  return repo.replace(/[^A-Za-z0-9]+/g, ' ');
}

/**
 * Rank gated candidates by relevance to the prompt, not installs alone.
 *   rankCandidates(cands, keywords, {prompt?, stackTags?, hits?} | Map)
 * Each candidate becomes a pseudo-skill {name: skill, description: repo words} and is scored with the
 * same BM25-lite as installed skills (lib/score.js) against the prompt plus its intent terms
 * (expandIntent: "landing page" -> "frontend design"). A candidate is *matched* only when at least
 * one prompt token matches exactly (stemmed) and the matched tokens are not all hyper-common words.
 * rank = relevance + 0.5 * stack-tag matches (weak signal) + log10(installs + 1); unmatched
 * candidates sink to the bottom with matches: 0. Returns new objects carrying
 * {matches, matched, stackMatches, relevance, rank, hits}.
 */
export function rankCandidates(cands, keywords = [], opts = {}) {
  const o = opts instanceof Map ? { hits: opts } : opts && typeof opts === 'object' ? opts : {};
  const hitsByKey = o.hits instanceof Map ? o.hits : new Map();
  const kws = (Array.isArray(keywords) ? keywords : []).map(lc).filter((k) => k.length >= 2);
  const stackStems = new Set((Array.isArray(o.stackTags) ? o.stackTags : []).flatMap((t) => tokenize(String(t))));
  const list = (Array.isArray(cands) ? cands : []).filter(isCandidate);
  if (list.length === 0) return [];

  const prompt = typeof o.prompt === 'string' && o.prompt.trim() ? o.prompt : kws.join(' ');
  const intent = expandIntent(prompt);
  const query = intent.length ? `${prompt} ${intent.join(' ')}` : prompt;
  const pseudo = list.map((c, i) => ({ name: c.skill, description: repoWords(c.source), _i: i }));
  const scored = new Map();
  if (query.trim()) {
    for (const s of scoreSkills(query, pseudo, { max: pseudo.length, minScore: MIN_CATALOG_MATCH_SCORE })) scored.set(s.skill._i, s);
  }

  const ranked = list.map((c, i) => {
    const s = scored.get(i);
    const matchedTokens = s ? s.matched : [];
    const weak = isWeakMatch(matchedTokens);
    const matches = weak ? 0 : matchedTokens.length;
    const relevance = weak ? 0 : s.score;
    const nameStems = new Set(tokenize(`${c.skill} ${repoWords(c.source)}`));
    let stackMatches = 0;
    for (const st of stackStems) if (nameStems.has(st)) stackMatches++;
    const installsTerm = Math.log10(Math.max(0, Number(c.installs) || 0) + 1);
    const rank = matches > 0 ? relevance + 0.5 * stackMatches + installsTerm : (0.5 * stackMatches + installsTerm) / 100;
    const hits = Number(hitsByKey.get(lc(candidateRef(c)))) || 0;
    return { ...c, matches, matched: weak ? [] : matchedTokens, stackMatches, relevance: Math.round(relevance * 1000) / 1000, rank: Math.round(rank * 1000) / 1000, hits };
  });
  ranked.sort((a, b) => Number(b.matches > 0) - Number(a.matches > 0) || b.rank - a.rank || b.hits - a.hits || byInstallsDesc(a, b));
  return ranked;
}

export function searchCacheKey(q, owner = null) {
  return owner ? `search:${q}|owner=${owner}` : `search:${q}`;
}

/** Negative-cache key for a failed request: `fail:catalog:<owner>` / `fail:search:<word>`. */
export function failKey(item) {
  return `fail:${typeof item === 'string' ? item : item.key}`;
}

export function auditCacheKey(source, skill) {
  return `audit:${source}@${skill}`;
}

/**
 * The only prompt-derived words that may leave the machine from the per-prompt hook: single tokens that
 * are in the built-in tech lexicon (react, stripe, supabase, ...), at most `max`, in keyword order.
 * Free-form words (names, projects, verbs) are never shared.
 */
export function shareableKeywords(keywords, max = MAX_KEYWORD_SEARCHES) {
  const out = [];
  for (const k of Array.isArray(keywords) ? keywords : []) {
    const t = lc(k).trim();
    if (t.length >= 2 && SHAREABLE_LEXICON.has(t) && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Query plan for an explicit search (`/singular find`): the joined keywords (+ stack tags to fill 4 terms)
 * once unscoped, then scoped to each allowlisted owner. Kept small: at most 1 + owners requests.
 * The per-prompt hook does not use this (it reads the cached owner catalogs instead).
 */
export function buildQueries(keywords, stackTags = [], allowlist = []) {
  const kw = (Array.isArray(keywords) ? keywords : []).map(lc).filter((k) => k.length >= 2).slice(0, 4);
  if (kw.length === 0) return [];
  const joinedTerms = [...kw];
  for (const t of Array.isArray(stackTags) ? stackTags : []) {
    if (joinedTerms.length >= 4) break;
    const tag = lc(t).trim();
    if (tag.length >= 2 && !joinedTerms.includes(tag)) joinedTerms.push(tag);
  }
  const joined = joinedTerms.join(' ');
  const out = [];
  const seen = new Set();
  const add = (q, owner = null) => {
    const query = String(q).trim();
    if (query.length < 2) return;
    const key = `${lc(query)}|${owner ? lc(owner) : ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ q: query, owner });
  };
  add(joined);
  for (const owner of allowlistOwners(allowlist, 4)) add(joined, owner);
  return out.slice(0, MAX_DISCOVER_QUERIES);
}

/**
 * discover(prompt, {config, stackTags, timeoutMs, deps, installedNames, search})
 *   -> {candidates: Gated[], keywords, cached, rejected, queries, auditSkipped, errors, cooldownUntil, elapsedMs}
 * Gated = Candidate & {owner, ref: "owner/repo@skill", matches, matched, rank, audit: {status, raw, providers}}
 * Pipeline: keywords (local) -> owner catalogs (one request per allowlisted owner, cached cacheTtlHours,
 *           at most 2 in flight) -> up to MAX_KEYWORD_SEARCHES unscoped searches for tech-lexicon words
 *           only (`q=stripe`, cached per word) -> [search=true: one explicit search with the joined keywords]
 *           -> gate -> rank (prompt vs catalog names, stack tags weak, log10 installs) -> audit -> top maxCandidates.
 * The only prompt-derived data on the wire is shareableKeywords() (tech nouns), plus the joined query
 * when `search` is true (explicit /singular find).
 * Respects the deadline: requests are skipped when < MIN_SEARCH_MS remain and audits when
 * < MIN_AUDIT_MS remain (audit status then "unknown"). An HTTP 429 sets a 5-minute cooldown
 * (cache key COOLDOWN_KEY) during which no request is made; cached catalogs still rank.
 * `cached` is true when every catalog/search was served from the cache. Never throws.
 */
export async function discover(prompt, opts = {}) {
  const { config = {}, stackTags = [], timeoutMs, deps = {}, installedNames = [], search = false } = opts;
  const d = withDeps(deps);
  const cfg = {
    allowlist: [],
    installFloor: 1000,
    maxCandidates: 2,
    remoteTimeoutMs: 2500,
    cacheTtlHours: 24,
    requireAuditPass: true,
    blockedRefs: [],
    ...(config && typeof config === 'object' ? config : {}),
  };
  const budget = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : Math.max(Number(cfg.remoteTimeoutMs) * 2 || 0, 3000);
  const start = d.now();
  const deadline = start + budget;
  const remaining = () => deadline - d.now();
  const result = {
    candidates: [],
    keywords: [],
    intent: [],
    shared: [], // the prompt-derived words that were (or would be) sent: tech-lexicon nouns only
    cached: false,
    rejected: [],
    queries: [],
    auditSkipped: false,
    errors: [],
    cooldownUntil: null,
    elapsedMs: 0,
  };
  const finish = () => {
    result.elapsedMs = Math.max(0, d.now() - start);
    return result;
  };
  const safe = async (fn, label) => {
    try {
      return await fn();
    } catch (err) {
      result.errors.push(`${label}: ${String(err?.message ?? err)}`);
      return null;
    }
  };

  try {
    result.keywords = await getKeywords(prompt, d);
    result.intent = expandIntent(prompt);
    if (result.keywords.length === 0 && result.intent.length === 0) return finish();
    const owners = allowlistOwners(cfg.allowlist);
    if (owners.length === 0 && !search) return finish();
    const cache = getCache(d);
    const ttl = Number(cfg.cacheTtlHours) || 0;
    const perRequest = (left) => Math.max(1, Math.min(Number(cfg.remoteTimeoutMs) || 2500, left - 50));
    let cooldownUntil = await getCooldown(cache, d.now());
    result.cooldownUntil = cooldownUntil || null;
    const rateLimited = async () => {
      if (!cooldownUntil) {
        cooldownUntil = await setCooldown(cache, d.now());
        result.cooldownUntil = cooldownUntil;
        result.errors.push(`skills.sh rate limited (429); no requests until ${new Date(cooldownUntil).toISOString()}`);
      }
    };

    // --- request plan: one catalog per owner (cached), tech-noun searches (cached per word), plus one
    //     explicit joined search when asked (/singular find). Catalogs come first so a tight deadline drops
    //     the keyword searches, not the (usually cached) catalogs.
    const plan = owners.map((owner) => ({ kind: 'catalog', q: CATALOG_QUERY, owner, key: catalogCacheKey(owner) }));
    const joined = search ? buildQueries(result.keywords, stackTags, [])[0]?.q ?? null : null;
    result.shared = shareableKeywords(result.keywords).filter((kw) => kw !== joined);
    for (const kw of result.shared) plan.push({ kind: 'keyword', q: kw, owner: null, key: searchCacheKey(kw) });
    if (joined) plan.push({ kind: 'search', q: joined, owner: null, key: searchCacheKey(joined) });

    const fetched = await mapLimit(plan, MAX_CONCURRENT_REQUESTS, async (item) => {
      const hit = await safe(() => cache.get(item.key, ttl), `cacheGet ${item.key}`);
      if (Array.isArray(hit)) return { ...item, candidates: hit, cached: true, stale: false, skipped: null };
      // Expired copy (stale-while-revalidate) and the failure marker for this exact request.
      const staleHit = await safe(() => cache.get(item.key, STALE_TTL_HOURS), `cacheGet ${item.key}`);
      const stale = Array.isArray(staleHit) ? staleHit : null;
      const withStale = (skipped) => ({ ...item, candidates: stale ?? [], cached: stale !== null, stale: stale !== null, skipped });
      const marker = await safe(() => cache.get(failKey(item), FAIL_MARKER_MS / 3600000), `cacheGet ${failKey(item)}`);
      if (marker && typeof marker === 'object' && Number(marker.until) > d.now()) return withStale('recent-failure');
      if (cooldownUntil) return withStale('cooldown');
      const left = remaining();
      if (left < MIN_SEARCH_MS) return withStale('deadline');
      const r = await searchSkillsRaw(item.q, { limit: MAX_SEARCH_LIMIT, timeoutMs: perRequest(left), owner: item.owner }, d);
      if (r.ok) {
        await safe(() => cache.set(item.key, r.candidates), `cacheSet ${item.key}`);
        return { ...item, candidates: r.candidates, cached: false, stale: false, skipped: null, truncated: r.truncated === true };
      }
      if (r.status === 429) await rateLimited();
      else await safe(() => cache.set(failKey(item), { until: d.now() + FAIL_MARKER_MS, error: String(r.error ?? '').slice(0, 120), ts: d.now() }), `cacheSet ${failKey(item)}`);
      result.errors.push(`${item.kind} "${item.q}"${item.owner ? ` owner=${item.owner}` : ''}: ${r.error}${stale ? ' (stale cached copy used)' : ''}`);
      return withStale(r.status === 429 ? 'rate-limited' : 'error');
    });
    result.queries = fetched.map(({ kind, q, owner, cached, stale, skipped, candidates, truncated }) => ({ kind, q, owner, cached, stale: stale === true, skipped, results: candidates.length, truncated: truncated === true }));
    result.cached = fetched.length > 0 && fetched.every((s) => s.cached);

    // --- gate, then rank by relevance (prompt vs catalog names, stack tags weak, installs)
    const hits = new Map();
    for (const s of fetched) {
      const seenHere = new Set();
      for (const c of s.candidates) {
        if (!isCandidate(c)) continue;
        const key = lc(candidateRef(c));
        if (seenHere.has(key)) continue;
        seenHere.add(key);
        hits.set(key, (hits.get(key) ?? 0) + 1);
      }
    }
    const merged = mergeCandidates(fetched.map((s) => s.candidates));
    const gate = gateCandidates(merged, cfg, { installedNames });
    result.rejected = gate.rejected;
    const maxCandidates = Math.max(0, Math.floor(Number(cfg.maxCandidates) || 0));
    if (maxCandidates === 0 || gate.accepted.length === 0) return finish();
    const ranked = rankCandidates(gate.accepted, result.keywords, { prompt, stackTags, hits }).filter((c) => c.matches > 0);
    if (ranked.length === 0) return finish();

    // --- audit top N (+2 spare so a fail can be backfilled without a second round trip)
    const top = ranked.slice(0, maxCandidates + 2);
    const gated = await mapLimit(top, MAX_CONCURRENT_REQUESTS, async (cand) => {
      const ref = candidateRef(cand);
      const key = auditCacheKey(cand.source, cand.skill);
      let audit = await safe(() => cache.get(key, ttl), `cacheGet ${key}`);
      if (!audit || typeof audit !== 'object' || typeof audit.status !== 'string') {
        const left = remaining();
        if (cooldownUntil) {
          audit = { status: 'unknown', raw: { skipped: 'cooldown' }, providers: [] };
        } else if (left < MIN_AUDIT_MS) {
          result.auditSkipped = true;
          audit = { status: 'unknown', raw: { skipped: 'deadline' }, providers: [] };
        } else {
          audit = await auditSkill(cand.source, cand.skill, { timeoutMs: perRequest(left) }, d);
          if (audit.raw?.rateLimited) await rateLimited();
          if (!audit.raw?.transient) await safe(() => cache.set(key, audit), `cacheSet ${key}`);
        }
      }
      return { ...cand, owner: cand.source.split('/')[0], ref, audit };
    });

    const kept = [];
    for (const g of gated) {
      if (cfg.requireAuditPass && g.audit.status === 'fail') {
        result.rejected.unshift({ cand: g, reason: `audit fail (${g.audit.providers.filter((p) => p.status === 'fail' || p.riskLevel === 'CRITICAL').map((p) => p.provider).join(', ') || 'provider'})` });
        continue;
      }
      kept.push(g);
    }
    result.candidates = kept.slice(0, maxCandidates);
    return finish();
  } catch (err) {
    result.errors.push(`discover: ${String(err?.message ?? err)}`);
    return finish();
  }
}
