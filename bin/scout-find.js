#!/usr/bin/env node
// bin/scout-find.js — search skills.sh for a query, apply the same gates as the hook, print a table.
//
//   node bin/scout-find.js "<query>" [--limit N] [--all] [--json] [--cwd <dir>]
//
// Prints installed skills that already match (local index), then gated third-party candidates
//   ref  installs  audit  allowlisted?
// and the rejected count grouped by reason (--all lists every rejected entry). Never installs.
//
// This is the ONE path that sends prompt-derived text to skills.sh: the user typed the query on purpose,
// so the joined keywords go out as `q=` (one request) in addition to the cached owner catalogs.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { hardenEnv, loadConfig } from '../lib/config.js';
import { TAG } from '../lib/context.js';
import { log } from '../lib/log.js';
import { discover, rankCandidates } from '../lib/registry.js';
import { isWeakMatch, scoreSkills } from '../lib/score.js';
import { buildIndex } from '../lib/skill-index.js';
import { detectStack } from '../lib/stack.js';

export const FIND_TIMEOUT_MS = 15000;
const OWNER_REJECTION_RE = /^owner (\S+) not allowlisted$/;

function fmtInstalls(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}K`;
  return String(v);
}

function pad(s, n) {
  const t = String(s ?? '');
  return t.length >= n ? t : t + ' '.repeat(n - t.length);
}

function parseArgs(argv) {
  const out = { query: [], limit: 10, all: false, json: false, cwd: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Math.max(1, Math.min(50, Number(argv[++i]) || 10));
    else if (a === '--all') out.all = true;
    else if (a === '--json') out.json = true;
    else if (a === '--cwd') out.cwd = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.query.push(a);
  }
  out.query = out.query.join(' ').trim();
  return out;
}

/**
 * Rank the rejected entries by the same relevance score the accepted ones get (installs alone put
 * `frontend-design (already installed)` on top of every query) and name the best allowlist-only
 * rejection explicitly, so the model can quote it instead of inferring an owner from an unrelated row.
 */
export function rankRejected(rejected, keywords, { prompt, stackTags } = {}) {
  const list = Array.isArray(rejected) ? rejected : [];
  const ranked = rankCandidates(list.map((r) => r.cand), keywords, { prompt, stackTags });
  const byRef = new Map(ranked.map((c) => [`${c.source}@${c.skill}`.toLowerCase(), c]));
  const out = list.map((r) => {
    const ref = `${r.cand.source}@${r.cand.skill}`;
    const c = byRef.get(ref.toLowerCase());
    return { ref, installs: r.cand.installs, reason: r.reason, matches: c?.matches ?? 0, matched: c?.matched ?? [], rank: c?.rank ?? 0 };
  });
  out.sort((a, b) => Number(b.matches > 0) - Number(a.matches > 0) || b.rank - a.rank || b.installs - a.installs || a.ref.localeCompare(b.ref));
  const best = out.find((x) => x.matches > 0 && OWNER_REJECTION_RE.test(x.reason));
  const bestRejected = best ? { ref: best.ref, installs: best.installs, owner: OWNER_REJECTION_RE.exec(best.reason)[1], matched: best.matched } : null;
  return { rejected: out, bestRejected };
}

/** @returns {Promise<{query, keywords, local, accepted, rejected, bestRejected, errors, cached, elapsedMs}>} */
export async function runScoutFind({ query, limit = 10, cwd, env: rawEnv = process.env, deps = {}, config: cfgOverride, timeoutMs = FIND_TIMEOUT_MS } = {}) {
  const dir = path.resolve(cwd || process.cwd());
  const hardened = hardenEnv(rawEnv, { cwd: dir });
  const env = hardened.env;
  for (const w of hardened.warnings) log('warn', /TEST SEAM/.test(w) ? 'scout-find: test seam active' : 'scout-find: environment override ignored', { warning: w });
  const config = cfgOverride ?? loadConfig(env);
  const indexOpts = { cwd: dir, home: env.HOME };
  if (env.CLAUDE_CONFIG_DIR) indexOpts.configDir = env.CLAUDE_CONFIG_DIR;
  const [index, stack] = await Promise.all([buildIndex(indexOpts).catch(() => []), detectStack(dir).catch(() => ({ summary: '', tags: [] }))]);
  const local = scoreSkills(query, index, { max: 8, minScore: 1.5 }).filter((m) => !isWeakMatch(m.matched)).slice(0, 5).map((m) => ({
    name: m.skill.invocableName || m.skill.name,
    scope: m.skill.scope,
    score: m.score,
    matched: m.matched,
    description: String(m.skill.description ?? '').slice(0, 100),
  }));
  const installedNames = [...new Set(index.flatMap((s) => [s.name, s.frontmatterName].filter(Boolean).map((n) => String(n).toLowerCase())))];
  const d = await discover(query, {
    config: { ...config, maxCandidates: limit, remoteTimeoutMs: Math.max(Number(config.remoteTimeoutMs) || 2500, 6000) },
    stackTags: stack.tags,
    timeoutMs,
    deps: { ...deps, env },
    installedNames,
    search: true,
  });
  const { rejected, bestRejected } = rankRejected(d.rejected, d.keywords, { prompt: query, stackTags: stack.tags });
  return {
    query,
    keywords: d.keywords,
    intent: d.intent,
    stack: stack.summary,
    configPath: config.path ?? null,
    local,
    accepted: d.candidates.map((c) => ({
      ref: c.ref,
      source: c.source,
      skill: c.skill,
      installs: c.installs,
      audit: c.audit?.status ?? 'unknown',
      allowlisted: true,
      url: c.url,
      matches: c.matches,
      matched: c.matched,
      rank: c.rank,
    })),
    rejected,
    bestRejected,
    queries: d.queries,
    errors: d.errors,
    cached: d.cached,
    auditSkipped: d.auditSkipped,
    cooldownUntil: d.cooldownUntil ?? null,
    elapsedMs: d.elapsedMs,
  };
}

function hhmm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatReport(r, { all = false } = {}) {
  const lines = [];
  lines.push(`${TAG} query: "${r.query}"  keywords: ${r.keywords.join(', ') || '(none)'}${r.stack ? `  stack: ${r.stack}` : ''}`);
  if (r.local.length) {
    lines.push('', 'Installed locally (already available, use the Skill tool / slash command):');
    for (const l of r.local) lines.push(`  ${pad(l.name, 44)} ${pad(l.scope, 8)} score ${l.score}  ${l.description}`);
  } else {
    lines.push('', 'Installed locally: no match.');
  }
  lines.push('', 'Third-party candidates (gated: allowlist, install floor, audit; NOT installed):');
  const requests = Array.isArray(r.queries) ? r.queries : [];
  const allFailed = requests.length > 0 && requests.every((q) => q.skipped && !q.cached);
  const rateLimited = r.cooldownUntil && Number(r.cooldownUntil) > Date.now();
  if (r.accepted.length === 0 && (allFailed || rateLimited)) {
    lines.push(`  Third-party search failed (${rateLimited ? `skills.sh rate-limited until ${hhmm(r.cooldownUntil)}` : 'timeout / network error'}); nothing could be evaluated.`);
  } else if (r.accepted.length === 0) lines.push('  (none passed the gates)');
  else {
    lines.push(`  ${pad('ref', 64)} ${pad('installs', 9)} ${pad('audit', 8)} allowlisted?`);
    for (const c of r.accepted) lines.push(`  ${pad(c.ref, 64)} ${pad(fmtInstalls(c.installs), 9)} ${pad(c.audit, 8)} yes`);
    lines.push('', '  Load ephemerally (text only):  /scout-load <ref>', '  Install persistently (pinned): /scout-add <ref>');
  }
  const groups = new Map();
  for (const x of r.rejected) {
    const key = x.reason
      .replace(/\d[\d,]*/g, 'N')
      .replace(/kept .*$/, 'kept ...')
      .replace(/fork of .*$/, 'fork of ...')
      .replace(/owner \S+ not allowlisted/, 'owner not allowlisted')
      .replace(/\(.*\)$/, '(...)');
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  if ((allFailed || rateLimited) && r.rejected.length === 0) lines.push('', `Rejected: n/a (${rateLimited ? `rate-limited until ${hhmm(r.cooldownUntil)}` : 'search failed'})`);
  else {
    lines.push('', `Rejected: ${r.rejected.length}${allFailed || rateLimited ? ' (from cached catalogs only)' : ''}`);
    for (const [reason, n] of [...groups.entries()].sort((a, b) => b[1] - a[1])) lines.push(`  ${n} x ${reason}`);
  }
  if (r.bestRejected) {
    lines.push(`  Best allowlist-only rejection: ${r.bestRejected.ref} (${fmtInstalls(r.bestRejected.installs)} installs, matched ${r.bestRejected.matched.join(', ') || '-'}) - add "${r.bestRejected.owner}" to "allowlist" in ${r.configPath ?? '~/.claude/skill-scout/config.json'} to consider it`);
  }
  const show = all ? r.rejected : r.rejected.slice(0, 8);
  if (show.length) {
    lines.push(all ? '  all rejected entries (by relevance, then installs):' : '  top rejected by relevance (use --all for the full list):');
    for (const x of show) lines.push(`    ${pad(x.ref, 64)} ${pad(fmtInstalls(x.installs), 9)} ${x.reason}${x.matches > 0 ? `  [matched ${x.matched.join(', ')}]` : ''}`);
  }
  if (r.errors.length) lines.push('', `Errors: ${r.errors.join(' | ')}`);
  lines.push('', `(${r.queries.length} requests, cached: ${r.cached}${r.auditSkipped ? ', audits skipped (deadline)' : ''}${rateLimited ? `, skills.sh rate-limited until ${hhmm(r.cooldownUntil)}` : ''}, ${Math.round(r.elapsedMs)} ms)`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.query) {
    process.stderr.write('usage: scout-find.js "<query>" [--limit N] [--all] [--json] [--cwd <dir>]\n');
    return args.help ? 0 : 1;
  }
  const r = await runScoutFind({ query: args.query, limit: args.limit, cwd: args.cwd, env: process.env });
  log('info', 'scout-find', { query: args.query, accepted: r.accepted.length, rejected: r.rejected.length, ms: Math.round(r.elapsedMs) });
  process.stdout.write(args.json ? `${JSON.stringify(r, null, 2)}\n` : `${formatReport(r, { all: args.all })}\n`);
  return 0;
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
      process.stderr.write(`${TAG} error: ${String(err?.message ?? err)}\n`);
      process.exit(1);
    },
  );
}
