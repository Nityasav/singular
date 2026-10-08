// test/e2e/lib/claude.mjs — run `claude -p` with skill-scout loaded for that session only (the recipe from
// test/e2e/README.md) and return the parsed stream.
//
//   const r = await runClaude(prompt, { root, cwd, home, model, allowedTools, permissionMode, resume, continueSession,
//                                       stdin, extraEnv, persist, maxBudgetUsd, timeoutMs, outFile })
//   r = { ...parseStream(stdout), wallMs, exitCode, stderr, args, outFile }
//
// Flags, always: --output-format stream-json --verbose --include-hook-events --model <m> --max-budget-usd <b>
//                --setting-sources project --strict-mcp-config --plugin-dir <root>, and --no-session-persistence
//                unless `persist` is true (multi-turn cases); stdin is /dev/null unless `stdin` is a string.
// Env: the caller's env plus SKILL_SCOUT_HOME=<home> (an absolute dir outside cwd: refused otherwise, because the
//      hook would then fall back to the real ~/.claude/skill-scout) and extraEnv (SKILL_SCOUT_MODE, the test seams).
// "Not logged in" anywhere in the output throws SkipError; so does a rejected rate limit (`rate_limit_event`, result
// "You've hit your session limit"), with the reset time in the message.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { SkipError } from './errors.mjs';
import { parseStream } from './stream.mjs';
import { isInside } from './world.mjs';

export const NOT_LOGGED_IN_RE = /Not logged in|Please run \/login|Invalid API key|authentication_error/i;
export const SESSION_LIMIT_RE = /hit your session limit|rate limit|usage limit/i;

export async function runClaude(prompt, opts = {}) {
  const {
    root,
    cwd,
    home,
    model = 'haiku',
    allowedTools,
    permissionMode,
    resume,
    continueSession = false,
    stdin,
    extraEnv = {},
    persist = false,
    maxBudgetUsd = 0.5,
    timeoutMs = 240000,
    outFile,
    extraArgs = [],
    retryOnStall = true,
  } = opts;
  if (!root || !fs.existsSync(path.join(root, '.claude-plugin', 'plugin.json'))) throw new Error(`runClaude: root ${root} is not a plugin directory`);
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`runClaude: cwd ${cwd} does not exist`);
  if (!home || !path.isAbsolute(home)) throw new Error(`runClaude: home must be an absolute path (got ${home})`);
  if (isInside(home, cwd)) throw new Error(`runClaude: SKILL_SCOUT_HOME ${home} is inside cwd ${cwd}; refusing (the hook would use the real ~/.claude/skill-scout)`);
  for (const [k, v] of Object.entries(extraEnv)) {
    if (k === 'SKILL_SCOUT_HOME' && v !== home) throw new Error('runClaude: extraEnv must not override SKILL_SCOUT_HOME');
    if (k === 'HOME') throw new Error('runClaude: HOME must not be overridden for a live claude run (it breaks the login)');
  }

  const args = ['-p'];
  if (prompt != null) args.push(String(prompt));
  args.push('--output-format', 'stream-json', '--verbose', '--include-hook-events', '--model', model, '--max-budget-usd', String(maxBudgetUsd), '--setting-sources', 'project', '--strict-mcp-config', '--plugin-dir', root);
  if (!persist) args.push('--no-session-persistence');
  if (allowedTools) args.push('--allowedTools', Array.isArray(allowedTools) ? allowedTools.join(',') : String(allowedTools));
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (resume) args.push('--resume', resume);
  if (continueSession) args.push('--continue');
  args.push(...extraArgs);

  const env = { ...process.env, SKILL_SCOUT_HOME: home, ...extraEnv };
  const started = Date.now();
  // detached: claude is its own process group, so a timeout kills the whole tree (hooks, npx, git) and not just the CLI.
  const child = spawn('claude', args, { cwd, env, stdio: [typeof stdin === 'string' ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  const out = [];
  const err = [];
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', (d) => err.push(d));
  if (typeof stdin === 'string') {
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, timeoutMs);
  const exitCode = await new Promise((resolve) => {
    child.on('error', (e) => {
      err.push(Buffer.from(`spawn error: ${e.message}\n`));
      resolve(-1);
    });
    // Resolve on 'exit', not 'close': after a SIGKILL the stdio pipes can stay open for minutes if a
    // grandchild (hook, npx) inherited them. A short grace period lets buffered output drain.
    let settled = false;
    const finish = (code) => { if (!settled) { settled = true; setTimeout(() => resolve(code), 300); } };
    child.on('exit', (code) => finish(code));
    child.on('close', (code) => finish(code));
  });
  clearTimeout(timer);
  const wallMs = Date.now() - started;
  const stdout = Buffer.concat(out).toString('utf8');
  const stderr = Buffer.concat(err).toString('utf8');
  if (outFile) {
    try {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, stdout);
      fs.writeFileSync(`${outFile.replace(/\.jsonl$/, '')}.err`, stderr);
      fs.writeFileSync(`${outFile.replace(/\.jsonl$/, '')}.cmd`, `cwd: ${cwd}\nenv: ${Object.entries({ SKILL_SCOUT_HOME: home, ...extraEnv }).map(([k, v]) => `${k}=${v}`).join(' ')}\nclaude ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
    } catch {
      /* artifacts are best effort */
    }
  }
  const parsed = parseStream(stdout);
  if (NOT_LOGGED_IN_RE.test(stdout) || NOT_LOGGED_IN_RE.test(stderr) || NOT_LOGGED_IN_RE.test(parsed.result)) {
    throw new SkipError(`claude is not logged in (run \`claude\` once and /login): ${(stderr || parsed.result).trim().slice(0, 160)}`);
  }
  if (exitCode === -1 && /ENOENT/.test(stderr)) throw new SkipError('claude is not on PATH');
  // A rejected rate limit (the account's session window, `rate_limit_event` status "rejected" with the result
  // "You've hit your session limit") makes no model call: the hook still ran, but nothing about the model can be
  // asserted, so the case is SKIPped with the reset time instead of failing or, worse, passing on hook-only checks.
  if (parsed.rateLimited && (parsed.isError || SESSION_LIMIT_RE.test(parsed.result))) {
    const resetsAt = parsed.rateLimitResetsAt ? new Date(parsed.rateLimitResetsAt * 1000).toISOString() : 'unknown';
    throw new SkipError(`claude is rate-limited (${parsed.result.trim().slice(0, 80) || 'rate_limit_event rejected'}; resets at ${resetsAt})`);
  }
  // A stalled CLI (killed at timeoutMs with no result event and no cost) is a transient API/CLI condition,
  // not a plugin failure: retry once so a flaky stall does not fail a case. Logged in stderr for the artifacts.
  if (timedOut && retryOnStall && !parsed.result && !(parsed.costUsd > 0)) {
    const second = await runClaude(prompt, { ...opts, retryOnStall: false, outFile: outFile ? outFile.replace(/\.jsonl$/, '') + '.retry.jsonl' : undefined });
    return { ...second, retried: true, firstAttempt: { wallMs, exitCode, timedOut, stderrTail: stderr.slice(-400) }, stderr: `[runClaude] first attempt stalled after ${wallMs} ms (no result event, $0); retried once\n` + second.stderr };
  }
  return { ...parsed, wallMs, exitCode, timedOut, stderr, args, outFile: outFile ?? null, retried: false };
}

/** Convenience: the single UserPromptSubmit hook record (or null) and its context. */
export function promptHook(r) {
  const hs = r.hooks('UserPromptSubmit');
  return hs.length ? hs[hs.length - 1] : null;
}

export function promptContext(r) {
  const h = promptHook(r);
  return h ? h.context : '';
}
