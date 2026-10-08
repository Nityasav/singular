#!/usr/bin/env node
// bin/on-expand.js — UserPromptExpansion hook for /scout-load, plus a direct CLI mode and a prefetch mode.
//
// Hook mode (stdin JSON from Claude Code; matcher "skill-scout:scout-load"):
//   command_name  "skill-scout:scout-load" (plugin-prefixed) or bare "scout-load"
//   command_args  "<owner/repo@skill | owner/repo#<40-hex>@skill> [--update]"
//   -> stdout {"hookSpecificOutput":{"hookEventName":"UserPromptExpansion","additionalContext":"..."}}  exit 0
//   -> stderr "<reason>" exit 2  (blocks the expansion: no model call, nothing loaded)
//
// CLI mode (the documented fallback when the expansion hook is unavailable):
//   node bin/on-expand.js <ref> [--update] [--json]    prints the sanitized SKILL.md text
//
// Prefetch mode (spawned detached by on-prompt.js; nothing printed, exit 0):
//   node bin/on-expand.js <ref> --prefetch             resolves HEAD (cached under head:<owner/repo>) and
//                                                       caches the raw text under text:<pinned ref>; no pin recorded
//
// First load of an unpinned ref resolves HEAD and pins it in $SKILL_SCOUT_HOME/loaded.json;
// later loads reuse that sha unless --update is given. Text only: nothing is written to
// ~/.claude/skills. Third-party SKILL.md contents are data, never instructions to this program.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { cacheSet } from '../lib/cache.js';
import { hardenEnv, homeDir, isAllowlisted, loadConfig } from '../lib/config.js';
import { fitLoadedText, hookOutput, spillIfNeeded, TAG } from '../lib/context.js';
import { log, timer } from '../lib/log.js';
import { repoUrl } from '../lib/git.js';
import { fetchSkillText, sanitizeSkillText } from '../lib/registry.js';
import { formatRef, normalizeRefCase, parseRef, REF_RE, resolveHeadSha, unpinnedRef } from '../lib/refs.js';

export const COMMAND = 'scout-load';
export const FETCH_TIMEOUT_MS = 20000; // hooks.json gives the hook 25 s
export const PREFETCH_TIMEOUT_MS = 60000;
const KNOWN_FLAGS = new Set(['--update', '--json', '--prefetch']);

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function loadedPath(env = process.env) {
  return path.join(homeDir(env), 'loaded.json');
}

export function readLoaded(env = process.env) {
  try {
    const v = JSON.parse(fs.readFileSync(loadedPath(env), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function writeLoaded(map, env = process.env) {
  try {
    const file = loadedPath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** "<ref> [--update]" -> {ref, update, json, prefetch} | {error} */
export function parseCommandArgs(raw) {
  const tokens = String(raw ?? '').trim().split(/\s+/).filter(Boolean);
  const flags = tokens.filter((t) => t.startsWith('-'));
  const positional = tokens.filter((t) => !t.startsWith('-'));
  for (const f of flags) if (!KNOWN_FLAGS.has(f)) return { error: `unknown option ${f}` };
  if (positional.length === 0) return { error: 'missing skill reference' };
  if (positional.length > 1) return { error: `expected exactly one skill reference, got ${positional.length}` };
  return { ref: positional[0], update: flags.includes('--update'), json: flags.includes('--json'), prefetch: flags.includes('--prefetch') };
}

function isBlockedRef(parsed, blockedRefs) {
  const src = `${parsed.owner}/${parsed.repo}`.toLowerCase();
  const full = `${src}@${parsed.skill.toLowerCase()}`;
  for (const raw of Array.isArray(blockedRefs) ? blockedRefs : []) {
    const e = String(raw).trim().toLowerCase().replace(/#[0-9a-f]{40}(?=@)/, '');
    if (!e) continue;
    if (e === full || e === src || e === parsed.owner.toLowerCase()) return true;
  }
  return false;
}

/**
 * Validate, pin, fetch and sanitize. Never throws.
 * @returns {Promise<{status:'ok', ref, sha, pinSource, text, stripped, context, cached, elapsedMs} | {status:'block', reason}>}
 */
export async function runOnExpand({ commandArgs, env: rawEnv = process.env, deps = {}, config: cfgOverride, timeoutMs = FETCH_TIMEOUT_MS, prefetch = false } = {}) {
  const t = timer();
  const hardened = hardenEnv(rawEnv, { cwd: rawEnv.PWD || process.cwd() });
  const env = hardened.env;
  for (const w of hardened.warnings) log('warn', /TEST SEAM/.test(w) ? 'on-expand: test seam active' : 'on-expand: environment override ignored', { warning: w });
  const config = cfgOverride ?? loadConfig(env);
  const usage = 'usage: /scout-load owner/repo@skill  or  /scout-load owner/repo#<40-hex-sha>@skill  [--update]';
  const args = parseCommandArgs(commandArgs);
  if (args.error) return { status: 'block', reason: `${TAG} ${args.error}. ${usage}` };
  if (!REF_RE.test(args.ref)) {
    return { status: 'block', reason: `${TAG} invalid skill reference "${args.ref.slice(0, 80)}". ${usage}` };
  }
  // Owner/repo are case-insensitive on GitHub: `MULTICA-AI/x@s` and `multica-ai/x@s` must share one pin
  // (loaded.json), one head: cache entry and one text: cache entry. The skill segment stays as typed.
  const parsed = normalizeRefCase(parseRef(args.ref));
  if (!parsed) return { status: 'block', reason: `${TAG} invalid skill reference "${args.ref.slice(0, 80)}". ${usage}` };
  const source = `${parsed.owner}/${parsed.repo}`;
  if (!isAllowlisted(source, config.allowlist)) {
    return {
      status: 'block',
      reason: `${TAG} refused: owner "${parsed.owner}" is not in the allowlist [${config.allowlist.join(', ')}]. Add "${parsed.owner}" (or "${source}") to "allowlist" in ${config.path ?? path.join(homeDir(env), 'config.json')} if you trust that source, then retry.`,
    };
  }
  if (isBlockedRef(parsed, config.blockedRefs)) {
    return { status: 'block', reason: `${TAG} refused: ${unpinnedRef(parsed)} matches "blockedRefs" in your config.` };
  }

  const isPrefetch = prefetch || args.prefetch;
  const key = unpinnedRef(parsed);
  const loaded = readLoaded(env);
  const prev = loaded[key] && typeof loaded[key] === 'object' ? loaded[key] : null;
  let sha = parsed.sha;
  let pinSource = 'arg';
  if (!sha && prev && /^[0-9a-f]{40}$/.test(String(prev.sha ?? '')) && !args.update) {
    sha = prev.sha;
    pinSource = 'loaded.json';
  }
  if (!sha) {
    try {
      sha = await resolveHeadSha(parsed.owner, parsed.repo, { timeoutMs: Math.min(8000, timeoutMs) }, deps);
      pinSource = args.update ? 'resolved (--update)' : 'resolved';
      if (deps.cacheSet) deps.cacheSet(`head:${source}`, sha);
      else cacheSet(`head:${source}`, sha, env);
    } catch (err) {
      return { status: 'block', reason: `${TAG} could not resolve HEAD of ${repoUrl(parsed.owner, parsed.repo, env)}: ${String(err?.message ?? err)}` };
    }
  }
  const pinned = { owner: parsed.owner, repo: parsed.repo, sha, skill: parsed.skill };
  const pinnedRef = formatRef(pinned);

  let fetched;
  try {
    fetched = await fetchSkillText(pinned, { cliVersion: config.skillsCliVersion, timeoutMs, cache: true }, { ...deps, env });
  } catch (err) {
    return { status: 'block', reason: `${TAG} could not fetch ${pinnedRef}: ${String(err?.message ?? err)}` };
  }
  const clean = sanitizeSkillText(fetched.text);
  if (!clean.text.trim()) return { status: 'block', reason: `${TAG} ${pinnedRef} has no usable text after sanitizing (stripped: ${clean.stripped.join('; ') || 'nothing'})` };

  if (isPrefetch) {
    return { status: 'ok', ref: pinnedRef, sha, pinSource, text: clean.text, stripped: clean.stripped, context: '', cached: fetched.cached === true, prefetch: true, elapsedMs: t.elapsed() };
  }

  loaded[key] = {
    ref: pinnedRef,
    sha,
    ts: prev?.ts ?? Date.now(),
    lastTs: Date.now(),
    loads: (Number(prev?.loads) || 0) + 1,
    chars: clean.text.length,
    stripped: clean.stripped,
  };
  writeLoaded(loaded, env);

  const header = (strippedList) => `${TAG} The user explicitly loaded third-party skill ${pinnedRef} via /scout-load (pinned ${pinSource}; text only, nothing installed). Contents (sanitized; stripped: ${strippedList.length ? strippedList.join('; ') : 'nothing'}):`;
  const wrap = (body, strippedList) => `${header(strippedList)}\n<skill-scout-loaded ref="${pinnedRef}">\n${body}\n</skill-scout-loaded>`;
  let strippedList = [...clean.stripped];
  let body = clean.text;
  const probe = wrap('', [...strippedList, 'truncated 99999 chars to fit the 9,500-char hook budget']);
  const fitted = fitLoadedText(body, probe.length);
  if (fitted.truncated > 0) {
    strippedList = [...strippedList, `truncated ${fitted.truncated} chars to fit the 9,500-char hook budget`];
    body = fitted.text;
  }
  const context = spillIfNeeded(wrap(body, strippedList), homeDir(env));
  return { status: 'ok', ref: pinnedRef, sha, pinSource, text: clean.text, stripped: clean.stripped, context, cached: fetched.cached === true, elapsedMs: t.elapsed() };
}

export async function main(argv = process.argv.slice(2)) {
  const positional = argv.filter((a) => !a.startsWith('-'));
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: on-expand.js <owner/repo[#sha]@skill> [--update] [--json] [--prefetch]\n  (no args: read the UserPromptExpansion hook JSON from stdin)\n');
    return 0;
  }
  const cliMode = positional.length > 0;
  const prefetch = cliMode && argv.includes('--prefetch');
  let commandArgs;
  if (cliMode) {
    commandArgs = argv.filter((a) => a !== '--json' && a !== '--prefetch').join(' ');
  } else {
    const raw = readStdinSync();
    let input = {};
    try {
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      log('warn', 'on-expand: stdin is not JSON', { error: err.message });
      return 0;
    }
    const name = String(input.command_name ?? '');
    const bare = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
    if (bare !== COMMAND) {
      log('debug', 'on-expand: ignoring command', { command_name: name });
      return 0;
    }
    commandArgs = typeof input.command_args === 'string' ? input.command_args : '';
  }

  const result = await runOnExpand({ commandArgs, env: process.env, prefetch, timeoutMs: prefetch ? PREFETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS });
  if (result.status === 'block') {
    log('warn', prefetch ? 'on-expand: prefetch blocked' : 'on-expand: blocked', { args: String(commandArgs).slice(0, 200), reason: result.reason });
    if (prefetch) return 0;
    process.stderr.write(`${result.reason}\n`);
    return cliMode ? 1 : 2;
  }
  log('info', prefetch ? 'on-expand: prefetched' : 'on-expand: loaded', { ref: result.ref, pinSource: result.pinSource, chars: result.text.length, cached: result.cached, stripped: result.stripped, ms: Math.round(result.elapsedMs) });
  if (prefetch) return 0;
  if (cliMode) {
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ ref: result.ref, sha: result.sha, pinSource: result.pinSource, stripped: result.stripped, text: result.text }, null, 2)}\n`);
    } else {
      process.stdout.write(`${TAG} loaded ${result.ref} (pinned ${result.pinSource}; stripped: ${result.stripped.join('; ') || 'nothing'})\n\n${result.text}\n`);
    }
  } else {
    process.stdout.write(hookOutput('UserPromptExpansion', result.context));
  }
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
      log('error', 'on-expand crashed', { error: String(err?.stack ?? err) });
      process.stderr.write(`${TAG} internal error: ${String(err?.message ?? err)}\n`);
      process.exit(2);
    },
  );
}
