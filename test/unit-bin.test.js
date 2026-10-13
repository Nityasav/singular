// test/unit-bin.test.js — node --test test/unit-bin.test.js
//
// Every bin/*.js entrypoint (on-prompt, on-expand, on-subagent and the `singular.js` dispatcher with each of its
// subcommands) exercised as a CHILD PROCESS with HOME and SINGULAR_HOME pointed at scratch directories and the
// test seams (docs/testing.md) pointed at:
//   - a tiny loopback skills.sh mock started here with node:http (SINGULAR_REGISTRY_BASE), with
//     switchable delay / HTTP status / empty mode and a request log, and
//   - local bare git repositories built from test/fixtures/skill-folders/clean and /malicious
//     (SINGULAR_GIT_BASE), so /singular load, auto mode, the prefetch and /singular add drive REAL git.
// No request ever leaves the machine; nothing under the real ~/.claude is read or written.
// A few in-process calls (runOnPrompt / runAdd with injected deps) cover branches a subprocess
// cannot reach (spawn failure, a throwing cache, a post-copy rejection, a credential prompt).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(HERE, 'fixtures');
const SCRATCH_ROOT = process.env.SINGULAR_TEST_TMP
  || '/private/tmp/claude-501/-Users-nitya--superset-projects-claude-skills/cfa575e5-ae3c-4522-b59f-cd3623c88bf0/scratchpad';

function mkTmp(label) {
  let base = SCRATCH_ROOT;
  try { fs.mkdirSync(base, { recursive: true }); } catch { base = os.tmpdir(); }
  return fs.mkdtempSync(path.join(base, `unit-bin-${label}-`));
}

const AGENT = mkTmp('world');
// lib/log.js reads process.env at call time: keep in-process logging out of the real ~/.claude.
process.env.SINGULAR_HOME = path.join(AGENT, 'process-state', 'singular-home');
process.env.HOME = path.join(AGENT, 'process-state', 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

// The load command as bin/on-prompt.js and lib/context.js spell it in routing lines and the systemMessage.
const LOAD_CMD = 'singular load';

const { DEFAULTS } = await import('../lib/config.js');
const { cacheFile, cacheSet } = await import('../lib/cache.js');
const { COOLDOWN_KEY } = await import('../lib/registry.js');

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const CLEAN = path.join(FIXTURES, 'skill-folders', 'clean');
const MALICIOUS = path.join(FIXTURES, 'skill-folders', 'malicious');
const SUBMIT_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'hook-stdin-userpromptsubmit.json'), 'utf8'));
const EXPAND_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'hook-stdin-userpromptexpansion.json'), 'utf8'));
const TASK_FIXTURE = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'hook-stdin-task-notification.json'), 'utf8'));
const PROMPT = SUBMIT_FIXTURE.prompt; // "Add a Playwright e2e test for the checkout flow in this Next.js app and run it"

// ---------------------------------------------------------------------------
// world: project cwd, homes, the registry mock, the git base
// ---------------------------------------------------------------------------

const PROJ = path.join(AGENT, 'proj');
fs.cpSync(path.join(FIXTURES, 'projects', 'next-tailwind-ts'), PROJ, { recursive: true });
fs.mkdirSync(path.join(PROJ, '.git'), { recursive: true });
fs.writeFileSync(path.join(PROJ, '.git', 'HEAD'), 'ref: refs/heads/main\n');
const EMPTY_HOME = path.join(AGENT, 'empty-home');
fs.mkdirSync(EMPTY_HOME, { recursive: true });
const SKILLS_HOME = path.join(AGENT, 'skills-home');
function write(file, content, opts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, opts);
}
const skillMd = (name, description, body = `# ${name}\n`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
write(path.join(SKILLS_HOME, '.claude', 'skills', 'frontend-design', 'SKILL.md'), skillMd('frontend-design', 'Distinctive visual design for landing pages and UI with Tailwind or CSS.'));
write(path.join(SKILLS_HOME, '.claude', 'skills', 'playwright', 'SKILL.md'), skillMd('playwright', 'Write, debug and stabilize Playwright end-to-end tests; fix flaky e2e tests.'));
write(path.join(SKILLS_HOME, '.claude', 'skills', 'pdf', 'SKILL.md'), skillMd('pdf', 'Read, merge and fill PDF forms.'));
const MANY_HOME = path.join(AGENT, 'many-home');
for (let i = 0; i < 160; i++) {
  write(path.join(MANY_HOME, '.claude', 'skills', `synthetic-skill-${i}`, 'SKILL.md'), skillMd(`synthetic-skill-${i}`, `Synthetic skill number ${i} about topic${i % 7} and area${i % 11} for routing load tests.`));
}

let homeN = 0;
/** A fresh SINGULAR_HOME, optionally with a config.json. */
function freshHome(label, config) {
  const dir = path.join(AGENT, 'homes', `${label}-${++homeN}`);
  fs.mkdirSync(dir, { recursive: true });
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return dir;
}

// --- registry mock -----------------------------------------------------------
const CATALOG = [
  { source: 'anthropics/skills', skillId: 'playwright-e2e', name: 'playwright-e2e', installs: 50000 },
  { source: 'anthropics/skills', skillId: 'webapp-testing', name: 'webapp-testing', installs: 172000 },
  { source: 'anthropics/skills', skillId: 'frontend-design', name: 'frontend-design', installs: 960000 },
  { source: 'anthropics/skills', skillId: 'pdf', name: 'pdf', installs: 300000 },
  { source: 'vercel-labs/agent-skills', skillId: 'vercel-react-best-practices', name: 'vercel-react-best-practices', installs: 740986 },
  { source: 'vercel-labs/agent-skills', skillId: 'nextjs', name: 'nextjs', installs: 120000 },
  { source: 'supabase/agent-skills', skillId: 'supabase', name: 'supabase', installs: 314000 },
  { source: 'supabase/agent-skills', skillId: 'supabase-auth', name: 'supabase-auth', installs: 90000 },
  { source: 'evil-local/repo', skillId: 'playwright-e2e', name: 'playwright-e2e', installs: 20000 },
  { source: 'evil-local/repo', skillId: 'helpful-setup', name: 'helpful-setup', installs: 5000 },
  { source: 'ghost-owner/none', skillId: 'playwright-e2e', name: 'playwright-e2e', installs: 30000 },
  { source: 'long-owner/repo', skillId: 'long-playwright-guide', name: 'long-playwright-guide', installs: 40000 },
  { source: 'lowinstalls/x', skillId: 'playwright-tiny', name: 'playwright-tiny', installs: 12 },
];
const registry = { requests: [], delayMs: 0, status: null, empty: false, base: '', server: null };
function registryHandler(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const q = u.searchParams.get('q');
  const owner = u.searchParams.get('owner');
  registry.requests.push({ path: u.pathname, q, owner, limit: u.searchParams.get('limit'), ua: req.headers['user-agent'] });
  res.on('error', () => {});
  const respond = () => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (registry.status) return json(registry.status, { error: registry.status === 429 ? 'rate_limit_exceeded' : 'boom' });
    if (u.pathname === '/api/search') {
      if (registry.empty) return json(200, { skills: [] });
      const tokens = String(q ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      let list = CATALOG.filter((e) => !owner || e.source.split('/')[0] === owner.toLowerCase());
      if (q !== 'skill') list = list.filter((e) => tokens.some((t) => e.name.includes(t) || e.source.split('/')[0].split('-').includes(t)));
      return json(200, { query: q, skills: list });
    }
    const m = /^\/api\/v1\/skills\/audit\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const [, o, , s] = m.map((x) => decodeURIComponent(x));
      if (o === 'microsoft') return json(404, { error: 'not found' });
      if (s === 'helpful-setup') return json(200, { audits: [{ provider: 'Snyk', status: 'fail', riskLevel: 'CRITICAL', summary: 'trojan' }] });
      return json(200, { audits: [{ provider: 'Socket', status: 'pass' }, { provider: 'Snyk', status: 'pass', riskLevel: 'LOW' }] });
    }
    return json(404, { error: 'no such route' });
  };
  if (registry.delayMs > 0) setTimeout(respond, registry.delayMs);
  else respond();
}
await new Promise((resolve, reject) => {
  registry.server = http.createServer(registryHandler);
  registry.server.on('error', reject);
  registry.server.listen(0, '127.0.0.1', () => {
    registry.base = `http://127.0.0.1:${registry.server.address().port}`;
    resolve();
  });
});
const seenRequests = () => registry.requests.length;

// --- git base ----------------------------------------------------------------
const GIT_BASE = path.join(AGENT, 'git');
let HEAD_SHA = null;
const LONG_BODY = Array.from({ length: 200 }, (_, i) => `Line ${String(i).padStart(3, '0')}: guidance text that keeps going on and on about tests. `).join('\n'); // > 10,400 chars
if (HAS_GIT) {
  const src = path.join(AGENT, 'gitsrc');
  fs.cpSync(CLEAN, path.join(src, 'playwright-e2e'), { recursive: true });
  write(path.join(src, 'karpathy-guidelines', 'SKILL.md'), skillMd('karpathy-guidelines', 'Behavioral guidelines to reduce common LLM coding mistakes.', '# Karpathy Guidelines\n\n## 1. Think Before Coding\n\nSurface assumptions.\n'));
  fs.cpSync(MALICIOUS, path.join(src, 'helpful-setup'), { recursive: true });
  fs.chmodSync(path.join(src, 'helpful-setup', 'bin', 'pwn'), 0o755);
  fs.symlinkSync('../../etc/passwd', path.join(src, 'helpful-setup', 'link'));
  write(path.join(src, 'long-playwright-guide', 'SKILL.md'), `---\nname: long-playwright-guide\ndescription: A very long playwright guide.\nallowed-tools: Bash(*)\nhooks:\n  SessionStart: []\nmodel: opus\n---\n\n# Long guide\n\n${LONG_BODY}\n`);
  const g = (args, cwd = src) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g(['init', '-q', '-b', 'main']);
  g(['add', '-A']);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture']);
  HEAD_SHA = g(['rev-parse', 'HEAD']);
  for (const repo of ['evil-local/repo', 'anthropics/skills', 'multica-ai/andrej-karpathy-skills', 'long-owner/repo']) {
    fs.mkdirSync(path.join(GIT_BASE, path.dirname(repo)), { recursive: true });
    g(['clone', '-q', '--bare', src, path.join(GIT_BASE, repo)]);
  }
}
const GIT_SEAM = `file://${GIT_BASE}`;

after(() => {
  registry.server?.close();
  try { fs.rmSync(AGENT, { recursive: true, force: true }); } catch { /* ignore */ }
});

// --- helpers -----------------------------------------------------------------
/** env for a child: scratch HOME, a scratch state dir, both seams; nothing from the real shell but PATH. */
function baseEnv(home, extra = {}) {
  return { HOME: EMPTY_HOME, SINGULAR_HOME: home, SINGULAR_REGISTRY_BASE: registry.base, SINGULAR_GIT_BASE: GIT_SEAM, ...extra };
}
function runBin(script, args, { env = {}, input, cwd = PROJ, timeout = 60000 } = {}) {
  // Asynchronous on purpose: a synchronous spawn would block this process's event loop and the loopback
  // registry mock (which lives in this process) could never answer the child.
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', script), ...args], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, ms: performance.now() - t0 }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
const submitInput = (overrides = {}) => JSON.stringify({ ...SUBMIT_FIXTURE, cwd: PROJ, ...overrides });
/** The captured /singular expansion stdin with its command_args replaced verbatim (`load <ref>`, `status`, ...). */
const expandRaw = (commandArgs, overrides = {}) => JSON.stringify({ ...EXPAND_FIXTURE, cwd: PROJ, command_args: commandArgs, ...overrides });
/** The same, for `/singular load <loadArgs>`: the ref (and its flags) after the `load` subcommand. */
const expandInput = (loadArgs, overrides = {}) => expandRaw(`load ${loadArgs}`, overrides);
function readLog(home, msg) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(home, 'singular.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { lines = []; }
  return msg ? lines.filter((l) => l.msg === msg) : lines;
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
/** In-process calls log through lib/log.js, which resolves the state dir from process.env, not from the env they were handed. */
const processLog = (msg) => readLog(process.env.SINGULAR_HOME, msg);
const textKey = (ref) => `text:${ref}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 10000, every = 100 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(every);
  }
  return fn();
}
/** Capture process.stdout/stderr writes while `fn` runs (in-process main() calls must not pollute the TAP stream). */
async function capture(fn) {
  const out = [];
  const err = [];
  const o = process.stdout.write;
  const e = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  try {
    const value = await fn();
    return { value, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

// ---------------------------------------------------------------------------

describe('bin/on-prompt.js (UserPromptSubmit) as a child process', () => {
  test('hook stdin (captured fixture) in suggest mode on an empty HOME: stack + gated candidates from the loopback registry, systemMessage, log line with sessionId/promptId; only tech words leave the machine', async () => {
    const home = freshHome('suggest', { mode: 'suggest', prefetch: false });
    const before = seenRequests();
    const r = await runBin('on-prompt.js', [], { env: baseEnv(home), input: submitInput() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '', 'hook mode never echoes the systemMessage to stderr');
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ['hookSpecificOutput', 'systemMessage']);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /^\[singular\] Stack: Next\.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm; branch main\n/);
    assert.doesNotMatch(ctx, /Installed skills likely relevant/, 'empty HOME: nothing installed');
    assert.match(ctx, new RegExp(`\\nIf one of the third-party candidates below fits the request, end your reply with exactly one line \`Load with /${LOAD_CMD} <ref>\``));
    assert.match(ctx, new RegExp(`\\nThird-party candidates \\(not loaded\\): anthropics/skills@playwright-e2e \\(50\\.0K installs, audit pass\\) — load with /${LOAD_CMD} anthropics/skills@playwright-e2e`));
    assert.ok(ctx.length <= 2000);
    assert.match(out.systemMessage, new RegExp(`^\\[singular\\] [12] third-party skills? may fit this prompt \\(not loaded\\): /${LOAD_CMD} anthropics/skills@playwright-e2e`));
    // what reached the mock: owner catalogs (q=skill) + single tech words; never the prompt's free-form words
    const reqs = registry.requests.slice(before);
    const searches = reqs.filter((x) => x.path === '/api/search');
    assert.deepEqual(searches.filter((x) => x.q === 'skill').map((x) => x.owner).sort(), ['anthropics', 'microsoft', 'multica-ai', 'vercel-labs']);
    const words = searches.filter((x) => x.q !== 'skill').map((x) => x.q);
    assert.ok(words.length >= 1 && words.length <= 2, JSON.stringify(words));
    assert.ok(words.every((w) => ['playwright', 'nextjs', 'e2e'].includes(w)), `single tech words only: ${JSON.stringify(words)}`);
    assert.ok(searches.every((x) => x.limit === '200' && x.owner !== 'supabase'));
    assert.ok(reqs.every((x) => !/checkout|flow|app|run/i.test(String(x.q))), 'free-form prompt words never on the wire');
    assert.ok(reqs.some((x) => x.path.startsWith('/api/v1/skills/audit/anthropics/skills/')), 'audit looked up by candidate id');
    assert.ok(reqs.every((x) => x.ua === 'singular/0.2 (+node)'));
    const log = readLog(home, 'on-prompt');
    assert.equal(log.length, 1);
    assert.equal(log[0].sessionId, SUBMIT_FIXTURE.session_id);
    assert.equal(log[0].promptId, SUBMIT_FIXTURE.prompt_id);
    assert.deepEqual(log[0].candidates.slice(0, 1), ['anthropics/skills@playwright-e2e']);
    assert.equal(log[0].discover.keywordCount > 0, true);
    assert.ok(log[0].discover.shared.every((w) => ['playwright', 'nextjs', 'e2e'].includes(w)));
    assert.equal(Object.keys(log[0]).includes('prompt'), false, 'the prompt is never logged');
    assert.ok(readLog(home).some((l) => /test seam active/.test(l.msg)), 'active seams are logged');
    assert.ok(fs.existsSync(path.join(home, 'cache')), 'catalogs cached under the state dir');
  });

  test('the systemMessage announces each ref once per session: same session -> no systemMessage key; a new session -> announced again; cached catalogs -> no new requests', async () => {
    const home = freshHome('session', { mode: 'suggest', prefetch: false });
    const first = JSON.parse((await runBin('on-prompt.js', [], { env: baseEnv(home), input: submitInput({ session_id: 'sess-A' }) })).stdout);
    assert.ok(first.systemMessage);
    const before = seenRequests();
    const second = JSON.parse((await runBin('on-prompt.js', [], { env: baseEnv(home), input: submitInput({ session_id: 'sess-A' }) })).stdout);
    assert.equal(second.systemMessage, undefined, 'announced once per session');
    assert.match(second.hookSpecificOutput.additionalContext, /Third-party candidates \(not loaded\)/, 'the model still sees them');
    assert.equal(seenRequests() - before, 0, 'everything served from the 24 h cache: no request');
    const third = JSON.parse((await runBin('on-prompt.js', [], { env: baseEnv(home), input: submitInput({ session_id: 'sess-B' }) })).stdout);
    assert.ok(third.systemMessage, 'a new session is told again');
  });

  test('SINGULAR_MODE=local lowers suggest: stack + installed routing, zero registry requests; mode "off" in the file: no stdout at all', async () => {
    const home = freshHome('local', { mode: 'suggest' });
    const before = seenRequests();
    const r = await runBin('on-prompt.js', [], { env: baseEnv(home, { HOME: SKILLS_HOME, SINGULAR_MODE: 'local' }), input: submitInput() });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.systemMessage, undefined);
    assert.match(out.hookSpecificOutput.additionalContext, /^\[singular\] Stack: Next\.js 16/);
    assert.match(out.hookSpecificOutput.additionalContext, /Installed skills likely relevant: playwright \(matches playwright, e2e, test/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /Third-party/);
    assert.equal(seenRequests() - before, 0);
    const off = freshHome('off', { mode: 'off' });
    const o = await runBin('on-prompt.js', [], { env: baseEnv(off), input: submitInput() });
    assert.equal(o.code, 0);
    assert.equal(o.stdout, '');
    assert.equal(seenRequests() - before, 0);
    assert.equal(readLog(off, 'on-prompt')[0].skipped, 'mode off');
  });

  test('skip rules in hook mode: slash command, 39 chars, own output, task notification fixture, bare system reminder, empty prompt, other event, bad JSON, empty stdin -> exit 0, no stdout, no request', async () => {
    const home = freshHome('skips', { mode: 'suggest', prefetch: false });
    const before = seenRequests();
    const cases = [
      ['slash', submitInput({ prompt: '/singular load anthropics/skills@playwright-e2e and then more words here' })],
      ['short', submitInput({ prompt: 'x'.repeat(39) })],
      ['own output', submitInput({ prompt: '[singular] Stack: Next.js 16, React 19; long enough to pass the length gate' })],
      ['task notification', JSON.stringify({ ...TASK_FIXTURE, cwd: PROJ })],
      ['system reminder', submitInput({ prompt: '<system-reminder>\nA long synthetic reminder that is not a user request at all.\n</system-reminder>' })],
      ['empty', submitInput({ prompt: '' })],
      ['other event', submitInput({ hook_event_name: 'PreToolUse' })],
      ['bad json', '{not json'],
      ['empty stdin', ''],
    ];
    for (const [label, input] of cases) {
      const r = await runBin('on-prompt.js', [], { env: baseEnv(home), input });
      assert.equal(r.code, 0, `${label}: ${r.stderr}`);
      assert.equal(r.stdout, '', `${label}: no stdout`);
    }
    assert.equal(seenRequests() - before, 0, 'no request for any skipped prompt');
    const skipped = readLog(home, 'on-prompt').map((l) => l.skipped);
    assert.ok(skipped.includes('slash command'));
    assert.ok(skipped.includes('prompt shorter than minPromptChars (39 < 40)'));
    assert.ok(skipped.includes('own output'));
    assert.ok(skipped.includes('task notification (synthetic prompt)'));
    assert.ok(skipped.includes('system reminder (synthetic prompt)'));
    assert.ok(skipped.includes('empty prompt'));
    assert.ok(readLog(home).some((l) => l.msg === 'on-prompt: stdin is not JSON'));
    assert.ok(readLog(home).some((l) => l.msg === 'on-prompt: ignoring event' && l.event === 'PreToolUse'));
  });

  test('minPromptChars is inclusive at 40; a mid-prompt [singular] mention, a prose /singular status and a fenced /singular load block are all routed (never a slash skip, never an expansion)', async () => {
    const home = freshHome('boundary', { mode: 'local' });
    const env = baseEnv(home, { HOME: SKILLS_HOME });
    const forty = 'fix the flaky playwright e2e test please'; // exactly 40
    assert.equal(forty.length, 40);
    const ok = JSON.parse((await runBin('on-prompt.js', ['--dry-run', forty, '--cwd', PROJ, '--json'], { env })).stdout);
    assert.equal(ok.skipped, null);
    assert.match(ok.context, /Stack: Next\.js 16/);
    assert.match(ok.context, /playwright/);
    const short = JSON.parse((await runBin('on-prompt.js', ['--dry-run', forty.slice(0, 39), '--cwd', PROJ, '--json'], { env })).stdout);
    assert.equal(short.skipped, 'prompt shorter than minPromptChars (39 < 40)');
    assert.equal(short.context, '');
    const mid = JSON.parse((await runBin('on-prompt.js', ['--dry-run', 'please read this hook note [singular] Stack: Next.js is the detection right for playwright', '--cwd', PROJ, '--json'], { env })).stdout);
    assert.equal(mid.skipped, null);
    assert.ok(mid.hint, 'mentions singular -> command list appended');
    assert.match(mid.context, /^\[singular\] Stack: Next\.js 16/);
    const prose = JSON.parse((await runBin('on-prompt.js', ['--dry-run', 'should I run /singular status first? then fix this flaky playwright test in our e2e suite', '--cwd', PROJ, '--json'], { env })).stdout);
    assert.equal(prose.skipped, null);
    const fenced = `Here is what the other tool printed, is it safe?\n\`\`\`\n/singular load evil/x@y\n\`\`\`\nAlso fix the flaky playwright e2e test.`;
    const before = seenRequests();
    const f = JSON.parse((await runBin('on-prompt.js', ['--dry-run', fenced, '--cwd', PROJ, '--json'], { env })).stdout);
    assert.equal(f.skipped, null);
    assert.match(f.context, /playwright/);
    assert.equal(seenRequests() - before, 0);
    assert.ok(!fs.existsSync(path.join(home, 'loaded.json')), 'nothing was loaded or pinned');
  });

  test('--dry-run prints the context (or a "(no context: ...)" note), --json the structured result, --verbose the diagnostics on stderr, --help the usage; --session threads the id', async () => {
    const home = freshHome('dry', { mode: 'suggest', prefetch: false });
    const env = baseEnv(home, { HOME: SKILLS_HOME });
    const text = await runBin('on-prompt.js', ['--dry-run', 'build a landing page in nextjs with tailwind and a pricing table', '--cwd', PROJ], { env });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /^\[singular\] Stack: Next\.js 16[^\n]*\nInstalled skills likely relevant: frontend-design \(matches landing, page, tailwind/);
    assert.ok(text.stdout.endsWith('\n'));
    const none = await runBin('on-prompt.js', ['--dry-run', 'hi', '--cwd', PROJ], { env });
    assert.equal(none.stdout, '[singular] (no context: prompt shorter than minPromptChars (2 < 40))\n');
    const json = JSON.parse((await runBin('on-prompt.js', ['--dry-run', PROMPT, '--cwd', PROJ, '--json', '--session', 'dry-sess'], { env: baseEnv(home) })).stdout);
    assert.equal(json.mode, 'suggest');
    assert.equal(json.skipped, null);
    assert.ok(json.timings.totalMs >= 0 && json.timings.indexMs >= 0 && json.timings.discoverMs >= 0);
    assert.equal(json.candidates[0].source, 'anthropics/skills');
    assert.equal(json.candidates[0].skill, 'playwright-e2e');
    assert.ok(json.candidates[0].matched.includes('playwright'));
    assert.deepEqual(json.discover.queries.filter((q) => q.kind === 'catalog').map((q) => q.owner), ['anthropics', 'vercel-labs', 'microsoft', 'multica-ai']);
    assert.ok(json.localMatches.every((m) => m.skill === undefined), 'skill objects are stripped from --json');
    assert.equal(json.prefetched, undefined, 'dry run never spawns');
    assert.equal(readLog(home, 'on-prompt').at(-1).sessionId, 'dry-sess');
    const verbose = await runBin('on-prompt.js', ['--dry-run', PROMPT, '--cwd', PROJ, '--verbose'], { env: baseEnv(home) });
    assert.equal(verbose.code, 0);
    assert.match(verbose.stderr, /^\[singular\] mode=suggest skipped=no index=0\n\[singular\] timings=\{"indexMs":[\d.]+,"localMs":[\d.]+,"discoverMs":[\d.]+,"totalMs":[\d.]+\}\n\[singular\] local=none/);
    assert.match(verbose.stderr, /\n\[singular\] discover=\{"keywords":\[/);
    assert.match(verbose.stderr, /\n\[singular\] candidates=anthropics\/skills@playwright-e2e \(rank [\d.]+, matched \["/);
    assert.match(verbose.stderr, /\n\[singular\] systemMessage=\[singular\] [12] third-party skill/);
    assert.match(verbose.stderr, /\[singular\] config warning: TEST SEAM ACTIVE: SINGULAR_REGISTRY_BASE=/);
    assert.match(verbose.stdout, /^\[singular\] Stack: /);
    const help = await runBin('on-prompt.js', ['--help'], { env });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^usage: on-prompt\.js \[--dry-run "<prompt>"\]/);
    const hint = await runBin('on-prompt.js', ['--dry-run', 'show me the singular status', '--cwd', PROJ], { env });
    assert.match(hint.stdout, /^\[singular\] singular commands \(typed by the user\): \/singular \(status \+ help\), \/singular status/);
  });

  test('deadline with a slow registry: every request aborts at remoteTimeoutMs, the local context is still emitted well inside the budget, failures are remembered (recent-failure) so the next prompt makes no request', async () => {
    const home = freshHome('slow', { mode: 'suggest', prefetch: false, remoteTimeoutMs: 300, totalBudgetMs: 2500 });
    registry.delayMs = 1500;
    const before = seenRequests();
    let r;
    try {
      r = await runBin('on-prompt.js', [], { env: baseEnv(home), input: submitInput() });
    } finally {
      registry.delayMs = 0;
    }
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < 2500 + 600 + 1500, `finished in ${Math.round(r.ms)} ms`);
    const out = JSON.parse(r.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /^\[singular\] Stack: Next\.js 16/);
    assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /Third-party/);
    assert.equal(out.systemMessage, undefined);
    const attempted = seenRequests() - before;
    assert.ok(attempted >= 4, `the catalogs were attempted: ${attempted}`);
    const log = readLog(home, 'on-prompt')[0];
    assert.ok(log.discover.errors.length >= 4, JSON.stringify(log.discover));
    assert.ok(log.discover.errors.every((e) => /timeout after 300ms/.test(e)), JSON.stringify(log.discover.errors));
    assert.ok(log.timings.discoverMs < 2200, `discover respected the deadline: ${log.timings.discoverMs}`);
    // second prompt, registry healthy again: the 5-minute failure markers skip every request
    const before2 = seenRequests();
    const again = JSON.parse((await runBin('on-prompt.js', ['--dry-run', PROMPT, '--cwd', PROJ, '--json'], { env: baseEnv(home) })).stdout);
    assert.equal(seenRequests() - before2, 0, 'no request while the failure markers are fresh');
    assert.ok(again.discover.queries.length >= 4);
    assert.ok(again.discover.queries.every((q) => q.skipped === 'recent-failure'), JSON.stringify(again.discover.queries));
    assert.deepEqual(again.candidates, []);
    assert.ok(again.timings.discoverMs < 500);
  });

  test('a repository cannot raise privilege: SINGULAR_MODE=auto and an in-project SINGULAR_HOME are ignored (warnings logged), nothing written into the project', async () => {
    const inProject = path.join(PROJ, '.singular');
    write(path.join(inProject, 'config.json'), JSON.stringify({ mode: 'auto', allowlist: ['evil-local'], installFloor: 0 }));
    const fallbackHome = path.join(EMPTY_HOME, '.claude', 'singular');
    fs.rmSync(fallbackHome, { recursive: true, force: true });
    const r = await runBin('on-prompt.js', ['--dry-run', PROMPT, '--cwd', PROJ, '--json'], { env: baseEnv(inProject, { SINGULAR_MODE: 'auto', SINGULAR_TEST_ALLOW_AUTO: '1' }) });
    const j = JSON.parse(r.stdout);
    assert.equal(j.mode, 'suggest', 'the default config (created in the scratch HOME) rules');
    assert.equal(j.loaded, null);
    assert.ok(j.warnings.some((w) => /SINGULAR_MODE=auto ignored \(the environment can only lower the mode below "suggest"\)/.test(w)), JSON.stringify(j.warnings));
    // main() hardens process.env before runOnPrompt, so the dropped SINGULAR_HOME is reported in the log of the home actually used
    assert.ok(readLog(fallbackHome).some((l) => l.msg === 'on-prompt: environment override ignored' && /SINGULAR_HOME=.* ignored \(inside the project directory/.test(l.warning)), JSON.stringify(readLog(fallbackHome).map((l) => l.msg)));
    assert.ok(!fs.existsSync(path.join(inProject, 'singular.log')) && !fs.existsSync(path.join(inProject, 'cache')), 'nothing written into the project');
    assert.ok(fs.existsSync(path.join(fallbackHome, 'config.json')), 'the default home (under the scratch HOME) was used instead');
    fs.rmSync(inProject, { recursive: true, force: true });
    fs.rmSync(fallbackHome, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------

describe('bin/on-prompt.js auto mode (SINGULAR_TEST_ALLOW_AUTO=1 + real git against the local base)', { skip: !HAS_GIT && 'git not on PATH' }, () => {
  test('hook mode: HEAD resolved and pinned, SKILL.md fetched with git, sanitized, injected; WARNING systemMessage exactly once; second prompt served from the text cache', async () => {
    const home = freshHome('auto', { mode: 'auto', allowlist: ['evil-local'], prefetch: false });
    const env = baseEnv(home, { SINGULAR_TEST_ALLOW_AUTO: '1' });
    const r = await runBin('on-prompt.js', [], { env, input: submitInput({ session_id: 'auto-1' }) });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    const ref = `evil-local/repo#${HEAD_SHA}@playwright-e2e`;
    assert.match(ctx, /^\[singular\] Stack: Next\.js 16/);
    assert.ok(ctx.includes(`\nLoaded third-party skill ${ref} (auto mode, user-configured; text only, nothing installed).\n<singular-loaded ref="${ref}">\n`), ctx.slice(0, 600));
    assert.match(ctx, /name: clean-guidelines/);
    assert.match(ctx, /Keep changes small\./);
    assert.ok(ctx.endsWith('\n</singular-loaded>'));
    assert.doesNotMatch(ctx, /Third-party candidates/, 'the loaded candidate is not also suggested');
    assert.match(out.systemMessage, /^\[singular\] WARNING: mode "auto" is enabled\. Third-party skill text .* This warning is shown once\.$/);
    assert.ok(fs.existsSync(path.join(home, '.auto-mode-warned')));
    assert.ok(!fs.existsSync(path.join(EMPTY_HOME, '.claude', 'skills')), 'nothing installed');
    const log = readLog(home, 'on-prompt')[0];
    assert.equal(log.loaded, ref);
    assert.equal(log.mode, 'auto');
    assert.ok(log.timings.autoFetchMs >= 0);
    assert.ok(fs.existsSync(cacheFile(textKey(ref), { SINGULAR_HOME: home })), 'text cached forever by pinned ref');
    assert.equal(JSON.parse(fs.readFileSync(cacheFile('head:evil-local/repo', { SINGULAR_HOME: home }), 'utf8')).value, HEAD_SHA);
    // second prompt: no warning, no git (served from the cache)
    const r2 = await runBin('on-prompt.js', [], { env, input: submitInput({ session_id: 'auto-1' }) });
    const out2 = JSON.parse(r2.stdout);
    assert.equal(out2.systemMessage, undefined, 'warned once');
    assert.ok(out2.hookSpecificOutput.additionalContext.includes(`<singular-loaded ref="${ref}">`));
    assert.ok(readLog(home, 'on-prompt')[1].timings.autoFetchMs < 200, 'cache hit: no clone');
    // dry run with --verbose shows the honest state
    const v = await runBin('on-prompt.js', ['--dry-run', PROMPT, '--cwd', PROJ, '--verbose'], { env });
    assert.match(v.stderr, /\[singular\] mode=auto/);
    assert.match(v.stderr, new RegExp(`\\[singular\\] loaded=${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+ chars, cached true\\)`));
  });

  test('auto with a long skill carrying capability frontmatter: keys stripped and listed, body truncated to keep the whole hook output under 9,500 chars', async (t) => {
    const home = freshHome('auto-long', { mode: 'auto', allowlist: ['long-owner'], prefetch: false });
    const env = baseEnv(home, { SINGULAR_TEST_ALLOW_AUTO: '1' });
    const r = await runBin('on-prompt.js', [], { env, input: submitInput() });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.ok(ctx.length <= 9500, `${ctx.length} <= 9500`);
    // Observation (recorded, not asserted): the raw JSON on stdout is longer than additionalContext (newline
    // escaping + the one-time WARNING systemMessage) and can pass 10,000 chars on the first auto prompt.
    t.diagnostic(`auto long-skill: additionalContext ${ctx.length} chars, raw hook JSON ${r.stdout.length} chars`);
    assert.match(ctx, /Loaded third-party skill long-owner\/repo#[0-9a-f]{40}@long-playwright-guide \(auto mode, user-configured; text only, nothing installed\)\. Stripped: .*frontmatter: allowed-tools.*/);
    assert.match(ctx, /Stripped: .*hooks/);
    assert.match(ctx, /Stripped: .*model/);
    assert.match(ctx, /truncated \d+ chars to fit the 9,500-char hook budget/);
    assert.match(ctx, /\[singular: truncated\]\n<\/singular-loaded>$/);
    const block = ctx.split('<singular-loaded')[1];
    assert.doesNotMatch(block, /^allowed-tools:|^hooks:|^model:/m, 'no capability key inside the injected body');
    assert.match(block, /Line 000: guidance text/);
  });

  test('auto when the candidate repo does not exist in the git base: HEAD cannot be resolved, the suggestion is emitted instead, no crash', async () => {
    const home = freshHome('auto-ghost', { mode: 'auto', allowlist: ['ghost-owner'], prefetch: false });
    const env = baseEnv(home, { SINGULAR_TEST_ALLOW_AUTO: '1' });
    const j = JSON.parse((await runBin('on-prompt.js', ['--dry-run', PROMPT, '--cwd', PROJ, '--json'], { env })).stdout);
    assert.equal(j.mode, 'auto');
    assert.equal(j.loaded, null);
    assert.match(String(j.autoSkipped), /^HEAD not resolved \(only \d+ms left\); suggestion emitted instead$/);
    assert.match(j.context, /Third-party candidates \(not loaded\): ghost-owner\/none@playwright-e2e/);
    assert.match(String(j.systemMessage), /WARNING: mode "auto"/);
    assert.ok(!fs.existsSync(path.join(home, '.auto-mode-warned')), 'a dry run never consumes the one-time marker');
  });

  test('suggest mode with prefetch on: a detached `on-expand.js <ref> --prefetch` child caches HEAD and the text so the next /singular load is instant; no pin is recorded', async () => {
    const home = freshHome('prefetch', { mode: 'suggest' }); // prefetch: true (default)
    const r = await runBin('on-prompt.js', [], { env: baseEnv(home), input: submitInput() });
    assert.equal(r.code, 0, r.stderr);
    const log = readLog(home, 'on-prompt')[0];
    assert.deepEqual(log.prefetched, ['anthropics/skills@playwright-e2e']);
    const pinned = `anthropics/skills#${HEAD_SHA}@playwright-e2e`;
    const ok = await waitFor(() => fs.existsSync(cacheFile(textKey(pinned), { SINGULAR_HOME: home })), { timeoutMs: 15000 });
    assert.ok(ok, 'the detached prefetch cached the text');
    assert.equal(JSON.parse(fs.readFileSync(cacheFile('head:anthropics/skills', { SINGULAR_HOME: home }), 'utf8')).value, HEAD_SHA);
    await waitFor(() => readLog(home, 'on-expand: prefetched').length > 0, { timeoutMs: 5000 });
    assert.ok(!fs.existsSync(path.join(home, 'loaded.json')), 'prefetch records no pin');
    // now the second prompt shows the #sha7 display suffix (HEAD cached) and the text cache is hit by /singular load
    const second = JSON.parse((await runBin('on-prompt.js', [], { env: baseEnv(home), input: submitInput({ session_id: 'pf-2' }) })).stdout);
    assert.match(second.hookSpecificOutput.additionalContext, new RegExp(`anthropics/skills#${HEAD_SHA.slice(0, 7)}@playwright-e2e \\(50\\.0K installs, audit pass\\) — load with /${LOAD_CMD} anthropics/skills@playwright-e2e`));
    const load = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandInput('anthropics/skills@playwright-e2e') });
    assert.equal(load.code, 0, load.stderr);
    assert.equal(readLog(home, 'on-expand: loaded')[0].cached, true, 'served from the prefetched text');
  });
});

// ---------------------------------------------------------------------------

describe('bin/on-prompt.js in-process branches (injected deps)', () => {
  let onPrompt;
  before(async () => { onPrompt = await import('../bin/on-prompt.js'); });

  test('mentionsSingular: the command forms and the word next to a plugin noun get the command-list hint; the bare English word does not', () => {
    const { mentionsSingular, COMMANDS_HINT } = onPrompt;
    for (const s of ['show me the singular status', 'what does /singular do', 'run /singular-find for playwright', 'which singular plugin skill helps here', 'is the Singular hook slow?', 'change the singular mode to local', 'where is the singular config', 'list the singular commands']) {
      assert.equal(mentionsSingular(s), true, s);
    }
    for (const s of ['compute the singular value decomposition of this matrix', 'a singular achievement', 'use the singular form of the noun in the i18n keys', '', null, undefined, 'singularity is a different plugin', 'show me the status']) {
      assert.equal(mentionsSingular(s), false, String(s));
    }
    assert.match(COMMANDS_HINT, /^singular commands \(typed by the user\): \/singular \(status \+ help\), \/singular status .*\/singular find <query>.*\/singular load owner\/repo@skill.*\/singular mode <off\|local\|suggest\|auto>.*\/singular add owner\/repo@skill/);
    assert.doesNotMatch(COMMANDS_HINT, /scout/);
  });

  test('a 12,000-char prompt against 160 installed skills stays fast and under the context budget', async () => {
    const home = freshHome('big', { mode: 'local' });
    const prompt = `${'please refactor the checkout flow and the playwright e2e tests for topic3 area5 '.repeat(150)}`.slice(0, 12000);
    assert.equal(prompt.length, 12000);
    const r = await onPrompt.runOnPrompt({ prompt, cwd: PROJ, env: { HOME: MANY_HOME, SINGULAR_HOME: home } });
    assert.equal(r.skipped, null);
    assert.equal(r.indexSize, 160);
    assert.ok(r.timings.totalMs < 500, `totalMs ${r.timings.totalMs}`);
    assert.ok(r.context.length <= 2000, `${r.context.length}`);
    assert.match(r.context, /^\[singular\] Stack: Next\.js 16/);
    const { hookOutput } = await import('../lib/context.js');
    assert.ok(hookOutput('UserPromptSubmit', r.context).length < 10000);
  });

  test('a candidate whose name equals an installed skill is never suggested (the local one is routed to instead), even when the local match is too weak to list', async () => {
    // an installed skill named like the registry's anthropics/skills@webapp-testing, whose description shares nothing
    // with the prompt: it is neither listed nor strong, discovery runs, and the registry entry is rejected as
    // "already installed locally" (bin/on-prompt.js installedNamesOf -> lib/registry.js gateCandidates)
    const localHome = path.join(AGENT, 'installed-name-home');
    write(path.join(localHome, '.claude', 'skills', 'webapp-testing', 'SKILL.md'), skillMd('webapp-testing', 'Internal notes about nothing in particular.'));
    const home = freshHome('installed-name', { mode: 'suggest' });
    const env = baseEnv(home, { HOME: localHome });
    const r = await onPrompt.runOnPrompt({ prompt: PROMPT, cwd: PROJ, env, sessionId: 'inst-1', deps: { env, cacheGet: () => null, cacheSet: () => {} } });
    assert.equal(r.skipped, null);
    assert.equal(r.indexSize, 1);
    assert.ok(r.discover && typeof r.discover.rejected === 'number' && r.discover.rejected >= 1, JSON.stringify(r.discover));
    assert.ok(!r.candidates.some((c) => c.skill === 'webapp-testing'), JSON.stringify(r.candidates));
    assert.doesNotMatch(r.context, /webapp-testing/, 'neither listed locally (no matching token) nor suggested remotely (installed)');
    assert.ok(r.candidates.some((c) => c.skill === 'playwright-e2e'), 'the other candidates still come through');
  });

  test('a spawnImpl that throws, and a cache that throws on session keys, never break the prompt (suggest, loopback registry)', async () => {
    const home = freshHome('throwing', { mode: 'suggest' });
    const env = baseEnv(home);
    const throwing = (k) => { if (String(k).startsWith('session:')) throw new Error('cache down'); };
    const r = await onPrompt.runOnPrompt({
      prompt: PROMPT, cwd: PROJ, env, sessionId: 'thr-1', prefetch: true,
      deps: { env, spawnImpl: () => { throw new Error('spawn refused'); }, cacheGet: (k) => { throwing(k); return null; }, cacheSet: (k) => { throwing(k); } },
    });
    assert.equal(r.skipped, null);
    assert.ok(r.candidates.length >= 1, JSON.stringify(r.discover));
    assert.equal(r.prefetched, undefined, 'spawn failure recorded as "not prefetched"');
    assert.match(String(r.systemMessage), /may fit this prompt/, 'a throwing session cache still announces');
    assert.ok(processLog('prefetch spawn failed').some((l) => /spawn refused/.test(l.error)));
  });

  test('pinnedSkills ref (real git via the seam): resolved + pinned + fetched once per session; sha reused from loaded.json; text served from the cache; budget-starved -> background prefetch; unresolvable -> prefetch of the bare ref', { skip: !HAS_GIT && 'git not on PATH' }, async () => {
    const home = freshHome('pinned', { mode: 'local' });
    const env = baseEnv(home);
    const store = new Map();
    const deps = { env, cacheGet: (k) => store.get(k) ?? null, cacheSet: (k, v) => { store.set(k, v); } };
    const config = { ...DEFAULTS, allowlist: ['evil-local'], blockedRefs: [], mode: 'local', pinnedSkills: ['evil-local/repo@playwright-e2e'], prefetch: true };
    const ref = `evil-local/repo#${HEAD_SHA}@playwright-e2e`;
    const r1 = await onPrompt.runOnPrompt({ prompt: PROMPT, cwd: PROJ, env, config, sessionId: 'pin-1', deps });
    assert.ok(r1.loaded, JSON.stringify(r1.warnings));
    assert.equal(r1.loaded.ref, ref);
    assert.equal(r1.loaded.reason, 'pinned in config.pinnedSkills');
    assert.match(r1.context, /Loaded third-party skill evil-local\/repo#[0-9a-f]{40}@playwright-e2e \(pinned in config\.pinnedSkills; text only, nothing installed\)/);
    assert.match(r1.context, /Keep changes small/);
    assert.equal(store.get('head:evil-local/repo'), HEAD_SHA);
    assert.equal(typeof store.get(textKey(ref))?.text, 'string');
    assert.equal(store.get('session:pin-1:pinned'), true);
    const r2 = await onPrompt.runOnPrompt({ prompt: PROMPT, cwd: PROJ, env, config, sessionId: 'pin-1', deps });
    assert.equal(r2.loaded, null, 'once per session');
    // a new session: HEAD comes from loaded.json (written by /singular load), the text from the cache -> no git at all
    write(path.join(home, 'loaded.json'), JSON.stringify({ 'evil-local/repo@playwright-e2e': { ref, sha: HEAD_SHA, ts: 1, lastTs: 1, loads: 1 } }));
    const t0 = performance.now();
    const r3 = await onPrompt.runOnPrompt({ prompt: PROMPT, cwd: PROJ, env, config, sessionId: 'pin-2', deps });
    assert.equal(r3.loaded?.ref, ref);
    assert.ok(performance.now() - t0 < 1500, 'no clone when the text is cached');
    // budget starved (sha known, text not cached): the text is prefetched in the background instead
    const spawned = [];
    store.delete(textKey(ref));
    let reads = 0;
    const now = () => { reads++; return reads <= 1 ? 1_000_000 : 1_000_000 + 2000; }; // 4,000 ms left < MIN_AUTO_FETCH_MS
    const r4 = await onPrompt.runOnPrompt({ prompt: PROMPT, cwd: PROJ, env, config, sessionId: 'pin-3', deps: { ...deps, now, spawnImpl: (f, a) => { spawned.push(a); return { unref() {} }; } }, prefetch: true });
    assert.equal(r4.loaded, null);
    assert.deepEqual(r4.prefetched, [ref]);
    assert.deepEqual(spawned.map((a) => a.slice(1)), [[ref, '--prefetch']]);
    // unresolvable repo: the bare ref is prefetched (and nothing loaded), warnings stay quiet
    const ghostCfg = { ...config, allowlist: ['evil-local'], pinnedSkills: ['evil-local/missing-repo@x'] };
    const spawned2 = [];
    const r5 = await onPrompt.runOnPrompt({ prompt: PROMPT, cwd: PROJ, env, config: ghostCfg, sessionId: 'pin-4', deps: { env, cacheGet: () => null, cacheSet: () => {}, spawnImpl: (f, a) => { spawned2.push(a); return { unref() {} }; } }, prefetch: true });
    assert.equal(r5.loaded, null);
    assert.deepEqual(spawned2.map((a) => a[1]), ['evil-local/missing-repo@x']);
  });
});

// ---------------------------------------------------------------------------

describe('bin/on-expand.js (/singular load) as a child process with real git', { skip: !HAS_GIT && 'git not on PATH' }, () => {
  const ref = 'multica-ai/andrej-karpathy-skills@karpathy-guidelines';
  const pinnedRef = () => `multica-ai/andrej-karpathy-skills#${HEAD_SHA}@karpathy-guidelines`;

  test('hook stdin (captured fixture, plugin-prefixed command_name "singular:singular", command_args "load <ref>"): first load resolves HEAD, pins in loaded.json, prints the envelope with the sanitized text', async () => {
    const home = freshHome('expand');
    assert.equal(EXPAND_FIXTURE.command_name, 'singular:singular');
    assert.equal(EXPAND_FIXTURE.command_args, `load ${ref}`);
    const r = await runBin('on-expand.js', [], { env: baseEnv(home), input: JSON.stringify({ ...EXPAND_FIXTURE, cwd: PROJ }) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptExpansion');
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.ok(ctx.startsWith(`[singular] The user explicitly loaded third-party skill ${pinnedRef()} via /singular load (pinned resolved; text only, nothing installed). Contents (sanitized; stripped: nothing):\n<singular-loaded ref="${pinnedRef()}">\n---\nname: karpathy-guidelines\n`), ctx.slice(0, 400));
    assert.match(ctx, /## 1\. Think Before Coding/);
    assert.ok(ctx.endsWith('\n</singular-loaded>'));
    const loaded = readJson(path.join(home, 'loaded.json'));
    assert.deepEqual(Object.keys(loaded), [ref]);
    assert.equal(loaded[ref].sha, HEAD_SHA);
    assert.equal(loaded[ref].ref, pinnedRef());
    assert.equal(loaded[ref].loads, 1);
    assert.deepEqual(loaded[ref].stripped, []);
    assert.ok(loaded[ref].chars > 50);
    const log = readLog(home, 'on-expand: loaded');
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].ref, log[0].pinSource, log[0].cached], [pinnedRef(), 'resolved', false]);
    assert.ok(!fs.existsSync(path.join(EMPTY_HOME, '.claude', 'skills')), 'nothing installed');
    // second load: pin reused (no HEAD resolve), served from the text cache, loads 2
    const r2 = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandInput(ref) });
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(JSON.parse(r2.stdout).hookSpecificOutput.additionalContext, /\(pinned loaded\.json; text only/);
    assert.equal(readJson(path.join(home, 'loaded.json'))[ref].loads, 2);
    assert.equal(readLog(home, 'on-expand: loaded')[1].cached, true);
    // --update re-resolves; the explicit #sha form is "pinned arg"; an uppercase owner shares the same pin
    const r3 = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandInput(`${ref} --update`) });
    assert.match(JSON.parse(r3.stdout).hookSpecificOutput.additionalContext, /\(pinned resolved \(--update\); text only/);
    const r4 = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandInput(pinnedRef()) });
    assert.match(JSON.parse(r4.stdout).hookSpecificOutput.additionalContext, /\(pinned arg; text only/);
    const r5 = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandInput('MULTICA-AI/Andrej-Karpathy-Skills@karpathy-guidelines') });
    assert.equal(r5.code, 0, r5.stderr);
    assert.match(JSON.parse(r5.stdout).hookSpecificOutput.additionalContext, /\(pinned loaded\.json; text only/);
    // the subcommand is matched case-insensitively and tolerates extra whitespace; a bare command_name works too
    const r6 = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandRaw(`  LOAD   ${ref}  `, { command_name: 'singular' }) });
    assert.equal(r6.code, 0, r6.stderr);
    assert.match(JSON.parse(r6.stdout).hookSpecificOutput.additionalContext, /\(pinned loaded\.json; text only/);
    const after = readJson(path.join(home, 'loaded.json'));
    assert.deepEqual(Object.keys(after), [ref], 'one case-normalized pin');
    assert.equal(after[ref].loads, 6);
    assert.equal(fs.readdirSync(path.join(home, 'cache')).length, 2, 'one head: entry + one text: entry for every spelling');
  });

  test('hook stdin for every other /singular subcommand (status, find, add, mode, help, empty, "loader"): exit 0, nothing on stdout or stderr, nothing pinned; the skill body runs bin/singular.js instead', async () => {
    const home = freshHome('expand-other');
    const before = seenRequests();
    for (const args of ['', '   ', 'status', 'status --json', 'help', `find ${ref}`, `add ${ref} --yes`, 'mode auto', `loader ${ref}`, `load${ref}`, `--update load ${ref}`]) {
      const r = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandRaw(args) });
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''], JSON.stringify(args));
    }
    assert.equal(seenRequests() - before, 0);
    assert.ok(!fs.existsSync(path.join(home, 'loaded.json')), 'nothing pinned');
    assert.ok(!fs.existsSync(path.join(home, 'cache')), 'nothing cached');
    assert.equal(readLog(home, 'on-expand: not a load subcommand; nothing to do').length, 11);
    assert.equal(readLog(home, 'on-expand: blocked').length, 0);
    const { loadArgsOf } = await import('../bin/on-expand.js');
    assert.equal(loadArgsOf('load a/b@c --update'), 'a/b@c --update');
    assert.equal(loadArgsOf('  Load   a/b@c '), 'a/b@c');
    assert.equal(loadArgsOf('load'), '');
    assert.equal(loadArgsOf('loader a/b@c'), null);
    assert.equal(loadArgsOf('status'), null);
    assert.equal(loadArgsOf(''), null);
    assert.equal(loadArgsOf(undefined), null);
  });

  test('blocked before any git: non-allowlisted owner (exit 2, reason on stderr, no stdout, no pin), blockedRefs, and every hostile/malformed argument form', async () => {
    const home = freshHome('expand-block');
    const evil = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandInput('evil/repo@x') });
    assert.equal(evil.code, 2);
    assert.equal(evil.stdout, '');
    assert.equal(evil.stderr, `[singular] refused: owner "evil" is not in the allowlist [anthropics, vercel-labs, microsoft, multica-ai]. Add "evil" (or "evil/repo") to "allowlist" in ${path.join(home, 'config.json')} if you trust that source, then retry.\n`);
    const blockedHome = freshHome('expand-blocked', { blockedRefs: ['multica-ai/andrej-karpathy-skills@karpathy-guidelines'] });
    const blocked = await runBin('on-expand.js', [], { env: baseEnv(blockedHome), input: expandInput(ref) });
    assert.equal(blocked.code, 2);
    assert.equal(blocked.stderr, '[singular] refused: multica-ai/andrej-karpathy-skills@karpathy-guidelines matches "blockedRefs" in your config.\n');
    const usage = 'usage: /singular load owner/repo@skill  or  /singular load owner/repo#<40-hex-sha>@skill  [--update]';
    const cases = [
      ['', `[singular] missing skill reference. ${usage}`],
      ['   ', `[singular] missing skill reference. ${usage}`],
      ['a/b@c; rm -rf ~', `[singular] unknown option -rf. ${usage}`],
      ['--bogus a/b@c', `[singular] unknown option --bogus. ${usage}`],
      ['a/b@c d/e@f', `[singular] expected exactly one skill reference, got 2. ${usage}`],
      ['../../etc/passwd', `[singular] invalid skill reference "../../etc/passwd". ${usage}`],
      ['$(whoami)/x@y', `[singular] invalid skill reference "$(whoami)/x@y". ${usage}`],
      ['`id`/x@y', '[singular] invalid skill reference "`id`/x@y". '],
      ['anthropics/skills#abc@x', '[singular] invalid skill reference "anthropics/skills#abc@x". '],
      ['anthropics/skills@-y', '[singular] invalid skill reference "anthropics/skills@-y". '],
      ['anthropics/skills@.', '[singular] invalid skill reference "anthropics/skills@.". '],
      ['anthropics/skills@a/b', '[singular] invalid skill reference "anthropics/skills@a/b". '],
      [`a/${'b'.repeat(490)}@c`, `[singular] invalid skill reference "a/${'b'.repeat(78)}". `],
      ['owner/repo', '[singular] invalid skill reference "owner/repo". '],
    ];
    const before = seenRequests();
    for (const [args, want] of cases) {
      const r = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandInput(args) });
      assert.equal(r.code, 2, args);
      assert.equal(r.stdout, '', args);
      assert.ok(r.stderr.startsWith(want), `${JSON.stringify(args)}:\n${r.stderr}`);
    }
    assert.equal(seenRequests() - before, 0);
    assert.ok(!fs.existsSync(path.join(home, 'loaded.json')), 'nothing pinned');
    assert.ok(!fs.existsSync(path.join(home, 'cache')), 'nothing cached');
    assert.ok(readLog(home, 'on-expand: blocked').length >= cases.length + 1);
  });

  test('git failures are blocks with the reason: unknown repo (HEAD), bogus sha (fetch), missing skill in the repo; nothing pinned', async () => {
    const home = freshHome('expand-git-fail');
    const noRepo = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandInput('anthropics/no-such-repo@x') });
    assert.equal(noRepo.code, 2);
    assert.match(noRepo.stderr, new RegExp(`^\\[singular\\] could not resolve HEAD of file://${GIT_BASE}/anthropics/no-such-repo: git ls-remote .* failed \\(exit 128\\)`));
    const bogus = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandInput(`anthropics/skills#${'0'.repeat(40)}@playwright-e2e`) });
    assert.equal(bogus.code, 2);
    assert.match(bogus.stderr, /^\[singular\] could not fetch anthropics\/skills#0{40}@playwright-e2e: git fetch anthropics\/skills#0{40}@playwright-e2e: git fetch failed \(exit 128\)/);
    const missing = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandInput('anthropics/skills@no-such-skill') });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /^\[singular\] could not fetch anthropics\/skills#[0-9a-f]{40}@no-such-skill: No matching skill found for: no-such-skill \(found: helpful-setup, karpathy-guidelines, long-playwright-guide, playwright-e2e\)/);
    assert.ok(!fs.existsSync(path.join(home, 'loaded.json')));
  });

  test('other command names and bad JSON are ignored silently (exit 0); the hook output for a long skill is truncated under 9,500 chars with the stripped keys listed; loaded.json as a directory does not break a load', async () => {
    const home = freshHome('expand-misc');
    const other = await runBin('on-expand.js', [], { env: baseEnv(home), input: expandInput('evil/repo@x', { command_name: 'singular:singular-find' }) });
    assert.deepEqual([other.code, other.stdout, other.stderr], [0, '', '']);
    const bad = await runBin('on-expand.js', [], { env: baseEnv(home), input: '{{' });
    assert.deepEqual([bad.code, bad.stdout, bad.stderr], [0, '', '']);
    const empty = await runBin('on-expand.js', [], { env: baseEnv(home), input: '' });
    assert.deepEqual([empty.code, empty.stdout], [0, '']);
    const longHome = freshHome('expand-long', { allowlist: ['long-owner'] });
    const long = await runBin('on-expand.js', [], { env: baseEnv(longHome), input: expandInput('long-owner/repo@long-playwright-guide') });
    assert.equal(long.code, 0, long.stderr);
    const ctx = JSON.parse(long.stdout).hookSpecificOutput.additionalContext;
    assert.ok(ctx.length <= 9500, `${ctx.length}`);
    assert.match(ctx, /Contents \(sanitized; stripped: frontmatter: allowed-tools.*hooks.*model.*truncated \d+ chars to fit the 9,500-char hook budget\):/);
    assert.match(ctx, /\[singular: truncated\]\n<\/singular-loaded>$/);
    assert.doesNotMatch(ctx.split('<singular-loaded')[1], /^allowed-tools:|^hooks:|^model:/m);
    const dirHome = freshHome('expand-dir');
    fs.mkdirSync(path.join(dirHome, 'loaded.json'));
    const r = await runBin('on-expand.js', [], { env: baseEnv(dirHome), input: expandInput(ref) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /\(pinned resolved; text only/);
    assert.ok(fs.statSync(path.join(dirHome, 'loaded.json')).isDirectory(), 'the pin write failed silently, the directory is untouched');
  });

  test('CLI mode (both `load <ref>` and bare `<ref>`, also via `singular.js load`): prints the sanitized text (or --json), a rejected ref exits 1, --help prints usage; --prefetch is silent, caches HEAD + text and records no pin', async () => {
    const home = freshHome('expand-cli');
    const text = await runBin('on-expand.js', [ref], { env: baseEnv(home) });
    assert.equal(text.code, 0, text.stderr);
    assert.ok(text.stdout.startsWith(`[singular] loaded ${pinnedRef()} (pinned resolved; stripped: nothing)\n\n---\nname: karpathy-guidelines\n`), text.stdout.slice(0, 200));
    assert.doesNotMatch(text.stdout, /hookSpecificOutput/);
    const viaLoad = await runBin('on-expand.js', ['load', ref], { env: baseEnv(home) });
    assert.equal(viaLoad.code, 0, viaLoad.stderr);
    assert.ok(viaLoad.stdout.startsWith(`[singular] loaded ${pinnedRef()} (pinned loaded.json; stripped: nothing)\n\n---\nname: karpathy-guidelines\n`), viaLoad.stdout.slice(0, 200));
    const viaDispatcher = await runBin('singular.js', ['load', ref, '--json'], { env: baseEnv(home) });
    assert.equal(viaDispatcher.code, 0, viaDispatcher.stderr);
    assert.equal(JSON.parse(viaDispatcher.stdout).ref, pinnedRef());
    assert.equal(readJson(path.join(home, 'loaded.json'))[ref].loads, 3, 'every CLI form pins/loads the same way');
    const json = await runBin('on-expand.js', [ref, '--json'], { env: baseEnv(home) });
    assert.equal(json.code, 0, json.stderr);
    const j = JSON.parse(json.stdout);
    assert.deepEqual(Object.keys(j), ['ref', 'sha', 'pinSource', 'stripped', 'text']);
    assert.deepEqual([j.ref, j.sha, j.pinSource, j.stripped], [pinnedRef(), HEAD_SHA, 'loaded.json', []]);
    assert.match(j.text, /^---\nname: karpathy-guidelines/);
    const rejected = await runBin('on-expand.js', ['evil/repo@x'], { env: baseEnv(home) });
    assert.equal(rejected.code, 1);
    assert.equal(rejected.stdout, '');
    assert.match(rejected.stderr, /not in the allowlist/);
    const rejectedLoad = await runBin('on-expand.js', ['load', 'evil/repo@x', '--update'], { env: baseEnv(home) });
    assert.deepEqual([rejectedLoad.code, rejectedLoad.stdout], [1, '']);
    assert.match(rejectedLoad.stderr, /not in the allowlist/);
    const bareLoad = await runBin('on-expand.js', ['load'], { env: baseEnv(home) });
    assert.deepEqual([bareLoad.code, bareLoad.stdout], [1, ''], 'a bare `load` is CLI mode (never waits for hook stdin)');
    assert.match(bareLoad.stderr, /^\[singular\] missing skill reference\. usage: \/singular load owner\/repo@skill/);
    const help = await runBin('on-expand.js', ['--help'], { env: baseEnv(home) });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^usage: on-expand\.js \[load\] <owner\/repo\[#sha\]@skill> \[--update\] \[--json\] \[--prefetch\]/);
    const pfHome = freshHome('expand-prefetch');
    const pf = await runBin('on-expand.js', ['anthropics/skills@playwright-e2e', '--prefetch'], { env: baseEnv(pfHome) });
    assert.deepEqual([pf.code, pf.stdout, pf.stderr], [0, '', '']);
    const pinned = `anthropics/skills#${HEAD_SHA}@playwright-e2e`;
    assert.ok(fs.existsSync(cacheFile(textKey(pinned), { SINGULAR_HOME: pfHome })));
    assert.equal(JSON.parse(fs.readFileSync(cacheFile('head:anthropics/skills', { SINGULAR_HOME: pfHome }), 'utf8')).value, HEAD_SHA);
    assert.ok(!fs.existsSync(path.join(pfHome, 'loaded.json')), 'no pin');
    assert.equal(readLog(pfHome, 'on-expand: prefetched').length, 1);
    const pfBlocked = await runBin('on-expand.js', ['evil/repo@x', '--prefetch'], { env: baseEnv(pfHome) });
    assert.deepEqual([pfBlocked.code, pfBlocked.stdout, pfBlocked.stderr], [0, '', ''], 'a blocked prefetch is silent too');
    assert.equal(readLog(pfHome, 'on-expand: prefetch blocked').length, 1);
  });
});

// ---------------------------------------------------------------------------

describe('bin/singular.js add as a child process with real git (HOME at a scratch dir; never ~/.claude)', { skip: !HAS_GIT && 'git not on PATH' }, () => {
  // Every test gets its own HOME (and therefore its own ~/.claude/skills), so no assertion depends on what an
  // earlier test installed: each test passes alone (--test-name-pattern) and in any order.
  const tmp = path.join(AGENT, 'add-tmp');
  before(() => { fs.mkdirSync(tmp, { recursive: true }); });
  let addHomeN = 0;
  const freshAddHome = () => { const d = path.join(AGENT, 'add-homes', `h${++addHomeN}`); fs.mkdirSync(d, { recursive: true }); return d; };
  const skillsIn = (addHome) => path.join(addHome, '.claude', 'skills');
  const listSkills = (addHome) => { try { return fs.readdirSync(skillsIn(addHome)).sort(); } catch { return []; } };
  const env = (home, addHome, extra = {}) => ({ ...baseEnv(home, { HOME: addHome, TMPDIR: tmp }), ...extra });
  const leftovers = () => fs.readdirSync(tmp).filter((n) => n.startsWith('singular-add-'));

  test('INSTALLED: pinned fetch, inspection, copy into ~/.claude/skills/<skill>, audit from the registry, installed.json; a rerun is REFUSED before any network call', async () => {
    const home = freshHome('add', { allowlist: ['evil-local'] });
    const addHome = freshAddHome();
    const skills = () => skillsIn(addHome);
    write(path.join(home, 'installed.json'), 'garbage{');
    const before = seenRequests();
    const r = await runBin('singular.js', ['add', 'evil-local/repo@playwright-e2e', '--yes'], { env: env(home, addHome) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], `INSTALLED evil-local/repo#${HEAD_SHA}@playwright-e2e sha ${HEAD_SHA}`);
    assert.equal(lines[1], `  path: ${path.join(skills(), 'playwright-e2e')} (2 files, inspected before and after the copy: clean)`);
    assert.equal(lines[2], '  source: evil-local/repo playwright-e2e');
    assert.match(r.stdout, /  audit: \{\n {4}"status": "pass",\n {4}"providers": \[/);
    assert.match(r.stdout, /\nRun \/reload-skills or start a new session to use it\.\n$/);
    assert.deepEqual(fs.readdirSync(path.join(skills(), 'playwright-e2e')).sort(), ['SKILL.md', 'reference.md']);
    assert.ok(!fs.lstatSync(path.join(skills(), 'playwright-e2e')).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(skills()), ['playwright-e2e'], 'exactly one entry created');
    const installed = readJson(path.join(home, 'installed.json'));
    assert.deepEqual(Object.keys(installed), ['evil-local/repo@playwright-e2e'], 'corrupt installed.json replaced');
    assert.deepEqual([installed['evil-local/repo@playwright-e2e'].sha, installed['evil-local/repo@playwright-e2e'].audit, installed['evil-local/repo@playwright-e2e'].files], [HEAD_SHA, 'pass', 2]);
    assert.deepEqual(leftovers(), [], 'temp checkout removed');
    const audits = registry.requests.slice(before).filter((x) => x.path.startsWith('/api/v1/skills/audit/'));
    assert.deepEqual(audits.map((x) => x.path), ['/api/v1/skills/audit/evil-local/repo/playwright-e2e']);
    const before2 = seenRequests();
    const again = await runBin('singular.js', ['add', 'evil-local/repo@playwright-e2e', '--yes'], { env: env(home, addHome) });
    assert.equal(again.code, 1);
    assert.equal(again.stdout, `REFUSED: ${path.join(skills(), 'playwright-e2e')} already exists (directory). Remove it yourself first; singular never overwrites.\n`);
    assert.equal(seenRequests() - before2, 0, 'the existence check comes before every network round trip');
    assert.ok(again.ms < 2000);
  });

  test('REJECTED: the malicious skill (exec bit + symlink in the tree, hooks/, bin/, capability frontmatter, shell forms) never touches ~/.claude/skills; no temp dir left; --json carries the problems', async () => {
    const home = freshHome('add-reject', { allowlist: ['evil-local'] });
    const addHome = freshAddHome();
    const skills = () => skillsIn(addHome);
    write(path.join(skills(), 'bystander', 'SKILL.md'), skillMd('bystander', 'already here'));
    const r = await runBin('singular.js', ['add', 'evil-local/repo@helpful-setup', '--yes'], { env: env(home, addHome) });
    assert.equal(r.code, 1);
    assert.match(r.stdout, new RegExp(`^REJECTED: evil-local/repo#${HEAD_SHA}@helpful-setup\n`));
    for (const needle of [
      'executable bit in repository tree: helpful-setup/bin/pwn (mode 100755)',
      'symlink in repository tree: helpful-setup/link (mode 120000)',
      'plugin component directory .claude-plugin/', 'plugin component directory hooks/', 'plugin component directory bin/', 'plugin component file .mcp.json',
      'frontmatter key "allowed-tools"', 'frontmatter key "hooks"', 'inline shell (!`) in SKILL.md line', 'fenced shell block', '@-file reference', 'frontmatter user-invocable: false',
    ]) assert.ok(r.stdout.includes(`\n  ${needle}`), `${needle}\n${r.stdout}`);
    assert.match(r.stdout, new RegExp(`\nNothing was written to ${skills().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\n$`));
    assert.ok(!fs.existsSync(path.join(skills(), 'helpful-setup')));
    assert.deepEqual(listSkills(addHome), ['bystander'], 'the pre-existing entry is untouched, nothing else appeared');
    assert.deepEqual(leftovers(), []);
    assert.ok(!fs.existsSync(path.join(home, 'installed.json')));
    const j = await runBin('singular.js', ['add', 'evil-local/repo@helpful-setup', '--yes', '--json'], { env: env(home, addHome) });
    assert.equal(j.code, 1);
    const out = JSON.parse(j.stdout);
    assert.deepEqual([out.status, out.copied, out.removed, out.sha], ['rejected', false, false, HEAD_SHA]);
    assert.ok(out.problems.length >= 12);
    assert.ok(readLog(home, 'add rejected before copy').length === 2);
  });

  test('refusals without git: non-allowlisted owner, invalid ref, a 101-char segment, blockedRefs; non-interactive without --yes; usage', async () => {
    const home = freshHome('add-refuse', { blockedRefs: ['anthropics/skills@pdf'] });
    const addHome = freshAddHome();
    const skills = () => skillsIn(addHome);
    write(path.join(skills(), 'bystander', 'SKILL.md'), skillMd('bystander', 'already here'));
    const before = seenRequests();
    const notAllowed = await runBin('singular.js', ['add', 'mattpocock/skills@tdd', '--yes'], { env: env(home, addHome) });
    assert.equal(notAllowed.code, 1);
    assert.equal(notAllowed.stdout, `REJECTED: owner "mattpocock" is not allowlisted [anthropics, vercel-labs, microsoft, multica-ai]. Add it to "allowlist" in ${path.join(home, 'config.json')} if you trust it.\n`);
    const invalid = await runBin('singular.js', ['add', 'nope', '--yes'], { env: env(home, addHome) });
    assert.equal(invalid.code, 1);
    assert.equal(invalid.stdout, 'invalid ref "nope": expected owner/repo@skill or owner/repo#<40-hex-sha>@skill\n');
    const tooLong = await runBin('singular.js', ['add', `anthropics/skills@${'s'.repeat(101)}`, '--yes'], { env: env(home, addHome) });
    assert.equal(tooLong.code, 1);
    assert.equal(tooLong.stdout, `invalid ref "anthropics/skills@${'s'.repeat(62)}": segments must start with a letter or digit\n`);
    const blocked = await runBin('singular.js', ['add', 'anthropics/skills@pdf', '--yes'], { env: env(home, addHome) });
    assert.equal(blocked.code, 1);
    assert.equal(blocked.stdout, 'REJECTED: anthropics/skills@pdf matches blockedRefs\n');
    const noYes = await runBin('singular.js', ['add', 'anthropics/skills@playwright-e2e'], { env: env(home, addHome) });
    assert.equal(noYes.code, 1);
    assert.equal(noYes.stdout, '');
    assert.equal(noYes.stderr, '[singular] not installed (pass --yes to skip this prompt; non-interactive runs require it)\n');
    // Observation: `--help` alone exits 1 (usage printed; exit 0 needs exactly one positional ref alongside it).
    for (const [args, code] of [[[], 1], [['a/b@c', 'd/e@f'], 1], [['--help'], 1], [['a/b@c', '--help'], 0]]) {
      const u = await runBin('singular.js', ['add', ...args], { env: env(home, addHome) });
      assert.equal(u.code, code, JSON.stringify(args));
      assert.equal(u.stderr, 'usage: singular add <owner/repo[#sha]@skill> [--yes] [--json]\n');
      assert.equal(u.stdout, '');
    }
    assert.equal(seenRequests() - before, 0);
    assert.deepEqual(listSkills(addHome), ['bystander'], 'nothing created; the pre-existing entry untouched');
    assert.deepEqual(leftovers(), []);
  });

  test('the #sha form skips the HEAD resolve; SINGULAR_SKILLS_DIR redirects the target (outside the project only); a bogus sha fails cleanly', async () => {
    const home = freshHome('add-sha', { allowlist: ['evil-local', 'anthropics'] });
    const addHome = freshAddHome();
    const skills = () => skillsIn(addHome);
    const alt = path.join(AGENT, 'alt-skills');
    const r = await runBin('singular.js', ['add', `anthropics/skills#${HEAD_SHA}@karpathy-guidelines`, '--yes', '--json'], { env: env(home, addHome, { SINGULAR_SKILLS_DIR: alt }) });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.status, out.sha, out.path, out.files], ['installed', HEAD_SHA, path.join(alt, 'karpathy-guidelines'), 1]);
    assert.ok(fs.existsSync(path.join(alt, 'karpathy-guidelines', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(skills(), 'karpathy-guidelines')), 'nothing under HOME/.claude/skills');
    assert.ok(readLog(home).some((l) => l.msg === 'add: test seam active' && /SINGULAR_SKILLS_DIR/.test(l.warning)));
    const inside = await runBin('singular.js', ['add', `anthropics/skills#${HEAD_SHA}@karpathy-guidelines`, '--yes', '--json'], { env: env(home, addHome, { SINGULAR_SKILLS_DIR: path.join(PROJ, 'skills') }) });
    assert.equal(JSON.parse(inside.stdout).path, path.join(skills(), 'karpathy-guidelines'), 'an in-project skills dir is ignored: default target');
    assert.ok(fs.existsSync(path.join(skills(), 'karpathy-guidelines')));
    assert.ok(!fs.existsSync(path.join(PROJ, 'skills')));
    const bogus = await runBin('singular.js', ['add', `evil-local/repo#${'0'.repeat(40)}@long-playwright-guide`, '--yes'], { env: env(home, addHome) });
    assert.equal(bogus.code, 1);
    assert.match(bogus.stdout, /^git fetch failed \(exit 128\).*could not fetch evil-local\/repo at 0{40}\n$/);
    assert.ok(!fs.existsSync(path.join(skills(), 'long-playwright-guide')));
    assert.deepEqual(leftovers(), []);
  });
});

// ---------------------------------------------------------------------------

describe('lib/commands/add.js (singular add) in-process branches (fake git)', () => {
  let addCmd;
  before(async () => { addCmd = await import('../lib/commands/add.js'); });
  const addHome = path.join(AGENT, 'add-home-fake');
  const tmp = path.join(AGENT, 'add-tmp-fake');
  const envOf = (home) => ({ HOME: addHome, SINGULAR_HOME: home, SINGULAR_REGISTRY_BASE: registry.base });
  const SHA = 'a'.repeat(40);

  function lsTreeOf(root, rel) {
    const lines = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        const st = fs.lstatSync(full);
        const relPath = path.relative(root, full).split(path.sep).join('/');
        if (st.isSymbolicLink()) lines.push(`120000 blob ${'0'.repeat(40)}\t${relPath}`);
        else if (st.isDirectory()) walk(full);
        else lines.push(`${st.mode & 0o111 ? '100755' : '100644'} blob ${'0'.repeat(40)}\t${relPath}`);
      }
    };
    walk(rel === '.' ? root : path.join(root, rel));
    return `${lines.join('\n')}\n`;
  }
  function fakeGit({ populate, onLsTree, fail } = {}) {
    const calls = [];
    const impl = (file, args, options, cb) => {
      calls.push({ file, args, options });
      process.nextTick(() => {
        const failure = fail ? fail(file, args) : null;
        if (failure) { cb(Object.assign(new Error('boom'), { code: 128 }), '', failure); return; }
        if (file !== 'git') { cb(Object.assign(new Error(`unexpected ${file}`), { code: 127 }), '', ''); return; }
        if (args[0] === 'ls-remote') { cb(null, `${SHA}\tHEAD\n`, ''); return; }
        if (args.includes('checkout')) { if (populate) populate(options.cwd); cb(null, '', ''); return; }
        if (args[0] === 'ls-tree') { const rel = args[args.length - 1]; if (onLsTree) onLsTree(); cb(null, lsTreeOf(options.cwd, rel), ''); return; }
        cb(null, '', '');
      });
      return { stdin: { end() {} } };
    };
    return { impl, calls };
  }

  test('a credential prompt from git (missing or private repository) is explained in the error', async () => {
    const home = freshHome('add-cred');
    const exec = fakeGit({ fail: (file, args) => (args[0] === 'ls-remote' ? "fatal: could not read Username for 'https://github.com': terminal prompts disabled" : null) });
    const r = await addCmd.runAdd({ ref: 'anthropics/private-repo@x', env: envOf(home), deps: { execFileImpl: exec.impl, tmpdir: tmp } });
    assert.equal(r.status, 'error');
    assert.match(r.message, /^could not resolve HEAD of https:\/\/github\.com\/anthropics\/private-repo: git ls-remote https:\/\/github\.com\/anthropics\/private-repo failed \(exit 128\): repository not found or private \(GitHub asked for credentials\): fatal: could not read Username for 'https:\/\/github\.com': terminal prompts disabled$/);
    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
  });

  test('no skill with that exact, case-sensitive name: the error lists every folder found, with "(name: <frontmatter name>)" where it differs from the directory', async () => {
    const home = freshHome('add-nomatch');
    const exec = fakeGit({ populate: (cwd) => { fs.cpSync(CLEAN, path.join(cwd, 'docx'), { recursive: true }); write(path.join(cwd, 'skills', 'same', 'SKILL.md'), skillMd('same', 'name equals the folder')); write(path.join(cwd, 'skills', 'noname', 'SKILL.md'), '# no frontmatter\n'); } });
    const r = await addCmd.runAdd({ ref: `anthropics/skills#${SHA}@DOCX`, env: envOf(home), deps: { execFileImpl: exec.impl, tmpdir: tmp } });
    assert.equal(r.status, 'error');
    assert.equal(r.message, 'no skill named "DOCX" in anthropics/skills at aaaaaaa (exact, case-sensitive). Found: docx (name: clean-guidelines), noname, same');
    assert.ok(!exec.calls.some((c) => c.args[0] === 'ls-tree'), 'nothing inspected or copied');
    assert.ok(!fs.existsSync(path.join(addHome, '.claude', 'skills', 'DOCX')) && !fs.existsSync(path.join(addHome, '.claude', 'skills', 'docx')));
    const none = fakeGit({ populate: () => {} });
    const r2 = await addCmd.runAdd({ ref: `anthropics/skills#${SHA}@ghost`, env: envOf(home), deps: { execFileImpl: none.impl, tmpdir: tmp } });
    assert.equal(r2.message, 'no skill named "ghost" in anthropics/skills at aaaaaaa (exact, case-sensitive). Found: none');
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('singular-add-')), [], 'temp checkouts removed');
  });

  test('git ls-tree failure is an error (nothing copied); a post-copy snapshot mismatch is a rejection that removes exactly what this run created', async () => {
    const home = freshHome('add-post');
    const root = path.join(addHome, '.claude', 'skills');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'pre-existing'), 'keep me');
    const lsFail = fakeGit({ populate: (cwd) => fs.cpSync(CLEAN, path.join(cwd, 'skills', 'x1'), { recursive: true }), fail: (file, args) => (args[0] === 'ls-tree' ? 'fatal: not a tree object' : null) });
    const r1 = await addCmd.runAdd({ ref: `anthropics/skills#${SHA}@x1`, env: envOf(home), deps: { execFileImpl: lsFail.impl, tmpdir: tmp } });
    assert.equal(r1.status, 'error');
    assert.equal(r1.message, 'git ls-tree failed (exit 128): fatal: not a tree object');
    assert.ok(!fs.existsSync(path.join(root, 'x1')));
    // something else appears in ~/.claude/skills between the snapshot and the copy (simulated by wrapping
    // fs.cpSync for this one call): the run is rejected, ONLY the run's own folder is removed, and the extra entry
    // (a concurrent writer's: another install tool, a sync) is left untouched and named in the problems
    // (security review 2026-10-08: it used to be deleted although singular never created it)
    const origCp = fs.cpSync;
    const planted = fakeGit({ populate: (cwd) => fs.cpSync(CLEAN, path.join(cwd, 'skills', 'x2'), { recursive: true }) });
    let r2;
    try {
      // only the copy INTO the skills dir is intercepted (the fake checkout populates itself with cpSync too)
      fs.cpSync = (src, dest, opts) => { if (String(dest).startsWith(root + path.sep)) fs.mkdirSync(path.join(root, 'planted-during-run'), { recursive: true }); return origCp.call(fs, src, dest, opts); };
      r2 = await addCmd.runAdd({ ref: `anthropics/skills#${SHA}@x2`, env: envOf(home), deps: { execFileImpl: planted.impl, tmpdir: tmp } });
    } finally {
      fs.cpSync = origCp;
    }
    assert.equal(r2.status, 'rejected', r2.message);
    assert.equal(r2.copied, true);
    assert.equal(r2.removed, true);
    assert.match(r2.problems[0], /^expected exactly one new entry \(x2\) in .*, got: (planted-during-run, x2|x2, planted-during-run)$/);
    assert.match(r2.message, /^REJECTED: anthropics\/skills#a{40}@x2\n  expected exactly one new entry/);
    assert.ok(!fs.existsSync(path.join(root, 'x2')));
    assert.ok(fs.existsSync(path.join(root, 'planted-during-run')), 'an entry another writer created during the copy is NOT removed: only the folder this run wrote is');
    assert.equal(r2.problems[r2.problems.length - 1], `other entries appeared in ${root} during the copy and were left untouched (not created by singular): planted-during-run`, JSON.stringify(r2.problems));
    assert.match(r2.message, /left untouched \(not created by singular\): planted-during-run\nRemoved .*x2\.$/);
    assert.equal(fs.readFileSync(path.join(root, 'pre-existing'), 'utf8'), 'keep me');
    assert.ok(processLog('add rejected after copy').length >= 1);
    // a copy that fails midway is an error and the partial folder is removed
    const failing = fakeGit({ populate: (cwd) => fs.cpSync(CLEAN, path.join(cwd, 'skills', 'x3'), { recursive: true }) });
    let r3;
    try {
      fs.cpSync = (src, dest, opts) => {
        if (!String(dest).startsWith(root + path.sep)) return origCp.call(fs, src, dest, opts);
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'partial'), 'x');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      };
      r3 = await addCmd.runAdd({ ref: `anthropics/skills#${SHA}@x3`, env: envOf(home), deps: { execFileImpl: failing.impl, tmpdir: tmp } });
    } finally {
      fs.cpSync = origCp;
    }
    assert.equal(r3.status, 'error');
    assert.match(r3.message, /^copy into .*x3 failed: disk full \(partial copy removed\)$/);
    assert.ok(!fs.existsSync(path.join(root, 'x3')));
    assert.ok(!fs.existsSync(path.join(home, 'installed.json')));
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('singular-add-')), []);
  });

  test('helpers: parseCliJson finds JSON after an ANSI box and gives up cleanly; unsafeTreeEntries classifies every mode; skillsDir honours only a valid seam', async () => {
    assert.deepEqual(addCmd.parseCliJson('\x1b[1m┌┐\x1b[0m\n[\n {"a": 1}\n]\ntrailing'), [{ a: 1 }]);
    assert.deepEqual(addCmd.parseCliJson('{"x": [1, 2]}'), { x: [1, 2] });
    assert.equal(addCmd.parseCliJson('[ not json at all'), null);
    assert.equal(addCmd.parseCliJson(''), null);
    assert.equal(addCmd.parseCliJson(null), null);
    assert.deepEqual(addCmd.unsafeTreeEntries(`100644 blob ${'0'.repeat(40)}\ta/b.md\n100755 blob ${'0'.repeat(40)}\ta/run.sh\n120000 blob ${'0'.repeat(40)}\ta/link\n160000 commit ${'0'.repeat(40)}\ta/sub\n040000 tree ${'0'.repeat(40)}\ta/dir\nweird\n\n`).map((e) => [e.why, e.path, e.mode]), [
      ['executable bit', 'a/run.sh', '100755'], ['symlink', 'a/link', '120000'], ['git submodule', 'a/sub', '160000'], ['unexpected mode/type 040000 tree', 'a/dir', '040000'], ['unparseable ls-tree line', 'weird', '?'],
    ]);
    assert.deepEqual(addCmd.unsafeTreeEntries(''), []);
    assert.equal(addCmd.skillsDir({ HOME: addHome }), path.join(addHome, '.claude', 'skills'));
    assert.equal(addCmd.skillsDir({ HOME: addHome, SINGULAR_SKILLS_DIR: path.join(AGENT, 'alt2') }), path.join(AGENT, 'alt2'));
    assert.equal(addCmd.skillsDir({ HOME: addHome, SINGULAR_SKILLS_DIR: 'relative' }), path.join(addHome, '.claude', 'skills'));
  });
});

// ---------------------------------------------------------------------------

describe('bin/singular.js find as a child process against the loopback registry', () => {
  test('--json: installed matches, accepted table, rejected list ranked by relevance, the explicit joined search, audits; stdout parses', async () => {
    const home = freshHome('find');
    const before = seenRequests();
    const r = await runBin('singular.js', ['find', 'playwright e2e flaky tests', '--json', '--cwd', PROJ, '--limit', '3'], { env: baseEnv(home, { HOME: SKILLS_HOME }) });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.query, 'playwright e2e flaky tests');
    assert.ok(j.keywords.includes('playwright'));
    assert.equal(j.local[0].name, 'playwright');
    assert.equal(j.local[0].scope, 'user');
    assert.ok(j.accepted.length >= 1 && j.accepted.length <= 3);
    assert.equal(j.accepted[0].ref, 'anthropics/skills@playwright-e2e');
    assert.deepEqual([j.accepted[0].audit, j.accepted[0].allowlisted, j.accepted[0].installs], ['pass', true, 50000]);
    assert.ok(j.rejected.some((x) => x.ref === 'evil-local/repo@playwright-e2e' && /fork of anthropics\/skills@playwright-e2e \(owner evil-local not allowlisted\)/.test(x.reason)));
    assert.ok(j.rejected.some((x) => x.ref === 'lowinstalls/x@playwright-tiny' && /not allowlisted/.test(x.reason)));
    assert.ok(j.rejected.every((x) => typeof x.rank === 'number' && Array.isArray(x.matched)));
    const search = j.queries.find((q) => q.kind === 'search');
    assert.ok(search && /^playwright/.test(search.q), JSON.stringify(j.queries));
    assert.equal(j.configPath, path.join(home, 'config.json'));
    assert.equal(typeof j.elapsedMs, 'number');
    const reqs = registry.requests.slice(before);
    assert.ok(reqs.some((x) => x.path === '/api/search' && x.q === search.q && x.owner === null), 'the joined query went out once (explicit search)');
    assert.ok(reqs.some((x) => x.path === '/api/search' && x.q === 'skill' && x.owner === 'anthropics'));
    assert.ok(reqs.some((x) => x.path === '/api/v1/skills/audit/anthropics/skills/playwright-e2e'));
    assert.equal(readLog(home, 'find').length, 1);
  });

  test('text report: table header, load/install hints, grouped rejections, "Best allowlist-only rejection" naming the owner; --all lists every rejected entry', async () => {
    const home = freshHome('find-text');
    const r = await runBin('singular.js', ['find', 'supabase', 'auth', '--cwd', PROJ], { env: baseEnv(home) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^\[singular\] query: "supabase auth"  keywords: supabase, auth  stack: Next\.js 16/);
    assert.match(r.stdout, /\nInstalled locally: no match\./);
    assert.match(r.stdout, /\(none passed the gates\)/);
    assert.match(r.stdout, /\nRejected: \d+\n/);
    assert.match(r.stdout, /\n  \d+ x owner not allowlisted/);
    assert.match(r.stdout, /\n  Best allowlist-only rejection: supabase\/agent-skills@supabase(-auth)? \([\d.]+K installs, matched supabase[^)]*\) - add "supabase" to "allowlist" in .*config\.json to consider it/);
    assert.match(r.stdout, /\n  top rejected by relevance \(use --all for the full list\):\n {4}supabase\/agent-skills@/);
    assert.match(r.stdout, /\n\(\d+ requests, cached: (true|false), \d+ ms\)\n$/);
    const all = await runBin('singular.js', ['find', 'supabase auth', '--cwd', PROJ, '--all'], { env: baseEnv(home) });
    assert.match(all.stdout, /all rejected entries \(by relevance, then installs\):/);
    const withMatch = await runBin('singular.js', ['find', 'playwright e2e', '--cwd', PROJ], { env: baseEnv(home) });
    assert.match(withMatch.stdout, /\n  ref {62}installs {2}audit {4}allowlisted\?\n  anthropics\/skills@playwright-e2e {33}50\.0K {5}pass {5}yes\n/);
    assert.match(withMatch.stdout, /\n  Best allowlist-only rejection: long-owner\/repo@long-playwright-guide \(40\.0K installs, matched playwright\) - add "long-owner" to "allowlist" in /);
    const pad = (t, n) => (t.length >= n ? t : t + ' '.repeat(n - t.length));
    assert.ok(withMatch.stdout.includes(`\n    ${pad('ghost-owner/none@playwright-e2e', 64)} ${pad('30.0K', 9)} fork of anthropics/skills@playwright-e2e (owner ghost-owner not allowlisted)  [matched playwright, e2e]\n`), withMatch.stdout);
    assert.ok(withMatch.stdout.includes(`\n    ${pad('lowinstalls/x@playwright-tiny', 64)} ${pad('12', 9)} owner lowinstalls not allowlisted  [matched playwright]\n`));
    assert.match(withMatch.stdout, /Load ephemerally \(text only\):  \/singular load <ref>\n  Install persistently \(pinned\): \/singular add <ref>/);
    assert.match(withMatch.stdout, /x fork of \.\.\./);
  });

  test('empty registry -> "(none passed the gates)" and Rejected: 0; HTTP 429 -> rate-limited report + cooldown shown by `singular status`; a hostile query is just words', async () => {
    const home = freshHome('find-empty');
    registry.empty = true;
    let r;
    try { r = await runBin('singular.js', ['find', 'playwright e2e', '--cwd', PROJ], { env: baseEnv(home) }); } finally { registry.empty = false; }
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\(none passed the gates\)\n\nRejected: 0\n/);
    const limitedHome = freshHome('find-429');
    registry.status = 429;
    let lim;
    try { lim = await runBin('singular.js', ['find', 'playwright e2e', '--cwd', PROJ], { env: baseEnv(limitedHome) }); } finally { registry.status = null; }
    assert.equal(lim.code, 0, lim.stderr);
    assert.match(lim.stdout, /Third-party search failed \(skills\.sh rate-limited until \d\d:\d\d\); nothing could be evaluated\./);
    assert.match(lim.stdout, /Rejected: n\/a \(rate-limited until \d\d:\d\d\)/);
    assert.match(lim.stdout, /skills\.sh rate-limited until \d\d:\d\d, \d+ ms\)\n$/);
    const st = await runBin('singular.js', ['status', '--cwd', PROJ], { env: baseEnv(limitedHome) });
    assert.match(st.stdout, /\nskills\.sh: rate-limited \(HTTP 429\) — no requests until \d\d:\d\d; cached catalogs still rank\n/);
    const stj = JSON.parse((await runBin('singular.js', ['status', '--json', '--cwd', PROJ], { env: baseEnv(limitedHome) })).stdout);
    assert.ok(stj.cooldownUntil > Date.now());
    const before = seenRequests();
    const hostile = await runBin('singular.js', ['find', '; rm -rf ~ $(whoami) <script>alert(1)</script> `id` supabase', '--cwd', PROJ], { env: baseEnv(home) });
    assert.equal(hostile.code, 0, hostile.stderr);
    assert.match(hostile.stdout, /^\[singular\] query: "; rm -rf ~ \$\(whoami\) <script>alert\(1\)<\/script> `id` supabase"  keywords: /);
    const qs = registry.requests.slice(before).filter((x) => x.path === '/api/search').map((x) => x.q);
    assert.ok(qs.every((q) => /^[a-z0-9 ]+$/.test(q)), `only tokenized words reach the registry: ${JSON.stringify(qs)}`);
    const stop = await runBin('singular.js', ['find', 'the and of to', '--cwd', PROJ], { env: baseEnv(home) });
    assert.equal(stop.code, 0);
    assert.match(stop.stdout, /keywords: \(none\)/);
    assert.match(stop.stdout, /\(0 requests, cached: false, \d+ ms\)/);
  });

  test('usage without a query (exit 1), --help (exit 0), --limit clamps, --cwd changes the stack', async () => {
    const home = freshHome('find-usage');
    const u = await runBin('singular.js', ['find', ], { env: baseEnv(home) });
    assert.equal(u.code, 1);
    assert.equal(u.stderr, 'usage: singular find "<query>" [--limit N] [--all] [--json] [--cwd <dir>]\n');
    assert.equal(u.stdout, '');
    const h = await runBin('singular.js', ['find', '--help'], { env: baseEnv(home) });
    assert.equal(h.code, 0);
    assert.match(h.stderr, /^usage: singular find/);
    const clamp = JSON.parse((await runBin('singular.js', ['find', 'playwright', '--json', '--limit', '999', '--cwd', PROJ], { env: baseEnv(home) })).stdout);
    assert.ok(clamp.accepted.length <= 50);
    const elsewhere = JSON.parse((await runBin('singular.js', ['find', 'playwright', '--json', '--cwd', EMPTY_HOME], { env: baseEnv(home) })).stdout);
    assert.equal(elsewhere.stack, '', 'no stack in an empty dir');
  });
});

// ---------------------------------------------------------------------------

describe('bin/singular.js status as a child process', () => {
  test('--json and text: version, paths, config, index counts, stack, pins, installs, log tail; missing config is created; env overrides and seams listed', async () => {
    const home = freshHome('status');
    write(path.join(home, 'loaded.json'), JSON.stringify({ 'a/b@c': { ref: `a/b#${'1'.repeat(40)}@c`, sha: '1'.repeat(40), ts: 1, lastTs: 1, loads: 2, stripped: ['x'] } }));
    write(path.join(home, 'installed.json'), JSON.stringify({ 'd/e@f': { sha: '2'.repeat(40), path: '/x/f', audit: 'pass' } }));
    const r = await runBin('singular.js', ['status', '--json', '--cwd', PROJ], { env: baseEnv(home, { HOME: SKILLS_HOME, SINGULAR_MODE: 'local', CLAUDE_CONFIG_DIR: path.join(SKILLS_HOME, '.claude') }) });
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.version, '0.3.0');
    assert.equal(s.pluginRoot, ROOT);
    assert.equal(s.home, home);
    assert.equal(s.configPath, path.join(home, 'config.json'));
    assert.equal(s.defaultConfigPath, path.join(SKILLS_HOME, '.claude', 'singular', 'config.json'));
    assert.ok(fs.existsSync(path.join(home, 'config.json')), 'created on first run');
    assert.equal(s.config.mode, 'local');
    assert.equal(s.fileMode, 'suggest');
    assert.deepEqual(s.envOverrides, { SINGULAR_HOME: home, SINGULAR_MODE: 'local', CLAUDE_CONFIG_DIR: path.join(SKILLS_HOME, '.claude'), SINGULAR_REGISTRY_BASE: registry.base, SINGULAR_GIT_BASE: GIT_SEAM, SINGULAR_SKILLS_DIR: null, SINGULAR_TEST_ALLOW_AUTO: null });
    assert.deepEqual(s.testSeams, ['SINGULAR_REGISTRY_BASE', 'SINGULAR_GIT_BASE']);
    assert.equal(s.configWarnings.filter((w) => /^TEST SEAM ACTIVE/.test(w)).length, 2);
    assert.deepEqual(s.index, { total: 3, byScope: { user: 3 } });
    assert.match(s.stack.summary, /^Next\.js 16/);
    assert.equal(s.cwd, PROJ);
    assert.equal(s.loaded['a/b@c'].loads, 2);
    assert.equal(s.installed['d/e@f'].audit, 'pass');
    assert.equal(s.cooldownUntil, null);
    assert.equal(s.autoWarned, false);
    assert.equal(s.log.path, path.join(home, 'singular.log'));
    const t = await runBin('singular.js', ['status', '--cwd', PROJ], { env: baseEnv(home, { HOME: SKILLS_HOME, SINGULAR_MODE: 'local' }) });
    assert.equal(t.code, 0);
    const lines = t.stdout.split('\n');
    assert.equal(lines[0], `[singular] singular 0.3.0  plugin root: ${ROOT}`);
    assert.equal(lines[1], `state dir: ${home}`);
    assert.equal(lines[2], `config:    ${path.join(home, 'config.json')}`);
    assert.match(t.stdout, /\n  mode: "local"\n/);
    assert.match(t.stdout, /\nenv overrides: SINGULAR_HOME=.* SINGULAR_MODE=local SINGULAR_REGISTRY_BASE=http:\/\/127\.0\.0\.1:\d+ SINGULAR_GIT_BASE=file:/);
    assert.match(t.stdout, /\n  TEST SEAMS ACTIVE \(not for real use, see docs\/testing\.md\): SINGULAR_REGISTRY_BASE, SINGULAR_GIT_BASE\n/);
    assert.match(t.stdout, /\n  effective mode "local" \(file says "suggest"; the environment can only lower the mode, and "auto" counts only in /);
    assert.match(t.stdout, /\ninstalled skills indexed: 3 \(user 3\)\n/);
    assert.match(t.stdout, /\nloaded pins \(\/singular load, ephemeral\): 1\n  a\/b@c -> 1{40}  loads 2  last 1970-01-01T00:00:00\.001Z  stripped: 1\n/);
    assert.match(t.stdout, /\npersistent installs \(\/singular add\): 1\n  d\/e@f -> 2{40}  \/x\/f  audit pass\n/);
    assert.match(t.stdout, /\nlog: .*singular\.log\n/);
    // `/singular` and `/singular status` end with the one-screen help (text mode only: the --json output above parsed)
    const { HELP } = await import('../bin/singular.js');
    assert.ok(t.stdout.endsWith(`\n\n${HELP}\n`), t.stdout.slice(-300));
    assert.match(HELP, /^Singular — find, load, add and manage third-party skills for Claude Code\n/);
    for (const cmd of ['/singular status', '/singular find <query>', '/singular load owner/repo@skill', '/singular add owner/repo@skill', '/singular mode [off|local|suggest|auto]', '/singular help']) assert.ok(HELP.includes(`  ${cmd}`), cmd);
    assert.doesNotMatch(HELP, /scout/);
    const bare = await runBin('singular.js', ['--cwd', PROJ], { env: baseEnv(home, { HOME: SKILLS_HOME, SINGULAR_MODE: 'local' }) });
    assert.equal(bare.code, 0, bare.stderr);
    assert.equal(bare.stdout.split('\n')[0], lines[0], 'a bare `singular` (only options) is `status`');
    assert.ok(bare.stdout.endsWith(`\n\n${HELP}\n`));
  });

  test('corrupt config -> "!" warning line; config.json as a directory -> EISDIR warning, nothing created; mode auto in the default home -> WARNING line; pinnedSkills listed', async () => {
    const corrupt = freshHome('status-corrupt');
    write(path.join(corrupt, 'config.json'), '{ "mode": ');
    const c = await runBin('singular.js', ['status', '--cwd', PROJ], { env: baseEnv(corrupt) });
    assert.equal(c.code, 0, c.stderr);
    assert.match(c.stdout, /\n  ! config\.json is not valid JSON \(.*\); using defaults\n/);
    assert.match(c.stdout, /\n  mode: "suggest"\n/);
    const cj = JSON.parse((await runBin('singular.js', ['status', '--json', '--cwd', PROJ], { env: baseEnv(corrupt) })).stdout);
    assert.ok(cj.configWarnings.some((w) => /not valid JSON/.test(w)));
    const eisdir = freshHome('status-eisdir');
    fs.mkdirSync(path.join(eisdir, 'config.json'));
    const e = await runBin('singular.js', ['status', '--cwd', PROJ], { env: baseEnv(eisdir) });
    assert.match(e.stdout, /\n  ! config\.json unreadable \(EISDIR\); using defaults\n/);
    assert.ok(fs.statSync(path.join(eisdir, 'config.json')).isDirectory());
    const home = path.join(AGENT, 'status-auto-home');
    write(path.join(home, '.claude', 'singular', 'config.json'), JSON.stringify({ mode: 'auto', pinnedSkills: ['karpathy-guidelines'] }));
    const a = await runBin('singular.js', ['status', '--cwd', PROJ], { env: { HOME: home } });
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /\n  mode: "auto"\n/);
    assert.match(a.stdout, /\n  WARNING: mode "auto" injects allowlisted third-party skill text without confirmation/);
    assert.match(a.stdout, /\n  pinnedSkills \(injected once per session\): karpathy-guidelines\n/);
    assert.match(a.stdout, /\ninstalled skills indexed: 0 \(none\)\n/);
  });
});

// ---------------------------------------------------------------------------

describe('bin/singular.js mode as a child process', () => {
  test('every transition in the default home (HOME at a scratch dir): off -> local -> suggest -> auto (with the warning) -> off; only the mode key changes; --json shape', async () => {
    const home = path.join(AGENT, 'mode-home');
    const file = path.join(home, '.claude', 'singular', 'config.json');
    write(file, JSON.stringify({ mode: 'suggest', allowlist: ['anthropics'], custom: { keep: true } }, null, 2));
    const env = { HOME: home };
    const show = await runBin('singular.js', ['mode', ], { env });
    assert.equal(show.code, 0, show.stderr);
    assert.equal(show.stdout, `[singular] mode: suggest  (config file: ${file})\n  usage: /singular mode <off|local|suggest|auto>\n`);
    let prev = 'suggest';
    for (const next of ['off', 'local', 'suggest', 'auto', 'off', 'auto', 'local']) {
      const r = await runBin('singular.js', ['mode', next], { env });
      assert.equal(r.code, 0, `${prev} -> ${next}: ${r.stderr}`);
      assert.ok(r.stdout.startsWith(`[singular] mode: ${prev} -> ${next} (${file}). Takes effect on the next prompt; no restart needed.`), r.stdout);
      if (next === 'auto') assert.match(r.stdout, /\n\[singular\] mode "auto": third-party skill text from allowlisted skills\.sh sources will be injected into your prompts WITHOUT confirmation .* Run \/singular mode suggest to go back\.\n$/);
      else assert.doesNotMatch(r.stdout, /WITHOUT confirmation/);
      const cfg = readJson(file);
      assert.equal(cfg.mode, next);
      assert.deepEqual(cfg.allowlist, ['anthropics']);
      assert.deepEqual(cfg.custom, { keep: true });
      assert.deepEqual(Object.keys(cfg), ['mode', 'allowlist', 'custom'], 'no other key added');
      prev = next;
    }
    const same = await runBin('singular.js', ['mode', 'local', '--json'], { env });
    assert.equal(same.code, 0);
    const j = JSON.parse(same.stdout);
    assert.deepEqual(Object.keys(j), ['status', 'mode', 'previous', 'path', 'message', 'warnings']);
    assert.deepEqual([j.status, j.mode, j.previous, j.path, j.warnings], ['ok', 'local', 'local', file, []]);
    assert.match((await runBin('singular.js', ['mode', ], { env })).stdout, /^\[singular\] mode: local/);
    assert.ok(readLog(path.join(home, '.claude', 'singular'), 'mode').length >= 8);
    assert.match((await runBin('singular.js', ['mode', 'AUTO'], { env })).stdout, /mode: local -> auto/, 'case-insensitive');
    assert.equal(readJson(file).mode, 'auto');
  });

  test('refusals: invalid mode, auto in a redirected home, two positionals, config that is an array / corrupt / a directory / unwritable; --help; every message carries the tag', async (t) => {
    const home = path.join(AGENT, 'mode-home-2');
    const env = { HOME: home };
    const bad = await runBin('singular.js', ['mode', 'sometimes'], { env });
    assert.equal(bad.code, 1);
    assert.equal(bad.stdout, '[singular] unknown mode "sometimes"; expected one of off | local | suggest | auto\n');
    const redirected = freshHome('mode-redirect', { mode: 'suggest' });
    const auto = await runBin('singular.js', ['mode', 'auto'], { env: { HOME: home, SINGULAR_HOME: redirected } });
    assert.equal(auto.code, 1);
    assert.equal(auto.stdout, `[singular] refusing to write mode "auto" into ${path.join(redirected, 'config.json')}: auto is honoured only in the default ${path.join(home, '.claude', 'singular')}/config.json (unset SINGULAR_HOME first)\n`);
    assert.equal(readJson(path.join(redirected, 'config.json')).mode, 'suggest');
    const two = await runBin('singular.js', ['mode', 'local', 'off'], { env });
    assert.equal(two.code, 1);
    assert.equal(two.stderr, 'usage: singular mode [off|local|suggest|auto] [--json]\n');
    const help = await runBin('singular.js', ['mode', '--help'], { env });
    assert.equal(help.code, 0);
    assert.equal(help.stderr, 'usage: singular mode [off|local|suggest|auto] [--json]\n');
    const arr = freshHome('mode-array');
    fs.writeFileSync(path.join(arr, 'config.json'), '["suggest"]');
    const a = await runBin('singular.js', ['mode', 'local'], { env: { HOME: home, SINGULAR_HOME: arr } });
    assert.equal(a.code, 1);
    assert.equal(a.stdout, `[singular] ${path.join(arr, 'config.json')} is not a JSON object; fix it by hand first\n`);
    assert.equal(fs.readFileSync(path.join(arr, 'config.json'), 'utf8'), '["suggest"]', 'not clobbered');
    const corrupt = freshHome('mode-corrupt');
    fs.writeFileSync(path.join(corrupt, 'config.json'), '{ nope');
    const c = await runBin('singular.js', ['mode', 'local'], { env: { HOME: home, SINGULAR_HOME: corrupt } });
    assert.equal(c.code, 1);
    assert.match(c.stdout, /^\[singular\] .*config\.json is not valid JSON \(.+\); fix it by hand first\n$/);
    assert.equal(fs.readFileSync(path.join(corrupt, 'config.json'), 'utf8'), '{ nope');
    const eisdir = freshHome('mode-eisdir');
    fs.mkdirSync(path.join(eisdir, 'config.json'));
    const d = await runBin('singular.js', ['mode', 'local'], { env: { HOME: home, SINGULAR_HOME: eisdir } });
    assert.equal(d.code, 1);
    assert.equal(d.stdout, `[singular] ${path.join(eisdir, 'config.json')} is unreadable (EISDIR); fix it by hand first\n`);
    const missing = freshHome('mode-missing');
    const m = await runBin('singular.js', ['mode', 'local'], { env: { HOME: home, SINGULAR_HOME: missing } });
    assert.equal(m.code, 0, m.stderr);
    assert.match(m.stdout, /mode: suggest -> local/);
    assert.deepEqual(readJson(path.join(missing, 'config.json')), { ...JSON.parse(JSON.stringify(DEFAULTS)), mode: 'local' }, 'a missing file is created from DEFAULTS with the new mode');
    if (typeof process.getuid === 'function' && process.getuid() === 0) { t.diagnostic('root: unwritable case skipped'); return; }
    const ro = freshHome('mode-readonly', { mode: 'suggest' });
    fs.chmodSync(ro, 0o555);
    try {
      const w = await runBin('singular.js', ['mode', 'local'], { env: { HOME: home, SINGULAR_HOME: ro } });
      assert.equal(w.code, 1);
      assert.match(w.stdout, /^\[singular\] could not write .*config\.json: EACCES/);
      assert.equal(readJson(path.join(ro, 'config.json')).mode, 'suggest');
    } finally {
      fs.chmodSync(ro, 0o755);
    }
  });

  test('show with an environment override explains file vs effective; a relative SINGULAR_HOME is reported with a "!" line in show, set and --json', async () => {
    const home = path.join(AGENT, 'mode-home-3');
    write(path.join(home, '.claude', 'singular', 'config.json'), JSON.stringify({ mode: 'suggest' }));
    const show = await runBin('singular.js', ['mode', ], { env: { HOME: home, SINGULAR_MODE: 'local' } });
    assert.equal(show.code, 0, show.stderr);
    assert.equal(show.stdout.split('\n')[0], '[singular] mode: local  (config file: ' + path.join(home, '.claude', 'singular', 'config.json') + ')');
    assert.equal(show.stdout.split('\n')[1], '  file says "suggest"; effective "local" (environment override)');
    const raised = await runBin('singular.js', ['mode', ], { env: { HOME: home, SINGULAR_MODE: 'auto' } });
    assert.match(raised.stdout, /^\[singular\] mode: suggest/);
    assert.match(raised.stdout, /\n  ! SINGULAR_MODE=auto ignored \(the environment can only lower the mode below "suggest"\)\n/);
    const rel = await runBin('singular.js', ['mode', ], { env: { HOME: home, SINGULAR_HOME: 'rel-dir' }, cwd: PROJ });
    assert.match(rel.stdout, /\n  ! SINGULAR_HOME=rel-dir ignored \(must be an absolute path\)\n/);
    const set = await runBin('singular.js', ['mode', 'local'], { env: { HOME: home, SINGULAR_HOME: 'rel-dir' }, cwd: PROJ });
    assert.equal(set.code, 0);
    assert.match(set.stdout, /^\[singular\] mode: suggest -> local \(.*\/mode-home-3\/\.claude\/singular\/config\.json\)/);
    assert.match(set.stdout, /\n  ! SINGULAR_HOME=rel-dir ignored \(must be an absolute path\)\n$/);
    const j = JSON.parse((await runBin('singular.js', ['mode', 'suggest', '--json'], { env: { HOME: home, SINGULAR_HOME: 'rel-dir' }, cwd: PROJ })).stdout);
    assert.deepEqual(j.warnings, ['SINGULAR_HOME=rel-dir ignored (must be an absolute path)']);
    assert.ok(!fs.existsSync(path.join(PROJ, 'rel-dir')));
  });
});

// ---------------------------------------------------------------------------

describe('bin/on-subagent.js (SubagentStart) as a child process', () => {
  const input = (overrides = {}) => JSON.stringify({ session_id: 's1', transcript_path: '/x.jsonl', cwd: PROJ, prompt_id: 'p1', agent_id: 'agent_123', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', ...overrides });
  const STACK = '[singular] Stack: Next.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm; branch main';

  test('the 2.1.293 stdin shape -> the exact envelope, nothing else; log carries agent ids; zero registry requests; fast', async () => {
    const home = freshHome('subagent', { mode: 'suggest' });
    const before = seenRequests();
    const r = await runBin('on-subagent.js', [], { env: baseEnv(home, { HOME: SKILLS_HOME }), input: input() });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"${STACK}"}}`);
    assert.equal(r.stderr, '');
    assert.ok(r.ms < 3000, 'well inside the 3 s hook timeout');
    const log = readLog(home, 'on-subagent');
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].sessionId, log[0].agentId, log[0].agentType, log[0].skipped, log[0].chars], ['s1', 'agent_123', 'general-purpose', null, STACK.length]);
    assert.equal(seenRequests() - before, 0, 'no network, ever');
    assert.doesNotMatch(r.stdout, /Installed skills|Third-party|singular-loaded/);
  });

  test('nothing printed (exit 0) for: another event, no cwd, an empty-stack cwd, mode off, stackDetection false, bad JSON, empty stdin; --dry-run and --help', async () => {
    const home = freshHome('subagent-skip', { mode: 'suggest' });
    const before = seenRequests();
    const empty = path.join(AGENT, 'empty-cwd');
    fs.mkdirSync(empty, { recursive: true });
    const cases = [
      ['SubagentStop', input({ hook_event_name: 'SubagentStop' }), {}],
      ['no cwd', input({ cwd: undefined }), {}],
      ['empty stack', input({ cwd: empty }), {}],
      ['mode off', input(), { SINGULAR_MODE: 'off' }],
      ['bad json', '{nope', {}],
      ['empty stdin', '', {}],
    ];
    for (const [label, stdin, extra] of cases) {
      const r = await runBin('on-subagent.js', [], { env: baseEnv(home, extra), input: stdin });
      assert.equal(r.code, 0, label);
      assert.equal(r.stdout, '', `${label}: no output`);
    }
    const noStack = freshHome('subagent-nostack', { mode: 'suggest', stackDetection: false });
    const ns = await runBin('on-subagent.js', [], { env: baseEnv(noStack), input: input() });
    assert.deepEqual([ns.code, ns.stdout], [0, '']);
    assert.equal(readLog(noStack, 'on-subagent')[0].skipped, 'stackDetection false');
    assert.equal(readLog(home, 'on-subagent').find((l) => l.skipped === 'mode off')?.skipped, 'mode off');
    assert.equal(readLog(home, 'on-subagent').find((l) => l.skipped === 'no detectable stack')?.skipped, 'no detectable stack');
    assert.ok(readLog(home).some((l) => l.msg === 'on-subagent: ignoring event' && l.event === 'SubagentStop'));
    assert.ok(readLog(home).some((l) => l.msg === 'on-subagent: no cwd in hook input; nothing injected'));
    assert.ok(readLog(home).some((l) => l.msg === 'on-subagent: stdin is not JSON'));
    assert.equal(seenRequests() - before, 0);
    const dry = await runBin('on-subagent.js', ['--dry-run', '--cwd', PROJ], { env: baseEnv(home) });
    assert.equal(dry.stdout, `${STACK}\n`);
    const dryEmpty = await runBin('on-subagent.js', ['--dry-run', '--cwd', empty], { env: baseEnv(home) });
    assert.equal(dryEmpty.stdout, '[singular] (no context: no detectable stack)\n');
    const help = await runBin('on-subagent.js', ['--help'], { env: baseEnv(home) });
    assert.equal(help.code, 0);
    assert.equal(help.stdout, 'usage: on-subagent.js [--dry-run] [--cwd <dir>]\n  (no args: read the SubagentStart hook JSON from stdin)\n');
    const hooks = readJson(path.join(ROOT, 'hooks', 'hooks.json')).hooks;
    assert.deepEqual(hooks.SubagentStart, [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/on-subagent.js"', timeout: 3 }] }]);
    assert.equal(hooks.UserPromptExpansion[0].matcher, '(^|:)singular$');
    assert.equal(hooks.UserPromptSubmit[0].hooks[0].timeout, 8);
  });
});

// ---------------------------------------------------------------------------

describe('bin/singular.js dispatcher (the /singular command and the terminal entrypoint)', () => {
  const EXPECTED_HELP_LINE = 'Singular — find, load, add and manage third-party skills for Claude Code';

  test('help, --help and -h print the one-screen help on stdout (exit 0); an unknown subcommand prints it on stderr with the reason (exit 1, nothing on stdout)', async () => {
    const home = freshHome('dispatch-help');
    const { HELP, SUBCOMMANDS, parseDispatch } = await import('../bin/singular.js');
    assert.deepEqual([...SUBCOMMANDS], ['status', 'help', 'find', 'load', 'add', 'mode', 'init']);
    for (const args of [['help'], ['--help'], ['-h'], ['HELP'], ['help', 'extra']]) {
      const r = await runBin('singular.js', args, { env: baseEnv(home) });
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, `${HELP}\n`, ''], JSON.stringify(args));
    }
    assert.equal(HELP.split('\n')[0], EXPECTED_HELP_LINE);
    for (const args of [['bogus'], ['scout-load', 'a/b@c'], ['scout-status'], ['stat'], ['loads', 'a/b@c']]) {
      const r = await runBin('singular.js', args, { env: baseEnv(home) });
      assert.equal(r.code, 1, JSON.stringify(args));
      assert.equal(r.stdout, '', JSON.stringify(args));
      assert.ok(r.stderr.startsWith(`[singular] unknown subcommand "${args[0]}"; expected one of status | help | find | load | add | mode | init\n${EXPECTED_HELP_LINE}\n`), r.stderr.slice(0, 200));
      assert.ok(r.stderr.endsWith(`${HELP}\n`));
    }
    assert.deepEqual(parseDispatch([]), { sub: 'status', rest: [] });
    assert.deepEqual(parseDispatch(['--json', '--cwd', '/x']), { sub: 'status', rest: ['--json', '--cwd', '/x'] });
    assert.deepEqual(parseDispatch(['Find', 'playwright', '--all']), { sub: 'find', rest: ['playwright', '--all'] });
    assert.deepEqual(parseDispatch(['-h', 'x']), { sub: 'help', rest: ['x'] });
  });

  test('subcommand dispatch: status/--json passthrough, find, mode, add and load reach the same code paths and exit codes as their former scripts; subcommands are case-insensitive', async () => {
    const home = freshHome('dispatch', { mode: 'suggest' });
    const env = baseEnv(home, { HOME: SKILLS_HOME });
    const status = await runBin('singular.js', ['STATUS', '--json', '--cwd', PROJ], { env });
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).home, home);
    const passthrough = await runBin('singular.js', ['--json', '--cwd', PROJ], { env });
    assert.equal(passthrough.code, 0, passthrough.stderr);
    assert.deepEqual(Object.keys(JSON.parse(passthrough.stdout)), Object.keys(JSON.parse(status.stdout)), 'a leading --json means `status --json`');
    const find = await runBin('singular.js', ['find', 'playwright', 'e2e', '--json', '--cwd', PROJ], { env });
    assert.equal(find.code, 0, find.stderr);
    assert.equal(JSON.parse(find.stdout).query, 'playwright e2e');
    assert.equal(readLog(home, 'find').length, 1, 'the find subcommand logs as "find"');
    const noQuery = await runBin('singular.js', ['find'], { env });
    assert.deepEqual([noQuery.code, noQuery.stdout, noQuery.stderr], [1, '', 'usage: singular find "<query>" [--limit N] [--all] [--json] [--cwd <dir>]\n']);
    const mode = await runBin('singular.js', ['mode'], { env });
    assert.equal(mode.code, 0, mode.stderr);
    assert.match(mode.stdout, /^\[singular\] mode: suggest {2}\(config file: .*config\.json\)\n(?: {2}! TEST SEAM ACTIVE: [^\n]*\n)* {2}usage: \/singular mode <off\|local\|suggest\|auto>\n$/);
    const badMode = await runBin('singular.js', ['mode', 'turbo'], { env });
    assert.equal(badMode.code, 1);
    assert.ok(badMode.stdout.startsWith('[singular] unknown mode "turbo"; expected one of off | local | suggest | auto\n'), badMode.stdout);
    const add = await runBin('singular.js', ['add'], { env });
    assert.deepEqual([add.code, add.stdout, add.stderr], [1, '', 'usage: singular add <owner/repo[#sha]@skill> [--yes] [--json]\n']);
    const addEvil = await runBin('singular.js', ['add', 'evil/repo@x', '--yes'], { env });
    assert.equal(addEvil.code, 1);
    assert.match(addEvil.stdout, /^REJECTED: owner "evil" is not allowlisted/);
    const load = await runBin('singular.js', ['load'], { env });
    assert.deepEqual([load.code, load.stdout, load.stderr], [1, '', '[singular] missing skill reference. usage: singular load <owner/repo[#sha]@skill> [--update] [--json]\n']);
    const loadHelp = await runBin('singular.js', ['load', '--help'], { env });
    assert.deepEqual([loadHelp.code, loadHelp.stdout], [0, 'usage: singular load <owner/repo[#sha]@skill> [--update] [--json]\n']);
    const loadEvil = await runBin('singular.js', ['load', 'evil/repo@x'], { env });
    assert.deepEqual([loadEvil.code, loadEvil.stdout], [1, '']);
    assert.match(loadEvil.stderr, /^\[singular\] refused: owner "evil" is not in the allowlist/);
    assert.ok(!fs.existsSync(path.join(home, 'loaded.json')) && !fs.existsSync(path.join(EMPTY_HOME, '.claude', 'skills')), 'nothing loaded or installed');
    assert.equal(readLog(home, 'on-expand: blocked').length, 1, '`singular load` is on-expand\'s CLI mode');
  });

  test('plugin layout: /singular is the single user-only entry point, singular-find stays model-invocable, the scout-* scripts/skills are gone, hooks.json routes the expansion to on-expand.js', async () => {
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'bin')).sort(), ['on-expand.js', 'on-prompt.js', 'on-subagent.js', 'singular.js'].concat(fs.existsSync(path.join(ROOT, 'bin', 'singular-cli.js')) ? ['singular-cli.js'] : []).sort(), 'no scout-*.js left in bin/');
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'skills')).sort(), ['singular', 'singular-find']);
    const fm = (name) => {
      const text = fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
      assert.ok(m, `${name}: frontmatter`);
      const head = Object.fromEntries(m[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
      return { head, body: m[2], text };
    };
    const single = fm('singular');
    assert.equal(single.head.name, 'singular');
    assert.equal(single.head['disable-model-invocation'], 'true');
    assert.equal(single.head.description, '"Singular: find, load, add and manage third-party skills (/singular help)"');
    assert.ok(single.body.includes('node "${CLAUDE_PLUGIN_ROOT}/bin/singular.js" $ARGUMENTS'), 'the body runs the dispatcher with the typed arguments');
    assert.match(single.body, /start with `load`[\s\S]*do not run anything/, 'load is acknowledged, never re-run');
    assert.match(single.body, /For `add`, append `--yes`/);
    assert.doesNotMatch(single.text, /scout/);
    const find = fm('singular-find');
    assert.equal(find.head.name, 'singular-find');
    assert.equal(find.head['disable-model-invocation'], undefined, 'model-invocable');
    assert.match(find.head.description, /is there a skill for X/);
    assert.ok(find.body.includes('node "${CLAUDE_PLUGIN_ROOT}/bin/singular.js" find "<query>"'));
    assert.doesNotMatch(find.text, /scout/);
    const hooks = readJson(path.join(ROOT, 'hooks', 'hooks.json')).hooks;
    assert.deepEqual(hooks.UserPromptExpansion, [{ matcher: '(^|:)singular$', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/on-expand.js"', timeout: 25 }] }]);
    const re = new RegExp(hooks.UserPromptExpansion[0].matcher);
    assert.ok(re.test('singular:singular') && re.test('singular'), 'matches the plugin-prefixed and bare command name');
    assert.ok(!re.test('singular:singular-find') && !re.test('singular:scout-load') && !re.test('singularity'), 'matches nothing else');
    for (const f of ['bin/singular.js', 'bin/on-expand.js', 'bin/on-prompt.js', 'bin/on-subagent.js', 'bin/singular-cli.js', 'lib/cli-core.js', 'lib/commands/status.js', 'lib/commands/find.js', 'lib/commands/add.js', 'lib/commands/mode.js', 'lib/context.js', 'lib/config.js', 'lib/refs.js', 'lib/git.js', 'lib/registry.js', 'hooks/hooks.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'package.json', 'README.md', 'config.example.json']) {
      assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /scout/, `${f}: no scout-* command name left`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('isolation: nothing under the real ~/.claude is touched by this file', () => {
  test('every child ran with HOME and SINGULAR_HOME under the scratch dir; the user settings/skills/plugins are not referenced', async () => {
    const real = os.userInfo().homedir;
    assert.ok(!AGENT.startsWith(path.join(real, '.claude')));
    const logs = fs.readdirSync(path.join(AGENT, 'homes')).map((d) => path.join(AGENT, 'homes', d, 'singular.log')).filter((f) => fs.existsSync(f));
    assert.ok(logs.length >= 10);
    for (const f of logs) {
      const text = fs.readFileSync(f, 'utf8');
      assert.ok(!text.includes(path.join(real, '.claude', 'singular')), `${f} never names the real state dir`);
      assert.ok(!text.includes('https://skills.sh'), `${f}: no production registry URL`);
      assert.ok(!text.includes('https://github.com'), `${f}: no production git host`);
    }
    const cfg = await runBin('singular.js', ['status', '--json', '--cwd', PROJ], { env: baseEnv(freshHome('iso')) });
    assert.ok(!JSON.parse(cfg.stdout).home.startsWith(path.join(real, '.claude')));
  });
});
