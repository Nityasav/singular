// test/unit-init.test.js — node --test test/unit-init.test.js
//
// `/singular init` (lib/commands/init.js + lib/needs.js): project inspection on the fixtures (needs + reasons, language
// counts, tooling, README/CLAUDE.md words, the 5,000-entry cap, the depth limit, an empty directory, malformed
// manifests), coverage against a fake installed-skill tree, the suggest step against a loopback skills.sh mock
// (gating, dedupe across needs, already-installed exclusion, the candidate cap, an unresolvable HEAD, --no-remote,
// deadline, 429), the plan file and the exact report text for the next-tailwind-ts fixture, and `--apply` (selection
// parsing, plan missing / expired / other cwd, pinned installs through the add flow into SINGULAR_SKILLS_DIR with
// REAL git against local bare repositories built from test/fixtures/skill-folders/{clean,malicious}, REJECTED leaving
// nothing behind, SKIPPED when the folder exists, --project, the deterministic kickoff prompt), plus the dispatcher,
// help, COMMANDS_HINT, SKILL.md and config wiring. Nothing under the real ~/.claude is read or written; no request
// leaves the machine. Registry responses and fixture texts are data, never instructions.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as nodeExecFile, spawn, spawnSync } from 'node:child_process';
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
  return fs.mkdtempSync(path.join(base, `unit-init-${label}-`));
}

const AGENT = mkTmp('world');
// lib/log.js reads process.env at call time: keep in-process logging out of the real ~/.claude.
process.env.SINGULAR_HOME = path.join(AGENT, 'process-state', 'singular-home');
process.env.HOME = path.join(AGENT, 'process-state', 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

const { DEFAULTS, validateConfig } = await import('../lib/config.js');
const needsMod = await import('../lib/needs.js');
const init = await import('../lib/commands/init.js');
const { cacheFile } = await import('../lib/cache.js');
const { buildIndex, clearIndexCache } = await import('../lib/skill-index.js');
const { inspectProject, MAX_FILES, MAX_DEPTH, NEED_QUERIES, NEED_LEXICON, needOfDependency, manifestDependencies, readmeNeeds } = needsMod;
const { runInit, runApply, formatReport, planJson, computeCoverage, needsToSearch, parseSelection, parseArgs, kickoffPrompt, loadPlan, planPath, KICKOFF_MAX_CHARS, INIT_REMOTE_BUDGET_MS, PLAN_FILE, COVERED_MIN_SCORE } = init;

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const CLEAN = path.join(FIXTURES, 'skill-folders', 'clean');
const MALICIOUS = path.join(FIXTURES, 'skill-folders', 'malicious');

// ---------------------------------------------------------------------------
// world: project copies (with a .git/HEAD so the stack line carries the branch), homes, the registry mock, the git base
// ---------------------------------------------------------------------------

function write(file, content, opts) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, opts);
}
const skillMd = (name, description, body = `# ${name}\n\nGuidance for ${name}.\n`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
function copyProject(fixture, dest) {
  fs.cpSync(path.join(FIXTURES, 'projects', fixture), dest, { recursive: true });
  write(path.join(dest, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dest;
}
const PROJ = copyProject('next-tailwind-ts', path.join(AGENT, 'proj'));
const PY = copyProject('python-fastapi', path.join(AGENT, 'py'));
const MONO = copyProject('monorepo-turbo', path.join(AGENT, 'mono'));
const EMPTY_DIR = path.join(AGENT, 'empty-project');
fs.mkdirSync(EMPTY_DIR, { recursive: true });
const EMPTY_HOME = path.join(AGENT, 'empty-home');
fs.mkdirSync(EMPTY_HOME, { recursive: true });
// installed skills: nextjs (covers `next` by name), playwright (covers `playwright`), pdf (nothing here)
const SKILLS_HOME = path.join(AGENT, 'skills-home');
write(path.join(SKILLS_HOME, '.claude', 'skills', 'nextjs', 'SKILL.md'), skillMd('nextjs', 'Next.js app router guidance and conventions.'));
write(path.join(SKILLS_HOME, '.claude', 'skills', 'playwright', 'SKILL.md'), skillMd('playwright', 'Write, debug and stabilize Playwright end-to-end tests.'));
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

// --- registry mock: one result list per need query word, audits by skill name ------------------------------------
const e = (source, skillId, installs) => ({ source, skillId, name: skillId, installs });
const SEARCH = {
  nextjs: [e('vercel-labs/agent-skills', 'nextjs-app-router', 150000), e('vercel-labs/agent-skills', 'nextjs', 120000), e('vercel-labs/agent-skills', 'nextjs-react-patterns', 60000)],
  react: [e('vercel-labs/agent-skills', 'vercel-react-best-practices', 740986), e('vercel-labs/agent-skills', 'nextjs-react-patterns', 60000), e('evil-local/repo', 'react-magic', 999999)],
  tailwind: [e('anthropics/skills', 'frontend-design', 960000)],
  supabase: [e('supabase/agent-skills', 'supabase', 314000), e('anthropics/skills', 'supabase-postgres', 40000)],
  stripe: [e('anthropics/skills', 'stripe-best-practices', 80000), e('evil-local/repo', 'stripe-best-practices', 500000)],
  vitest: [e('anthropics/skills', 'vitest-tiny', 12), e('microsoft/testing', 'vitest-helper', 5000)],
  typescript: [e('ghost-owner/none', 'typescript-strict', 30000), e('anthropics/skills', 'typescript-strict-mode', 31000)],
  playwright: [e('microsoft/playwright-cli', 'playwright-cli', 1200000)],
  monorepo: [e('anthropics/skills', 'monorepo-turbo-guide', 20000)],
  prisma: [e('anthropics/skills', 'prisma-schema', 25000)],
  auth: [e('anthropics/skills', 'auth-patterns', 26000)],
  'github actions': [e('anthropics/skills', 'github-actions-ci', 27000)],
  docker: [e('anthropics/skills', 'docker-compose-guide', 28000)],
  vercel: [e('vercel-labs/agent-skills', 'vercel-deploy', 29000)],
};
const registry = { requests: [], delayMs: 0, status: null, base: '', server: null };
function registryHandler(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const q = u.searchParams.get('q');
  registry.requests.push({ path: u.pathname, q, owner: u.searchParams.get('owner'), limit: u.searchParams.get('limit'), ua: req.headers['user-agent'] });
  res.on('error', () => {});
  const respond = () => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (registry.status) return json(registry.status, { error: registry.status === 429 ? 'rate_limit_exceeded' : 'boom' });
    if (u.pathname === '/api/search') return json(200, { query: q, skills: SEARCH[String(q ?? '').toLowerCase()] ?? [] });
    const m = /^\/api\/v1\/skills\/audit\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const skill = decodeURIComponent(m[3]);
      if (skill === 'typescript-strict') return json(404, { error: 'not found' });
      if (skill === 'vitest-helper') return json(200, { audits: [{ provider: 'Snyk', status: 'fail', riskLevel: 'CRITICAL', summary: 'trojan' }] });
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
const searchesSince = (n) => registry.requests.slice(n).filter((x) => x.path === '/api/search').map((x) => x.q);

// --- git base: one source tree with every catalogued skill folder, cloned bare per owner/repo -----------------------
const GIT_BASE = path.join(AGENT, 'git');
let HEAD_SHA = null; // every bare repo's HEAD
let MOVED_SHA = null; // pinned-owner/repo: HEAD advanced one commit past HEAD_SHA
const CLEAN_SKILLS = ['vercel-react-best-practices', 'supabase-postgres', 'frontend-design', 'nextjs-app-router', 'nextjs-react-patterns', 'nextjs', 'typescript-strict', 'typescript-strict-mode', 'monorepo-turbo-guide', 'prisma-schema', 'auth-patterns', 'github-actions-ci', 'docker-compose-guide', 'vercel-deploy', 'vitest-helper', 'playwright-cli'];
if (HAS_GIT) {
  const src = path.join(AGENT, 'gitsrc');
  for (const name of CLEAN_SKILLS) write(path.join(src, name, 'SKILL.md'), skillMd(name, `Third-party guidance for ${name}.`));
  fs.cpSync(CLEAN, path.join(src, 'clean-guidelines'), { recursive: true });
  fs.cpSync(MALICIOUS, path.join(src, 'stripe-best-practices'), { recursive: true });
  fs.chmodSync(path.join(src, 'stripe-best-practices', 'bin', 'pwn'), 0o755);
  fs.symlinkSync('../../etc/passwd', path.join(src, 'stripe-best-practices', 'link'));
  const g = (args, cwd = src) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  g(['init', '-q', '-b', 'main']);
  g(['add', '-A']);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'fixture']);
  HEAD_SHA = g(['rev-parse', 'HEAD']);
  for (const repo of ['anthropics/skills', 'vercel-labs/agent-skills', 'microsoft/testing', 'microsoft/playwright-cli', 'evil-local/repo', 'pinned-owner/repo']) {
    fs.mkdirSync(path.join(GIT_BASE, path.dirname(repo)), { recursive: true });
    g(['clone', '-q', '--bare', src, path.join(GIT_BASE, repo)]);
  }
  // pinned-owner/repo moves on: a plan pinned at HEAD_SHA must still install HEAD_SHA, never the new HEAD
  write(path.join(src, 'frontend-design', 'CHANGELOG.md'), 'v2: moved on\n');
  g(['add', '-A']);
  g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'moved on']);
  MOVED_SHA = g(['rev-parse', 'HEAD']);
  g(['push', '-q', path.join(GIT_BASE, 'pinned-owner', 'repo'), 'main:main']);
}
const GIT_SEAM = `file://${GIT_BASE}`;
const sha7 = () => HEAD_SHA.slice(0, 7);

after(() => {
  registry.server?.close();
  try { fs.rmSync(AGENT, { recursive: true, force: true }); } catch { /* ignore */ }
});

// --- helpers --------------------------------------------------------------------------------------------------------
/** env for a child or an in-process call: scratch HOME, a scratch state dir, both seams; nothing from the shell but PATH. */
function baseEnv(home, extra = {}) {
  return { HOME: EMPTY_HOME, SINGULAR_HOME: home, SINGULAR_REGISTRY_BASE: registry.base, SINGULAR_GIT_BASE: GIT_SEAM, ...extra };
}
function runBin(args, { env = {}, input, cwd = PROJ, timeout = 60000 } = {}) {
  // Asynchronous on purpose: the loopback registry mock lives in this process and must be able to answer the child.
  const t0 = performance.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'singular.js'), ...args], { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function readLog(home, msg) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(home, 'singular.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { lines = []; }
  return msg ? lines.filter((l) => l.msg === msg) : lines;
}
/** Capture process.stdout/stderr writes while `fn` runs (in-process main() calls must not pollute the TAP stream). */
async function capture(fn) {
  const out = [];
  const err = [];
  const o = process.stdout.write;
  const er = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  try {
    const value = await fn();
    return { value, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = o;
    process.stderr.write = er;
  }
}
const CONFIG = { allowlist: ['anthropics', 'vercel-labs', 'microsoft'], prefetch: false };
const byNeed = (r) => Object.fromEntries(r.needs.map((n) => [n.need, n]));

// ---------------------------------------------------------------------------
// 1. inspection (lib/needs.js)
// ---------------------------------------------------------------------------

describe('lib/needs.js inspectProject on the fixtures', () => {
  test('next-tailwind-ts: eight dependency needs in weight order, TypeScript counted, tsconfig as tooling, no README', async () => {
    const r = await inspectProject(PROJ);
    assert.equal(r.name, 'proj');
    assert.equal(r.cwd, PROJ);
    assert.match(r.stack.summary, /^Next\.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm; branch main$/);
    assert.deepEqual(r.needs.map((n) => `${n.need} (${n.reason})`), ['next (dep)', 'react (dep)', 'supabase (dep)', 'stripe (dep)', 'tailwind (dep)', 'vitest (dep)', 'playwright (dep)', 'typescript (dep)']);
    const n = byNeed(r);
    assert.deepEqual(n.react.evidence, ['react (package.json)', 'react-dom (package.json)']);
    assert.deepEqual(n.tailwind.evidence, ['tailwindcss (package.json)', '@tailwindcss/postcss (package.json)']);
    assert.deepEqual(n.typescript.evidence, ['typescript (package.json)', 'tsconfig.json', '1 TypeScript file']);
    assert.ok(n.next.weight > n.supabase.weight && n.supabase.weight > n.typescript.weight, 'frameworks first, bare languages last');
    assert.deepEqual(r.languages, [{ name: 'TypeScript', files: 1 }]);
    assert.deepEqual(r.tooling, [{ file: 'tsconfig.json', need: 'typescript' }]);
    assert.deepEqual(r.manifests, ['package.json']);
    assert.deepEqual(r.readme, { present: false, claudeMd: false, words: [] });
    assert.equal(r.truncated, false);
    assert.equal(r.signals, 8);
    assert.ok(r.filesScanned >= 6 && r.filesScanned < 20, String(r.filesScanned));
    assert.ok(r.elapsedMs < 1500, `elapsed ${r.elapsedMs}`);
    for (const need of r.needs) assert.ok(NEED_QUERIES[need.need], `${need.need} has query words`);
  });

  test('python-fastapi: pyproject + requirements deps (extras, pins, -e lines skipped), Dockerfile and conftest as tooling, README words, Python as the top language', async () => {
    const r = await inspectProject(PY);
    assert.equal(r.stack.summary, 'Python, FastAPI, SQLAlchemy, pytest, Docker; branch main');
    assert.deepEqual(r.needs.map((n) => `${n.need} (${n.reason})`), ['fastapi (dep)', 'pytest (dep)', 'postgres (dep)', 'aws (dep)', 'docker (file)', 'python (file)', 'terraform (readme)']);
    const n = byNeed(r);
    assert.deepEqual(n.fastapi.evidence, ['fastapi (pyproject.toml)', 'fastapi (requirements.txt)', '"fastapi" in README.md']);
    assert.deepEqual(n.pytest.evidence, ['pytest (pyproject.toml)', 'pytest-asyncio (pyproject.toml)', 'tests/conftest.py', '"pytest" in README.md']);
    assert.deepEqual(n.postgres.evidence, ['psycopg (requirements.txt)', '"postgres" in README.md'], 'psycopg[binary] extras stripped');
    assert.deepEqual(n.aws.evidence, ['boto3 (requirements.txt)', '"aws" in README.md']);
    assert.deepEqual(n.docker.evidence, ['Dockerfile']);
    assert.deepEqual(n.python.evidence, ['pyproject.toml', 'requirements.txt', '4 Python files']);
    assert.deepEqual(n.terraform.evidence, ['"terraform" in README.md']);
    assert.deepEqual(r.languages, [{ name: 'Python', files: 4 }]);
    assert.deepEqual(r.tooling.map((t) => `${t.file}:${t.need}`), ['Dockerfile:docker', 'pyproject.toml:python', 'requirements.txt:python', 'tests/conftest.py:pytest']);
    assert.deepEqual(r.manifests, ['pyproject.toml', 'requirements.txt']);
    assert.deepEqual(r.readme, { present: true, claudeMd: false, words: ['fastapi (README.md)', 'postgres (README.md)', 'aws (README.md)', 'terraform (README.md)', 'pytest (README.md)'] });
  });

  test('monorepo-turbo: nested manifests (depth 2), turbo.json / pnpm-workspace / workspaces -> monorepo, prisma dir + schema, docker-compose, .github/workflows, CLAUDE.md words', async () => {
    const r = await inspectProject(MONO);
    assert.equal(r.stack.summary, 'TypeScript 5 strict, pnpm; branch main');
    assert.deepEqual(r.needs.map((n) => `${n.need} (${n.reason})`), ['monorepo (dep)', 'next (dep)', 'prisma (dep)', 'react (dep)', 'auth (dep)', 'tailwind (dep)', 'github-actions (file)', 'typescript (dep)', 'docker (file)', 'vercel (readme)']);
    const n = byNeed(r);
    assert.deepEqual(n.monorepo.evidence, ['turbo (package.json)', 'package.json workspaces', 'pnpm-workspace.yaml', 'turbo.json', '"monorepo" in CLAUDE.md']);
    assert.deepEqual(n.next.evidence, ['next (apps/web/package.json)', '"nextjs" in CLAUDE.md']);
    assert.deepEqual(n.prisma.evidence, ['@prisma/client (packages/db/package.json)', 'prisma (packages/db/package.json)', 'packages/db/prisma', 'packages/db/prisma/schema.prisma', '"prisma" in CLAUDE.md']);
    assert.deepEqual(n.auth.evidence, ['@clerk/nextjs (apps/web/package.json)'], 'prefix rule @clerk/*');
    assert.deepEqual(n['github-actions'].evidence, ['.github/workflows', '"github actions" in CLAUDE.md']);
    assert.deepEqual(n.docker.evidence, ['docker-compose.yml']);
    assert.deepEqual(n.vercel.evidence, ['"vercel" in CLAUDE.md']);
    assert.deepEqual(r.manifests, ['package.json', 'apps/web/package.json', 'packages/db/package.json'], 'root manifest first (breadth-first walk)');
    assert.deepEqual(r.languages, [{ name: 'TypeScript', files: 1 }], 'only depth <= 3 files count: apps/web/src/app/*.tsx is depth 4');
    assert.deepEqual(r.readme, { present: false, claudeMd: true, words: ['monorepo (CLAUDE.md)', 'nextjs (CLAUDE.md)', 'prisma (CLAUDE.md)', 'vercel (CLAUDE.md)', 'github actions (CLAUDE.md)'] });
    assert.equal(r.signals, 10);
  });

  test('empty directory, a missing directory and a file path: no signals, never throws', async () => {
    const r = await inspectProject(EMPTY_DIR);
    assert.deepEqual([r.needs, r.languages, r.tooling, r.manifests, r.signals, r.filesScanned, r.truncated], [[], [], [], [], 0, 0, false]);
    assert.deepEqual(r.stack, { summary: '', tags: [] });
    const missing = await inspectProject(path.join(AGENT, 'does-not-exist'));
    assert.deepEqual([missing.needs, missing.signals], [[], 0]);
    const file = await inspectProject(path.join(PROJ, 'package.json'));
    assert.deepEqual([file.needs, file.signals], [[], 0]);
    assert.deepEqual((await inspectProject(null)).cwd, process.cwd());
  });

  test('malformed manifests are skipped, never a crash; the valid parts still count', async () => {
    const dir = path.join(AGENT, 'malformed');
    write(path.join(dir, 'package.json'), '{not json');
    write(path.join(dir, 'pyproject.toml'), '[[[ garbage\ndependencies = [ "unterminated');
    write(path.join(dir, 'requirements.txt'), 'stripe>=10\n\u0000binary\n-r other.txt\n');
    write(path.join(dir, 'go.mod'), 'this is not a go module');
    write(path.join(dir, 'Cargo.toml'), '= = =\n[dependencies\nredis = "0.25"');
    write(path.join(dir, 'Gemfile'), 'gem\ngem "rails"');
    write(path.join(dir, 'pom.xml'), '<project><dependencies><dependency><artifactId>stripe-java</artifactId></dependency>');
    const r = await inspectProject(dir);
    const needs = Object.fromEntries(r.needs.map((n) => [n.need, n.evidence]));
    assert.deepEqual(needs.stripe, ['stripe-java (pom.xml)', 'stripe (requirements.txt)'], 'manifests in sorted directory order');
    assert.deepEqual(needs.rails, ['rails (Gemfile)']);
    assert.ok(!('redis' in needs), 'a Cargo section header that never closes is not a dependency table');
    assert.ok(!('go' in needs) || needs.go.includes('go.mod'), 'go.mod only counts as the tooling file');
    assert.equal(manifestDependencies('package.json', '{not json').ok, false);
    assert.deepEqual(manifestDependencies('package.json', JSON.stringify({ dependencies: { next: '1' }, devDependencies: 'oops', optionalDependencies: { fsevents: '1' } })), { deps: [{ ecosystem: 'npm', name: 'next' }, { ecosystem: 'npm', name: 'fsevents' }], workspaces: false, ok: true });
    assert.deepEqual(manifestDependencies('go.mod', 'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/lib/pq v1.10.9\n\tk8s.io/client-go v0.30.0 // indirect\n)\n').deps.map((d) => d.name), ['github.com/lib/pq', 'k8s.io/client-go']);
    assert.deepEqual(manifestDependencies('Gemfile', "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n  gem \"pg\"\n").deps.map((d) => d.name), ['rails', 'pg']);
    assert.deepEqual(manifestDependencies('unknown.txt', 'x').ok, false);
  });

  test('the lexicon: exact and prefix rules per ecosystem, underscores folded, unknown -> null; README words and bigrams', () => {
    assert.equal(needOfDependency('npm', '@clerk/nextjs'), 'auth');
    assert.equal(needOfDependency('npm', '@AI-SDK/openai'), 'ai-sdk');
    assert.equal(needOfDependency('npm', 'ai'), 'ai-sdk');
    assert.equal(needOfDependency('npm', 'turbo'), 'monorepo');
    assert.equal(needOfDependency('pypi', 'Django_Rest_Framework'), 'django');
    assert.equal(needOfDependency('go', 'github.com/jackc/pgx/v5'), 'postgres');
    assert.equal(needOfDependency('cargo', 'aws-sdk-s3'), 'aws');
    assert.equal(needOfDependency('gem', 'omniauth-github'), 'auth');
    assert.equal(needOfDependency('maven', 'spring-security-core'), 'auth');
    assert.equal(needOfDependency('npm', 'left-pad'), null);
    assert.equal(needOfDependency('nope', 'next'), null);
    assert.equal(needOfDependency('npm', ''), null);
    for (const table of Object.values(NEED_LEXICON)) for (const need of Object.values(table)) assert.ok(NEED_QUERIES[need], `${need} has query words`);
    assert.deepEqual(readmeNeeds('# App\n\nBuilt with Next.js, Tailwind CSS and GitHub Actions on Google Cloud.\n'), [{ need: 'next', word: 'nextjs' }, { need: 'tailwind', word: 'tailwind' }, { need: 'github-actions', word: 'github actions' }, { need: 'gcp', word: 'google cloud' }]);
    const late = `${'filler line\n'.repeat(45)}uses stripe\n`;
    assert.deepEqual(readmeNeeds(late), [], 'only the first 40 lines are read');
  });

  test('the 5,000-entry cap (MAX_FILES) and the depth limit (MAX_DEPTH = 3, root = 0); symlinks are never followed', async () => {
    assert.equal(MAX_FILES, 5000);
    assert.equal(MAX_DEPTH, 3);
    const big = path.join(AGENT, 'big');
    fs.mkdirSync(path.join(big, 'src'), { recursive: true });
    for (let i = 0; i < 5100; i++) fs.writeFileSync(path.join(big, 'src', `f${i}.ts`), '');
    write(path.join(big, 'zzz', 'package.json'), JSON.stringify({ dependencies: { stripe: '1' } }));
    const t0 = performance.now();
    const r = await inspectProject(big);
    assert.ok(performance.now() - t0 < 1500, 'under the budget even when truncated');
    assert.equal(r.truncated, true);
    assert.equal(r.filesScanned, 5000);
    assert.ok(!r.needs.some((n) => n.need === 'stripe'), 'entries after the cap are never read');
    const capped = await inspectProject(PROJ, { maxFiles: 3 });
    assert.deepEqual([capped.truncated, capped.filesScanned], [true, 3]);
    const deep = path.join(AGENT, 'deep');
    write(path.join(deep, 'a', 'b', 'c', 'package.json'), JSON.stringify({ dependencies: { stripe: '1' } }));
    write(path.join(deep, 'a', 'b', 'c', 'd', 'package.json'), JSON.stringify({ dependencies: { redis: '1' } }));
    write(path.join(deep, 'a', 'b', 'c', 'd', 'main.go'), 'package main');
    fs.symlinkSync(PROJ, path.join(deep, 'linked'));
    const d = await inspectProject(deep);
    assert.deepEqual(d.needs.map((n) => n.need), ['stripe'], 'depth 3 read, depth 4 not; the symlinked project never followed');
    assert.deepEqual(d.manifests, ['a/b/c/package.json']);
    assert.deepEqual(d.languages, []);
    const shallow = await inspectProject(deep, { maxDepth: 1 });
    assert.deepEqual(shallow.needs, []);
  });
});

// ---------------------------------------------------------------------------
// 2. coverage
// ---------------------------------------------------------------------------

describe('coverage of needs by installed skills', () => {
  test('a name-token hit covers; a description hit covers only at score >= 6 (multi-word need); plugin skills keep their namespaced name', async () => {
    const home = path.join(AGENT, 'coverage-home');
    write(path.join(home, '.claude', 'skills', 'frontend-design', 'SKILL.md'), skillMd('frontend-design', 'Distinctive visual design for landing pages and UI with Tailwind or CSS.'));
    write(path.join(home, '.claude', 'skills', 'ci-workflows', 'SKILL.md'), skillMd('ci-workflows', 'Write GitHub Actions workflows and CI pipelines.'));
    write(path.join(home, '.claude', 'skills', 'pdf', 'SKILL.md'), skillMd('pdf', 'Read, merge and fill PDF forms.'));
    write(path.join(home, '.claude', 'skills', 'vercel', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'vercel' }));
    write(path.join(home, '.claude', 'skills', 'vercel', 'skills', 'nextjs', 'SKILL.md'), skillMd('nextjs', 'Next.js guidance.'));
    clearIndexCache();
    const index = await buildIndex({ cwd: EMPTY_DIR, home, ttlMs: 0 });
    const needs = [{ need: 'next', reason: 'dep' }, { need: 'github-actions', reason: 'file' }, { need: 'tailwind', reason: 'dep' }, { need: 'stripe', reason: 'dep' }, 'playwright'];
    const c = computeCoverage(needs, index);
    assert.deepEqual(c.covered.map((x) => [x.need, x.skill, x.via]), [['next', 'vercel:nextjs', 'name'], ['github-actions', 'ci-workflows', 'score']]);
    assert.ok(c.covered[1].score >= COVERED_MIN_SCORE);
    assert.deepEqual(c.uncovered, ['tailwind', 'stripe', 'playwright'], 'a lone description word ("Tailwind") is not coverage');
    assert.deepEqual(computeCoverage(needs, []), { covered: [], uncovered: ['next', 'github-actions', 'tailwind', 'stripe', 'playwright'] });
    assert.deepEqual(computeCoverage([], index), { covered: [], uncovered: [] });
  });

  test('needsToSearch: every uncovered need in need order, then the top 3 needs even when covered, flagged "also"', () => {
    const needs = ['next', 'react', 'supabase', 'stripe', 'tailwind'].map((need) => ({ need, reason: 'dep' }));
    const list = needsToSearch(needs, { covered: [{ need: 'next' }, { need: 'react' }, { need: 'tailwind' }], uncovered: ['supabase', 'stripe'] });
    assert.deepEqual(list.map((x) => `${x.need}:${x.query}:${x.also}`), ['supabase:supabase:false', 'stripe:stripe:false', 'next:nextjs:true', 'react:react:true']);
    assert.deepEqual(needsToSearch([], { covered: [], uncovered: [] }), []);
    assert.deepEqual(needsToSearch(needs, { covered: [], uncovered: needs.map((n) => n.need) }).map((x) => x.also), [false, false, false, false, false]);
  });
});

// ---------------------------------------------------------------------------
// 3. the report, the plan and --json / --no-remote as a child process
// ---------------------------------------------------------------------------

describe('bin/singular.js init as a child process (loopback registry + local git base)', { skip: !HAS_GIT && 'git not on PATH' }, () => {
  test('exact report for the next-tailwind-ts fixture: needs, coverage, pinned candidates (gated, deduped across needs, audit-fail dropped, "also"), the Approve line; the plan file; nothing installed', async () => {
    const home = freshHome('report', CONFIG);
    const before = seenRequests();
    const r = await runBin(['init'], { env: baseEnv(home, { HOME: SKILLS_HOME }) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
    const expected = [
      '[singular] init: proj',
      'Stack: Next.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm; branch main',
      'Needs (8): next (dep), react (dep), supabase (dep), stripe (dep), tailwind (dep), vitest (dep), playwright (dep), typescript (dep)',
      'Covered by installed skills: next -> nextjs; playwright -> playwright',
      'Not covered: react, supabase, stripe, tailwind, vitest, typescript',
      'Suggested third-party skills (pinned, not installed):',
      `  1. vercel-labs/agent-skills#${sha7()}@vercel-react-best-practices   741K installs   audit pass   for: react`,
      `  2. anthropics/skills#${sha7()}@supabase-postgres   40.0K installs   audit pass   for: supabase`,
      `  3. anthropics/skills#${sha7()}@stripe-best-practices   80.0K installs   audit pass   for: stripe`,
      `  4. anthropics/skills#${sha7()}@frontend-design   960K installs   audit pass   for: tailwind`,
      `  5. anthropics/skills#${sha7()}@typescript-strict-mode   31.0K installs   audit pass   for: typescript`,
      `  6. vercel-labs/agent-skills#${sha7()}@nextjs-react-patterns   60.0K installs   audit pass   for: react`,
      `  7. vercel-labs/agent-skills#${sha7()}@nextjs-app-router   150K installs   audit pass   for: next (also)`,
      '  (contents are fetched and inspected only at apply time; a candidate can still be rejected or missing then)',
      'Approve: /singular init --apply 1,2   (or: all)   Add --project to install into ./.claude/skills instead of ~/.claude/skills',
      '',
    ].join('\n');
    assert.equal(r.stdout, expected);
    // what reached the mock: one search per uncovered need + the top-3 "also" need, audits for the picked candidates
    // suggest() keeps two searches in flight, so the order in which the mock RECEIVES them is not deterministic under
    // load (observed: tailwind before stripe in a full `npm test` run); the set is. The dispatch order (need order,
    // then the "also" need) shows in the candidates' `need` sequence asserted by the --json cap test below.
    const qs = searchesSince(before);
    assert.deepEqual([...qs].sort(), ['nextjs', 'react', 'stripe', 'supabase', 'tailwind', 'typescript', 'vitest'], 'one search per uncovered need plus the covered top-3 need ("also"), no duplicates');
    assert.ok(registry.requests.slice(before).every((x) => x.ua === 'singular/0.2 (+node)' && x.limit !== '0'));
    const audits = registry.requests.slice(before).filter((x) => x.path.startsWith('/api/v1/skills/audit/')).map((x) => x.path.split('/').pop()).sort();
    assert.deepEqual(audits, ['frontend-design', 'nextjs-app-router', 'nextjs-react-patterns', 'stripe-best-practices', 'supabase-postgres', 'typescript-strict-mode', 'vercel-react-best-practices', 'vitest-helper']);
    // the plan
    const plan = readJson(path.join(home, PLAN_FILE));
    assert.deepEqual(Object.keys(plan), ['version', 'cwd', 'createdAt', 'stack', 'needs', 'coverage', 'candidates']);
    assert.equal(plan.version, 1);
    assert.equal(plan.cwd, PROJ);
    assert.ok(Date.now() - Date.parse(plan.createdAt) < 60000);
    assert.equal(plan.stack.summary.split(';')[0], 'Next.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm');
    assert.deepEqual(plan.needs.map((n) => n.need), ['next', 'react', 'supabase', 'stripe', 'tailwind', 'vitest', 'playwright', 'typescript']);
    assert.deepEqual(plan.coverage.covered.map((c) => `${c.need}->${c.skill}`), ['next->nextjs', 'playwright->playwright']);
    assert.deepEqual(plan.coverage.uncovered, ['react', 'supabase', 'stripe', 'tailwind', 'vitest', 'typescript']);
    assert.equal(plan.candidates.length, 7);
    for (const c of plan.candidates) assert.deepEqual(Object.keys(c), ['n', 'ref', 'source', 'skill', 'installs', 'audit', 'need', 'reason', 'also', 'sha', 'approvable']);
    assert.deepEqual(plan.candidates.map((c) => c.n), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(plan.candidates.map((c) => c.ref), [
      `vercel-labs/agent-skills#${HEAD_SHA}@vercel-react-best-practices`, `anthropics/skills#${HEAD_SHA}@supabase-postgres`, `anthropics/skills#${HEAD_SHA}@stripe-best-practices`,
      `anthropics/skills#${HEAD_SHA}@frontend-design`, `anthropics/skills#${HEAD_SHA}@typescript-strict-mode`, `vercel-labs/agent-skills#${HEAD_SHA}@nextjs-react-patterns`, `vercel-labs/agent-skills#${HEAD_SHA}@nextjs-app-router`,
    ]);
    assert.deepEqual(plan.candidates.map((c) => [c.need, c.reason, c.also, c.approvable, c.audit]), [['react', 'dep', false, true, 'pass'], ['supabase', 'dep', false, true, 'pass'], ['stripe', 'dep', false, true, 'pass'], ['tailwind', 'dep', false, true, 'pass'], ['typescript', 'dep', false, true, 'pass'], ['react', 'dep', false, true, 'pass'], ['next', 'dep', true, true, 'pass']]);
    assert.equal(plan.candidates.filter((c) => c.skill === 'nextjs-react-patterns').length, 1, 'deduped across the react and next searches');
    assert.ok(!plan.candidates.some((c) => c.skill === 'nextjs'), 'already installed: excluded');
    assert.ok(!plan.candidates.some((c) => c.skill === 'vitest-helper'), 'audit fail: dropped');
    assert.ok(!plan.candidates.some((c) => c.skill === 'vitest-tiny'), 'below the install floor');
    assert.ok(!plan.candidates.some((c) => c.source.startsWith('evil-local') || c.source.startsWith('supabase/') || c.source.startsWith('ghost-owner')), 'owners outside the allowlist never appear');
    assert.ok(!fs.existsSync(path.join(EMPTY_HOME, '.claude', 'skills')) && !fs.existsSync(path.join(SKILLS_HOME, '.claude', 'skills', 'frontend-design')), 'nothing installed');
    assert.ok(!fs.existsSync(path.join(PROJ, '.claude')), 'nothing written into the project');
    assert.equal(JSON.parse(fs.readFileSync(cacheFile('head:anthropics/skills', { SINGULAR_HOME: home }), 'utf8')).value, HEAD_SHA, 'HEAD cached under head:<source> (shared with the hook)');
    const log = readLog(home, 'init');
    assert.equal(log.length, 1);
    assert.deepEqual(log[0].covered, ['next->nextjs', 'playwright->playwright']);
    assert.equal(log[0].candidates.length, 7);
    assert.equal(log[0].planWritten, true);
    // a second run is served from the cache: no search, no audit, no git
    const before2 = seenRequests();
    const again = await runBin(['init'], { env: baseEnv(home, { HOME: SKILLS_HOME }) });
    assert.equal(again.stdout, expected);
    assert.equal(seenRequests() - before2, 0, 'searches, audits and HEAD shas all cached');
    assert.ok(again.ms < 3000);
  });

  test('--no-remote: installed-only report, zero requests, the plan still written (no candidates); --yes is accepted; --json prints the plan object', async () => {
    const home = freshHome('noremote', CONFIG);
    const before = seenRequests();
    const r = await runBin(['init', '--no-remote', '--yes'], { env: baseEnv(home, { HOME: SKILLS_HOME }) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, [
      '[singular] init: proj',
      'Stack: Next.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm; branch main',
      'Needs (8): next (dep), react (dep), supabase (dep), stripe (dep), tailwind (dep), vitest (dep), playwright (dep), typescript (dep)',
      'Covered by installed skills: next -> nextjs; playwright -> playwright',
      'Not covered: react, supabase, stripe, tailwind, vitest, typescript',
      'Suggested third-party skills: skipped (--no-remote)',
      '',
    ].join('\n'));
    assert.equal(seenRequests() - before, 0);
    const plan = readJson(path.join(home, PLAN_FILE));
    assert.deepEqual([plan.version, plan.cwd, plan.candidates], [1, PROJ, []]);
    const j = await runBin(['init', '--no-remote', '--json'], { env: baseEnv(home, { HOME: SKILLS_HOME }) });
    assert.equal(j.code, 0, j.stderr);
    const out = JSON.parse(j.stdout);
    assert.deepEqual(Object.keys(out), ['version', 'cwd', 'createdAt', 'stack', 'needs', 'coverage', 'candidates', 'inspection', 'remote', 'index', 'plan', 'warnings', 'elapsedMs']);
    assert.equal(out.version, 1);
    assert.equal(out.cwd, PROJ);
    assert.deepEqual(out.candidates, []);
    assert.equal(out.remote.skipped, 'no-remote');
    assert.deepEqual(out.inspection.languages, [{ name: 'TypeScript', files: 1 }]);
    assert.equal(out.index.total, 3);
    assert.deepEqual([out.plan.written, out.plan.path], [true, path.join(home, PLAN_FILE)]);
    assert.ok(out.warnings.some((w) => /TEST SEAM ACTIVE: SINGULAR_REGISTRY_BASE/.test(w)));
    assert.equal(seenRequests() - before, 0);
  });

  test('an empty directory: "no signals" report, no request, exit 0; --cwd selects the project; the python fixture reports its own needs', async () => {
    const home = freshHome('empty', CONFIG);
    const before = seenRequests();
    const r = await runBin(['init'], { env: baseEnv(home), cwd: EMPTY_DIR });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, [
      '[singular] init: empty-project',
      'Stack: (unknown)',
      'Needs (0): no signals',
      'Covered by installed skills: none',
      'Not covered: none',
      'Suggested third-party skills (pinned, not installed): none (no needs to search)',
      '',
    ].join('\n'));
    assert.equal(seenRequests() - before, 0, 'nothing to search for');
    const py = await runBin(['init', '--no-remote', '--cwd', PY], { env: baseEnv(home), cwd: EMPTY_DIR });
    assert.equal(py.code, 0, py.stderr);
    assert.match(py.stdout, /^\[singular\] init: py\nStack: Python, FastAPI, SQLAlchemy, pytest, Docker; branch main\nNeeds \(7\): fastapi \(dep\), pytest \(dep\), postgres \(dep\), aws \(dep\), docker \(file\), python \(file\), terraform \(readme\)\n/);
    assert.equal(readJson(path.join(home, PLAN_FILE)).cwd, PY);
  });

  test('candidate cap: 8 by default (round-robin across needs), initMaxCandidates from config; every candidate pinned', async () => {
    const home = freshHome('cap', CONFIG);
    const r = JSON.parse((await runBin(['init', '--json'], { env: baseEnv(home), cwd: MONO })).stdout);
    assert.equal(r.candidates.length, 8);
    assert.deepEqual(r.candidates.map((c) => c.need), ['monorepo', 'next', 'prisma', 'react', 'auth', 'tailwind', 'github-actions', 'typescript'], 'one per need in need order before any second pick');
    assert.deepEqual(r.candidates.map((c) => c.skill), ['monorepo-turbo-guide', 'nextjs-app-router', 'prisma-schema', 'vercel-react-best-practices', 'auth-patterns', 'frontend-design', 'github-actions-ci', 'typescript-strict-mode']);
    assert.ok(r.candidates.every((c) => c.approvable && c.sha === HEAD_SHA && c.ref.includes(`#${HEAD_SHA}@`)));
    assert.equal(r.remote.queries.length, 10);
    const small = freshHome('cap3', { ...CONFIG, initMaxCandidates: 3 });
    const s = JSON.parse((await runBin(['init', '--json'], { env: baseEnv(small), cwd: MONO })).stdout);
    assert.deepEqual(s.candidates.map((c) => c.skill), ['monorepo-turbo-guide', 'nextjs-app-router', 'prisma-schema']);
    const text = await runBin(['init'], { env: baseEnv(small), cwd: MONO });
    assert.match(text.stdout, /\nApprove: \/singular init --apply 1,2   \(or: all\)   Add --project/);
    assert.equal((text.stdout.match(/^  \d\. /gm) ?? []).length, 3);
  });
});

// ---------------------------------------------------------------------------
// 4. suggest branches in-process (gating, unresolvable HEAD, deadline, 429, blockedRefs, requireAuditPass)
// ---------------------------------------------------------------------------

describe('runInit suggest step in-process', { skip: !HAS_GIT && 'git not on PATH' }, () => {
  test('an allowlisted owner whose repository cannot be reached: listed with "HEAD not resolved: not approvable", no sha, an Errors line; --apply on it is SKIPPED', async () => {
    const home = freshHome('ghost', { ...CONFIG, allowlist: ['ghost-owner', 'anthropics'] });
    const env = baseEnv(home, { HOME: SKILLS_HOME });
    const r = await runInit({ cwd: PROJ, env, config: { ...DEFAULTS, ...CONFIG, allowlist: ['ghost-owner', 'anthropics'] } });
    const ghost = r.candidates.find((c) => c.skill === 'typescript-strict');
    assert.ok(ghost, JSON.stringify(r.candidates.map((c) => c.ref)));
    assert.deepEqual([ghost.sha, ghost.approvable, ghost.ref, ghost.audit], [null, false, 'ghost-owner/none@typescript-strict', 'unknown']);
    const report = formatReport(r);
    assert.match(report, new RegExp(`\\n  ${ghost.n}\\. ghost-owner/none@typescript-strict   30\\.0K installs   audit unknown   for: typescript   \\(HEAD not resolved: not approvable\\)\\n`));
    assert.match(report, /\nErrors: HEAD of ghost-owner\/none not resolved: git ls-remote /);
    assert.match(report, /\nApprove: \/singular init --apply 1,2   \(or: all\)/, 'the other candidates stay approvable');
    const a = await runApply({ selection: String(ghost.n), cwd: PROJ, env: { ...env, SINGULAR_SKILLS_DIR: path.join(AGENT, 'ghost-skills') } });
    assert.equal(a.exitCode, 0);
    assert.deepEqual(a.results.map((x) => [x.status, x.why]), [['skipped', 'unresolved']]);
    assert.match(a.message, new RegExp(`\\nSKIPPED ${ghost.n}\\. ghost-owner/none@typescript-strict \\(HEAD not resolved when the plan was made; run /singular init again\\)\\nInstalled: none\\nKickoff prompt: none \\(nothing new was installed\\)$`));
    assert.ok(!fs.existsSync(path.join(AGENT, 'ghost-skills')));
  });

  test('blockedRefs and requireAuditPass: a blocked ref never appears; with requireAuditPass false an audit-fail candidate is listed with "audit fail"', async () => {
    const home = freshHome('gates');
    const env = baseEnv(home, { HOME: SKILLS_HOME });
    const blocked = await runInit({ cwd: PROJ, env, config: { ...DEFAULTS, ...CONFIG, blockedRefs: ['anthropics/skills@frontend-design', 'vercel-labs'] } });
    assert.deepEqual(blocked.candidates.map((c) => c.skill), ['supabase-postgres', 'stripe-best-practices', 'typescript-strict-mode']);
    assert.ok(blocked.remote.rejectedByReason['blocked by blockedRefs'] >= 3, JSON.stringify(blocked.remote.rejectedByReason));
    const lax = await runInit({ cwd: PROJ, env, config: { ...DEFAULTS, ...CONFIG, requireAuditPass: false } });
    const vh = lax.candidates.find((c) => c.skill === 'vitest-helper');
    assert.ok(vh);
    assert.equal(vh.audit, 'fail');
    assert.match(formatReport(lax), /@vitest-helper   5\.0K installs   audit fail   for: vitest\n/);
    assert.equal(lax.remote.rejectedByReason['audit fail'], undefined);
    const strict = await runInit({ cwd: PROJ, env, config: { ...DEFAULTS, ...CONFIG } });
    assert.equal(strict.remote.rejectedByReason['audit fail'], 1);
    assert.ok(strict.remote.rejectedByReason['fork of ...'] >= 1 && strict.remote.rejectedByReason['owner not allowlisted'] >= 1 && strict.remote.rejectedByReason['installs N < floor N'] === 1 && strict.remote.rejectedByReason['already installed locally (...)'] === 1, JSON.stringify(strict.remote.rejectedByReason));
  });

  test('deadline: a slow registry stops the suggest step inside the budget (requests skipped "deadline", no crash); fresh cache each time', async () => {
    const home = freshHome('slow', CONFIG);
    const env = baseEnv(home, { HOME: SKILLS_HOME });
    registry.delayMs = 400;
    let r;
    const t0 = performance.now();
    try {
      r = await runInit({ cwd: PROJ, env, config: { ...DEFAULTS, ...CONFIG, remoteTimeoutMs: 2500 }, remoteBudgetMs: 900 });
    } finally {
      registry.delayMs = 0;
    }
    const wall = performance.now() - t0;
    assert.ok(wall < 900 + 2500 + 1500, `wall ${Math.round(wall)} ms`);
    assert.ok(r.remote.elapsedMs <= 900 + 2500, `suggest ${r.remote.elapsedMs} ms`);
    assert.equal(r.remote.queries.length, 7);
    assert.ok(r.remote.queries.some((q) => q.skipped === 'deadline'), JSON.stringify(r.remote.queries));
    assert.ok(r.remote.queries.filter((q) => !q.skipped).length >= 1, 'the first requests still complete');
    assert.equal(INIT_REMOTE_BUDGET_MS, 12000);
  });

  test('a per-request timeout shorter than the registry delay: every search fails, the report says so, failures are not cached as results', async () => {
    const home = freshHome('timeout', CONFIG);
    const env = baseEnv(home, { HOME: SKILLS_HOME });
    registry.delayMs = 600;
    let r;
    try {
      r = await runInit({ cwd: PROJ, env, config: { ...DEFAULTS, ...CONFIG, remoteTimeoutMs: 150 } });
    } finally {
      registry.delayMs = 0;
    }
    assert.deepEqual(r.candidates, []);
    assert.ok(r.remote.queries.every((q) => q.skipped === 'error'), JSON.stringify(r.remote.queries));
    assert.ok(r.remote.errors.every((x) => /timeout after 150ms/.test(x)), JSON.stringify(r.remote.errors));
    assert.match(formatReport(r), /\nSuggested third-party skills \(pinned, not installed\): none \(third-party search failed: timeout \/ network error\)\nErrors: search "react": timeout after 150ms/);
    const ok = await runInit({ cwd: PROJ, env, config: { ...DEFAULTS, ...CONFIG } });
    assert.equal(ok.candidates.length, 7, 'the registry is healthy again and nothing stale was cached');
  });

  test('HTTP 429: cooldown set, no further request, the report names the time; HTTP 500: "none passed the gates" is not claimed', async () => {
    const home = freshHome('429', CONFIG);
    const env = baseEnv(home, { HOME: SKILLS_HOME });
    registry.status = 429;
    const before = seenRequests();
    let r;
    try {
      r = await runInit({ cwd: PROJ, env, config: { ...DEFAULTS, ...CONFIG } });
    } finally {
      registry.status = null;
    }
    assert.ok(Number(r.remote.cooldownUntil) > Date.now());
    assert.ok(seenRequests() - before <= 2, 'the first failure sets the cooldown; the rest are skipped');
    assert.ok(r.remote.queries.some((q) => q.skipped === 'rate-limited') && r.remote.queries.some((q) => q.skipped === 'cooldown'), JSON.stringify(r.remote.queries));
    assert.match(formatReport(r), /\nSuggested third-party skills \(pinned, not installed\): none \(skills\.sh rate-limited until \d\d:\d\d\)\n/);
    const before2 = seenRequests();
    await runInit({ cwd: PROJ, env, config: { ...DEFAULTS, ...CONFIG } });
    assert.equal(seenRequests() - before2, 0, 'cooldown honoured on the next run');
  });

  test('stack + candidates cover a project with no installed skills; the index is empty on an empty HOME; config initMaxCandidates 0 skips the search', async () => {
    const home = freshHome('nohome', CONFIG);
    const env = baseEnv(home);
    const r = await runInit({ cwd: PROJ, env, config: { ...DEFAULTS, ...CONFIG } });
    assert.equal(r.index.total, 0);
    assert.deepEqual(r.coverage.covered, []);
    assert.ok(r.candidates.some((c) => c.skill === 'nextjs'), 'nothing installed: nextjs is a candidate here');
    assert.ok(r.candidates.some((c) => c.skill === 'playwright-cli'));
    assert.ok(!r.candidates.some((c) => c.also), 'nothing covered: no "also"');
    const before = seenRequests();
    const zero = await runInit({ cwd: PROJ, env, config: { ...DEFAULTS, ...CONFIG, initMaxCandidates: 0 } });
    assert.deepEqual([zero.candidates, zero.remote.skipped], [[], 'initMaxCandidates is 0']);
    assert.equal(seenRequests() - before, 0);
    assert.match(formatReport(zero), /none \(initMaxCandidates is 0\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. --apply
// ---------------------------------------------------------------------------

describe('--apply selection parsing and plan validation (no git needed)', () => {
  test('parseSelection: "1,3", "1-3", "all", spaces, duplicates; junk, zero, reversed range, out of range, empty plan', () => {
    assert.deepEqual(parseSelection('1,3', 5), { ok: true, numbers: [1, 3] });
    assert.deepEqual(parseSelection('1-3', 5), { ok: true, numbers: [1, 2, 3] });
    assert.deepEqual(parseSelection('ALL', 3), { ok: true, numbers: [1, 2, 3] });
    assert.deepEqual(parseSelection(' 2, 1 , 2-3 ', 5), { ok: true, numbers: [2, 1, 3] });
    assert.deepEqual(parseSelection('3', 3), { ok: true, numbers: [3] });
    for (const [sel, re] of [['junk', /cannot parse "junk": expected numbers like 1,3 or 1-3, or all/], ['1;2', /cannot parse "1;2"/], ['0', /"0" is not a valid number or range/], ['3-1', /"3-1" is not a valid number or range/], ['9', /9 is not in the plan \(candidates are 1-5\)/], ['4-9', /4-9 is not in the plan \(candidates are 1-5\)/], ['', /empty selection/], ['1-99999', /cannot parse/]]) {
      const r = parseSelection(sel, 5);
      assert.equal(r.ok, false, sel);
      assert.match(r.message, re, sel);
    }
    assert.match(parseSelection('all', 0).message, /the plan has no candidates/);
    assert.match(parseSelection('1', 0).message, /1 is not in the plan \(the plan has no candidates\)/);
  });

  test('parseArgs: every flag, --apply=sel, missing --apply value, unknown argument', () => {
    assert.deepEqual(parseArgs(['--apply', '1,3', '--project', '--no-remote', '--json', '--yes', '--cwd', '/x']), { apply: '1,3', project: true, remote: false, json: true, yes: true, cwd: '/x', help: false, errors: [] });
    assert.equal(parseArgs(['--apply=all']).apply, 'all');
    assert.equal(parseArgs(['--apply', 'all', '--yes']).apply, 'all');
    assert.deepEqual(parseArgs(['--apply']).errors, ['--apply needs a selection: numbers like 1,3 or 1-3, or all']);
    assert.deepEqual(parseArgs(['--apply', '--json']).errors, ['--apply needs a selection: numbers like 1,3 or 1-3, or all']);
    assert.deepEqual(parseArgs(['--apply=']).errors, ['--apply needs a selection: numbers like 1,3 or 1-3, or all']);
    assert.deepEqual(parseArgs(['extra']).errors, ['unexpected argument "extra"']);
    assert.equal(parseArgs(['-h']).help, true);
    assert.deepEqual(parseArgs(null).errors, []);
  });

  test('loadPlan: missing, invalid JSON, wrong shape, expired (24 h), undated, other cwd, ok; the cwd compares after symlink resolution', () => {
    const home = freshHome('plan');
    const file = path.join(home, PLAN_FILE);
    assert.match(loadPlan({ file, dir: PROJ, ttlHours: 24 }).message, /^no plan found at .*init-plan\.json; run \/singular init first$/);
    fs.writeFileSync(file, '{nope');
    assert.match(loadPlan({ file, dir: PROJ, ttlHours: 24 }).message, /is not valid JSON; run \/singular init again$/);
    fs.writeFileSync(file, JSON.stringify({ version: 2, cwd: PROJ, createdAt: new Date().toISOString(), candidates: [] }));
    assert.match(loadPlan({ file, dir: PROJ, ttlHours: 24 }).message, /unexpected shape \(version 2\)/);
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ version: 1, cwd: PROJ, createdAt: old, candidates: [] }));
    assert.match(loadPlan({ file, dir: PROJ, ttlHours: 24 }).message, /is 25 h old \(older than 24 h\); run \/singular init again$/);
    fs.writeFileSync(file, JSON.stringify({ version: 1, cwd: PROJ, createdAt: 'yesterday', candidates: [] }));
    assert.match(loadPlan({ file, dir: PROJ, ttlHours: 24 }).message, /is undated \(older than 24 h\)/);
    const fresh = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify({ version: 1, cwd: PY, createdAt: fresh, candidates: [] }));
    assert.match(loadPlan({ file, dir: PROJ, ttlHours: 24 }).message, new RegExp(`^the plan was made for ${PY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, not ${PROJ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}; run /singular init here first$`));
    fs.writeFileSync(file, JSON.stringify({ version: 1, cwd: PROJ, createdAt: fresh, candidates: [] }));
    assert.equal(loadPlan({ file, dir: PROJ, ttlHours: 24 }).ok, true);
    assert.equal(loadPlan({ file, dir: PROJ, ttlHours: 0.5, now: Date.now() + 3600 * 1000 }).ok, false, 'ttl from config');
    const link = path.join(AGENT, 'proj-link');
    fs.symlinkSync(PROJ, link);
    assert.equal(loadPlan({ file, dir: link, ttlHours: 24 }).ok, true, 'symlinked cwd is the same project');
  });

  test('runApply refusals as a child process: missing plan, expired plan, other cwd, junk selection, out of range -> exit 1 with the message, nothing installed', async () => {
    const home = freshHome('apply-refuse', CONFIG);
    const skills = path.join(AGENT, 'apply-refuse-skills');
    const env = baseEnv(home, { SINGULAR_SKILLS_DIR: skills });
    const before = seenRequests();
    const missing = await runBin(['init', '--apply', '1'], { env });
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, `[singular] init --apply: no plan found at ${path.join(home, PLAN_FILE)}; run /singular init first\n`);
    const cand = { n: 1, ref: `anthropics/skills#${'a'.repeat(40)}@frontend-design`, source: 'anthropics/skills', skill: 'frontend-design', installs: 1, audit: 'pass', need: 'tailwind', reason: 'dep', also: false, sha: 'a'.repeat(40), approvable: true };
    write(path.join(home, PLAN_FILE), JSON.stringify({ version: 1, cwd: PROJ, createdAt: new Date(Date.now() - 30 * 3600 * 1000).toISOString(), stack: { summary: '', tags: [] }, needs: [], coverage: { covered: [], uncovered: [] }, candidates: [cand] }));
    const expired = await runBin(['init', '--apply', '1'], { env });
    assert.equal(expired.code, 1);
    assert.match(expired.stdout, /^\[singular\] init --apply: the plan at .* is 30 h old \(older than 24 h\); run \/singular init again\n$/);
    write(path.join(home, PLAN_FILE), JSON.stringify({ version: 1, cwd: PY, createdAt: new Date().toISOString(), stack: { summary: '', tags: [] }, needs: [], coverage: { covered: [], uncovered: [] }, candidates: [cand] }));
    const elsewhere = await runBin(['init', '--apply', '1'], { env });
    assert.equal(elsewhere.code, 1);
    assert.equal(elsewhere.stdout, `[singular] init --apply: the plan was made for ${PY}, not ${PROJ}; run /singular init here first\n`);
    write(path.join(home, PLAN_FILE), JSON.stringify({ version: 1, cwd: PROJ, createdAt: new Date().toISOString(), stack: { summary: '', tags: [] }, needs: [], coverage: { covered: [], uncovered: [] }, candidates: [cand] }));
    for (const [sel, msg] of [['junk', 'cannot parse "junk": expected numbers like 1,3 or 1-3, or all'], ['2', '2 is not in the plan (candidates are 1-1)'], ['0', 'cannot parse "0": "0" is not a valid number or range']]) {
      const r = await runBin(['init', '--apply', sel], { env });
      assert.equal(r.code, 1, sel);
      assert.equal(r.stdout, `[singular] init --apply: ${msg}\n`, sel);
    }
    const noValue = await runBin(['init', '--apply'], { env });
    assert.equal(noValue.code, 1);
    assert.equal(noValue.stdout, '');
    assert.match(noValue.stderr, /^\[singular\] init: --apply needs a selection: numbers like 1,3 or 1-3, or all\nusage: singular init /);
    assert.equal(seenRequests() - before, 0, 'refusals never reach the network');
    assert.ok(!fs.existsSync(skills), 'nothing installed');
  });
});

describe('--apply installs through the add flow (real git against the local base)', { skip: !HAS_GIT && 'git not on PATH' }, () => {
  const tmp = path.join(AGENT, 'apply-tmp');
  before(() => { fs.mkdirSync(tmp, { recursive: true }); });
  const leftovers = () => fs.readdirSync(tmp).filter((n) => n.startsWith('singular-add-'));

  test('plan -> --apply all: INSTALLED (pinned, into SINGULAR_SKILLS_DIR), REJECTED malicious leaves nothing, kickoff prompt; --apply again -> SKIPPED (exists); --project targets ./.claude/skills', async () => {
    const home = freshHome('apply', CONFIG);
    const skills = path.join(AGENT, 'apply-skills');
    const env = baseEnv(home, { HOME: SKILLS_HOME, SINGULAR_SKILLS_DIR: skills, TMPDIR: tmp });
    const plan = JSON.parse((await runBin(['init', '--json'], { env })).stdout);
    assert.equal(plan.candidates.length, 7);
    const r = await runBin(['init', '--apply', 'all', '--yes'], { env });
    assert.equal(r.code, 1, 'one candidate was REJECTED');
    assert.equal(r.stderr, '');
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], `[singular] init --apply all: 7 of 7 candidates for proj (plan from ${plan.createdAt}) -> ${skills}`);
    assert.equal(lines[1], `INSTALLED 1. vercel-labs/agent-skills#${sha7()}@vercel-react-best-practices -> ${path.join(skills, 'vercel-react-best-practices')} (audit pass)`);
    assert.equal(lines[2], `INSTALLED 2. anthropics/skills#${sha7()}@supabase-postgres -> ${path.join(skills, 'supabase-postgres')} (audit pass)`);
    assert.ok(lines[3].startsWith(`REJECTED 3. anthropics/skills#${sha7()}@stripe-best-practices: executable bit in repository tree: stripe-best-practices/bin/pwn (mode 100755); symlink in repository tree: stripe-best-practices/link (mode 120000); `), lines[3]);
    assert.ok(lines[3].endsWith(' (nothing was written)'), lines[3]);
    assert.match(lines[3], /; \+\d+ more \(nothing was written\)$/);
    assert.equal(lines[4], `INSTALLED 4. anthropics/skills#${sha7()}@frontend-design -> ${path.join(skills, 'frontend-design')} (audit pass)`);
    assert.equal(lines[5], `INSTALLED 5. anthropics/skills#${sha7()}@typescript-strict-mode -> ${path.join(skills, 'typescript-strict-mode')} (audit pass)`);
    assert.equal(lines[6], `INSTALLED 6. vercel-labs/agent-skills#${sha7()}@nextjs-react-patterns -> ${path.join(skills, 'nextjs-react-patterns')} (audit pass)`);
    assert.equal(lines[7], `INSTALLED 7. vercel-labs/agent-skills#${sha7()}@nextjs-app-router -> ${path.join(skills, 'nextjs-app-router')} (audit pass)`);
    assert.equal(lines[8], 'Installed: vercel-react-best-practices, supabase-postgres, frontend-design, typescript-strict-mode, nextjs-react-patterns, nextjs-app-router');
    assert.equal(lines[9], 'Kickoff prompt (copy or say "run it"):');
    assert.equal(lines[10], '  Using the skills vercel-react-best-practices, supabase-postgres, frontend-design, typescript-strict-mode, nextjs-react-patterns and nextjs-app-router, review this Next.js 16 + React 19 project: list the 3 highest-impact improvements for react, supabase, tailwind, typescript, next, then implement the first one.');
    assert.ok(lines[10].trim().length <= KICKOFF_MAX_CHARS);
    assert.equal(lines[11], 'Reload: new skills are picked up automatically; run /reload-skills if /singular status does not list them.');
    assert.deepEqual(lines.slice(12), ['']);
    // the file system: exactly the six clean skills, the malicious one never landed, no temp dir left, nothing under HOME
    assert.deepEqual(fs.readdirSync(skills).sort(), ['frontend-design', 'nextjs-app-router', 'nextjs-react-patterns', 'supabase-postgres', 'typescript-strict-mode', 'vercel-react-best-practices']);
    assert.ok(!fs.existsSync(path.join(skills, 'stripe-best-practices')));
    assert.deepEqual(fs.readdirSync(path.join(skills, 'frontend-design')), ['SKILL.md']);
    assert.deepEqual(leftovers(), []);
    assert.ok(!fs.existsSync(path.join(SKILLS_HOME, '.claude', 'skills', 'frontend-design')) && !fs.existsSync(path.join(EMPTY_HOME, '.claude', 'skills')), 'the seam redirected every install');
    assert.ok(!fs.existsSync(path.join(PROJ, '.claude')), 'nothing in the project without --project');
    const installed = readJson(path.join(home, 'installed.json'));
    assert.deepEqual(Object.keys(installed).sort(), ['anthropics/skills@frontend-design', 'anthropics/skills@supabase-postgres', 'anthropics/skills@typescript-strict-mode', 'vercel-labs/agent-skills@nextjs-app-router', 'vercel-labs/agent-skills@nextjs-react-patterns', 'vercel-labs/agent-skills@vercel-react-best-practices']);
    assert.ok(Object.values(installed).every((v) => v.sha === HEAD_SHA && v.audit === 'pass'));
    const log = readLog(home, 'init apply');
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].selection, log[0].installed.length, log[0].rejected, log[0].skipped], [[1, 2, 3, 4, 5, 6, 7], 6, [`anthropics/skills#${HEAD_SHA}@stripe-best-practices`], []]);
    // again: the selected ones are SKIPPED (exists), exit 0; nothing changes
    const again = await runBin(['init', '--apply', '1,2', '--yes'], { env });
    assert.equal(again.code, 0, again.stdout);
    assert.equal(again.stdout, [
      `[singular] init --apply 1,2: 2 of 7 candidates for proj (plan from ${plan.createdAt}) -> ${skills}`,
      `SKIPPED 1. vercel-labs/agent-skills#${sha7()}@vercel-react-best-practices (exists: ${path.join(skills, 'vercel-react-best-practices')})`,
      `SKIPPED 2. anthropics/skills#${sha7()}@supabase-postgres (exists: ${path.join(skills, 'supabase-postgres')})`,
      'Installed: none',
      'Kickoff prompt: none (nothing new was installed)',
      '',
    ].join('\n'));
    // --project: the same candidate goes into <cwd>/.claude/skills (the seam only replaces ~/.claude/skills)
    const proj = await runBin(['init', '--apply', '4', '--project'], { env });
    assert.equal(proj.code, 0, proj.stdout);
    assert.equal(proj.stdout.split('\n')[0], `[singular] init --apply 4: 1 of 7 candidates for proj (plan from ${plan.createdAt}) -> ${path.join(PROJ, '.claude', 'skills')}`);
    assert.equal(proj.stdout.split('\n')[1], `INSTALLED 4. anthropics/skills#${sha7()}@frontend-design -> ${path.join(PROJ, '.claude', 'skills', 'frontend-design')} (audit pass)`);
    assert.match(proj.stdout, /\nInstalled: frontend-design\nKickoff prompt \(copy or say "run it"\):\n  Using the skill frontend-design, review this Next\.js 16 \+ React 19 project: list the 3 highest-impact improvements for tailwind, then implement the first one\.\nReload: /);
    assert.ok(fs.existsSync(path.join(PROJ, '.claude', 'skills', 'frontend-design', 'SKILL.md')));
    assert.deepEqual(fs.readdirSync(path.join(PROJ, '.claude', 'skills')), ['frontend-design']);
    const j = await runBin(['init', '--apply', '4', '--project', '--json'], { env });
    assert.equal(j.code, 0);
    const out = JSON.parse(j.stdout);
    assert.deepEqual([out.status, out.exitCode, out.target, out.installed, out.kickoff, out.results[0].status, out.results[0].why], ['ok', 0, path.join(PROJ, '.claude', 'skills'), [], '', 'skipped', 'exists']);
    fs.rmSync(path.join(PROJ, '.claude'), { recursive: true, force: true });
    assert.deepEqual(leftovers(), []);
  });

  test('the pinned ref from the plan is installed even after the repository moved on: HEAD is never re-resolved (no ls-remote), installed sha = plan sha', async () => {
    assert.notEqual(MOVED_SHA, HEAD_SHA);
    const home = freshHome('pinned', { ...CONFIG, allowlist: ['pinned-owner'] });
    const skills = path.join(AGENT, 'pinned-skills');
    const env = baseEnv(home, { HOME: SKILLS_HOME, SINGULAR_SKILLS_DIR: skills, TMPDIR: tmp });
    write(path.join(home, PLAN_FILE), JSON.stringify({
      version: 1, cwd: PROJ, createdAt: new Date().toISOString(), stack: { summary: 'Next.js 16; branch main', tags: ['next'] }, needs: [], coverage: { covered: [], uncovered: [] },
      candidates: [{ n: 1, ref: `pinned-owner/repo#${HEAD_SHA}@frontend-design`, source: 'pinned-owner/repo', skill: 'frontend-design', installs: 5, audit: 'pass', need: 'tailwind', reason: 'dep', also: false, sha: HEAD_SHA, approvable: true }],
    }));
    const calls = [];
    const execFileImpl = (file, args, opts, cb) => { calls.push([file, ...args]); return nodeExecFile(file, args, opts, cb); };
    const r = await runApply({ selection: 'all', cwd: PROJ, env, deps: { execFileImpl }, config: { ...DEFAULTS, ...CONFIG, allowlist: ['pinned-owner'] } });
    assert.equal(r.exitCode, 0, r.message);
    assert.equal(r.results[0].sha, HEAD_SHA);
    assert.match(r.message, new RegExp(`\\nINSTALLED 1\\. pinned-owner/repo#${HEAD_SHA.slice(0, 7)}@frontend-design -> `));
    assert.ok(!calls.some((c) => c.includes('ls-remote')), `no HEAD resolve: ${JSON.stringify(calls.map((c) => c.slice(0, 3)))}`);
    assert.ok(calls.some((c) => c[0] === 'git' && c.includes('fetch') && c.includes(HEAD_SHA)), 'fetched exactly the pinned commit');
    assert.equal(readJson(path.join(home, 'installed.json'))['pinned-owner/repo@frontend-design'].sha, HEAD_SHA);
    assert.ok(!fs.existsSync(path.join(skills, 'frontend-design', 'CHANGELOG.md')), 'the newer commit (with CHANGELOG.md) was not what got installed');
    assert.equal(r.kickoff, 'Using the skill frontend-design, review this Next.js 16 project: list the 3 highest-impact improvements for tailwind, then implement the first one.');
  });

  test('kickoffPrompt is deterministic, names every skill, uses the first two stack labels, and never exceeds 400 chars (needs dropped first, then skills)', () => {
    const stack = { summary: 'Next.js 16, Tailwind 4, Supabase, Stripe; branch main', tags: [] };
    const p = kickoffPrompt({ stack, skills: ['playwright-cli', 'frontend-design'], needs: ['playwright', 'tailwind'] });
    assert.equal(p, 'Using the skills playwright-cli and frontend-design, review this Next.js 16 + Tailwind 4 project: list the 3 highest-impact improvements for playwright, tailwind, then implement the first one.');
    assert.equal(kickoffPrompt({ stack, skills: ['playwright-cli', 'frontend-design'], needs: ['playwright', 'tailwind'] }), p, 'same input, same text');
    assert.equal(kickoffPrompt({ stack: { summary: '', tags: [] }, skills: ['one'], needs: [] }), 'Using the skill one, review this project: list the 3 highest-impact improvements for this codebase, then implement the first one.');
    assert.equal(kickoffPrompt({ stack, skills: [], needs: ['x'] }), '');
    assert.equal(kickoffPrompt({ stack: 'Python, FastAPI, pytest', skills: ['a', 'b', 'a'], needs: ['fastapi', 'fastapi'] }), 'Using the skills a and b, review this Python + FastAPI project: list the 3 highest-impact improvements for fastapi, then implement the first one.');
    const many = Array.from({ length: 12 }, (_, i) => `very-long-skill-name-number-${i}-for-testing`);
    const long = kickoffPrompt({ stack, skills: many, needs: Array.from({ length: 12 }, (_, i) => `need${i}`) });
    assert.ok(long.length <= KICKOFF_MAX_CHARS, `${long.length}`);
    assert.ok(long.startsWith('Using the skills very-long-skill-name-number-0-for-testing'));
    assert.ok(long.endsWith(', then implement the first one.'), long);
    assert.equal(KICKOFF_MAX_CHARS, 400);
  });
});

// ---------------------------------------------------------------------------
// 6. wiring: dispatcher, help, COMMANDS_HINT, SKILL.md, config keys
// ---------------------------------------------------------------------------

describe('wiring', () => {
  test('bin/singular.js: init in SUBCOMMANDS and HELP; `init --help` prints the usage (exit 0); an unknown subcommand lists init', async () => {
    const { SUBCOMMANDS, HELP, parseDispatch } = await import('../bin/singular.js');
    assert.ok(SUBCOMMANDS.includes('init'));
    assert.deepEqual(parseDispatch(['INIT', '--no-remote']), { sub: 'init', rest: ['--no-remote'] });
    assert.match(HELP, /\n  \/singular init \[--no-remote\]     inspect this project: needs, which installed skills cover them, numbered pinned\n/);
    assert.match(HELP, /\n  \/singular init --apply 1,3\|all \[--project\]\n/);
    assert.match(HELP, /initMaxCandidates/);
    const home = freshHome('wiring');
    const help = await runBin(['init', '--help'], { env: baseEnv(home) });
    assert.deepEqual([help.code, help.stdout, help.stderr], [0, '', `${init.USAGE}\n`]);
    const bad = await runBin(['init', '--bogus'], { env: baseEnv(home) });
    assert.deepEqual([bad.code, bad.stdout], [1, '']);
    assert.equal(bad.stderr, `[singular] init: unexpected argument "--bogus"\n${init.USAGE}\n`);
    const unknown = await runBin(['nope'], { env: baseEnv(home) });
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /^\[singular\] unknown subcommand "nope"; expected one of status \| help \| find \| load \| add \| mode \| init\n/);
    assert.ok(!fs.existsSync(path.join(home, PLAN_FILE)), 'help and errors write no plan');
  });

  test('bin/on-prompt.js COMMANDS_HINT mentions /singular init; the dispatcher main() in-process returns the exit code', async () => {
    const { COMMANDS_HINT } = await import('../bin/on-prompt.js');
    assert.match(COMMANDS_HINT, /, \/singular init \(inspect this project, suggest and install skills\)\.$/);
    const { main } = await import('../bin/singular.js');
    const home = freshHome('inproc');
    const prev = { HOME: process.env.HOME, SINGULAR_HOME: process.env.SINGULAR_HOME, SINGULAR_REGISTRY_BASE: process.env.SINGULAR_REGISTRY_BASE };
    Object.assign(process.env, { HOME: SKILLS_HOME, SINGULAR_HOME: home });
    try {
      const r = await capture(() => main(['init', '--no-remote', '--cwd', PROJ]));
      assert.equal(r.value, 0);
      assert.match(r.stdout, /^\[singular\] init: proj\nStack: Next\.js 16/);
      assert.match(r.stdout, /\nSuggested third-party skills: skipped \(--no-remote\)\n$/);
      const bad = await capture(() => main(['init', '--apply', 'junk', '--cwd', PROJ]));
      assert.equal(bad.value, 1);
      assert.equal(bad.stdout, '[singular] init --apply: cannot parse "junk": expected numbers like 1,3 or 1-3, or all\n');
    } finally {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  test('skills/singular/SKILL.md documents init: run, show verbatim, ask which numbers, --apply only after the answer, kickoff prompt via the Skill tool; frontmatter unchanged', () => {
    const text = fs.readFileSync(path.join(ROOT, 'skills', 'singular', 'SKILL.md'), 'utf8');
    assert.match(text, /^---\nname: singular\ndescription: "Singular: find, load, add and manage third-party skills \(\/singular help\)"\ndisable-model-invocation: true\n---\n/);
    assert.match(text, /\n- `init \[--no-remote\]` - inspects the current project/);
    assert.match(text, /`init --apply <numbers\|all> \[--project\]` installs the approved candidates/);
    assert.match(text, /For `init`: run `node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/singular\.js" init` \(add `--no-remote` if the user asked for installed-only\), show the report verbatim, then ask the user which numbered candidates to install \(or none\)\. Never pass `--apply` until they answer\./);
    assert.match(text, /run `node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/singular\.js" init --apply <numbers>` \(append `--project` if they asked for a project-local install\) and show the result verbatim\. If it prints a kickoff prompt, ask whether to run it now; if yes, follow that prompt and invoke the named skills with the Skill tool\./);
    assert.doesNotMatch(text, /singular-init|\/init\b/, 'no alias command');
  });

  test('config: initMaxCandidates (8) and initPlanTtlHours (24) in DEFAULTS, config.example.json and validation (bad types fall back with a warning)', () => {
    assert.equal(DEFAULTS.initMaxCandidates, 8);
    assert.equal(DEFAULTS.initPlanTtlHours, 24);
    const example = readJson(path.join(ROOT, 'config.example.json'));
    assert.deepEqual([example.initMaxCandidates, example.initPlanTtlHours], [8, 24]);
    for (const key of Object.keys(DEFAULTS)) assert.ok(key in example, `${key} in config.example.json`);
    const r = validateConfig({ initMaxCandidates: 'eight', initPlanTtlHours: -1 });
    assert.deepEqual([r.config.initMaxCandidates, r.config.initPlanTtlHours], [8, 24]);
    assert.deepEqual(r.warnings, ['initMaxCandidates: must be a non-negative number; using default 8', 'initPlanTtlHours: must be a non-negative number; using default 24']);
    const ok = validateConfig({ initMaxCandidates: 3, initPlanTtlHours: 1 });
    assert.deepEqual([ok.config.initMaxCandidates, ok.config.initPlanTtlHours, ok.warnings], [3, 1, []]);
    assert.equal(planPath({ SINGULAR_HOME: path.join(AGENT, 'pp') }), path.join(AGENT, 'pp', 'init-plan.json'));
  });
});

// ---------------------------------------------------------------------------
// 7. timing
// ---------------------------------------------------------------------------

describe('timing', () => {
  test('init --no-remote stays under 1.5 s in-process on every fixture and on this repository, also with 160 installed skills', async (t) => {
    const home = freshHome('timing', CONFIG);
    const results = [];
    for (const [label, cwd, HOME] of [['proj', PROJ, SKILLS_HOME], ['py', PY, SKILLS_HOME], ['mono', MONO, SKILLS_HOME], ['empty', EMPTY_DIR, EMPTY_HOME], ['repo', ROOT, MANY_HOME]]) {
      clearIndexCache();
      const t0 = performance.now();
      const r = await runInit({ cwd, remote: false, env: { HOME, SINGULAR_HOME: home }, config: { ...DEFAULTS, ...CONFIG } });
      const wall = performance.now() - t0;
      results.push(`${label} ${Math.round(wall)} ms (inspect ${r.inspection.elapsedMs} ms, ${r.inspection.filesScanned} entries, index ${r.index.total})`);
      assert.ok(wall < 1500, `${label}: ${Math.round(wall)} ms`);
      assert.equal(r.remote.skipped, 'no-remote');
    }
    t.diagnostic(`init --no-remote: ${results.join('; ')}`);
    const child = await runBin(['init', '--no-remote'], { env: baseEnv(home, { HOME: MANY_HOME }), cwd: ROOT });
    assert.equal(child.code, 0, child.stderr);
    assert.ok(child.ms < 1500, `child process ${Math.round(child.ms)} ms`);
    t.diagnostic(`init --no-remote as a child process on the repository: ${Math.round(child.ms)} ms`);
  });
});
