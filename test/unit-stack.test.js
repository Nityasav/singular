// test/unit-stack.test.js — node --test test/unit-stack.test.js
//
// Exhaustive unit tests for lib/stack.js: every detector (each package.json framework with its version and
// dedupe rule, every lockfile, packageManager, tsconfig strict incl. JSONC, pyproject/requirements with the
// word-boundary rules, poetry/uv, go.mod, Cargo.toml, Gemfile, pom.xml, Gradle, Dockerfile, .git/HEAD incl.
// worktree gitdir files and the walk-up limit), malformed / oversized / unreadable manifests, the 160-char
// summary cap, the mtime-validated cache, and the never-throws guarantee (fs faults injected with node:test
// mock). All projects are created under the scratchpad; nothing outside it is read.
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectStack, clearStackCache, majorOf, gitBranch, stripJsonComments, SUMMARY_MAX, STACK_TTL_MS } from '../lib/stack.js';

const SCRATCH_ROOT = process.env.SINGULAR_TEST_TMP
  || '/private/tmp/claude-501/-Users-nitya--superset-projects-claude-skills/cfa575e5-ae3c-4522-b59f-cd3623c88bf0/scratchpad';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

function mkTmp(label) {
  let base = SCRATCH_ROOT;
  try { fs.mkdirSync(base, { recursive: true }); } catch { base = os.tmpdir(); }
  return fs.mkdtempSync(path.join(base, `unit-stack-${label}-`));
}
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } };

let root;
let counter = 0;
/** A fresh project dir with the given files ({relativePath: content}); `null` content creates a directory. */
function project(files = {}) {
  const dir = path.join(root, `p${counter++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel);
    if (content === null) fs.mkdirSync(f, { recursive: true });
    else write(f, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}
const detect = (dir) => { clearStackCache(); return detectStack(dir); };

before(() => { root = mkTmp('root'); });
after(() => rm(root));
beforeEach(() => clearStackCache());

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------
describe('package.json: frameworks, versions, dedupe', () => {
  // [dependency, label, tag, versioned] — the NPM_MAP table of lib/stack.js
  const TABLE = [
    ['next', 'Next.js', 'next', true], ['react', 'React', 'react', true], ['vue', 'Vue', 'vue', true],
    ['nuxt', 'Nuxt', 'nuxt', true], ['@sveltejs/kit', 'SvelteKit', 'svelte', true], ['svelte', 'Svelte', 'svelte', true],
    ['astro', 'Astro', 'astro', true], ['@remix-run/react', 'Remix', 'remix', true], ['@remix-run/node', 'Remix', 'remix', true],
    ['@angular/core', 'Angular', 'angular', true], ['solid-js', 'SolidJS', 'solid', true], ['express', 'Express', 'express', true],
    ['hono', 'Hono', 'hono', true], ['@nestjs/core', 'NestJS', 'nest', true], ['fastify', 'Fastify', 'fastify', true],
    ['electron', 'Electron', 'electron', true], ['expo', 'Expo', 'expo', true], ['react-native', 'React Native', 'react-native', true],
    ['tailwindcss', 'Tailwind', 'tailwind', true], ['@prisma/client', 'Prisma', 'prisma', true], ['prisma', 'Prisma', 'prisma', true],
    ['drizzle-orm', 'Drizzle', 'drizzle', false], ['@supabase/supabase-js', 'Supabase', 'supabase', false],
    ['@trpc/server', 'tRPC', 'trpc', false], ['@trpc/client', 'tRPC', 'trpc', false], ['graphql', 'GraphQL', 'graphql', false],
    ['stripe', 'Stripe', 'stripe', false], ['vitest', 'Vitest', 'vitest', false], ['jest', 'Jest', 'jest', false],
    ['@playwright/test', 'Playwright', 'playwright', false], ['playwright', 'Playwright', 'playwright', false],
    ['cypress', 'Cypress', 'cypress', false], ['storybook', 'Storybook', 'storybook', false], ['typescript', 'TypeScript', 'typescript', true],
  ];

  test('every known dependency alone: label (+ major when versioned) and tag', async () => {
    for (const [dep, label, tag, versioned] of TABLE) {
      const r = await detect(project({ 'package.json': { dependencies: { [dep]: '^3.2.1' } } }));
      assert.equal(r.summary, versioned ? `${label} 3` : label, dep);
      assert.deepEqual(r.tags, [tag], dep);
    }
  });

  test('one tag per family: the first listed package wins (SvelteKit over Svelte, Remix pair, Prisma pair, tRPC pair, Playwright pair)', async () => {
    const r = await detect(project({ 'package.json': { dependencies: {
      svelte: '5.0.0', '@sveltejs/kit': '2.5.0', '@remix-run/node': '2', '@remix-run/react': '2', prisma: '6', '@prisma/client': '6',
      '@trpc/client': '11', '@trpc/server': '11', playwright: '1', '@playwright/test': '1',
    } } }));
    assert.equal(r.summary, 'SvelteKit 2, Remix 2, Prisma 6, tRPC, Playwright');
    assert.deepEqual(r.tags, ['svelte', 'remix', 'prisma', 'trpc', 'playwright']);
  });

  test('order follows the table, not the manifest; devDependencies merge; non-object dependency blocks are ignored', async () => {
    const r = await detect(project({ 'package.json': { devDependencies: { vitest: '2', typescript: '5.6' }, dependencies: { stripe: '17', next: '16.0.1' }, peerDependencies: { react: '19' } } }));
    assert.equal(r.summary, 'Next.js 16, Stripe, Vitest, TypeScript 5');
    assert.deepEqual(r.tags, ['next', 'stripe', 'vitest', 'typescript']);
    const bad = await detect(project({ 'package.json': { dependencies: 'oops', devDependencies: ['nope'], type: 'module' } }));
    assert.deepEqual(bad, { summary: 'Node.js (ESM)', tags: ['node'] });
  });

  test('version specs: caret, tilde, range, x, tag, workspace, catalog, npm alias', async () => {
    const r = await detect(project({ 'package.json': { dependencies: { next: 'latest', react: 'workspace:*', vue: 'catalog:', astro: '>=4.1.0 <5', nuxt: '3.x', hono: 'npm:hono@4.6.0' } } }));
    assert.equal(r.summary, 'Next.js, React, Vue, Nuxt 3, Astro 4, Hono 4');
  });

  test('manifest edge cases: BOM, JSONC, corrupt, over 512 KB, a directory, a dangling symlink', async () => {
    assert.equal((await detect(project({ 'package.json': '﻿{"dependencies":{"react":"18.3.1"}}' }))).summary, 'React 18');
    assert.equal((await detect(project({ 'package.json': '{\n  // comment\n  "dependencies": { "vue": "3.5.0", /* trailing */ },\n}\n' }))).summary, 'Vue 3');
    assert.deepEqual(await detect(project({ 'package.json': '{ nope' })), { summary: '', tags: [] });
    assert.deepEqual(await detect(project({ 'package.json': '"just a string"' })), { summary: '', tags: [] });
    assert.deepEqual(await detect(project({ 'package.json': `{"dependencies":{"react":"19"},"pad":"${'x'.repeat(520 * 1024)}"}` })), { summary: '', tags: [] }, 'files over 512 KB are treated as absent');
    assert.deepEqual(await detect(project({ 'package.json': null })), { summary: '', tags: [] }, 'a directory is not a manifest');
    const dir = project({});
    fs.symlinkSync(path.join(dir, 'nowhere.json'), path.join(dir, 'package.json'));
    assert.deepEqual(await detect(dir), { summary: '', tags: [] });
  });
});

// ---------------------------------------------------------------------------
// lockfiles / packageManager / tsconfig / Node fallbacks
// ---------------------------------------------------------------------------
describe('lockfiles and packageManager', () => {
  test('each lockfile maps to its package manager and is listed after the frameworks', async () => {
    for (const [file, pm] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']]) {
      const r = await detect(project({ 'package.json': { dependencies: { react: '19' } }, [file]: '' }));
      assert.equal(r.summary, `React 19, ${pm}`, file);
      assert.deepEqual(r.tags, ['react', pm], file);
    }
  });

  test('precedence: pnpm > yarn > bun > npm; packageManager beats every lockfile (a package manager alone replaces the Node.js fallback)', async () => {
    const all = { 'pnpm-lock.yaml': '', 'yarn.lock': '', 'bun.lockb': '', 'package-lock.json': '' };
    assert.deepEqual(await detect(project({ 'package.json': {}, ...all })), { summary: 'pnpm', tags: ['pnpm'] });
    assert.equal((await detect(project({ 'package.json': {}, 'yarn.lock': '', 'bun.lock': '', 'npm-shrinkwrap.json': '' }))).summary, 'yarn');
    assert.equal((await detect(project({ 'package.json': {}, 'bun.lock': '', 'package-lock.json': '' }))).summary, 'bun');
    assert.equal((await detect(project({ 'package.json': { packageManager: 'yarn@4.5.0' }, ...all }))).summary, 'yarn');
    assert.equal((await detect(project({ 'package.json': { packageManager: 'bun' } }))).summary, 'bun');
    assert.equal((await detect(project({ 'package.json': { dependencies: { lodash: '4' } }, 'yarn.lock': '' }))).summary, 'yarn', 'unknown deps do not bring Node.js back either');
  });

  test('packageManager that is not a string or not a plain word falls back to lockfiles / nothing', async () => {
    assert.equal((await detect(project({ 'package.json': { packageManager: 42 }, 'yarn.lock': '' }))).summary, 'yarn');
    assert.equal((await detect(project({ 'package.json': { packageManager: 'my pm@1' } }))).summary, 'Node.js');
    assert.equal((await detect(project({ 'package.json': { packageManager: 'PNPM@9' } }))).summary, 'Node.js', 'only lowercase letters are accepted');
    assert.equal((await detect(project({ 'package.json': { packageManager: '@1.2.3' }, 'bun.lockb': '' }))).summary, 'bun');
  });
});

describe('tsconfig strict and Node.js fallbacks', () => {
  test('typescript dep + tsconfig strict true/false/missing/invalid/JSONC', async () => {
    const ts = { devDependencies: { typescript: '5.7.2' } };
    assert.equal((await detect(project({ 'package.json': ts, 'tsconfig.json': { compilerOptions: { strict: true } } }))).summary, 'TypeScript 5 strict');
    assert.equal((await detect(project({ 'package.json': ts, 'tsconfig.json': { compilerOptions: { strict: false } } }))).summary, 'TypeScript 5');
    assert.equal((await detect(project({ 'package.json': ts, 'tsconfig.json': { compilerOptions: { strict: 'true' } } }))).summary, 'TypeScript 5', 'only a boolean true counts');
    assert.equal((await detect(project({ 'package.json': ts, 'tsconfig.json': { extends: './base.json' } }))).summary, 'TypeScript 5');
    assert.equal((await detect(project({ 'package.json': ts }))).summary, 'TypeScript 5');
    assert.equal((await detect(project({ 'package.json': ts, 'tsconfig.json': '{ broken' }))).summary, 'TypeScript 5');
    assert.equal((await detect(project({ 'package.json': ts, 'tsconfig.json': '﻿{\n  // c\n  "compilerOptions": { /* b */ "strict": true, },\n}\n' }))).summary, 'TypeScript 5 strict');
    assert.equal((await detect(project({ 'package.json': ts, 'tsconfig.json': '{"compilerOptions": {"paths": {"@/*": ["./src/*"]}, "strict": true // url-ish http://x/*y*/ \n}}' }))).summary, 'TypeScript 5 strict');
  });

  test('tsconfig.json without a typescript dependency still tags TypeScript (unversioned, never strict)', async () => {
    const r = await detect(project({ 'package.json': { dependencies: { react: '19' } }, 'tsconfig.json': { compilerOptions: { strict: true } } }));
    assert.deepEqual(r, { summary: 'React 19, TypeScript', tags: ['react', 'typescript'] });
  });

  test('no known dependency: Node.js, or Node.js (ESM) for "type": "module"; a known dep removes the fallback', async () => {
    assert.deepEqual(await detect(project({ 'package.json': { dependencies: { lodash: '4' } } })), { summary: 'Node.js', tags: ['node'] });
    assert.deepEqual(await detect(project({ 'package.json': { type: 'module' } })), { summary: 'Node.js (ESM)', tags: ['node'] });
    assert.deepEqual(await detect(project({ 'package.json': { type: 'commonjs' } })), { summary: 'Node.js', tags: ['node'] });
    assert.deepEqual(await detect(project({ 'package.json': { type: 'module', dependencies: { hono: '4' } } })), { summary: 'Hono 4', tags: ['hono'] });
    assert.deepEqual(await detect(project({ 'package.json': { type: 'module' }, 'pnpm-lock.yaml': '' })), { summary: 'pnpm', tags: ['pnpm'] }, 'a package manager alone counts as a tag');
  });
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------
describe('pyproject.toml / requirements.txt', () => {
  test('each framework needle in pyproject or requirements, case-insensitive', async () => {
    for (const [needle, label, tag] of [['django', 'Django', 'django'], ['fastapi', 'FastAPI', 'fastapi'], ['flask', 'Flask', 'flask'], ['sqlalchemy', 'SQLAlchemy', 'sqlalchemy'], ['pydantic', 'Pydantic', 'pydantic'], ['pytest', 'pytest', 'pytest']]) {
      const a = await detect(project({ 'requirements.txt': `${needle.toUpperCase()}>=1\n` }));
      assert.deepEqual(a, { summary: `Python, ${label}`, tags: ['python', tag] }, `${needle} in requirements`);
      const b = await detect(project({ 'pyproject.toml': `[project]\ndependencies = ["${needle}"]\n` }));
      assert.deepEqual(b, { summary: `Python, ${label}`, tags: ['python', tag] }, `${needle} in pyproject`);
    }
  });

  test('word boundaries: django-filter / pytest-cov do not count, fastapi[all] / "flask" / sqlalchemy==2 do', async () => {
    const r = await detect(project({ 'requirements.txt': 'django-filter\npytest-cov\nfastapi[all]>=0.1\n"flask"\nsqlalchemy==2.0\npydantic_settings\n' }));
    assert.deepEqual(r.tags, ['python', 'fastapi', 'flask', 'sqlalchemy']);
    assert.equal(r.summary, 'Python, FastAPI, Flask, SQLAlchemy');
  });

  test('poetry wins over uv; uv via [tool.uv], via a uv.lock mention, or via the uv.lock file', async () => {
    assert.deepEqual((await detect(project({ 'pyproject.toml': '[tool.poetry]\nname = "x"\n[tool.uv]\n' }))).tags, ['python', 'poetry']);
    assert.deepEqual((await detect(project({ 'pyproject.toml': '[tool.uv]\ndev-dependencies = []\n' }))).tags, ['python', 'uv']);
    assert.deepEqual((await detect(project({ 'requirements.txt': '# generated from uv.lock\n' }))).tags, ['python', 'uv']);
    assert.deepEqual((await detect(project({ 'requirements.txt': 'requests\n', 'uv.lock': '' }))).tags, ['python', 'uv']);
    assert.deepEqual((await detect(project({ 'requirements.txt': 'requests\n' }))).tags, ['python']);
  });

  test('either file alone is enough; both are read; neither means no Python', async () => {
    assert.equal((await detect(project({ 'pyproject.toml': '[project]\nname = "x"\n' }))).summary, 'Python');
    assert.equal((await detect(project({ 'requirements.txt': '' }))).summary, 'Python');
    assert.equal((await detect(project({ 'pyproject.toml': '[project]\ndependencies = ["django"]\n', 'requirements.txt': 'pytest\n' }))).summary, 'Python, Django, pytest');
    assert.equal((await detect(project({ 'setup.py': 'x' }))).summary, '');
  });
});

// ---------------------------------------------------------------------------
// Go / Rust / Ruby / Java / Docker
// ---------------------------------------------------------------------------
describe('go.mod, Cargo.toml, Gemfile, pom.xml, Gradle, Dockerfile', () => {
  test('go.mod with and without a go directive', async () => {
    assert.deepEqual(await detect(project({ 'go.mod': 'module example.com/x\n\ngo 1.24.1\n' })), { summary: 'Go 1.24', tags: ['go'] });
    assert.deepEqual(await detect(project({ 'go.mod': 'module example.com/x\n' })), { summary: 'Go', tags: ['go'] });
  });

  test('Cargo.toml: plain, axum, actix-web, tokio (first match only)', async () => {
    assert.deepEqual(await detect(project({ 'Cargo.toml': '[package]\nname = "x"\n' })), { summary: 'Rust', tags: ['rust'] });
    assert.deepEqual(await detect(project({ 'Cargo.toml': '[dependencies]\naxum = "0.8"\n' })), { summary: 'Rust, axum', tags: ['rust', 'axum'] });
    assert.deepEqual(await detect(project({ 'Cargo.toml': '[dependencies]\nactix-web = { version = "4" }\n' })), { summary: 'Rust, actix-web', tags: ['rust', 'actix-web'] });
    assert.deepEqual(await detect(project({ 'Cargo.toml': '[dependencies]\ntokio = "1"\naxum = "0.8"\n' })), { summary: 'Rust, tokio', tags: ['rust', 'tokio'] });
    assert.deepEqual(await detect(project({ 'Cargo.toml': '[dependencies]\nmy-axum-fork = "1"\n' })), { summary: 'Rust', tags: ['rust'] });
  });

  test('Gemfile with and without rails', async () => {
    assert.deepEqual(await detect(project({ Gemfile: "source 'https://rubygems.org'\ngem \"rails\", '~> 8.0'\n" })), { summary: 'Ruby, Rails', tags: ['ruby', 'rails'] });
    assert.deepEqual(await detect(project({ Gemfile: "gem 'sinatra'\n# gem 'rails'\n" })), { summary: 'Ruby', tags: ['ruby'] });
  });

  test('pom.xml with and without spring-boot; Gradle (groovy or kts); pom wins over Gradle', async () => {
    assert.deepEqual(await detect(project({ 'pom.xml': '<project><artifactId>spring-boot-starter-web</artifactId></project>' })), { summary: 'Java (Maven), Spring Boot', tags: ['java', 'maven', 'spring'] });
    assert.deepEqual(await detect(project({ 'pom.xml': '<project/>' })), { summary: 'Java (Maven)', tags: ['java', 'maven'] });
    assert.deepEqual(await detect(project({ 'build.gradle': '' })), { summary: 'Java (Gradle)', tags: ['java', 'gradle'] });
    assert.deepEqual(await detect(project({ 'build.gradle.kts': '' })), { summary: 'Java (Gradle)', tags: ['java', 'gradle'] });
    assert.deepEqual(await detect(project({ 'build.gradle': '', 'build.gradle.kts': '' })), { summary: 'Java (Gradle)', tags: ['java', 'gradle'] }, 'listed once');
    assert.deepEqual(await detect(project({ 'pom.xml': '<project/>', 'build.gradle': '' })), { summary: 'Java (Maven)', tags: ['java', 'maven'] });
  });

  test('Dockerfile alone, and the full multi-ecosystem order: node, python, go, rust, ruby, java, docker, branch', async () => {
    assert.deepEqual(await detect(project({ Dockerfile: 'FROM scratch\n' })), { summary: 'Docker', tags: ['docker'] });
    const r = await detect(project({
      'package.json': { dependencies: { react: '19' } }, 'pyproject.toml': '[project]\n', 'go.mod': 'go 1.22\n', 'Cargo.toml': '', Gemfile: '',
      'build.gradle': '', Dockerfile: '', '.git/HEAD': 'ref: refs/heads/main\n',
    }));
    assert.equal(r.summary, 'React 19, Python, Go 1.22, Rust, Ruby, Java (Gradle), Docker; branch main');
    assert.deepEqual(r.tags, ['react', 'python', 'go', 'rust', 'ruby', 'java', 'gradle', 'docker']);
  });
});

// ---------------------------------------------------------------------------
// .git/HEAD
// ---------------------------------------------------------------------------
describe('.git/HEAD and gitBranch', () => {
  test('branch ref (with slashes), detached sha, garbage, missing HEAD, no .git at all', () => {
    assert.equal(gitBranch(project({ '.git/HEAD': 'ref: refs/heads/feat/pricing-v2\n' })), 'feat/pricing-v2');
    assert.equal(gitBranch(project({ '.git/HEAD': 'ref:   refs/heads/spaced   \n' })), 'spaced');
    assert.equal(gitBranch(project({ '.git/HEAD': 'abcdef0123456789abcdef0123456789abcdef01\n' })), 'detached abcdef0');
    assert.equal(gitBranch(project({ '.git/HEAD': 'garbage\n' })), '');
    assert.equal(gitBranch(project({ '.git/HEAD': 'ref: refs/remotes/origin/main\n' })), '', 'only refs/heads');
    assert.equal(gitBranch(project({ '.git/config': '' })), '', 'a .git dir without HEAD');
    assert.equal(gitBranch(project({ '.git/HEAD': null })), '', 'HEAD that is a directory');
    assert.equal(gitBranch(project({})), '');
    assert.equal(gitBranch(path.join(root, 'never-created')), '');
  });

  test('worktree .git files: absolute and relative gitdir; no gitdir line; gitdir to a missing dir', () => {
    const real = project({ 'HEAD': 'ref: refs/heads/wt\n' });
    assert.equal(gitBranch(project({ '.git': `gitdir: ${real}\n` })), 'wt');
    const co = project({ 'real/HEAD': 'ref: refs/heads/rel\n', 'checkout/.git': 'gitdir: ../real\n' });
    assert.equal(gitBranch(path.join(co, 'checkout')), 'rel');
    assert.equal(gitBranch(project({ '.git': 'not a pointer\n' })), '');
    assert.equal(gitBranch(project({ '.git': 'gitdir: /nonexistent/singular-test\n' })), '');
    assert.equal(gitBranch(project({ '.git': '' })), '');
  });

  test('walks up through parents, at most 16 levels; the files list receives the HEAD it read', () => {
    const repo = project({ '.git/HEAD': 'ref: refs/heads/deep\n' });
    let d = repo;
    for (let i = 0; i < 15; i++) d = path.join(d, 'd');
    fs.mkdirSync(d, { recursive: true });
    const files = [];
    assert.equal(gitBranch(d, files), 'deep');
    assert.deepEqual(files, [path.join(repo, '.git', 'HEAD')]);
    const tooDeep = path.join(d, 'd');
    fs.mkdirSync(tooDeep);
    assert.equal(gitBranch(tooDeep), '');
    assert.equal(gitBranch(d), 'deep', 'the default files argument is fine');
  });

  test('detectStack: branch only, nested cwd, branch appended after the labels', async () => {
    const repo = project({ '.git/HEAD': 'ref: refs/heads/main\n', 'apps/web/package.json': { dependencies: { next: '16' } } });
    assert.deepEqual(await detect(repo), { summary: 'branch main', tags: [] });
    assert.deepEqual(await detect(path.join(repo, 'apps', 'web')), { summary: 'Next.js 16; branch main', tags: ['next'] });
    assert.deepEqual(await detect(path.join(repo, 'apps')), { summary: 'branch main', tags: [] });
  });
});

// ---------------------------------------------------------------------------
// Summary cap
// ---------------------------------------------------------------------------
describe('summary is capped at SUMMARY_MAX (160) characters', () => {
  test('constants', () => {
    assert.equal(SUMMARY_MAX, 160);
    assert.equal(STACK_TTL_MS, 60_000);
  });

  test('many labels: cut on a comma boundary, ellipsis, branch suffix kept', async () => {
    const deps = {};
    for (const n of ['next', 'react', 'vue', 'nuxt', '@sveltejs/kit', 'astro', '@remix-run/react', '@angular/core', 'solid-js', 'express', 'hono', '@nestjs/core', 'fastify', 'electron', 'expo', 'react-native', 'tailwindcss', '@prisma/client', 'drizzle-orm', '@supabase/supabase-js', '@trpc/server', 'graphql', 'stripe', 'vitest', 'jest', '@playwright/test', 'cypress', 'storybook', 'typescript']) deps[n] = '1.0.0';
    const r = await detect(project({ 'package.json': { dependencies: deps }, '.git/HEAD': 'ref: refs/heads/release/2026-10\n' }));
    assert.ok(r.summary.length <= SUMMARY_MAX, String(r.summary.length));
    assert.match(r.summary, /^Next\.js 1, React 1, Vue 1, .*[^,]…; branch release\/2026-10$/);
    assert.ok(!r.summary.includes(',…'), 'cut lands on a label boundary');
    assert.equal(r.tags.length, 29, 'tags are never truncated');
  });

  test('a single label with no comma to cut on: hard cut plus ellipsis', async () => {
    const r = await detect(project({ 'package.json': { packageManager: `${'a'.repeat(200)}@1.0.0` } }));
    assert.equal(r.summary.length, SUMMARY_MAX);
    assert.ok(r.summary.endsWith('…'));
    assert.equal(r.summary.slice(0, 159), 'a'.repeat(159));
    assert.deepEqual(r.tags, ['a'.repeat(200)]);
  });

  test('framework plus an over-long package manager: the long label is dropped, the short one kept', async () => {
    const r = await detect(project({ 'package.json': { dependencies: { next: '16.1.0' }, packageManager: `${'b'.repeat(200)}@1` } }));
    assert.equal(r.summary, 'Next.js 16…');
  });

  test('branch-only summary longer than the cap is sliced', async () => {
    const r = await detect(project({ '.git/HEAD': `ref: refs/heads/${'c'.repeat(200)}\n` }));
    assert.equal(r.summary.length, SUMMARY_MAX);
    assert.ok(r.summary.startsWith('branch ccc'));
    assert.deepEqual(r.tags, []);
  });

  test('tags are lowercase, unique and in detection order', async () => {
    const r = await detect(project({ 'package.json': { dependencies: { prisma: '6', '@prisma/client': '6', react: '19' }, packageManager: 'pnpm@9' }, Dockerfile: '' }));
    assert.deepEqual(r.tags, ['react', 'prisma', 'pnpm', 'docker']);
    assert.ok(r.tags.every((t) => t === t.toLowerCase()));
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
describe('cache (per cwd, 60 s, validated by manifest mtimes)', () => {
  const future = (dir, file, secondsAhead) => {
    const t = new Date(Date.now() + secondsAhead * 1000);
    fs.utimesSync(path.join(dir, file), t, t);
  };

  test('a hit returns a copy; a changed package.json, tsconfig.json or HEAD mtime invalidates; a newly created tsconfig too', async () => {
    const dir = project({ 'package.json': { devDependencies: { typescript: '5' } }, '.git/HEAD': 'ref: refs/heads/a\n' });
    const a = await detectStack(dir);
    assert.equal(a.summary, 'TypeScript 5; branch a');
    a.tags.push('x');
    const b = await detectStack(dir);
    assert.deepEqual(b.tags, ['typescript'], 'the cached tags are not shared');
    write(path.join(dir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
    future(dir, 'tsconfig.json', 10);
    assert.equal((await detectStack(dir)).summary, 'TypeScript 5 strict; branch a', 'tsconfig was in the watched list even while missing');
    write(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/b\n');
    future(dir, '.git/HEAD', 20);
    assert.equal((await detectStack(dir)).summary, 'TypeScript 5 strict; branch b');
    write(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { typescript: '5' }, dependencies: { hono: '4' } }));
    future(dir, 'package.json', 30);
    assert.equal((await detectStack(dir)).summary, 'Hono 4, TypeScript 5 strict; branch b');
  });

  test('a change that leaves every watched mtime alone is served from the cache until ttlMs or clearStackCache', async () => {
    const dir = project({ 'package.json': { dependencies: { react: '18' } } });
    const stamp = new Date(Date.now() - 5000);
    fs.utimesSync(path.join(dir, 'package.json'), stamp, stamp);
    assert.equal((await detectStack(dir)).summary, 'React 18');
    write(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }));
    fs.utimesSync(path.join(dir, 'package.json'), stamp, stamp);
    assert.equal((await detectStack(dir)).summary, 'React 18', 'cache hit');
    assert.equal((await detectStack(dir, { ttlMs: 0 })).summary, 'React 19', 'ttlMs 0 bypasses');
    assert.equal((await detectStack(dir)).summary, 'React 19', 'and refreshed the entry');
    write(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '20' } }));
    fs.utimesSync(path.join(dir, 'package.json'), stamp, stamp);
    assert.equal((await detectStack(dir)).summary, 'React 19');
    clearStackCache();
    assert.equal((await detectStack(dir)).summary, 'React 20');
    const t0 = Date.now();
    await detectStack(dir, { ttlMs: 1 });
    write(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '21' } }));
    fs.utimesSync(path.join(dir, 'package.json'), stamp, stamp);
    while (Date.now() - t0 < 3) { /* let 1 ms pass */ }
    assert.equal((await detectStack(dir, { ttlMs: 1 })).summary, 'React 21', 'expired ttl rescans');
  });

  test('cwd handling: undefined -> process.cwd(); relative paths resolve; a file as cwd; an object whose toString throws', async () => {
    assert.deepEqual(await detectStack(undefined), await detectStack(process.cwd()));
    assert.deepEqual(await detectStack(null), await detectStack(process.cwd()));
    const dir = project({ 'package.json': { dependencies: { vue: '3' } } });
    const saved = process.cwd();
    process.chdir(dir);
    try {
      assert.equal((await detectStack('.')).summary, 'Vue 3');
    } finally {
      process.chdir(saved);
    }
    const file = path.join(dir, 'package.json');
    assert.deepEqual(await detect(file), { summary: '', tags: [] }, 'a file has no manifests under it');
    assert.deepEqual(await detectStack({ toString() { throw new Error('nope'); } }), { summary: '', tags: [] });
  });
});

// ---------------------------------------------------------------------------
// never throws
// ---------------------------------------------------------------------------
describe('never throws', () => {
  test('an fs fault inside each detector is contained: what was detected before the fault is kept', async () => {
    const dir = project({ 'package.json': { dependencies: { react: '19' } }, 'pyproject.toml': '[project]\n', 'go.mod': 'module x\n', '.git/HEAD': 'ref: refs/heads/m\n' });
    const m = mock.method(fs, 'existsSync', () => { throw new Error('injected'); });
    try {
      clearStackCache();
      const r = await detectStack(dir);
      assert.deepEqual(r, { summary: 'React 19, Python, Go; branch m', tags: ['react', 'python', 'go'] });
      assert.equal(m.mock.callCount(), 3, 'node (tsconfig), python (uv.lock) and others (pom.xml) each hit the fault once');
    } finally {
      m.mock.restore();
    }
    clearStackCache();
    assert.deepEqual(await detectStack(dir), { summary: 'React 19, Python, Go; branch m', tags: ['react', 'python', 'go'] }, 'identical once restored');
  });

  test('unreadable manifest and unreadable project dir', { skip: IS_ROOT && 'running as root' }, async () => {
    const dir = project({ 'package.json': { dependencies: { react: '19' } }, 'go.mod': 'module x\n' });
    fs.chmodSync(path.join(dir, 'package.json'), 0o000);
    try {
      assert.deepEqual(await detect(dir), { summary: 'Go', tags: ['go'] });
    } finally {
      fs.chmodSync(path.join(dir, 'package.json'), 0o644);
    }
    const locked = project({ 'package.json': { dependencies: { react: '19' } } });
    fs.chmodSync(locked, 0o000);
    try {
      assert.deepEqual(await detect(locked), { summary: '', tags: [] });
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
describe('helpers', () => {
  test('majorOf', () => {
    const cases = [
      ['^16.0.3', '16'], ['~19', '19'], ['>=4.1.0 <5', '4'], ['16.x', '16'], ['16', '16'], ['v16', '16'], ['0.40.0', '0'],
      ['1.0.0-beta.1', '1'], ['npm:react@18.2.0', '18'], ['latest', ''], ['workspace:*', ''], ['catalog:', ''], ['', ''], [null, ''], [undefined, ''], [19, '19'],
    ];
    for (const [spec, want] of cases) assert.equal(majorOf(spec), want, String(spec));
  });

  test('stripJsonComments: line and block comments outside strings; strings with escapes and comment-like text survive; unterminated block comment eats the rest', () => {
    assert.equal(stripJsonComments('{"a": "http://x/*y*/", // c\n "b": /* z */ 1}').replace(/\s+/g, ''), '{"a":"http://x/*y*/","b":1}');
    assert.equal(stripJsonComments('{"a":"x\\"//y", "b": 1}'), '{"a":"x\\"//y", "b": 1}');
    assert.equal(stripJsonComments('{"a": 1 /* never closed'), '{"a": 1 ');
    assert.equal(stripJsonComments('// only a comment'), '');
    assert.equal(stripJsonComments(''), '');
    assert.equal(stripJsonComments('{"a": "unterminated string'), '{"a": "unterminated string');
  });
});
