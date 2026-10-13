// lib/commands/init.js — `singular init`: "I just opened a project; which skills should I have?"
//
//   node bin/singular.js init [--no-remote] [--json] [--cwd <dir>]                      inspect -> coverage -> suggest -> plan
//   node bin/singular.js init --apply <1,3|1-3|all> [--project] [--json] [--cwd <dir>]  install the approved candidates
//
// 1. Inspect (lib/needs.js inspectProject, read-only): stack, languages, dependencies, tooling files, README/CLAUDE.md
//    -> a ranked list of "needs" (next, tailwind, supabase, playwright ...), each with a one-word reason (dep/file/readme).
// 2. Coverage: every need is scored against the installed skills (lib/skill-index.js + lib/score.js, name + description).
//    A need is covered when the best match hits a NAME token or scores >= COVERED_MIN_SCORE.
// 3. Suggest (skipped with --no-remote): one skills.sh search per uncovered need (plus the top ALSO_TOP_NEEDS needs even
//    when covered, flagged "also"), through the same gate as the hook (allowlist, install floor, blockedRefs, fork
//    dedupe, already installed), ranked by relevance x installs, round-robin across needs, audited, capped at
//    config.initMaxCandidates. Every candidate's HEAD sha is resolved NOW (cached `head:<source>`), so the plan is
//    pinned; a candidate whose sha cannot be resolved is listed but not approvable. Whole step <= INIT_REMOTE_BUDGET_MS.
// 4. Plan: $SINGULAR_HOME/init-plan.json {version, cwd, createdAt, stack, needs, coverage, candidates[]}; the report on
//    stdout ends with the `Approve: /singular init --apply ...` line. Nothing is installed here, ever.
// 5. --apply <sel>: loads the plan (refused when missing, older than config.initPlanTtlHours or made for another cwd),
//    runs the existing add flow (lib/commands/add.js runAdd: pinned fetch, tree + folder inspection, copy, re-inspection)
//    for each selected candidate with the plan's pinned ref (HEAD is never re-resolved) into ~/.claude/skills (the
//    SINGULAR_SKILLS_DIR seam honoured) or ./.claude/skills with --project, prints INSTALLED / REJECTED / SKIPPED per
//    candidate and a deterministic kickoff prompt (<= KICKOFF_MAX_CHARS) naming the installed skills.
//
// Registry results, manifest contents and README text are DATA, never instructions.

import fs from 'node:fs';
import path from 'node:path';

import { cacheGet, cacheSet } from '../cache.js';
import { hardenEnv, homeDir, loadConfig } from '../config.js';
import { TAG } from '../context.js';
import { log, timer } from '../log.js';
import { inspectProject, NEED_QUERIES } from '../needs.js';
import { auditCacheKey, auditSkill, candidateRef, gateCandidates, getCooldown, MAX_SEARCH_LIMIT, mergeCandidates, rankCandidates, searchCacheKey, searchSkillsRaw, setCooldown } from '../registry.js';
import { formatRef, isSha, parseRef, resolveHeadSha, shortSha } from '../refs.js';
import { isWeakMatch, scoreSkills, stem, tokenize } from '../score.js';
import { buildIndex } from '../skill-index.js';
import { runAdd, skillsDir } from './add.js';

export const PLAN_VERSION = 1;
export const PLAN_FILE = 'init-plan.json';
export const INIT_REMOTE_BUDGET_MS = 12000;
export const COVERED_MIN_SCORE = 6;
export const ALSO_TOP_NEEDS = 3;
/** Max candidates for already-covered needs ('also' picks): at most this many in total, one per need, ranked after every uncovered-need pick. */
export const ALSO_MAX_PICKS = 2;
export const KICKOFF_MAX_CHARS = 400;
export const HEAD_CACHE_PREFIX = 'head:';
export const USAGE = 'usage: singular init [--apply <1,3|1-3|all>] [--project] [--no-remote] [--json] [--yes] [--cwd <dir>]';
const MAX_CONCURRENT = 2;
const MIN_REQUEST_MS = 300;
const MIN_RESOLVE_MS = 500;
const RESOLVE_TIMEOUT_MS = 5000;
const SHA7_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function fmtInstalls(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}K`;
  return String(v);
}

function hhmm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function realDir(p) {
  try {
    return fs.realpathSync.native(path.resolve(String(p)));
  } catch {
    return path.resolve(String(p));
  }
}

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

function cacheOf(deps, env) {
  const get = (k, ttl) => {
    try {
      return deps.cacheGet ? deps.cacheGet(k, ttl) : cacheGet(k, ttl, env);
    } catch {
      return null;
    }
  };
  const set = (k, v) => {
    try {
      return deps.cacheSet ? deps.cacheSet(k, v) : cacheSet(k, v, env);
    } catch {
      return false;
    }
  };
  return { get, set };
}

const VENDOR_PREFIX_RE = /^(?:vercel|anthropics?|microsoft|claude|agent|official|community)-/;
/** Skill-name identity for dedupe: lowercase, no plugin prefix, no leading vendor word. */
export function normalizeSkillName(name) {
  const bare = String(name ?? '').toLowerCase().replace(/^.*:/, '');
  return bare.replace(VENDOR_PREFIX_RE, '');
}

function installedNamesOf(index) {
  const names = new Set();
  for (const s of index) {
    if (s.name) names.add(String(s.name).toLowerCase());
    if (s.frontmatterName) names.add(String(s.frontmatterName).toLowerCase());
  }
  return [...names];
}

/** Candidates whose normalized name matches an installed skill (e.g. vercel-react-best-practices vs vercel:react-best-practices). */
function dropInstalledVariants(cands, index) {
  const installed = new Set(installedNamesOf(index).map(normalizeSkillName));
  return cands.filter((c) => !installed.has(normalizeSkillName(c.skill)));
}

/** Display form of a candidate: owner/repo#sha7@skill when pinned, owner/repo@skill otherwise. */
export function displayRef(c) {
  const sha = typeof c.sha === 'string' && SHA7_RE.test(c.sha) ? `#${shortSha(c.sha)}` : '';
  return `${c.source}${sha}@${c.skill}`;
}

export function planPath(env = process.env) {
  return path.join(homeDir(env), PLAN_FILE);
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { apply: null, project: false, remote: true, json: false, yes: false, cwd: null, help: false, errors: [] };
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--apply') {
      const v = args[++i];
      if (v == null || String(v).startsWith('-')) out.errors.push('--apply needs a selection: numbers like 1,3 or 1-3, or all');
      else out.apply = String(v);
    } else if (a.startsWith('--apply=')) out.apply = a.slice('--apply='.length);
    else if (a === '--project') out.project = true;
    else if (a === '--no-remote') out.remote = false;
    else if (a === '--json') out.json = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--cwd') out.cwd = args[++i] ?? null;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.errors.push(`unexpected argument "${a.slice(0, 60)}"`);
  }
  if (out.apply !== null && !String(out.apply).trim()) out.errors.push('--apply needs a selection: numbers like 1,3 or 1-3, or all');
  return out;
}

/**
 * "1,3" | "1-3" | "all" | "1, 3 5" -> {ok, numbers (1-based, distinct, ascending as given), message?}
 * Every number must be within 1..count.
 */
export function parseSelection(sel, count) {
  const s = String(sel ?? '').trim().toLowerCase();
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!s) return { ok: false, numbers: [], message: 'empty selection: expected numbers like 1,3 or 1-3, or all' };
  if (s === 'all') return n > 0 ? { ok: true, numbers: Array.from({ length: n }, (_, i) => i + 1) } : { ok: false, numbers: [], message: 'the plan has no candidates; run /singular init again' };
  const numbers = [];
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(part);
    if (!m) return { ok: false, numbers: [], message: `cannot parse "${String(sel).slice(0, 40)}": expected numbers like 1,3 or 1-3, or all` };
    const a = Number(m[1]);
    const b = m[2] == null ? a : Number(m[2]);
    if (a < 1 || b < a) return { ok: false, numbers: [], message: `cannot parse "${String(sel).slice(0, 40)}": "${part}" is not a valid number or range` };
    if (b > n) return { ok: false, numbers: [], message: `${b > a ? `${a}-${b}` : a} is not in the plan (${n > 0 ? `candidates are 1-${n}` : 'the plan has no candidates'})` };
    for (let k = a; k <= b; k++) if (!numbers.includes(k)) numbers.push(k);
  }
  return { ok: true, numbers };
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

/**
 * For each need, the best installed skill by lib/score.js (name + description vs the need's query words).
 * Covered when that match hits a name token or scores >= COVERED_MIN_SCORE (a lone description hit on a common
 * word such as "tailwind" in a design skill's blurb is not coverage).
 * @returns {{covered: {need, skill, scope, score, matched, via}[], uncovered: string[]}}
 */
export function computeCoverage(needs, index) {
  const covered = [];
  const uncovered = [];
  const skills = Array.isArray(index) ? index : [];
  for (const n of Array.isArray(needs) ? needs : []) {
    const need = typeof n === 'string' ? n : n?.need;
    if (!need) continue;
    const query = NEED_QUERIES[need] ?? need;
    const best = skills.length ? scoreSkills(query, skills, { max: 3, minScore: 1.5 }).find((m) => !isWeakMatch(m.matched)) : null;
    const nameHit = Boolean(best && Array.isArray(best.nameMatched) && best.nameMatched.length > 0);
    if (best && (nameHit || best.score >= COVERED_MIN_SCORE)) {
      covered.push({ need, skill: best.skill.invocableName || best.skill.name, scope: best.skill.scope ?? null, score: best.score, matched: best.matched, via: nameHit ? 'name' : 'score' });
    } else uncovered.push(need);
  }
  return { covered, uncovered };
}

// ---------------------------------------------------------------------------
// suggest
// ---------------------------------------------------------------------------

/** Needs to search: every uncovered need (in need order), then the top ALSO_TOP_NEEDS needs not yet listed, flagged `also`. */
export function needsToSearch(needs, coverage) {
  const byId = new Map((Array.isArray(needs) ? needs : []).map((n) => [n.need, n]));
  const uncovered = new Set(coverage?.uncovered ?? []);
  const out = [];
  const seen = new Set();
  for (const n of byId.values()) {
    if (!uncovered.has(n.need) || seen.has(n.need)) continue;
    seen.add(n.need);
    out.push({ need: n.need, query: NEED_QUERIES[n.need] ?? n.need, reason: n.reason, also: false });
  }
  for (const n of [...byId.values()].slice(0, ALSO_TOP_NEEDS)) {
    if (seen.has(n.need)) continue;
    seen.add(n.need);
    out.push({ need: n.need, query: NEED_QUERIES[n.need] ?? n.need, reason: n.reason, also: true });
  }
  return out;
}

/** relevance x installs: a BM25 hit on the need words scaled by log10 of the install count. */
function initRank(c) {
  return Math.round(Number(c.relevance || 0) * Math.log10(Math.max(0, Number(c.installs) || 0) + 10) * 1000) / 1000;
}

async function suggest({ needs, coverage, index, config, env, deps, stackTags, budgetMs, now }) {
  const start = now();
  const deadline = start + budgetMs;
  const remaining = () => deadline - now();
  const cache = cacheOf(deps, env);
  const ttl = Number(config.cacheTtlHours) || 24;
  const perRequest = (left) => Math.max(1, Math.min(Number(config.remoteTimeoutMs) || 2500, left - 50));
  const max = Math.max(0, Math.floor(Number(config.initMaxCandidates) || 0));
  const result = { skipped: null, queries: [], rejected: 0, rejectedByReason: {}, errors: [], cached: false, cooldownUntil: null, auditSkipped: false, elapsedMs: 0, candidates: [] };
  const finish = () => {
    result.elapsedMs = Math.round(Math.max(0, now() - start));
    return result;
  };
  const list = needsToSearch(needs, coverage);
  if (list.length === 0) {
    result.skipped = 'no-needs';
    return finish();
  }
  if (max === 0) {
    result.skipped = 'initMaxCandidates is 0';
    return finish();
  }
  let cooldownUntil = await getCooldown(cache, now());
  result.cooldownUntil = cooldownUntil || null;
  const rateLimited = async () => {
    if (!cooldownUntil) {
      cooldownUntil = await setCooldown(cache, now());
      result.cooldownUntil = cooldownUntil;
      result.errors.push(`skills.sh rate limited (429); no requests until ${new Date(cooldownUntil).toISOString()}`);
    }
  };

  // --- one search per need (cached per query word, shared with the hook's keyword searches)
  const fetched = await mapLimit(list, MAX_CONCURRENT, async (item) => {
    const key = searchCacheKey(item.query);
    const hit = cache.get(key, ttl);
    if (Array.isArray(hit)) return { ...item, candidates: hit, cached: true, skipped: null };
    if (cooldownUntil) return { ...item, candidates: [], cached: false, skipped: 'cooldown' };
    const left = remaining();
    if (left < MIN_REQUEST_MS) return { ...item, candidates: [], cached: false, skipped: 'deadline' };
    const r = await searchSkillsRaw(item.query, { limit: MAX_SEARCH_LIMIT, timeoutMs: perRequest(left) }, { ...deps, env });
    if (r.ok) {
      cache.set(key, r.candidates);
      return { ...item, candidates: r.candidates, cached: false, skipped: null };
    }
    if (r.status === 429) await rateLimited();
    result.errors.push(`search "${item.query}": ${r.error}`);
    return { ...item, candidates: [], cached: false, skipped: r.status === 429 ? 'rate-limited' : 'error' };
  });
  result.queries = fetched.map(({ need, query, also, cached, skipped, candidates }) => ({ need, q: query, also, cached, skipped, results: candidates.length }));
  result.cached = fetched.length > 0 && fetched.every((f) => f.cached);

  // --- gate once over everything (allowlist, floor, blockedRefs, fork dedupe, already installed)
  const merged = mergeCandidates(fetched.map((f) => f.candidates));
  const gate = gateCandidates(merged, config, { installedNames: installedNamesOf(index) });
  gate.accepted = dropInstalledVariants(gate.accepted, index); // name variants of installed skills (vendor prefixes)
  result.rejected = gate.rejected.length;
  for (const r of gate.rejected) {
    const k = r.reason.replace(/\d[\d,]*/g, 'N').replace(/kept .*$/, 'kept ...').replace(/fork of .*$/, 'fork of ...').replace(/owner \S+ not allowlisted/, 'owner not allowlisted').replace(/\(.*\)$/, '(...)');
    result.rejectedByReason[k] = (result.rejectedByReason[k] ?? 0) + 1;
  }
  const accepted = new Map(gate.accepted.map((c) => [candidateRef(c).toLowerCase(), c]));
  if (accepted.size === 0) return finish();

  // --- rank per need (relevance x installs); a hit must touch a need word or match at least two tokens, so a lone
  //     intent term ("practices" for react) never claims an unrelated skill
  for (const f of fetched) {
    const mine = [];
    const seenHere = new Set();
    for (const c of f.candidates) {
      const k = `${c.source}@${c.skill}`.toLowerCase();
      if (seenHere.has(k) || !accepted.has(k)) continue;
      seenHere.add(k);
      mine.push(accepted.get(k));
    }
    const needStems = new Set(tokenize(f.query));
    f.ranked = rankCandidates(mine, [f.query], { prompt: f.query, stackTags })
      .filter((c) => c.matches > 0 && (c.matched.some((t) => needStems.has(stem(String(t).toLowerCase()))) || c.matches >= 2))
      .map((c) => ({ ...c, rank: initRank(c) }))
      .sort((a, b) => b.rank - a.rank || b.installs - a.installs || candidateRef(a).localeCompare(candidateRef(b)));
  }

  // --- round-robin across needs (breadth first), deduped by ref, with two spares for audit backfill
  const picked = [];
  const seen = new Set();
  const limit = max + 2;
  // Uncovered needs first (breadth first across needs), so a gap always outranks an 'also' pick.
  for (let i = 0; picked.length < limit; i++) {
    let any = false;
    for (const f of fetched) {
      if (f.also) continue;
      const c = f.ranked?.[i];
      if (!c) continue;
      any = true;
      const k = candidateRef(c).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      picked.push({ ...c, need: f.need, reason: f.reason, also: false });
      if (picked.length >= limit) break;
    }
    if (!any) break;
  }
  // Then 'also' picks for needs that are already covered: one per need, ALSO_MAX_PICKS in total.
  let alsoPicked = 0;
  for (const f of fetched) {
    if (!f.also || alsoPicked >= ALSO_MAX_PICKS || picked.length >= limit) continue;
    const c = (f.ranked ?? []).find((x) => !seen.has(candidateRef(x).toLowerCase()));
    if (!c) continue;
    seen.add(candidateRef(c).toLowerCase());
    picked.push({ ...c, need: f.need, reason: f.reason, also: true });
    alsoPicked++;
  }
  if (picked.length === 0) return finish();

  // --- audit (cached), drop fails when requireAuditPass, cap
  const audited = await mapLimit(picked, MAX_CONCURRENT, async (cand) => {
    const key = auditCacheKey(cand.source, cand.skill);
    let audit = cache.get(key, ttl);
    if (!audit || typeof audit !== 'object' || typeof audit.status !== 'string') {
      const left = remaining();
      if (cooldownUntil) audit = { status: 'unknown', raw: { skipped: 'cooldown' }, providers: [] };
      else if (left < MIN_REQUEST_MS) {
        result.auditSkipped = true;
        audit = { status: 'unknown', raw: { skipped: 'deadline' }, providers: [] };
      } else {
        audit = await auditSkill(cand.source, cand.skill, { timeoutMs: perRequest(left) }, { ...deps, env });
        if (audit.raw?.rateLimited) await rateLimited();
        if (!audit.raw?.transient) cache.set(key, audit);
      }
    }
    return { ...cand, audit };
  });
  const kept = [];
  for (const c of audited) {
    if (config.requireAuditPass !== false && c.audit.status === 'fail') {
      result.rejected++;
      result.rejectedByReason['audit fail'] = (result.rejectedByReason['audit fail'] ?? 0) + 1;
      continue;
    }
    kept.push(c);
  }
  const final = kept.slice(0, max);

  // --- pin: resolve HEAD now (cached head:<source>); unresolved -> listed, not approvable
  const resolveDeps = { execFileImpl: deps.execFileImpl, env };
  const pinned = await mapLimit(final, MAX_CONCURRENT, async (c) => {
    const [owner, repo] = c.source.split('/');
    const key = `${HEAD_CACHE_PREFIX}${c.source}`;
    let sha = cache.get(key, ttl);
    let error = null;
    if (typeof sha !== 'string' || !isSha(sha)) {
      sha = null;
      const left = remaining();
      if (left < MIN_RESOLVE_MS) error = `HEAD of ${c.source} not resolved: deadline`;
      else {
        try {
          sha = await resolveHeadSha(owner, repo, { timeoutMs: Math.min(RESOLVE_TIMEOUT_MS, left - 100) }, resolveDeps);
          cache.set(key, sha);
        } catch (err) {
          sha = null;
          error = `HEAD of ${c.source} not resolved: ${String(err?.message ?? err).slice(0, 200)}`;
        }
      }
    }
    if (error) result.errors.push(error);
    return { ...c, sha, error };
  });
  result.candidates = pinned.map((c, i) => ({
    n: i + 1,
    ref: formatRef({ owner: c.source.split('/')[0], repo: c.source.split('/')[1], sha: c.sha, skill: c.skill }),
    source: c.source,
    skill: c.skill,
    installs: c.installs,
    audit: c.audit?.status ?? 'unknown',
    need: c.need,
    reason: c.reason,
    also: c.also === true,
    sha: c.sha,
    approvable: Boolean(c.sha),
    url: c.url,
    matched: c.matched,
    relevance: c.relevance,
    rank: c.rank,
  }));
  return finish();
}

// ---------------------------------------------------------------------------
// runInit: inspect -> coverage -> suggest -> plan
// ---------------------------------------------------------------------------

function writePlan(file, plan) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return { path: file, written: true, error: null };
  } catch (err) {
    return { path: file, written: false, error: String(err?.message ?? err) };
  }
}

/**
 * @returns {Promise<{name, cwd, stack, needs, coverage, candidates, inspection, remote, index, plan, createdAt, elapsedMs}>}
 */
export async function runInit({ cwd, remote = true, env: rawEnv = process.env, deps = {}, config: cfgOverride, remoteBudgetMs = INIT_REMOTE_BUDGET_MS } = {}) {
  const t = timer();
  const dir = path.resolve(cwd || rawEnv.PWD || process.cwd());
  const hardened = hardenEnv(rawEnv, { cwd: dir });
  const env = hardened.env;
  for (const w of hardened.warnings) log('warn', /TEST SEAM/.test(w) ? 'init: test seam active' : 'init: environment override ignored', { warning: w });
  const config = cfgOverride ?? loadConfig(env);
  const now = deps.now ?? Date.now;

  const indexOpts = { cwd: dir, home: env.HOME };
  if (env.CLAUDE_CONFIG_DIR) indexOpts.configDir = env.CLAUDE_CONFIG_DIR;
  const [inspection, index] = await Promise.all([
    inspectProject(dir).catch(() => ({ name: path.basename(dir) || dir, cwd: dir, stack: { summary: '', tags: [] }, languages: [], manifests: [], tooling: [], readme: { present: false, claudeMd: false, words: [] }, needs: [], filesScanned: 0, truncated: false, signals: 0, elapsedMs: 0 })),
    buildIndex(indexOpts).catch(() => []),
  ]);
  const needs = inspection.needs.map((n) => ({ need: n.need, reason: n.reason, evidence: n.evidence, weight: n.weight }));
  const coverage = computeCoverage(needs, index);
  let remoteResult = { skipped: 'no-remote', queries: [], rejected: 0, rejectedByReason: {}, errors: [], cached: false, cooldownUntil: null, auditSkipped: false, elapsedMs: 0, candidates: [] };
  if (remote) {
    try {
      remoteResult = await suggest({ needs, coverage, index, config, env, deps, stackTags: inspection.stack.tags, budgetMs: Math.max(500, Number(remoteBudgetMs) || INIT_REMOTE_BUDGET_MS), now });
    } catch (err) {
      remoteResult = { ...remoteResult, skipped: null, errors: [`suggest: ${String(err?.message ?? err)}`] };
    }
  }
  const createdAt = new Date(now()).toISOString();
  const plan = {
    version: PLAN_VERSION,
    cwd: dir,
    createdAt,
    stack: inspection.stack,
    needs,
    coverage,
    candidates: remoteResult.candidates.map(({ n, ref, source, skill, installs, audit, need, reason, also, sha, approvable }) => ({ n, ref, source, skill, installs, audit, need, reason, also, sha, approvable })),
  };
  const planState = writePlan(planPath(env), plan);
  const result = {
    name: inspection.name,
    cwd: dir,
    createdAt,
    stack: inspection.stack,
    needs,
    coverage,
    candidates: remoteResult.candidates,
    inspection: { languages: inspection.languages, manifests: inspection.manifests, tooling: inspection.tooling, readme: inspection.readme, filesScanned: inspection.filesScanned, truncated: inspection.truncated, signals: inspection.signals, elapsedMs: inspection.elapsedMs },
    remote: { ...remoteResult, candidates: undefined },
    index: { total: index.length },
    plan: planState,
    warnings: [...hardened.warnings, ...(config.warnings ?? [])],
    elapsedMs: Math.round(t.elapsed()),
  };
  delete result.remote.candidates;
  log('info', 'init', { cwd: dir, needs: needs.map((n) => n.need), covered: coverage.covered.map((c) => `${c.need}->${c.skill}`), candidates: result.candidates.map((c) => c.ref), remote: remote ? { queries: result.remote.queries.length, cached: result.remote.cached, errors: result.remote.errors, skipped: result.remote.skipped } : 'skipped', planWritten: planState.written, ms: result.elapsedMs });
  return result;
}

/** The plan object as written to init-plan.json plus the diagnostics (`--json`). */
export function planJson(r) {
  return {
    version: PLAN_VERSION,
    cwd: r.cwd,
    createdAt: r.createdAt,
    stack: r.stack,
    needs: r.needs,
    coverage: r.coverage,
    candidates: r.candidates,
    inspection: r.inspection,
    remote: r.remote,
    index: r.index,
    plan: r.plan,
    warnings: r.warnings,
    elapsedMs: r.elapsedMs,
  };
}

export function formatReport(r) {
  const lines = [];
  lines.push(`${TAG} init: ${r.name}`);
  lines.push(`Stack: ${r.stack?.summary || '(unknown)'}`);
  const needs = Array.isArray(r.needs) ? r.needs : [];
  lines.push(needs.length ? `Needs (${needs.length}): ${needs.map((n) => `${n.need} (${n.reason})`).join(', ')}` : 'Needs (0): no signals');
  const cov = r.coverage ?? { covered: [], uncovered: [] };
  lines.push(`Covered by installed skills: ${cov.covered.length ? cov.covered.map((c) => `${c.need} -> ${c.skill}`).join('; ') : 'none'}`);
  lines.push(`Not covered: ${cov.uncovered.length ? cov.uncovered.join(', ') : 'none'}`);
  const remote = r.remote ?? { skipped: 'no-remote', queries: [], errors: [] };
  if (remote.skipped === 'no-remote') {
    lines.push('Suggested third-party skills: skipped (--no-remote)');
  } else {
    const cands = Array.isArray(r.candidates) ? r.candidates : [];
    if (cands.length === 0) {
      const requests = Array.isArray(remote.queries) ? remote.queries : [];
      const rateLimited = remote.cooldownUntil && Number(remote.cooldownUntil) > Date.now();
      const allFailed = requests.length > 0 && requests.every((q) => q.skipped && !q.cached);
      let why = 'none passed the gates';
      if (remote.skipped === 'no-needs') why = 'none (no needs to search)';
      else if (rateLimited) why = `none (skills.sh rate-limited until ${hhmm(remote.cooldownUntil)})`;
      else if (allFailed) why = 'none (third-party search failed: timeout / network error)';
      else if (remote.skipped) why = `none (${remote.skipped})`;
      lines.push(`Suggested third-party skills (pinned, not installed): ${why}`);
    } else {
      lines.push('Suggested third-party skills (pinned, not installed):');
      for (const c of cands) {
        lines.push(`  ${c.n}. ${displayRef(c)}   ${fmtInstalls(c.installs)} installs   audit ${c.audit}   for: ${c.need}${c.also ? ' (also)' : ''}${c.approvable ? '' : '   (HEAD not resolved: not approvable)'}`);
      }
      lines.push('  (contents are fetched and inspected only at apply time; a candidate can still be rejected or missing then)');
      const approvable = cands.filter((c) => c.approvable).map((c) => c.n);
      if (approvable.length) lines.push(`Approve: /singular init --apply ${approvable.slice(0, 2).join(',')}   (or: all)   Add --project to install into ./.claude/skills instead of ~/.claude/skills`);
      else lines.push('Approve: nothing approvable (no HEAD sha could be resolved); run /singular init again later');
    }
    if (Array.isArray(remote.errors) && remote.errors.length) lines.push(`Errors: ${remote.errors.join(' | ')}`);
  }
  if (r.plan && !r.plan.written) lines.push(`! plan not written to ${r.plan.path}: ${r.plan.error} (--apply will not work)`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// --apply
// ---------------------------------------------------------------------------

/**
 * Deterministic kickoff prompt: names the installed skills (so the Skill tool can invoke them by name), the first two
 * stack labels and the needs they were picked for. Never longer than KICKOFF_MAX_CHARS.
 */
export function kickoffPrompt({ stack, skills, needs } = {}) {
  const summary = typeof stack === 'string' ? stack : String(stack?.summary ?? '');
  const labels = summary.split(';')[0].split(',').map((s) => s.trim()).filter(Boolean).slice(0, 2);
  const project = labels.length ? `${labels.join(' + ')} project` : 'project';
  const names = [...new Set((Array.isArray(skills) ? skills : []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (names.length === 0) return '';
  let ns = [...new Set((Array.isArray(needs) ? needs : []).map((s) => String(s ?? '').trim()).filter(Boolean))];
  const joinNames = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
  const build = () => `Using the skill${names.length > 1 ? 's' : ''} ${joinNames(names)}, review this ${project}: list the 3 highest-impact improvements for ${ns.length ? ns.join(', ') : 'this codebase'}, then implement the first one.`;
  let text = build();
  while (text.length > KICKOFF_MAX_CHARS && ns.length > 0) {
    ns = ns.slice(0, -1);
    text = build();
  }
  while (text.length > KICKOFF_MAX_CHARS && names.length > 1) {
    names.pop();
    text = build();
  }
  return text.length > KICKOFF_MAX_CHARS ? text.slice(0, KICKOFF_MAX_CHARS) : text;
}

function readPlan(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Load and validate the plan for `dir`: present, version 1, made for this cwd, younger than ttlHours.
 * @returns {{ok: true, plan} | {ok: false, message}}
 */
export function loadPlan({ file, dir, ttlHours, now = Date.now() }) {
  if (!fs.existsSync(file)) return { ok: false, message: `no plan found at ${file}; run /singular init first` };
  const plan = readPlan(file);
  if (!plan) return { ok: false, message: `the plan at ${file} is not valid JSON; run /singular init again` };
  if (plan.version !== PLAN_VERSION || !Array.isArray(plan.candidates) || typeof plan.cwd !== 'string') return { ok: false, message: `the plan at ${file} has an unexpected shape (version ${plan.version ?? '?'}); run /singular init again` };
  const made = Date.parse(plan.createdAt);
  const ttlMs = Math.max(0, Number(ttlHours) || 0) * 3600 * 1000;
  if (!Number.isFinite(made) || now - made > ttlMs) {
    const age = Number.isFinite(made) ? `${Math.round((now - made) / 3600000 * 10) / 10} h old` : 'undated';
    return { ok: false, message: `the plan at ${file} is ${age} (older than ${Number(ttlHours) || 0} h); run /singular init again` };
  }
  if (realDir(plan.cwd) !== realDir(dir)) return { ok: false, message: `the plan was made for ${plan.cwd}, not ${dir}; run /singular init here first` };
  return { ok: true, plan };
}

/**
 * Install the selected candidates of the plan through the add flow (pinned ref from the plan, never re-resolved).
 * @returns {Promise<{status:'ok'|'error', message, exitCode, results?, installed?, kickoff?, target?, plan?}>}
 */
export async function runApply({ selection, project = false, cwd, env: rawEnv = process.env, deps = {}, config: cfgOverride } = {}) {
  const t = timer();
  const dir = path.resolve(cwd || rawEnv.PWD || process.cwd());
  const hardened = hardenEnv(rawEnv, { cwd: dir });
  const env = hardened.env;
  for (const w of hardened.warnings) log('warn', /TEST SEAM/.test(w) ? 'init: test seam active' : 'init: environment override ignored', { warning: w });
  const config = cfgOverride ?? loadConfig(env);
  const now = deps.now ?? Date.now;
  const file = planPath(env);
  const loaded = loadPlan({ file, dir, ttlHours: config.initPlanTtlHours ?? 24, now: now() });
  if (!loaded.ok) return { status: 'error', exitCode: 1, message: `${TAG} init --apply: ${loaded.message}` };
  const plan = loaded.plan;
  const sel = parseSelection(selection, plan.candidates.length);
  if (!sel.ok) return { status: 'error', exitCode: 1, message: `${TAG} init --apply: ${sel.message}` };
  const target = project ? path.join(dir, '.claude', 'skills') : skillsDir(env);

  const results = [];
  for (const n of sel.numbers) {
    const cand = plan.candidates[n - 1];
    const label = `${n}. ${displayRef(cand)}`;
    if (!cand || typeof cand.ref !== 'string') {
      results.push({ n, status: 'error', ref: cand?.ref ?? null, line: `ERROR ${label}: malformed plan entry` });
      continue;
    }
    const parsed = parseRef(cand.ref);
    if (!cand.approvable || !parsed || !parsed.sha) {
      results.push({ n, status: 'skipped', why: 'unresolved', ref: cand.ref, skill: cand.skill, line: `SKIPPED ${label} (HEAD not resolved when the plan was made; run /singular init again)` });
      continue;
    }
    const dest = path.join(target, parsed.skill);
    let exists = false;
    try {
      fs.lstatSync(dest);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      results.push({ n, status: 'skipped', why: 'exists', ref: cand.ref, skill: parsed.skill, path: dest, line: `SKIPPED ${label} (exists: ${dest})` });
      continue;
    }
    const r = await runAdd({ ref: cand.ref, env, deps, config, targetDir: target });
    if (r.status === 'installed') {
      results.push({ n, status: 'installed', ref: r.ref, sha: r.sha, skill: parsed.skill, need: cand.need, path: r.path, audit: r.audit?.status ?? 'unknown', line: `INSTALLED ${label} -> ${r.path} (audit ${r.audit?.status ?? 'unknown'})` });
    } else if (r.status === 'rejected') {
      const problems = Array.isArray(r.problems) ? r.problems : [];
      const shown = problems.slice(0, 4).join('; ') + (problems.length > 4 ? `; +${problems.length - 4} more` : '');
      results.push({ n, status: 'rejected', ref: r.ref, skill: parsed.skill, problems, removed: r.removed, copied: r.copied, line: `REJECTED ${label}: ${shown} (${r.copied ? (r.removed ? 'removed again; nothing left behind' : 'WARNING: not removed, inspect it') : 'nothing was written'})` });
    } else {
      results.push({ n, status: 'error', ref: cand.ref, skill: parsed.skill, line: `ERROR ${label}: ${String(r.message ?? 'add failed').split('\n')[0]}` });
    }
  }
  const installed = results.filter((r) => r.status === 'installed');
  const names = installed.map((r) => r.skill);
  const kickoff = names.length ? kickoffPrompt({ stack: plan.stack, skills: names, needs: installed.map((r) => r.need) }) : '';
  const lines = [`${TAG} init --apply ${String(selection).trim()}: ${sel.numbers.length} of ${plan.candidates.length} candidate${plan.candidates.length === 1 ? '' : 's'} for ${path.basename(plan.cwd) || plan.cwd} (plan from ${plan.createdAt}) -> ${target}`];
  for (const r of results) lines.push(r.line);
  lines.push(`Installed: ${names.length ? names.join(', ') : 'none'}`);
  if (kickoff) {
    lines.push('Kickoff prompt (copy or say "run it"):', `  ${kickoff}`);
    lines.push('Reload: new skills are picked up automatically; run /reload-skills if /singular status does not list them.');
  } else lines.push('Kickoff prompt: none (nothing new was installed)');
  const failed = results.some((r) => r.status === 'rejected' || r.status === 'error');
  log('info', 'init apply', { cwd: dir, selection: sel.numbers, target, installed: names, rejected: results.filter((r) => r.status === 'rejected').map((r) => r.ref), skipped: results.filter((r) => r.status === 'skipped').map((r) => r.ref), ms: Math.round(t.elapsed()) });
  return { status: 'ok', exitCode: failed ? 1 : 0, message: lines.join('\n'), results, installed: names, kickoff, target, plan: { path: file, createdAt: plan.createdAt, cwd: plan.cwd, candidates: plan.candidates.length }, selection: sel.numbers };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** `singular init [...]`: returns the exit code. Never installs without --apply. */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stderr.write(`${USAGE}\n`);
    return 0;
  }
  if (args.errors.length) {
    process.stderr.write(`${TAG} init: ${args.errors.join('; ')}\n${USAGE}\n`);
    return 1;
  }
  if (args.apply !== null) {
    const r = await runApply({ selection: args.apply, project: args.project, cwd: args.cwd, env: process.env });
    if (args.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    else process.stdout.write(`${r.message}\n`);
    return r.exitCode;
  }
  const r = await runInit({ cwd: args.cwd, remote: args.remote, env: process.env });
  process.stdout.write(args.json ? `${JSON.stringify(planJson(r), null, 2)}\n` : `${formatReport(r)}\n`);
  return 0;
}
