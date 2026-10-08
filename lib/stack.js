// lib/stack.js — deterministic project stack detection (no subprocesses, no network).
//
//   detectStack(cwd) -> {summary: string, tags: string[]}
//     summary <= 160 chars, e.g. "Next.js 16, React 19, Tailwind 4, TypeScript strict, pnpm; branch main"
//     tags    lowercase framework/tool ids, e.g. ["next","react","tailwind","typescript","pnpm"]
//   Never throws; unknown project -> {summary: "", tags: []}. Cached per cwd for 60 s
//   (validated by manifest mtimes). clearStackCache() for tests.
//
// Reads: package.json (+ lockfiles, tsconfig.json), pyproject.toml, requirements.txt,
// go.mod, Cargo.toml, Gemfile, pom.xml, build.gradle(.kts), and .git/HEAD (walking up).

import fs from 'node:fs';
import path from 'node:path';

export const STACK_TTL_MS = 60_000;
export const SUMMARY_MAX = 160;

const cache = new Map(); // cwd -> {ts, sig, result}

export function clearStackCache() {
  cache.clear();
}

// npm package -> {tag, label, versioned}
const NPM_MAP = [
  ['next', 'next', 'Next.js', true],
  ['react', 'react', 'React', true],
  ['vue', 'vue', 'Vue', true],
  ['nuxt', 'nuxt', 'Nuxt', true],
  ['@sveltejs/kit', 'svelte', 'SvelteKit', true],
  ['svelte', 'svelte', 'Svelte', true],
  ['astro', 'astro', 'Astro', true],
  ['@remix-run/react', 'remix', 'Remix', true],
  ['@remix-run/node', 'remix', 'Remix', true],
  ['@angular/core', 'angular', 'Angular', true],
  ['solid-js', 'solid', 'SolidJS', true],
  ['express', 'express', 'Express', true],
  ['hono', 'hono', 'Hono', true],
  ['@nestjs/core', 'nest', 'NestJS', true],
  ['fastify', 'fastify', 'Fastify', true],
  ['electron', 'electron', 'Electron', true],
  ['expo', 'expo', 'Expo', true],
  ['react-native', 'react-native', 'React Native', true],
  ['tailwindcss', 'tailwind', 'Tailwind', true],
  ['@prisma/client', 'prisma', 'Prisma', true],
  ['prisma', 'prisma', 'Prisma', true],
  ['drizzle-orm', 'drizzle', 'Drizzle', false],
  ['@supabase/supabase-js', 'supabase', 'Supabase', false],
  ['@trpc/server', 'trpc', 'tRPC', false],
  ['@trpc/client', 'trpc', 'tRPC', false],
  ['graphql', 'graphql', 'GraphQL', false],
  ['stripe', 'stripe', 'Stripe', false],
  ['vitest', 'vitest', 'Vitest', false],
  ['jest', 'jest', 'Jest', false],
  ['@playwright/test', 'playwright', 'Playwright', false],
  ['playwright', 'playwright', 'Playwright', false],
  ['cypress', 'cypress', 'Cypress', false],
  ['storybook', 'storybook', 'Storybook', false],
  ['typescript', 'typescript', 'TypeScript', true],
];

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

const PY_MAP = [
  ['django', 'django', 'Django'],
  ['fastapi', 'fastapi', 'FastAPI'],
  ['flask', 'flask', 'Flask'],
  ['sqlalchemy', 'sqlalchemy', 'SQLAlchemy'],
  ['pydantic', 'pydantic', 'Pydantic'],
  ['pytest', 'pytest', 'pytest'],
];

function readText(file, max = 512 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function mtime(file) {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

/** Parse JSON that may contain // and /* comments or trailing commas (tsconfig style). Returns null on failure. */
function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/^﻿/, '');
  try {
    return JSON.parse(clean);
  } catch {
    /* fall through */
  }
  try {
    return JSON.parse(stripJsonComments(clean).replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

// Remove line comments and block comments outside of string literals (JSONC).
export function stripJsonComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\') j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** "^16.1.0" | "~19" | "16.x" | ">=4" -> "16"; "latest" | "workspace:*" | "catalog:" -> "" */
export function majorOf(spec) {
  const m = /(?:^|[^0-9.])(\d+)(?:\.\d+)*(?:[-+.][0-9A-Za-z.-]*)?/.exec(String(spec ?? ''));
  return m ? m[1] : '';
}

function detectNode(cwd, tags, labels, files) {
  const pkgFile = path.join(cwd, 'package.json');
  const pkgText = readText(pkgFile);
  if (pkgText === null) return;
  files.push(pkgFile);
  const pkg = parseJsonLoose(pkgText);
  if (!pkg || typeof pkg !== 'object') return;
  const deps = {
    ...(pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}),
    ...(pkg.devDependencies && typeof pkg.devDependencies === 'object' ? pkg.devDependencies : {}),
  };
  const seenTag = new Set();
  let tsStrict = false;
  if ('typescript' in deps) {
    const tsFile = path.join(cwd, 'tsconfig.json');
    const ts = parseJsonLoose(readText(tsFile));
    files.push(tsFile);
    tsStrict = Boolean(ts && ts.compilerOptions && ts.compilerOptions.strict === true);
  }
  for (const [name, tag, label, versioned] of NPM_MAP) {
    if (!(name in deps) || seenTag.has(tag)) continue;
    seenTag.add(tag);
    tags.push(tag);
    const major = versioned ? majorOf(deps[name]) : '';
    let text = major ? `${label} ${major}` : label;
    if (tag === 'typescript' && tsStrict) text += ' strict';
    labels.push(text);
  }
  if (!seenTag.has('typescript') && fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    tags.push('typescript');
    labels.push('TypeScript');
  }
  let pm = '';
  if (typeof pkg.packageManager === 'string') pm = pkg.packageManager.split('@')[0].trim();
  if (!pm) {
    for (const [file, name] of LOCKFILES) {
      if (fs.existsSync(path.join(cwd, file))) {
        pm = name;
        break;
      }
    }
  }
  if (pm && /^[a-z]+$/.test(pm)) {
    tags.push(pm);
    labels.push(pm);
  }
  if (typeof pkg.type === 'string' && pkg.type === 'module' && tags.length === 0) {
    tags.push('node');
    labels.push('Node.js (ESM)');
  } else if (tags.length === 0) {
    tags.push('node');
    labels.push('Node.js');
  }
}

function detectPython(cwd, tags, labels, files) {
  const pyproject = path.join(cwd, 'pyproject.toml');
  const requirements = path.join(cwd, 'requirements.txt');
  const pyText = readText(pyproject);
  const reqText = readText(requirements);
  if (pyText === null && reqText === null) return;
  if (pyText !== null) files.push(pyproject);
  if (reqText !== null) files.push(requirements);
  tags.push('python');
  labels.push('Python');
  const hay = `${pyText ?? ''}\n${reqText ?? ''}`.toLowerCase();
  for (const [needle, tag, label] of PY_MAP) {
    const re = new RegExp(`(^|[\\s"'\\[,=])${needle}(?=[\\s"'\\]>=<~!;,\\[]|$)`, 'm');
    if (re.test(hay)) {
      tags.push(tag);
      labels.push(label);
    }
  }
  if (/\[tool\.poetry\]/.test(hay)) {
    tags.push('poetry');
    labels.push('poetry');
  } else if (/\[tool\.uv\]|uv\.lock/.test(hay) || fs.existsSync(path.join(cwd, 'uv.lock'))) {
    tags.push('uv');
    labels.push('uv');
  }
}

function detectOthers(cwd, tags, labels, files) {
  const goMod = path.join(cwd, 'go.mod');
  const goText = readText(goMod);
  if (goText !== null) {
    files.push(goMod);
    const v = /^go\s+(\d+\.\d+)/m.exec(goText);
    tags.push('go');
    labels.push(v ? `Go ${v[1]}` : 'Go');
  }
  const cargo = path.join(cwd, 'Cargo.toml');
  const cargoText = readText(cargo);
  if (cargoText !== null) {
    files.push(cargo);
    tags.push('rust');
    labels.push('Rust');
    if (/^\s*(axum|actix-web|tokio)\s*=/m.test(cargoText)) {
      const m = /^\s*(axum|actix-web|tokio)\s*=/m.exec(cargoText);
      tags.push(m[1]);
      labels.push(m[1]);
    }
  }
  const gemfile = path.join(cwd, 'Gemfile');
  const gemText = readText(gemfile);
  if (gemText !== null) {
    files.push(gemfile);
    tags.push('ruby');
    labels.push('Ruby');
    if (/^\s*gem\s+['"]rails['"]/m.test(gemText)) {
      tags.push('rails');
      labels.push('Rails');
    }
  }
  const pom = path.join(cwd, 'pom.xml');
  if (fs.existsSync(pom)) {
    files.push(pom);
    tags.push('java', 'maven');
    labels.push('Java (Maven)');
    const t = readText(pom) ?? '';
    if (/spring-boot/.test(t)) {
      tags.push('spring');
      labels.push('Spring Boot');
    }
  } else {
    for (const g of ['build.gradle', 'build.gradle.kts']) {
      const f = path.join(cwd, g);
      if (fs.existsSync(f)) {
        files.push(f);
        tags.push('java', 'gradle');
        labels.push('Java (Gradle)');
        break;
      }
    }
  }
  if (fs.existsSync(path.join(cwd, 'Dockerfile'))) {
    tags.push('docker');
    labels.push('Docker');
  }
}

/** Current branch from .git/HEAD (walks up from cwd; supports worktree `gitdir:` files). */
export function gitBranch(cwd, files = []) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 16; i++) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      st = null;
    }
    if (st) {
      let headFile = path.join(dotGit, 'HEAD');
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? '');
        if (!m) return '';
        headFile = path.join(path.resolve(dir, m[1].trim()), 'HEAD');
      }
      const head = readText(headFile);
      if (head === null) return '';
      files.push(headFile);
      const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
      if (ref) return ref[1].trim();
      const sha = /^([0-9a-f]{40})/.exec(head.trim());
      return sha ? `detached ${sha[1].slice(0, 7)}` : '';
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

function uniq(list) {
  return [...new Set(list.map((t) => String(t).toLowerCase()))];
}

function buildSummary(labels, branch) {
  let base = labels.join(', ');
  if (!base) return branch ? `branch ${branch}`.slice(0, SUMMARY_MAX) : '';
  const suffix = branch ? `; branch ${branch}` : '';
  const room = SUMMARY_MAX - suffix.length;
  if (base.length > room) {
    let cut = base.slice(0, Math.max(0, room - 1));
    const comma = cut.lastIndexOf(', ');
    if (comma > 0) cut = cut.slice(0, comma);
    base = `${cut}…`;
  }
  return `${base}${suffix}`.slice(0, SUMMARY_MAX);
}

function scanOnce(cwd) {
  const tags = [];
  const labels = [];
  const files = [];
  try {
    detectNode(cwd, tags, labels, files);
  } catch {
    /* skip */
  }
  try {
    detectPython(cwd, tags, labels, files);
  } catch {
    /* skip */
  }
  try {
    detectOthers(cwd, tags, labels, files);
  } catch {
    /* skip */
  }
  let branch = '';
  try {
    branch = gitBranch(cwd, files);
  } catch {
    branch = '';
  }
  const t = uniq(tags);
  const summary = labels.length || branch ? buildSummary(labels, branch) : '';
  return { result: { summary, tags: t }, files };
}

/**
 * Detect the stack of `cwd`. Never throws.
 * @param {string} cwd
 * @param {{ttlMs?: number}} [opts]
 * @returns {Promise<{summary: string, tags: string[]}>}
 */
export async function detectStack(cwd, opts = {}) {
  const ttlMs = opts.ttlMs ?? STACK_TTL_MS;
  let dir;
  try {
    dir = path.resolve(String(cwd ?? process.cwd()));
  } catch {
    return { summary: '', tags: [] };
  }
  const now = Date.now();
  const hit = cache.get(dir);
  if (hit && ttlMs > 0 && now - hit.ts < ttlMs) {
    const sig = hit.files.map(mtime).join(',');
    if (sig === hit.sig) return { summary: hit.result.summary, tags: [...hit.result.tags] };
  }
  try {
    const { result, files } = scanOnce(dir);
    cache.set(dir, { ts: now, files, sig: files.map(mtime).join(','), result });
    return { summary: result.summary, tags: [...result.tags] };
  } catch {
    return { summary: '', tags: [] };
  }
}
