#!/usr/bin/env node
// bin/scout-status.js — print config, cache stats, loaded pins, persistent installs and recent log lines.
//
//   node bin/scout-status.js [--json] [--cwd <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cacheGet, cacheStats } from '../lib/cache.js';
import { configPath, defaultHomeDir, hardenEnv, homeDir, loadConfig, SEAM_VARS } from '../lib/config.js';
import { TAG } from '../lib/context.js';
import { logPath } from '../lib/log.js';
import { COOLDOWN_KEY } from '../lib/registry.js';
import { buildIndex } from '../lib/skill-index.js';
import { detectStack } from '../lib/stack.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function tailLines(file, n) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

export async function collectStatus({ env: rawEnv = process.env, cwd } = {}) {
  const dir = path.resolve(cwd || process.cwd());
  const hardened = hardenEnv(rawEnv, { cwd: dir });
  const env = hardened.env;
  const config = loadConfig(env);
  const home = homeDir(env);
  let cooldownUntil = null;
  try {
    const v = cacheGet(COOLDOWN_KEY, 1, env);
    if (v && Number(v.until) > Date.now()) cooldownUntil = Number(v.until);
  } catch {
    cooldownUntil = null;
  }
  const indexOpts = { cwd: dir, home: env.HOME };
  if (env.CLAUDE_CONFIG_DIR) indexOpts.configDir = env.CLAUDE_CONFIG_DIR;
  const [index, stack] = await Promise.all([buildIndex(indexOpts).catch(() => []), detectStack(dir).catch(() => ({ summary: '', tags: [] }))]);
  const byScope = {};
  for (const s of index) byScope[s.scope] = (byScope[s.scope] ?? 0) + 1;
  const pkg = readJson(path.join(PLUGIN_ROOT, 'package.json')) ?? {};
  return {
    version: pkg.version ?? null,
    pluginRoot: PLUGIN_ROOT,
    home,
    configPath: configPath(env),
    defaultConfigPath: path.join(defaultHomeDir(env), 'config.json'),
    config: { ...config },
    fileMode: config.fileMode ?? config.mode,
    configWarnings: [...hardened.warnings, ...(config.warnings ?? [])],
    envOverrides: {
      SKILL_SCOUT_HOME: rawEnv.SKILL_SCOUT_HOME ?? null,
      SKILL_SCOUT_MODE: rawEnv.SKILL_SCOUT_MODE ?? null,
      CLAUDE_CONFIG_DIR: rawEnv.CLAUDE_CONFIG_DIR ?? null,
      ...Object.fromEntries(SEAM_VARS.map((k) => [k, rawEnv[k] ?? null])),
    },
    testSeams: hardened.seams?.active ?? [],
    cache: cacheStats(env),
    cooldownUntil,
    loaded: readJson(path.join(home, 'loaded.json')) ?? {},
    installed: readJson(path.join(home, 'installed.json')) ?? {},
    index: { total: index.length, byScope },
    stack,
    cwd: dir,
    log: { path: logPath(env), tail: tailLines(logPath(env), 5) },
    autoWarned: fs.existsSync(path.join(home, '.auto-mode-warned')),
  };
}

export function formatStatus(s) {
  const lines = [];
  lines.push(`${TAG} skill-scout ${s.version ?? '?'}  plugin root: ${s.pluginRoot}`);
  lines.push(`state dir: ${s.home}`);
  lines.push(`config:    ${s.configPath}`);
  for (const [k, v] of Object.entries(s.config)) lines.push(`  ${k}: ${JSON.stringify(v)}`);
  for (const w of s.configWarnings) lines.push(`  ! ${w}`);
  const ov = Object.entries(s.envOverrides).filter(([, v]) => v);
  if (ov.length) lines.push(`env overrides: ${ov.map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (Array.isArray(s.testSeams) && s.testSeams.length) lines.push(`  TEST SEAMS ACTIVE (not for real use, see docs/testing.md): ${s.testSeams.join(', ')}`);
  if (s.fileMode && s.fileMode !== s.config.mode) lines.push(`  effective mode "${s.config.mode}" (file says "${s.fileMode}"; the environment can only lower the mode, and "auto" counts only in ${s.defaultConfigPath})`);
  if (s.config.mode === 'auto') lines.push('  WARNING: mode "auto" injects allowlisted third-party skill text without confirmation (see README "What auto actually costs"). /scout-mode suggest reverts it.');
  if (Array.isArray(s.config.pinnedSkills) && s.config.pinnedSkills.length) lines.push(`  pinnedSkills (injected once per session): ${s.config.pinnedSkills.join(', ')}`);
  lines.push(`installed skills indexed: ${s.index.total} (${Object.entries(s.index.byScope).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);
  lines.push(`stack (${s.cwd}): ${s.stack.summary || '(unknown)'}`);
  const c = s.cache;
  const age = (ts) => (ts ? `${Math.round((Date.now() - ts) / 60000)} min ago` : '-');
  lines.push(`cache: ${c.entries} entries, ${(c.bytes / 1024).toFixed(1)} KB, newest ${age(c.newestTs)}, oldest ${age(c.oldestTs)} (${c.dir})`);
  if (s.cooldownUntil) {
    const d = new Date(s.cooldownUntil);
    lines.push(`skills.sh: rate-limited (HTTP 429) — no requests until ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}; cached catalogs still rank`);
  }
  const loaded = Object.entries(s.loaded);
  lines.push(`loaded pins (/scout-load, ephemeral): ${loaded.length}`);
  for (const [key, v] of loaded) lines.push(`  ${key} -> ${v.sha ?? '?'}  loads ${v.loads ?? '?'}  last ${v.lastTs ? new Date(v.lastTs).toISOString() : '?'}${Array.isArray(v.stripped) && v.stripped.length ? `  stripped: ${v.stripped.length}` : ''}`);
  const installed = Object.entries(s.installed);
  lines.push(`persistent installs (/scout-add): ${installed.length}`);
  for (const [key, v] of installed) lines.push(`  ${key} -> ${v.sha ?? '?'}  ${v.path ?? ''}  audit ${v.audit ?? '?'}`);
  lines.push(`log: ${s.log.path}`);
  for (const l of s.log.tail) lines.push(`  ${l.slice(0, 200)}`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const i = argv.indexOf('--cwd');
  const cwd = i >= 0 ? argv[i + 1] : null;
  const s = await collectStatus({ env: process.env, cwd });
  process.stdout.write(json ? `${JSON.stringify(s, null, 2)}\n` : `${formatStatus(s)}\n`);
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
