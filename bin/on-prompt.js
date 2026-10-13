#!/usr/bin/env node
// bin/on-prompt.js — UserPromptSubmit hook entrypoint for singular.
//
// Hook mode:   reads the hook JSON on stdin, prints {"hookSpecificOutput":{...additionalContext}} or nothing.
// Dry-run:     node bin/on-prompt.js --dry-run "<prompt>" [--cwd <dir>] [--json] [--verbose] [--session <id>]
//
// Exit 0 always. Never writes to stdout except the hook JSON (or the dry-run text).
// Everything runs inside config.totalBudgetMs (hard deadline: a watchdog prints the
// local-only context and exits if the remote phase overruns).
//
// Hot path (per prompt): index + score installed skills, stack detection, then (suggest/auto, when no
// strong local match) rank the prompt against the cached allowlisted-owner catalogs plus at most two
// single tech-lexicon words searched on skills.sh (`q=stripe`; never free-form prompt text; see
// docs/security.md "Outbound data"). HEAD shas are read from the cache only; a detached background prefetch
// (`on-expand.js <ref> --prefetch`) resolves the pin and caches the skill text so `/singular load` and the
// next auto prompt are instant. Auto mode fetches inline only when the text is cached or enough budget
// is left for a cold `npx skills use`.

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cacheGet, cacheSet } from '../lib/cache.js';
import { hardenEnv, homeDir, isAllowlisted, loadConfig } from '../lib/config.js';
import { composeContext, hookOutput, spillIfNeeded, TAG } from '../lib/context.js';
import { log, timer } from '../lib/log.js';
import { discover, fetchSkillText, sanitizeSkillText, textCacheKey } from '../lib/registry.js';
import { formatRef, normalizeRefCase, parseRef, REF_RE, resolveHeadSha, unpinnedRef } from '../lib/refs.js';
import { isGenericToken, isTechToken, isWeakMatch, scoreSkills, stem } from '../lib/score.js';
import { buildIndex } from '../lib/skill-index.js';
import { detectStack } from '../lib/stack.js';

export const STRONG_LOCAL_SCORE = 10;
// A match on ONE name token needs a much higher score to count as strong: the score already carries the x3
// name weight, so >= 20 means the token is rare across the index (build-dashboard 44.7 for "dashboard"),
// while a word shared by many skill names stays below it (system-design 11.5 for "design", routing-middleware
// 15.9 for "route"). Tech-lexicon nouns (nextjs, stripe, pdf, auth) are strong at the normal bar.
export const STRONG_SINGLE_NAME_SCORE = 20;
// Common English words that name many skills; a single hit on one of them is never strong.
export const NAME_GENERIC = new Set('design designs route routes routing system systems review reviews plan plans start starts setup status update updates explore'.split(' '));
export const MIN_REMOTE_MS = 1500;
export const MIN_AUTO_FETCH_MS = 4500; // measured: a warm `npx skills use` takes ~4.2 s (cold npm cache: longer); a cached text takes ~0 ms
export const MIN_RESOLVE_MS = 1200;
export const HEAD_CACHE_PREFIX = 'head:';
export const SESSION_TTL_HOURS = 24 * 7;
// One factual line for prompts that talk about singular itself: /singular is user-only (disable-model-invocation),
// so the model cannot see its subcommands and would otherwise guess them.
export const COMMANDS_HINT = 'singular commands (typed by the user): /singular (status + help), /singular status (config, pins, cache), /singular find <query> (search skills.sh; the singular-find skill is also model-invocable), /singular load owner/repo@skill (load text into this session), /singular mode <off|local|suggest|auto>, /singular add owner/repo@skill (pinned persistent install).';
// A prompt is about the plugin when it names the command (/singular, /singular-find) or uses the word next to a
// plugin noun; the word alone is ordinary English ("singular value decomposition") and must not trigger the hint.
const SINGULAR_COMMAND_RE = /\/singular(?:-find)?\b/i;
const SINGULAR_WORD_RE = /\bsingular\b/i;
const SINGULAR_TOPIC_RE = /\b(?:skills?|plugins?|commands?|modes?|status|config|hooks?)\b/i;
export function mentionsSingular(text) {
  const s = String(text ?? '');
  return SINGULAR_COMMAND_RE.test(s) || (SINGULAR_WORD_RE.test(s) && SINGULAR_TOPIC_RE.test(s));
}
const ON_EXPAND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'on-expand.js');
const PASTED_WRAPPER_RE = /^[ \t]*<\/?pasted_content(?:\s+id="[^"]*")?>[ \t]*$/gm;
// Synthetic prompts Claude Code delivers to the main agent (2.1.293): a backgrounded subagent's completion
// notice, and a bare system reminder. They are not user requests; routing them wastes time and may send
// tech words from a subagent's output to skills.sh.
const TASK_NOTIFICATION_RE = /^<task-notification>/i;
const SYSTEM_REMINDER_RE = /^<system-reminder>[\s\S]*<\/system-reminder>$/i;

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const out = { dryRun: false, prompt: null, cwd: null, json: false, verbose: false, help: false, session: null, prefetch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      out.dryRun = true;
      if (argv[i + 1] != null && !argv[i + 1].startsWith('--')) out.prompt = argv[++i];
    } else if (a === '--cwd') out.cwd = argv[++i] ?? null;
    else if (a === '--session') out.session = argv[++i] ?? null;
    else if (a === '--json') out.json = true;
    else if (a === '--prefetch') out.prefetch = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (out.dryRun && out.prompt == null && !a.startsWith('--')) out.prompt = a;
  }
  return out;
}

/** Strip the `<pasted_content id="…">` wrapper lines Claude Code adds around pasted text; trim. */
export function normalizePrompt(prompt) {
  return String(prompt ?? '').replace(PASTED_WRAPPER_RE, '').trim();
}

/**
 * Why a prompt gets no routing. The slash-command rule follows Claude Code's own: a command is expanded only
 * when the RAW prompt starts with `/`, so a pasted block whose first inner line is a slash command
 * (`<pasted_content>\n/singular load ...`) is a normal prompt and keeps its stack + routing.
 */
export function skipReason(clean, config, raw = clean) {
  const t = clean;
  const rawText = String(raw ?? '').trim();
  if (config.mode === 'off') return 'mode off';
  if (!t) return 'empty prompt';
  if (rawText.startsWith('/')) return 'slash command';
  if (TASK_NOTIFICATION_RE.test(rawText) || TASK_NOTIFICATION_RE.test(t)) return 'task notification (synthetic prompt)';
  if (SYSTEM_REMINDER_RE.test(t)) return 'system reminder (synthetic prompt)';
  if (t.startsWith(TAG)) return 'own output';
  if (t.length < Number(config.minPromptChars)) return `prompt shorter than minPromptChars (${t.length} < ${config.minPromptChars})`;
  return null;
}

function installedNamesOf(index) {
  const names = new Set();
  for (const s of index) {
    if (s.name) names.add(String(s.name).toLowerCase());
    if (s.frontmatterName) names.add(String(s.frontmatterName).toLowerCase());
  }
  return [...names];
}

/**
 * A local match is strong (suppresses remote discovery) when it scores >= STRONG_LOCAL_SCORE and either
 * matched >= 2 meaningful (non-generic) tokens, or matched a single NAME token that is a tech-lexicon noun
 * (nextjs, stripe, pdf, auth ...), or a single rare, non-generic name token with score >=
 * STRONG_SINGLE_NAME_SCORE ("dashboard" -> data:build-dashboard, "karpathy"). A single hit on "file",
 * "function", "clean" ... is never strong and is not even listed (isWeakMatch); a single common English name
 * word ("design" -> system-design, "route" -> routing-middleware, "plan", "review", "setup") is listed but
 * never strong, so discovery still runs (measured 2026-10-07: those two made tangential skills strong and
 * hid vercel:nextjs / frontend-design).
 */
export function isStrongMatch(m) {
  if (!m || Number(m.score) < STRONG_LOCAL_SCORE) return false;
  const matched = Array.isArray(m.matched) ? m.matched : [];
  if (isWeakMatch(matched)) return false;
  // Only tokens that carry signal count: "tools, code" or "pull, requests" must not suppress discovery.
  const meaningful = matched.filter((t) => !isGenericToken(t));
  if (meaningful.length >= 2) return true;
  const nameMatched = Array.isArray(m.nameMatched) ? m.nameMatched : [];
  return nameMatched.some((t) => {
    const w = String(t ?? '').toLowerCase();
    if (!w || isGenericToken(w) || NAME_GENERIC.has(w) || NAME_GENERIC.has(stem(w))) return false;
    return isTechToken(w) || Number(m.score) >= STRONG_SINGLE_NAME_SCORE;
  });
}

function cacheOf(deps, env) {
  return {
    get: (k, ttl) => (deps.cacheGet ? deps.cacheGet(k, ttl) : cacheGet(k, ttl, env)),
    set: (k, v) => (deps.cacheSet ? deps.cacheSet(k, v) : cacheSet(k, v, env)),
  };
}

/** Attach cached HEAD shas (display only); never touches the network on the hot path. */
function pinFromCache(candidates, { ttlHours, cache }) {
  return candidates.map((c) => {
    try {
      const hit = cache.get(`${HEAD_CACHE_PREFIX}${c.source}`, ttlHours);
      if (typeof hit === 'string' && /^[0-9a-f]{40}$/.test(hit)) return { ...c, sha: hit };
    } catch {
      /* ignore */
    }
    return c;
  });
}

async function resolvePin(cand, { remaining, ttlHours, cache, deps }) {
  if (cand.sha) return cand.sha;
  const left = remaining();
  if (left < MIN_RESOLVE_MS) return null;
  try {
    const [owner, repo] = cand.source.split('/');
    const sha = await resolveHeadSha(owner, repo, { timeoutMs: Math.min(3000, left - 300) }, deps);
    cache.set(`${HEAD_CACHE_PREFIX}${cand.source}`, sha);
    return sha;
  } catch (err) {
    log('debug', 'head sha resolve failed', { source: cand.source, error: String(err?.message ?? err) });
    return null;
  }
}

/** Detached `node bin/on-expand.js <ref> --prefetch` (stdio ignored, unref) so the next load is instant. */
function spawnPrefetch(ref, { env, deps, result }) {
  const spawnImpl = deps.spawnImpl ?? nodeSpawn;
  try {
    const child = spawnImpl(process.execPath, [ON_EXPAND, ref, '--prefetch'], { detached: true, stdio: 'ignore', env, windowsHide: true });
    child?.unref?.();
    result.prefetched = [...(result.prefetched ?? []), ref];
    return true;
  } catch (err) {
    log('debug', 'prefetch spawn failed', { ref, error: String(err?.message ?? err) });
    return false;
  }
}

/** The one-time auto warning. The marker is written only for a real run (`persist`); a --dry-run must not consume it. */
function autoWarning(home, { persist = true } = {}) {
  const marker = path.join(home, '.auto-mode-warned');
  if (fs.existsSync(marker)) return null;
  if (persist) {
    try {
      fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
    } catch {
      /* ignore */
    }
  }
  return `${TAG} WARNING: mode "auto" is enabled. Third-party skill text from allowlisted skills.sh sources will be injected into your prompts without confirmation. It is text only (nothing is installed), pinned to a commit and sanitized, but it is still untrusted prose. Run /singular mode suggest (or edit ${path.join(home, 'config.json')}) to require /singular load. This warning is shown once.`;
}

/**
 * One line for the user (hook `systemMessage`, shown in the transcript) naming fresh third-party candidates,
 * so a suggestion no longer depends on the model relaying it. Each ref is announced once per session
 * (cache key session:<id>:suggested); without a session id every call announces.
 */
export function suggestionMessage(candidates, { sessionId, cache }) {
  const refs = (Array.isArray(candidates) ? candidates : []).map((c) => `${c.source}@${c.skill}`).filter(Boolean);
  if (refs.length === 0) return null;
  let fresh = refs;
  if (sessionId && cache) {
    const key = `session:${sessionId}:suggested`;
    let seen = [];
    try {
      const v = cache.get(key, SESSION_TTL_HOURS);
      seen = Array.isArray(v) ? v : [];
    } catch {
      seen = [];
    }
    fresh = refs.filter((r) => !seen.includes(r));
    if (fresh.length) {
      try {
        cache.set(key, [...seen, ...fresh]);
      } catch {
        /* ignore */
      }
    }
  }
  if (fresh.length === 0) return null;
  return `${TAG} ${fresh.length} third-party skill${fresh.length > 1 ? 's' : ''} may fit this prompt (not loaded): ${fresh.map((r) => `/singular load ${r}`).join(', ')}`;
}

/** Split config.pinnedSkills into installed names (hint) and allowlisted refs (text), dropping the rest with warnings. */
export function classifyPinned(pinnedSkills, index, config) {
  const names = new Map();
  for (const s of index) {
    for (const n of [s.name, s.frontmatterName, s.invocableName, s.pluginName ? `${s.pluginName}:${s.name}` : null]) {
      if (n) names.set(String(n).toLowerCase(), s.invocableName || s.name);
    }
  }
  const installed = [];
  const refs = [];
  const warnings = [];
  for (const raw of Array.isArray(pinnedSkills) ? pinnedSkills : []) {
    const entry = String(raw ?? '').trim();
    if (!entry) continue;
    const hit = names.get(entry.toLowerCase());
    if (hit) {
      if (!installed.includes(hit)) installed.push(hit);
      continue;
    }
    if (REF_RE.test(entry)) {
      const parsed = normalizeRefCase(parseRef(entry));
      if (parsed && isAllowlisted(`${parsed.owner}/${parsed.repo}`, config.allowlist)) refs.push(parsed);
      else warnings.push(`pinnedSkills: ${entry} ignored (owner not allowlisted)`);
      continue;
    }
    warnings.push(`pinnedSkills: ${entry} is neither an installed skill name nor an allowlisted owner/repo@skill ref`);
  }
  return { installed, refs, warnings };
}

function readLoadedPins(home) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, 'loaded.json'), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * Core pipeline. Pure with respect to process I/O: returns the context instead of printing it.
 * `state.partial` is updated after the local phase so a watchdog can flush it on overrun.
 * deps: {fetchImpl, execFileImpl, spawnImpl, cacheGet, cacheSet, now} forwarded to registry/refs (tests).
 * opts.prefetch: spawn background prefetches (hook mode default; off in --dry-run).
 * opts.dryRun: never consume the one-time auto warning marker.
 */
export async function runOnPrompt({ prompt, cwd, sessionId = null, env: rawEnv = process.env, deps = {}, state = {}, config: cfgOverride, prefetch = false, dryRun = false } = {}) {
  const t = timer();
  const timings = {};
  const dir = path.resolve(cwd || rawEnv.PWD || process.cwd());
  const hardened = hardenEnv(rawEnv, { cwd: dir });
  const env = hardened.env;
  const config = cfgOverride ?? loadConfig(env);
  const home = homeDir(env);
  const clean = normalizePrompt(prompt);
  const result = {
    mode: config.mode,
    skipped: null,
    context: '',
    systemMessage: null,
    stack: null,
    localMatches: [],
    candidates: [],
    loaded: null,
    pinned: [],
    discover: null,
    hint: false,
    timings,
    warnings: [...hardened.warnings, ...(config.warnings ?? [])],
  };
  const aboutSingular = config.mode !== 'off' && mentionsSingular(clean);
  const skip = skipReason(clean, config, prompt);
  if (skip) {
    result.skipped = skip;
    // "show me the singular status" (30 chars) is under minPromptChars but asks about the plugin itself:
    // answer with the command list only (no index, no stack, no network).
    if (aboutSingular && /shorter than minPromptChars/.test(skip)) {
      result.hint = true;
      result.context = `${TAG} ${COMMANDS_HINT}`;
    }
    timings.totalMs = t.elapsed();
    return result;
  }
  const notes = aboutSingular ? [COMMANDS_HINT] : [];
  if (aboutSingular) result.hint = true;
  const budget = Math.max(500, Number(config.totalBudgetMs) || 6000);
  const now = deps.now ?? Date.now;
  const deadline = now() + budget;
  const remaining = () => deadline - now();
  const cache = cacheOf(deps, env);
  const ttlHours = Number(config.cacheTtlHours) || 24;
  const canPrefetch = prefetch && config.prefetch !== false;

  // --- local phase: index + score, stack (parallel, all local I/O)
  const tLocal = timer();
  const indexOpts = { cwd: dir, home: env.HOME };
  if (env.CLAUDE_CONFIG_DIR) indexOpts.configDir = env.CLAUDE_CONFIG_DIR;
  const [index, stack] = await Promise.all([
    buildIndex(indexOpts).catch(() => []),
    config.stackDetection ? detectStack(dir).catch(() => ({ summary: '', tags: [] })) : Promise.resolve({ summary: '', tags: [] }),
  ]);
  timings.indexMs = tLocal.elapsed();
  const scored = scoreSkills(clean, index, { max: Math.max(0, Number(config.maxLocalSkills) || 3) + 3, minScore: 1.5 });
  const localMatches = scored.filter((m) => !isWeakMatch(m.matched)).slice(0, Math.max(0, Number(config.maxLocalSkills) || 3));
  timings.localMs = tLocal.elapsed();
  result.stack = stack;
  result.localMatches = localMatches.map((m) => ({
    name: m.skill.invocableName || m.skill.name,
    scope: m.skill.scope,
    score: m.score,
    matched: m.matched,
    nameMatched: m.nameMatched,
    strong: isStrongMatch(m),
    skill: m.skill,
  }));
  result.weakMatches = scored.filter((m) => isWeakMatch(m.matched)).map((m) => `${m.skill.invocableName || m.skill.name}:${m.score}`);
  result.indexSize = index.length;

  // --- pinned skills (config.pinnedSkills): once per session
  const pinned = classifyPinned(config.pinnedSkills, index, config);
  result.warnings.push(...pinned.warnings);
  const sessionKey = sessionId ? `session:${sessionId}:pinned` : null;
  let pinnedDone = false;
  if (sessionKey) {
    try {
      pinnedDone = cache.get(sessionKey, SESSION_TTL_HOURS) === true;
    } catch {
      pinnedDone = false;
    }
  }
  const wantPinned = (pinned.installed.length > 0 || pinned.refs.length > 0) && !pinnedDone;
  if (wantPinned) result.pinned = pinned.installed;

  const composeArgs = () => ({
    stack,
    localMatches,
    candidates: result.candidates,
    mode: config.mode,
    budgetChars: config.contextBudgetChars,
    loaded: result.loaded,
    pinned: result.pinned,
    notes,
  });
  state.partial = composeContext(composeArgs());

  if (wantPinned && pinned.refs.length > 0) {
    // Load the first pinned ref's text (cached forever by pinned sha); pin like /singular load does.
    const loadedPins = readLoadedPins(home);
    for (const parsed of pinned.refs) {
      const key = unpinnedRef(parsed);
      const prev = loadedPins[key] && typeof loadedPins[key] === 'object' ? loadedPins[key] : null;
      let sha = parsed.sha || (prev && /^[0-9a-f]{40}$/.test(String(prev.sha ?? '')) ? prev.sha : null);
      const source = `${parsed.owner}/${parsed.repo}`;
      if (!sha) sha = await resolvePin({ source, sha: null }, { remaining, ttlHours, cache, deps });
      if (!sha) {
        if (canPrefetch) spawnPrefetch(key, { env, deps, result });
        continue;
      }
      const pinnedRef = formatRef({ ...parsed, sha });
      let hit = null;
      try {
        hit = cache.get(textCacheKey(pinnedRef), 24 * 365 * 20);
      } catch {
        hit = null;
      }
      if (!hit || typeof hit.text !== 'string') {
        if (remaining() >= MIN_AUTO_FETCH_MS) {
          try {
            hit = await fetchSkillText({ ...parsed, sha }, { cliVersion: config.skillsCliVersion, timeoutMs: remaining() - 200, cache: true }, { ...deps, env });
          } catch (err) {
            log('warn', 'pinned fetch failed', { ref: pinnedRef, error: String(err?.message ?? err) });
            hit = null;
          }
        } else if (canPrefetch) spawnPrefetch(pinnedRef, { env, deps, result });
      }
      if (hit && typeof hit.text === 'string') {
        const cleanText = sanitizeSkillText(hit.text);
        result.loaded = { ref: pinnedRef, sha, text: cleanText.text, stripped: cleanText.stripped, reason: 'pinned in config.pinnedSkills' };
        break; // one loaded block per prompt
      }
    }
  }
  if (wantPinned && sessionKey && (result.pinned.length > 0 || result.loaded)) {
    try {
      cache.set(sessionKey, true);
    } catch {
      /* ignore */
    }
  }
  state.partial = composeContext(composeArgs());

  // --- remote phase (suggest/auto only, and only when nothing local is a strong match)
  const strong = localMatches.some(isStrongMatch);
  const wantRemote = (config.mode === 'suggest' || config.mode === 'auto') && !strong;
  if (wantRemote) {
    const left = remaining();
    if (left < MIN_REMOTE_MS) {
      result.discover = { skipped: `only ${Math.round(left)}ms left of ${budget}ms budget` };
    } else {
      const tRemote = timer();
      const d = await discover(clean, {
        config,
        stackTags: stack.tags,
        timeoutMs: left - 300,
        deps: { ...deps, env, cacheGet: deps.cacheGet, cacheSet: deps.cacheSet },
        installedNames: installedNamesOf(index),
      });
      timings.discoverMs = tRemote.elapsed();
      result.discover = {
        keywords: d.keywords,
        intent: d.intent,
        shared: d.shared,
        cached: d.cached,
        queries: d.queries,
        rejected: d.rejected.length,
        auditSkipped: d.auditSkipped,
        cooldownUntil: d.cooldownUntil,
        errors: d.errors,
      };
      result.candidates = pinFromCache(d.candidates, { ttlHours, cache });
      state.partial = composeContext(composeArgs());

      const top = result.candidates[0];
      if (config.mode === 'auto' && top && !result.loaded) {
        const warning = autoWarning(home, { persist: !dryRun });
        if (warning) result.systemMessage = warning;
        const tFetch = timer();
        const [owner, repo] = top.source.split('/');
        const sha = await resolvePin(top, { remaining, ttlHours, cache, deps });
        const pinnedRef = sha ? `${top.source}#${sha}@${top.skill}` : null;
        let hit = null;
        if (pinnedRef) {
          try {
            hit = cache.get(textCacheKey(pinnedRef), 24 * 365 * 20);
          } catch {
            hit = null;
          }
        }
        if (hit && typeof hit.text === 'string') {
          const cleanText = sanitizeSkillText(hit.text);
          result.loaded = { ref: pinnedRef, sha, text: cleanText.text, stripped: cleanText.stripped, cached: true };
          result.candidates = result.candidates.filter((c) => c !== top);
        } else {
          const leftAuto = remaining();
          if (!sha) {
            result.autoSkipped = `HEAD not resolved (only ${Math.round(leftAuto)}ms left); suggestion emitted instead`;
            if (canPrefetch) spawnPrefetch(`${top.source}@${top.skill}`, { env, deps, result });
          } else if (leftAuto < MIN_AUTO_FETCH_MS) {
            result.autoSkipped = `only ${Math.round(leftAuto)}ms left (< ${MIN_AUTO_FETCH_MS}ms for a cold fetch); suggestion emitted, ${canPrefetch ? 'text prefetched in the background' : 'text would be prefetched in the background (hook mode or --prefetch; not in this run)'}`;
            if (canPrefetch) spawnPrefetch(pinnedRef, { env, deps, result });
          } else {
            try {
              const fetched = await fetchSkillText({ owner, repo, sha, skill: top.skill }, { cliVersion: config.skillsCliVersion, timeoutMs: leftAuto - 200, cache: true }, { ...deps, env });
              const cleanText = sanitizeSkillText(fetched.text);
              result.loaded = { ref: fetched.ref, sha: fetched.sha, text: cleanText.text, stripped: cleanText.stripped, cached: fetched.cached === true };
              result.candidates = result.candidates.filter((c) => c !== top);
            } catch (err) {
              result.autoError = String(err?.message ?? err);
              log('warn', 'auto fetch failed', { ref: `${top.source}@${top.skill}`, error: result.autoError });
              if (canPrefetch) spawnPrefetch(pinnedRef, { env, deps, result });
            }
          }
        }
        timings.autoFetchMs = tFetch.elapsed();
      } else if (config.mode === 'suggest' && top && canPrefetch) {
        // Make /singular load (and a later auto prompt) instant: prefetch the top candidate once.
        const pinnedRef = top.sha ? `${top.source}#${top.sha}@${top.skill}` : null;
        let cached = false;
        if (pinnedRef) {
          try {
            cached = Boolean(cache.get(textCacheKey(pinnedRef), 24 * 365 * 20));
          } catch {
            cached = false;
          }
        }
        if (!cached) spawnPrefetch(pinnedRef ?? `${top.source}@${top.skill}`, { env, deps, result });
      }
      // Tell the user directly (systemMessage) about candidates that are only suggested, never loaded.
      if (result.candidates.length && (config.mode === 'suggest' || (config.mode === 'auto' && !result.loaded))) {
        const msg = suggestionMessage(result.candidates, { sessionId, cache });
        if (msg) result.systemMessage = result.systemMessage ? `${result.systemMessage}\n${msg}` : msg;
      }
    }
  }

  result.context = spillIfNeeded(composeContext(composeArgs()), home);
  state.partial = result.context;
  timings.totalMs = t.elapsed();
  return result;
}

function printVerbose(result) {
  const lines = [
    `${TAG} mode=${result.mode} skipped=${result.skipped ?? 'no'} index=${result.indexSize ?? 0}`,
    `${TAG} timings=${JSON.stringify(result.timings)}`,
    `${TAG} local=${result.localMatches.map((m) => `${m.name}:${m.score}${m.strong ? '*' : ''}`).join(', ') || 'none'}${result.weakMatches?.length ? `  weak(dropped)=${result.weakMatches.join(', ')}` : ''}`,
  ];
  if (result.pinned.length) lines.push(`${TAG} pinned=${result.pinned.join(', ')}`);
  if (result.discover) lines.push(`${TAG} discover=${JSON.stringify(result.discover)}`);
  if (result.candidates.length) lines.push(`${TAG} candidates=${result.candidates.map((c) => `${c.source}@${c.skill} (rank ${c.rank}, matched ${JSON.stringify(c.matched)})`).join(', ')}`);
  if (result.loaded) lines.push(`${TAG} loaded=${result.loaded.ref} (${result.loaded.text.length} chars, cached ${result.loaded.cached === true})`);
  if (result.prefetched) lines.push(`${TAG} prefetched=${result.prefetched.join(', ')}`);
  if (result.autoError) lines.push(`${TAG} autoError=${result.autoError}`);
  if (result.autoSkipped) lines.push(`${TAG} autoSkipped=${result.autoSkipped}`);
  if (result.hint) lines.push(`${TAG} hint=singular command list appended`);
  if (result.systemMessage) lines.push(`${TAG} systemMessage=${result.systemMessage.replace(/\n/g, ' | ')}`);
  for (const w of result.warnings) lines.push(`${TAG} config warning: ${w}`);
  process.stderr.write(`${lines.join('\n')}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('usage: on-prompt.js [--dry-run "<prompt>"] [--cwd <dir>] [--session <id>] [--json] [--verbose] [--prefetch]\n  (no args: read the UserPromptSubmit hook JSON from stdin)\n');
    return 0;
  }
  let prompt;
  let cwd = args.cwd;
  let sessionId = args.session;
  let promptId = null;
  let hookMode = !args.dryRun;
  if (args.dryRun) {
    prompt = args.prompt ?? readStdinSync();
  } else {
    const raw = readStdinSync();
    let input = {};
    try {
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      log('warn', 'on-prompt: stdin is not JSON', { error: err.message, head: raw.slice(0, 120) });
      return 0;
    }
    if (input.hook_event_name && input.hook_event_name !== 'UserPromptSubmit') {
      log('debug', 'on-prompt: ignoring event', { event: input.hook_event_name });
      return 0;
    }
    prompt = typeof input.prompt === 'string' ? input.prompt : '';
    cwd = cwd ?? (typeof input.cwd === 'string' && input.cwd ? input.cwd : null);
    sessionId = sessionId ?? (typeof input.session_id === 'string' && input.session_id ? input.session_id : null);
    promptId = typeof input.prompt_id === 'string' && input.prompt_id ? input.prompt_id : null;
    hookMode = true;
  }

  // The environment is untrusted (a repository's .claude/settings.json `env` reaches this process).
  const dir = path.resolve(cwd || process.cwd());
  const hardened = hardenEnv(process.env, { cwd: dir });
  for (const k of Object.keys(process.env)) if (!(k in hardened.env)) delete process.env[k];
  for (const [k, v] of Object.entries(hardened.env)) process.env[k] = v;
  for (const w of hardened.warnings) log('warn', /TEST SEAM/.test(w) ? 'on-prompt: test seam active' : 'on-prompt: environment override ignored', { warning: w });

  const config = loadConfig(process.env);
  for (const w of config.warnings ?? []) log('warn', 'on-prompt: config warning', { warning: w });
  const state = { partial: '' };
  const budget = Math.max(500, Number(config.totalBudgetMs) || 6000);
  let flushed = false;
  const flush = (ctx, why, extra) => {
    if (flushed) return;
    flushed = true;
    if (ctx || extra?.systemMessage) process.stdout.write(hookMode ? hookOutput('UserPromptSubmit', ctx, extra) : `${ctx}\n`);
    if (why) log('warn', 'on-prompt: watchdog fired', { why, chars: ctx.length });
  };
  const watchdog = setTimeout(() => {
    flush(state.partial || '', `deadline ${budget}ms + grace exceeded`);
    process.exit(0);
  }, budget + 600);

  try {
    const result = await runOnPrompt({ prompt, cwd, sessionId, env: process.env, state, config, prefetch: hookMode || args.prefetch, dryRun: args.dryRun });
    clearTimeout(watchdog);
    if (args.verbose) printVerbose(result);
    const debug = process.env.SINGULAR_DEBUG === '1';
    log('info', 'on-prompt', {
      sessionId,
      promptId,
      mode: result.mode,
      skipped: result.skipped,
      hint: result.hint,
      promptChars: normalizePrompt(prompt).length,
      local: result.localMatches.map((m) => `${m.name}:${m.score}${m.strong ? '*' : ''}`),
      candidates: result.candidates.map((c) => `${c.source}@${c.skill}`),
      loaded: result.loaded?.ref ?? null,
      pinned: result.pinned,
      prefetched: result.prefetched ?? [],
      discover: result.discover
        ? { keywordCount: result.discover.keywords?.length ?? 0, shared: result.discover.shared ?? [], ...(debug ? { keywords: result.discover.keywords, intent: result.discover.intent } : {}), cached: result.discover.cached, cooldownUntil: result.discover.cooldownUntil ?? null, errors: result.discover.errors, skipped: result.discover.skipped }
        : null,
      autoSkipped: result.autoSkipped ?? null,
      timings: result.timings,
      chars: result.context.length,
    });
    // In hook mode the JSON on stdout carries systemMessage; echoing it to stderr too only pollutes the
    // hook_response `output` Claude Code records (stderr + stdout concatenated). Humans get it in --dry-run.
    if (result.systemMessage && args.dryRun) process.stderr.write(`${result.systemMessage}\n`);
    if (args.dryRun && args.json) {
      const { localMatches, ...rest } = result;
      process.stdout.write(`${JSON.stringify({ ...rest, localMatches: localMatches.map(({ skill, ...m }) => m) }, null, 2)}\n`);
      flushed = true;
    } else if (args.dryRun) {
      flushed = true;
      process.stdout.write(result.context ? `${result.context}\n` : `${TAG} (no context: ${result.skipped ?? 'nothing relevant found'})\n`);
    } else if (result.context || result.systemMessage) {
      flush(result.context, null, { systemMessage: result.systemMessage });
    }
    return 0;
  } catch (err) {
    clearTimeout(watchdog);
    log('error', 'on-prompt failed', { error: String(err?.stack ?? err?.message ?? err) });
    if (args.dryRun) process.stderr.write(`${TAG} error: ${String(err?.message ?? err)}\n`);
    return 0;
  }
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
      log('error', 'on-prompt crashed', { error: String(err?.stack ?? err) });
      process.exit(0);
    },
  );
}
