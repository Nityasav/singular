// test/e2e/lib/world.mjs — per-case isolation: a fresh SKILL_SCOUT_HOME (outside every cwd) with a config.json,
// a temp cwd (a copy of test/fixtures/projects/next-tailwind-ts with a .git/HEAD by default), readers for the
// isolated scout.log and cache, and a direct `node bin/<script>.js` runner for the no-model paths.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from './catalog.mjs';

export const DEFAULT_ALLOWLIST = Object.freeze(['anthropics', 'vercel-labs', 'microsoft', 'multica-ai']);
const NEXT_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'projects', 'next-tailwind-ts');

function realResolve(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...rest.reverse());
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function isInside(child, parent) {
  const c = realResolve(child);
  const p = realResolve(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export function realHome() {
  try {
    return os.userInfo().homedir || os.homedir();
  } catch {
    return os.homedir();
  }
}

/** The directory name Claude Code derives from a cwd for ~/.claude/projects/<name> (every / and . becomes -). */
export function projectDirName(cwd) {
  return String(cwd).replace(/[/.]/g, '-');
}

export function writeConfig(home, config = {}) {
  fs.mkdirSync(home, { recursive: true });
  const cfg = { mode: 'suggest', allowlist: [...DEFAULT_ALLOWLIST], ...config };
  fs.writeFileSync(path.join(home, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  return cfg;
}

/**
 * Project-scope skills the cases can seed into a temp cwd (<cwd>/.claude/skills/<name>/SKILL.md). lib/skill-index.js
 * indexes them like Claude Code does, so a routing assertion ("Installed skills likely relevant: ...") no longer depends
 * on whatever happens to be installed under the host's ~/.claude (HOME cannot be redirected for a logged-in run).
 * Names carry an `e2e-` prefix so they can never collide with a real skill, and their descriptions name the tech nouns
 * the shared prompts use (nextjs / tailwind / landing page / pricing).
 */
export const PROJECT_SKILLS = Object.freeze({
  'e2e-nextjs-app-router': 'Next.js (nextjs) app router guidance for this project: server components versus client components, routing, data fetching, caching.',
  'e2e-tailwind-landing': 'Build a landing page with tailwind css for this project: pricing table, hero section, signup form, responsive layout in nextjs.',
});

export function writeProjectSkills(cwd, skills = PROJECT_SKILLS) {
  const names = [];
  for (const [name, description] of Object.entries(skills)) {
    const dir = path.join(cwd, '.claude', 'skills', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nFixture skill for the skill-scout e2e suite. It has no instructions.\n`);
    names.push(name);
  }
  return names;
}

/**
 * makeWorld(caseDir, label, {cwd, config, gitHead, projectSkills})
 *   cwd: 'next' (default) | 'empty' | 'plugin' (the plugin root itself; never written to) | an absolute path
 *   projectSkills: true seeds PROJECT_SKILLS into the temp cwd (never into the plugin root or a foreign absolute path)
 * Returns {label, base, home, cwd, env, ownsCwd, projectSkills: [names]}.
 */
export function makeWorld(caseDir, label, { cwd = 'next', config = {}, gitHead = true, projectSkills = false } = {}) {
  const base = path.join(caseDir, label);
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  writeConfig(home, config);
  let dir;
  let ownsCwd = true;
  if (cwd === 'next') {
    dir = path.join(base, 'cwd');
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(NEXT_FIXTURE, dir, { recursive: true });
    if (gitHead) {
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    }
  } else if (cwd === 'empty') {
    dir = path.join(base, 'cwd');
    fs.mkdirSync(dir, { recursive: true });
  } else if (cwd === 'plugin') {
    dir = ROOT;
    ownsCwd = false;
  } else if (path.isAbsolute(cwd)) {
    dir = cwd;
    ownsCwd = false;
  } else {
    throw new Error(`makeWorld: unknown cwd kind ${cwd}`);
  }
  if (isInside(home, dir)) throw new Error(`makeWorld: home ${home} is inside cwd ${dir}; the hook would fall back to the real ~/.claude/skill-scout`);
  let seeded = [];
  if (projectSkills) {
    if (!ownsCwd) throw new Error(`makeWorld: projectSkills can only be seeded into a temp cwd, not ${dir}`);
    seeded = writeProjectSkills(dir, projectSkills === true ? PROJECT_SKILLS : projectSkills);
  }
  return { label, base, home, cwd: dir, env: { SKILL_SCOUT_HOME: home }, ownsCwd, projectSkills: seeded };
}

export function readLog(home) {
  try {
    return fs
      .readFileSync(path.join(home, 'scout.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { msg: 'unparsable', raw: l };
        }
      });
  } catch {
    return [];
  }
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function cacheFile(home, key) {
  return path.join(home, 'cache', `${createHash('sha256').update(String(key)).digest('hex')}.json`);
}

/** The cached value for `key` (ignores TTL) or null. */
export function cacheEntry(home, key) {
  const raw = readJsonFile(cacheFile(home, key));
  return raw && typeof raw === 'object' ? raw.value : null;
}

/** Every cache value (keys are hashed, so callers match on the value's shape). */
export function cacheValues(home) {
  const dir = path.join(home, 'cache');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => readJsonFile(path.join(dir, n))).filter(Boolean).map((r) => r.value);
}

export function sha256File(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'absent';
  }
}

/** Poll until fn() is truthy or timeout; returns the last value. */
export async function waitFor(fn, { timeoutMs = 10000, intervalMs = 250 } = {}) {
  const until = Date.now() + timeoutMs;
  let v = fn();
  while (!v && Date.now() < until) {
    await new Promise((r) => setTimeout(r, intervalMs));
    v = fn();
  }
  return v;
}

/**
 * Run `node <ROOT>/bin/<script> args` (async, so a mock registry in this process can answer the child's requests).
 * env is merged over the caller's env minus every SKILL_SCOUT_* variable. Resolves {stdout, stderr, status, signal}.
 */
export function runNode(script, args = [], { env = {}, cwd = ROOT, input, timeoutMs = 120000 } = {}) {
  const file = path.isAbsolute(script) ? script : path.join(ROOT, 'bin', script);
  const baseEnv = { ...process.env };
  for (const k of Object.keys(baseEnv)) if (k.startsWith('SKILL_SCOUT_')) delete baseEnv[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env: { ...baseEnv, ...env }, stdio: [typeof input === 'string' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    if (typeof input === 'string') {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: String(e.message), status: null, signal: null, error: e });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), status, signal, error: null });
    });
  });
}

export function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
