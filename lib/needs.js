// lib/needs.js — read-only project inspection for `/singular init`: what does this project need a skill for?
//
//   inspectProject(cwd, {maxFiles, maxDepth}) -> {
//     name, cwd, stack: {summary, tags}, languages: [{name, files}] (top 5), manifests: [rel], tooling: [{file, need}],
//     readme: {present, claudeMd, words}, needs: [{need, reason: 'dep'|'file'|'readme', evidence: [..], weight}] (<= 12),
//     filesScanned, truncated, maxDepth, elapsedMs, signals: number }
//   NEED_LEXICON   { npm, pypi, go, cargo, gem, maven }: dependency name -> need id (exact names and `prefix*` rules)
//   NEED_QUERIES   need id -> the words used to match installed skills (lib/score.js) and to search skills.sh
//   TOOLING_RULES  file / directory names -> need id (Dockerfile -> docker, .github/workflows -> github-actions, ...)
//   LANGUAGES      file extension -> language name; LANGUAGE_NEEDS language -> need id
//   README_WORDS   README.md / CLAUDE.md words (first 40 lines) -> need id
//
// Deterministic and read-only: directory entries are sorted, symlinks are never followed, nothing is executed,
// only known manifests plus README.md / CLAUDE.md (first 40 lines) are read, nothing larger than 512 KB, at most
// MAX_FILES entries are visited and the walk stops at MAX_DEPTH (root = 0). Never throws: an unreadable or empty
// directory yields `needs: []`, which the report prints as "no signals". Manifest contents are DATA; a malformed
// package.json, pyproject.toml, go.mod ... is skipped, never a crash.

import fs from 'node:fs';
import path from 'node:path';

import { detectStack } from './stack.js';

export const MAX_FILES = 5000;
export const MAX_DEPTH = 3;
export const README_LINES = 40;
export const MAX_NEEDS = 12;
export const MAX_MANIFESTS = 40;
const MAX_TEXT = 512 * 1024;

export const SKIP_DIRS = Object.freeze(new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'venv', '.venv', '__pycache__', '.turbo', '.cache', 'coverage',
  'target', 'vendor', '.svelte-kit', '.nuxt', '.output', '.idea', '.vscode', '.pytest_cache', '.mypy_cache', '.tox',
  'site-packages', '.gradle', 'Pods', 'DerivedData', '.dart_tool', '.terraform', '.parcel-cache', '.yarn', '.pnpm-store',
]));

// Signal weights per source and the per-need multiplier (frameworks first, bare languages last).
export const SOURCE_WEIGHT = Object.freeze({ dep: 3, file: 2, readme: 1 });
const FRAMEWORK_NEEDS = new Set('next react vue svelte astro remix angular django fastapi flask rails express hono electron react-native expo flutter'.split(' '));
const LANGUAGE_NEED_IDS = new Set('typescript python go rust swift kotlin'.split(' '));
const REASON_RANK = { dep: 3, file: 2, readme: 1 };

/** need id -> words for lib/score.js (installed skills) and for the skills.sh search (`q=`). */
export const NEED_QUERIES = Object.freeze({
  next: 'nextjs',
  react: 'react',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  remix: 'remix',
  angular: 'angular',
  tailwind: 'tailwind',
  shadcn: 'shadcn',
  prisma: 'prisma',
  drizzle: 'drizzle',
  supabase: 'supabase',
  postgres: 'postgres',
  mongodb: 'mongodb',
  redis: 'redis',
  stripe: 'stripe',
  auth: 'auth',
  trpc: 'trpc',
  graphql: 'graphql',
  express: 'express',
  hono: 'hono',
  fastapi: 'fastapi',
  django: 'django',
  flask: 'flask',
  rails: 'rails',
  playwright: 'playwright',
  cypress: 'cypress',
  vitest: 'vitest',
  jest: 'jest',
  pytest: 'pytest',
  docker: 'docker',
  kubernetes: 'kubernetes',
  terraform: 'terraform',
  'github-actions': 'github actions',
  vercel: 'vercel',
  aws: 'aws',
  gcp: 'gcp',
  firebase: 'firebase',
  openai: 'openai',
  anthropic: 'anthropic',
  'ai-sdk': 'ai sdk',
  langchain: 'langchain',
  mcp: 'mcp',
  electron: 'electron',
  'react-native': 'react native',
  expo: 'expo',
  flutter: 'flutter',
  swift: 'swift',
  kotlin: 'kotlin',
  rust: 'rust',
  go: 'golang',
  python: 'python',
  typescript: 'typescript',
  monorepo: 'monorepo',
});

const NPM = {
  next: 'next', react: 'react', 'react-dom': 'react', vue: 'vue', nuxt: 'vue', svelte: 'svelte', '@sveltejs/kit': 'svelte',
  astro: 'astro', '@remix-run/*': 'remix', '@angular/*': 'angular',
  tailwindcss: 'tailwind', '@tailwindcss/*': 'tailwind', shadcn: 'shadcn', 'shadcn-ui': 'shadcn', '@shadcn/*': 'shadcn',
  prisma: 'prisma', '@prisma/*': 'prisma', 'drizzle-orm': 'drizzle', 'drizzle-kit': 'drizzle',
  supabase: 'supabase', '@supabase/*': 'supabase',
  pg: 'postgres', postgres: 'postgres', 'pg-promise': 'postgres', '@neondatabase/serverless': 'postgres', '@vercel/postgres': 'postgres', 'postgres-js': 'postgres',
  mongodb: 'mongodb', mongoose: 'mongodb', redis: 'redis', ioredis: 'redis', '@upstash/redis': 'redis',
  stripe: 'stripe', '@stripe/*': 'stripe',
  'next-auth': 'auth', '@auth/*': 'auth', '@clerk/*': 'auth', 'better-auth': 'auth', passport: 'auth', '@auth0/*': 'auth', lucia: 'auth', '@kinde-oss/*': 'auth', 'firebase-auth': 'auth',
  '@trpc/*': 'trpc', graphql: 'graphql', '@apollo/*': 'graphql', 'graphql-yoga': 'graphql',
  express: 'express', hono: 'hono',
  playwright: 'playwright', '@playwright/*': 'playwright', cypress: 'cypress', vitest: 'vitest', jest: 'jest', '@jest/*': 'jest',
  electron: 'electron', 'react-native': 'react-native', '@react-native/*': 'react-native', expo: 'expo', 'expo-*': 'expo',
  openai: 'openai', '@anthropic-ai/*': 'anthropic', ai: 'ai-sdk', '@ai-sdk/*': 'ai-sdk',
  langchain: 'langchain', '@langchain/*': 'langchain', '@modelcontextprotocol/*': 'mcp',
  typescript: 'typescript', firebase: 'firebase', 'firebase-admin': 'firebase', '@google-cloud/*': 'gcp',
  'aws-sdk': 'aws', '@aws-sdk/*': 'aws', 'aws-cdk-lib': 'aws', '@aws-cdk/*': 'aws',
  vercel: 'vercel', '@vercel/*': 'vercel', turbo: 'monorepo', nx: 'monorepo', '@nx/*': 'monorepo', lerna: 'monorepo',
};
const PYPI = {
  fastapi: 'fastapi', django: 'django', 'django-*': 'django', flask: 'flask', 'flask-*': 'flask', pytest: 'pytest', 'pytest-*': 'pytest',
  playwright: 'playwright', psycopg2: 'postgres', 'psycopg2-binary': 'postgres', psycopg: 'postgres', asyncpg: 'postgres',
  pymongo: 'mongodb', motor: 'mongodb', redis: 'redis', stripe: 'stripe', openai: 'openai', anthropic: 'anthropic',
  langchain: 'langchain', 'langchain-*': 'langchain', mcp: 'mcp', fastmcp: 'mcp', boto3: 'aws', 'aws-*': 'aws', 'google-cloud-*': 'gcp',
  'firebase-admin': 'firebase', supabase: 'supabase', authlib: 'auth', 'python-jose': 'auth', pyjwt: 'auth', 'django-allauth': 'auth',
  graphene: 'graphql', 'strawberry-graphql': 'graphql', ariadne: 'graphql', 'kubernetes': 'kubernetes',
};
const GO = {
  'github.com/jackc/pgx*': 'postgres', 'github.com/lib/pq': 'postgres', 'go.mongodb.org/*': 'mongodb',
  'github.com/redis/go-redis*': 'redis', 'github.com/go-redis/*': 'redis', 'github.com/stripe/*': 'stripe',
  'github.com/aws/*': 'aws', 'cloud.google.com/*': 'gcp', 'firebase.google.com/*': 'firebase',
  'github.com/graphql-go/*': 'graphql', 'github.com/99designs/gqlgen': 'graphql', 'github.com/mark3labs/mcp-go': 'mcp',
  'github.com/sashabaranov/go-openai': 'openai', 'github.com/anthropics/*': 'anthropic', 'k8s.io/*': 'kubernetes',
  'github.com/hashicorp/terraform*': 'terraform', 'github.com/playwright-community/*': 'playwright',
};
const CARGO = {
  'tokio-postgres': 'postgres', 'sqlx-postgres': 'postgres', 'diesel': 'postgres', redis: 'redis', mongodb: 'mongodb',
  'aws-config': 'aws', 'aws-sdk-*': 'aws', 'async-openai': 'openai', rmcp: 'mcp', 'stripe-rust': 'stripe', 'async-stripe': 'stripe',
  kube: 'kubernetes', 'kube-*': 'kubernetes', 'firebase-*': 'firebase',
};
const GEM = {
  rails: 'rails', pg: 'postgres', redis: 'redis', mongoid: 'mongodb', stripe: 'stripe', devise: 'auth', omniauth: 'auth', 'omniauth-*': 'auth',
  graphql: 'graphql', 'aws-sdk*': 'aws', 'google-cloud*': 'gcp', 'ruby-openai': 'openai', anthropic: 'anthropic', langchainrb: 'langchain',
};
const MAVEN = {
  postgresql: 'postgres', 'kotlin-*': 'kotlin', 'mongodb-driver*': 'mongodb', jedis: 'redis', 'lettuce-core': 'redis', 'stripe-java': 'stripe',
  'aws-java-sdk*': 'aws', 'software.amazon.awssdk': 'aws', 'google-cloud-*': 'gcp', 'firebase-admin': 'firebase', 'graphql-java': 'graphql',
  langchain4j: 'langchain', 'langchain4j-*': 'langchain', 'spring-security*': 'auth', 'org.jetbrains.kotlin': 'kotlin', 'kubernetes-client': 'kubernetes',
};
export const NEED_LEXICON = Object.freeze({ npm: Object.freeze(NPM), pypi: Object.freeze(PYPI), go: Object.freeze(GO), cargo: Object.freeze(CARGO), gem: Object.freeze(GEM), maven: Object.freeze(MAVEN) });

/** Look a dependency name up in one ecosystem table: exact match first, then `prefix*` rules. */
export function needOfDependency(ecosystem, name) {
  const table = NEED_LEXICON[ecosystem];
  if (!table) return null;
  const n = String(name ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!n) return null;
  if (table[n]) return table[n];
  for (const [key, need] of Object.entries(table)) {
    if (key.endsWith('*') && n.startsWith(key.slice(0, -1))) return need;
  }
  return null;
}

/** File / directory names -> need id. `dir: true` rules match directories; `re` rules match a basename. */
export const TOOLING_RULES = Object.freeze([
  { re: /^Dockerfile(\..+)?$/, need: 'docker' },
  { re: /\.dockerfile$/i, need: 'docker' },
  { re: /^(docker-)?compose(\..+)?\.ya?ml$/, need: 'docker' },
  { dir: true, rel: '.github/workflows', need: 'github-actions' },
  { re: /^vercel\.json$/, need: 'vercel' },
  { dir: true, name: 'terraform', need: 'terraform' },
  { re: /\.tf$/, need: 'terraform' },
  { dir: true, name: 'supabase', need: 'supabase' },
  { dir: true, name: 'prisma', need: 'prisma' },
  { re: /^schema\.prisma$/, need: 'prisma' },
  { re: /^(turbo\.json|pnpm-workspace\.yaml|nx\.json|lerna\.json)$/, need: 'monorepo' },
  { dir: true, name: 'k8s', need: 'kubernetes' },
  { dir: true, name: 'kubernetes', need: 'kubernetes' },
  { dir: true, name: 'helm', need: 'kubernetes' },
  { re: /^(Chart\.yaml|skaffold\.ya?ml|kustomization\.ya?ml)$/, need: 'kubernetes' },
  { re: /^(firebase\.json|\.firebaserc)$/, need: 'firebase' },
  { re: /^components\.json$/, need: 'shadcn' },
  { re: /^Package\.swift$/, need: 'swift' },
  { dir: true, re: /\.(xcodeproj|xcworkspace)$/, need: 'swift' },
  { re: /^pubspec\.yaml$/, need: 'flutter' },
  { re: /^eas\.json$/, need: 'expo' },
  { re: /^(serverless\.ya?ml|cdk\.json|samconfig\.toml)$/, need: 'aws' },
  { re: /^\.mcp\.json$/, need: 'mcp' },
  { re: /^(pytest\.ini|conftest\.py)$/, need: 'pytest' },
  { re: /^playwright\.config\.[cm]?[jt]s$/, need: 'playwright' },
  { re: /^cypress\.config\.[cm]?[jt]s$/, need: 'cypress' },
  { re: /^vitest\.config\.[cm]?[jt]s$/, need: 'vitest' },
  { re: /^jest\.config\.([cm]?[jt]s|json)$/, need: 'jest' },
  { re: /^tailwind\.config\.[cm]?[jt]s$/, need: 'tailwind' },
  { re: /^next\.config\.([cm]?[jt]s)$/, need: 'next' },
  { re: /^drizzle\.config\.[cm]?[jt]s$/, need: 'drizzle' },
  { re: /^astro\.config\.[cm]?[jt]s$/, need: 'astro' },
  { re: /^svelte\.config\.[cm]?[jt]s$/, need: 'svelte' },
  { re: /^nuxt\.config\.[cm]?[jt]s$/, need: 'vue' },
  { re: /^angular\.json$/, need: 'angular' },
  { re: /^tsconfig(\..+)?\.json$/, need: 'typescript' },
  { re: /^go\.mod$/, need: 'go' },
  { re: /^Cargo\.toml$/, need: 'rust' },
  { re: /^(pyproject\.toml|requirements(-.+)?\.txt|setup\.py|Pipfile)$/, need: 'python' },
  { re: /^build\.gradle\.kts$/, need: 'kotlin' },
  { re: /^electron-builder\.(ya?ml|json)$/, need: 'electron' },
]);

export const LANGUAGES = Object.freeze({
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', swift: 'Swift', dart: 'Dart',
  php: 'PHP', cs: 'C#', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', c: 'C', h: 'C', scala: 'Scala', ex: 'Elixir', exs: 'Elixir',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro', sql: 'SQL', css: 'CSS', scss: 'CSS', html: 'HTML', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  tf: 'HCL', lua: 'Lua', zig: 'Zig', hs: 'Haskell', clj: 'Clojure', r: 'R', jl: 'Julia', proto: 'Protobuf', graphql: 'GraphQL', gql: 'GraphQL',
});
export const LANGUAGE_NEEDS = Object.freeze({ TypeScript: 'typescript', Python: 'python', Go: 'go', Rust: 'rust', Swift: 'swift', Kotlin: 'kotlin', Dart: 'flutter', GraphQL: 'graphql', HCL: 'terraform' });

/** README.md / CLAUDE.md words (lowercase; bigrams joined with a space) -> need id. Ambiguous English words are left out. */
export const README_WORDS = Object.freeze({
  nextjs: 'next', 'next js': 'next', react: 'react', vue: 'vue', vuejs: 'vue', nuxt: 'vue', svelte: 'svelte', sveltekit: 'svelte', astro: 'astro', remix: 'remix', angular: 'angular',
  tailwind: 'tailwind', tailwindcss: 'tailwind', shadcn: 'shadcn', prisma: 'prisma', drizzle: 'drizzle', supabase: 'supabase',
  postgres: 'postgres', postgresql: 'postgres', mongodb: 'mongodb', mongo: 'mongodb', redis: 'redis', stripe: 'stripe',
  authentication: 'auth', oauth: 'auth', clerk: 'auth', nextauth: 'auth', trpc: 'trpc', graphql: 'graphql',
  expressjs: 'express', 'express js': 'express', hono: 'hono', fastapi: 'fastapi', django: 'django', flask: 'flask', rails: 'rails',
  playwright: 'playwright', cypress: 'cypress', vitest: 'vitest', jest: 'jest', pytest: 'pytest',
  docker: 'docker', dockerfile: 'docker', kubernetes: 'kubernetes', k8s: 'kubernetes', helm: 'kubernetes', terraform: 'terraform',
  'github actions': 'github-actions', vercel: 'vercel', aws: 'aws', gcp: 'gcp', 'google cloud': 'gcp', firebase: 'firebase',
  openai: 'openai', anthropic: 'anthropic', claude: 'anthropic', 'ai sdk': 'ai-sdk', langchain: 'langchain', mcp: 'mcp',
  electron: 'electron', 'react native': 'react-native', expo: 'expo', flutter: 'flutter', swift: 'swift', swiftui: 'swift',
  kotlin: 'kotlin', rust: 'rust', golang: 'go', python: 'python', typescript: 'typescript', monorepo: 'monorepo', turborepo: 'monorepo',
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readText(file, max = MAX_TEXT) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  try {
    const v = JSON.parse(text.replace(/^﻿/, ''));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** Max characters of one manifest line/value scanned for quoted names (a 512 KB single-line file stays cheap). */
export const MAX_QUOTED_BLOCK = 8 * 1024;
/**
 * Quoted names in a manifest fragment. The name class and the "rest" class are disjoint
 * ([^"'A-Za-z0-9._-] must follow the name), so there is exactly one way to split a match and the
 * regex is linear in the input: an unterminated quote cannot trigger polynomial backtracking.
 */
export const quotedNames = (block) => {
  const out = [];
  const text = String(block ?? '').slice(0, MAX_QUOTED_BLOCK);
  const re = /["']([A-Za-z0-9][A-Za-z0-9._-]*)(?:[^"'A-Za-z0-9._-][^"']*)?["']/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
};

/** Dependency names of a manifest (never throws): [{ecosystem, name}] in file order. */
export function manifestDependencies(basename, text) {
  const out = [];
  const push = (ecosystem, name) => {
    const n = String(name ?? '').trim();
    if (n) out.push({ ecosystem, name: n });
  };
  try {
    if (basename === 'package.json') {
      const pkg = parseJsonLoose(text);
      if (!pkg) return { deps: out, workspaces: false, ok: false };
      for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const v = pkg[key];
        if (v && typeof v === 'object' && !Array.isArray(v)) for (const name of Object.keys(v)) push('npm', name);
      }
      return { deps: out, workspaces: Boolean(Array.isArray(pkg.workspaces) || (pkg.workspaces && typeof pkg.workspaces === 'object')), ok: true };
    }
    if (basename === 'pyproject.toml') {
      let section = '';
      let array = null; // collecting a `key = [` array
      for (const raw of String(text).split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        if (array !== null) {
          for (const n of quotedNames(line)) push('pypi', n);
          if (line.includes(']')) array = null;
          continue;
        }
        const h = /^\[([^\]]+)\]$/.exec(line);
        if (h) {
          section = h[1].trim();
          continue;
        }
        const kv = /^([A-Za-z0-9_."-]+)\s*=\s*(.*)$/.exec(line);
        if (!kv) continue;
        const key = kv[1].replace(/^"|"$/g, '');
        const value = kv[2];
        const arrayKey = (section === 'project' && key === 'dependencies') || section === 'project.optional-dependencies' || section === 'dependency-groups' || (section === 'build-system' && key === 'requires' && false);
        if (arrayKey && value.startsWith('[')) {
          for (const n of quotedNames(value)) push('pypi', n);
          if (!value.includes(']')) array = key;
          continue;
        }
        if (/^tool\.poetry\.(dev-)?dependencies$/.test(section) || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section) || section === 'tool.uv.dev-dependencies') {
          if (key !== 'python') push('pypi', key);
        }
      }
      return { deps: out, ok: true };
    }
    if (/^requirements(-.+)?\.txt$/.test(basename) || basename === 'Pipfile') {
      let inPackages = basename !== 'Pipfile';
      for (const raw of String(text).split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        if (basename === 'Pipfile') {
          const h = /^\[([^\]]+)\]$/.exec(line);
          if (h) {
            inPackages = /^(dev-)?packages$/.test(h[1].trim());
            continue;
          }
          if (!inPackages) continue;
          const kv = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
          if (kv) push('pypi', kv[1]);
          continue;
        }
        if (line.startsWith('-')) continue; // -r other.txt, -e ., --index-url
        const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
        if (m) push('pypi', m[1]);
      }
      return { deps: out, ok: true };
    }
    if (basename === 'go.mod') {
      const re = /^\s*(?:require\s+)?([A-Za-z0-9][A-Za-z0-9._\-/]*\.[A-Za-z0-9._\-/]+)\s+v[0-9][^\s]*/gm;
      let m;
      while ((m = re.exec(String(text)))) push('go', m[1]);
      return { deps: out, ok: true };
    }
    if (basename === 'Cargo.toml') {
      let inDeps = false;
      for (const raw of String(text).split('\n')) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const h = /^\[([^\]]+)\]$/.exec(line);
        if (h) {
          inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(h[1].trim());
          continue;
        }
        if (!inDeps) continue;
        const kv = /^([A-Za-z0-9][A-Za-z0-9_-]*)\s*=/.exec(line);
        if (kv) push('cargo', kv[1]);
      }
      return { deps: out, ok: true };
    }
    if (basename === 'Gemfile') {
      const re = /^\s*gem\s+['"]([A-Za-z0-9][A-Za-z0-9._-]*)['"]/gm;
      let m;
      while ((m = re.exec(String(text)))) push('gem', m[1]);
      return { deps: out, ok: true };
    }
    if (basename === 'pom.xml') {
      const re = /<(artifactId|groupId)>\s*([^<\s]+)\s*<\/\1>/g;
      let m;
      while ((m = re.exec(String(text)))) push('maven', m[2]);
      return { deps: out, ok: true };
    }
  } catch {
    /* malformed manifest: no deps */
  }
  return { deps: out, ok: false };
}

export const MANIFEST_RE = /^(package\.json|pyproject\.toml|requirements(-.+)?\.txt|Pipfile|go\.mod|Cargo\.toml|Gemfile|pom\.xml)$/;

/** Tooling rule for a directory entry; `rel` is the posix-style path relative to the root. */
function toolingNeed(ent, rel) {
  const base = path.posix.basename(rel);
  for (const rule of TOOLING_RULES) {
    if (rule.dir) {
      if (!ent.isDirectory()) continue;
      if (rule.rel && rel === rule.rel) return rule.need;
      if (rule.name && base === rule.name) return rule.need;
      if (rule.re && rule.re.test(base)) return rule.need;
    } else if (ent.isFile() && rule.re.test(base)) return rule.need;
  }
  return null;
}

/** Words + bigrams of the first README_LINES lines, lowercased, "next.js" -> "nextjs". */
export function readmeNeeds(text) {
  const head = String(text ?? '').split('\n').slice(0, README_LINES).join('\n').toLowerCase()
    .replace(/\b(next|vue|express|node|nest|svelte)[ .\-_]js\b/g, '$1js')
    .replace(/[^a-z0-9+#.\s-]+/g, ' ');
  const words = head.split(/[\s.,;:!?()[\]{}"'`/\\|<>=+#*_-]+/).filter(Boolean);
  const hits = new Map(); // need -> word
  const add = (w, need) => {
    if (!hits.has(need)) hits.set(need, w);
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (README_WORDS[w]) add(w, README_WORDS[w]);
    if (i + 1 < words.length) {
      const bg = `${w} ${words[i + 1]}`;
      if (README_WORDS[bg]) add(bg, README_WORDS[bg]);
    }
  }
  return [...hits.entries()].map(([need, word]) => ({ need, word }));
}

// ---------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------

/** Up to `limit` Dirents of `dir` via fs.opendirSync (null when unreadable). Never throws. */
export function readDirBounded(dir, limit) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  let handle;
  try {
    handle = fs.opendirSync(dir, { bufferSize: Math.min(1024, Math.max(1, max)) });
  } catch {
    return null;
  }
  const out = [];
  try {
    let ent;
    while (out.length < max && (ent = handle.readSync()) !== null) out.push(ent);
  } catch {
    /* a partial listing is fine */
  } finally {
    try { handle.closeSync(); } catch { /* ignore */ }
  }
  return out;
}

function walk(root, { maxFiles, maxDepth }) {
  const out = { manifests: [], tooling: [], extCounts: new Map(), readme: null, claudeMd: null, filesScanned: 0, truncated: false };
  const queue = [{ dir: root, depth: 0, rel: '' }];
  while (queue.length) {
    const { dir, depth, rel } = queue.shift();
    // Streamed, bounded read: one directory with millions of entries cannot defeat maxFiles by being
    // loaded whole (readdirSync) before the cap is checked. We read at most room+1 entries so the cap
    // still trips below.
    const ents = readDirBounded(dir, maxFiles - out.filesScanned + 1);
    if (ents === null) continue;
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of ents) {
      if (++out.filesScanned > maxFiles) {
        out.truncated = true;
        out.filesScanned = maxFiles;
        return out;
      }
      if (ent.isSymbolicLink()) continue; // never followed, never counted as a language file
      const entRel = rel ? `${rel}/${ent.name}` : ent.name;
      const need = toolingNeed(ent, entRel);
      if (need) out.tooling.push({ file: entRel, need });
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name) && depth + 1 <= maxDepth) queue.push({ dir: path.join(dir, ent.name), depth: depth + 1, rel: entRel });
        continue;
      }
      if (!ent.isFile()) continue;
      if (MANIFEST_RE.test(ent.name) && out.manifests.length < MAX_MANIFESTS) out.manifests.push({ file: entRel, abs: path.join(dir, ent.name) });
      if (depth === 0 && ent.name === 'README.md') out.readme = path.join(dir, ent.name);
      if (depth === 0 && ent.name === 'CLAUDE.md') out.claudeMd = path.join(dir, ent.name);
      const dot = ent.name.lastIndexOf('.');
      if (dot > 0) {
        const ext = ent.name.slice(dot + 1).toLowerCase();
        const lang = LANGUAGES[ext];
        if (lang) out.extCounts.set(lang, (out.extCounts.get(lang) ?? 0) + 1);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// inspectProject
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {{maxFiles?: number, maxDepth?: number, stack?: {summary: string, tags: string[]}}} [opts]
 */
export async function inspectProject(cwd, opts = {}) {
  const t0 = performance.now();
  const maxFiles = Math.max(1, Math.floor(Number(opts.maxFiles) || MAX_FILES));
  const maxDepth = Math.max(0, Math.floor(Number(opts.maxDepth ?? MAX_DEPTH)));
  let dir;
  try {
    dir = path.resolve(String(cwd ?? process.cwd()));
  } catch {
    dir = process.cwd();
  }
  const result = {
    name: path.basename(dir) || dir,
    cwd: dir,
    stack: { summary: '', tags: [] },
    languages: [],
    manifests: [],
    tooling: [],
    readme: { present: false, claudeMd: false, words: [] },
    needs: [],
    filesScanned: 0,
    truncated: false,
    maxDepth,
    signals: 0,
    elapsedMs: 0,
  };
  try {
    result.stack = opts.stack ?? (await detectStack(dir).catch(() => ({ summary: '', tags: [] })));
  } catch {
    result.stack = { summary: '', tags: [] };
  }
  let scan;
  try {
    scan = walk(dir, { maxFiles, maxDepth });
  } catch {
    scan = null;
  }
  if (!scan) {
    result.elapsedMs = performance.now() - t0;
    return result;
  }
  result.filesScanned = scan.filesScanned;
  result.truncated = scan.truncated;
  result.manifests = scan.manifests.map((m) => m.file);
  result.tooling = scan.tooling;
  result.languages = [...scan.extCounts.entries()].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)).slice(0, 5);

  // needs: need id -> {weight per source, evidence}
  const needs = new Map();
  const order = [];
  const addNeed = (need, source, evidence) => {
    if (!need || !NEED_QUERIES[need]) return;
    let n = needs.get(need);
    if (!n) {
      n = { need, sources: new Set(), evidence: [] };
      needs.set(need, n);
      order.push(need);
    }
    n.sources.add(source);
    if (n.evidence.length < 6 && !n.evidence.includes(evidence)) n.evidence.push(evidence);
  };

  // 1. dependencies (manifest order; root manifests come first because the walk is breadth-first)
  for (const m of scan.manifests) {
    const text = readText(m.abs);
    if (text === null) continue;
    const parsed = manifestDependencies(path.basename(m.file), text);
    for (const d of parsed.deps) addNeed(needOfDependency(d.ecosystem, d.name), 'dep', `${d.name} (${m.file})`);
    if (parsed.workspaces) addNeed('monorepo', 'file', `${m.file} workspaces`);
  }
  // 2. tooling files
  for (const t of scan.tooling) addNeed(t.need, 'file', t.file);
  // 3. languages (by extension): the top language, or any with at least two files
  result.languages.forEach((l, i) => {
    const need = LANGUAGE_NEEDS[l.name];
    if (need && (i === 0 || l.files >= 2)) addNeed(need, 'file', `${l.files} ${l.name} file${l.files === 1 ? '' : 's'}`);
  });
  // 4. README.md + CLAUDE.md (first 40 lines)
  const readmeText = scan.readme ? readText(scan.readme) : null;
  const claudeText = scan.claudeMd ? readText(scan.claudeMd) : null;
  result.readme = { present: readmeText !== null, claudeMd: claudeText !== null, words: [] };
  for (const [label, text] of [['README.md', readmeText], ['CLAUDE.md', claudeText]]) {
    if (text === null) continue;
    for (const { need, word } of readmeNeeds(text)) {
      result.readme.words.push(`${word} (${label})`);
      addNeed(need, 'readme', `"${word}" in ${label}`);
    }
  }

  const ranked = order.map((id, idx) => {
    const n = needs.get(id);
    let weight = 0;
    for (const s of n.sources) weight += SOURCE_WEIGHT[s] ?? 0;
    if (FRAMEWORK_NEEDS.has(id)) weight *= 1.5;
    if (LANGUAGE_NEED_IDS.has(id)) weight *= 0.5;
    const reason = [...n.sources].sort((a, b) => REASON_RANK[b] - REASON_RANK[a])[0];
    return { need: id, reason, evidence: n.evidence, weight: Math.round(weight * 100) / 100, idx };
  });
  ranked.sort((a, b) => b.weight - a.weight || a.idx - b.idx);
  result.needs = ranked.slice(0, MAX_NEEDS).map(({ idx, ...n }) => n);
  result.signals = ranked.length;
  result.elapsedMs = Math.round((performance.now() - t0) * 10) / 10;
  return result;
}
