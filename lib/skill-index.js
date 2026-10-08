// lib/skill-index.js — enumerate every skill Claude Code would load on this machine.
//
// Zero dependencies. Sync fs on purpose: ~150 skills index in single-digit ms and the
// per-prompt hook needs determinism more than concurrency.
//
// Where skills live (verified on Claude Code 2.1.282, see docs/spec.md + spike facts):
//   <cfg>/skills/<name>/SKILL.md                         user skill, bare name
//   <cfg>/skills/<sub>/<name>/SKILL.md                   nested user skill, invocable as <sub>:<name>
//   <cfg>/skills/synced/<bucket>/<name>/SKILL.md         claude.ai-synced skill -> anthropic-skills:<name>
//   <cfg>/skills/<dir>/.claude-plugin/plugin.json        skills-dir plugin (<dir>@skills-dir)
//   <cwd..repo root>/.claude/skills/<name>/SKILL.md      project skill, bare name
//   <cfg>/plugins/installed_plugins.json                 -> plugins[id][0].installPath (marketplace plugins)
//   <cfg>/plugins/synced/<bucket>/<name>[~g<N>]/         claude.ai-synced plugins (<name>@synced); the
//                                                        generation suffix is optional (manifest.json lists
//                                                        `data` and `cowork-plugin-management` without one,
//                                                        2.1.293) and the highest generation wins
//   <installPath>/skills/<name>/SKILL.md                 plugin skill -> <plugin>:<dir basename>
//   <installPath>/commands/<name>.md                     plugin command, also exposed as <plugin>:<name>
//   plugin.json "skills" entries (string|array)          extra skill dirs or containers of skill dirs
// where <cfg> = <home>/.claude (or $CLAUDE_CONFIG_DIR when no explicit home is given).
//
// Never scanned wholesale: <cfg>/plugins/cache (every past version is kept side by side) and
// <cfg>/plugins/marketplaces (full clones of marketplaces, mostly non-installed plugins).
// cache/ is only consulted as a fallback when installed_plugins.json is missing.
// Skipped everywhere: dot-dirs (.trash, .in_use, .git, ...), node_modules, temp_git_*, and plugin
// skills / commands whose name starts with `_` (the convention for internal partials such as
// vercel/commands/_conventions.md, which Claude Code does not list).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const INDEX_TTL_MS = 60_000;

/** @typedef {{
 *   name: string,               // bare skill name: directory basename (or command file basename)
 *   description: string,        // frontmatter description ('' when absent)
 *   path: string,               // absolute path of SKILL.md / command .md
 *   scope: 'user'|'project'|'plugin'|'synced',
 *   pluginName?: string,        // plugin/synced only: namespace prefix used by the Skill tool
 *   pluginId?: string,          // plugin only: '<name>@<marketplace>' | '<name>@skills-dir' | '<name>@synced'
 *   invocableName: string,      // exactly what the Skill tool / slash command expects
 *   kind: 'skill'|'command',
 *   frontmatterName?: string,   // frontmatter `name` when present
 *   aliases: string[],          // alternative names worth matching on (frontmatter name when it differs)
 *   whenToUse?: string,         // frontmatter `when_to_use` when present
 *   userInvocable: boolean,     // false when frontmatter `user-invocable: false`
 *   modelInvocable: boolean,    // false when frontmatter `disable-model-invocation: true`
 * }} Skill */

const SKIP_NAME_RE = /^(\.|node_modules$|temp_git_)/;
// `<name>` or `<name>~g<N>`; an unsuffixed directory counts as generation 0 so `name~g2` still beats `name`.
const SYNCED_PLUGIN_RE = /^(.+?)(?:~g(\d+))?$/;

const cache = new Map(); // key -> { ts, sig, skills }

/** Drop every cached index (tests, or after a known on-disk change). */
export function clearIndexCache() {
  cache.clear();
}

/**
 * Build (or return the cached) index of installed skills.
 * @param {{cwd?: string, home?: string, configDir?: string, ttlMs?: number, includeCommands?: boolean}} [opts]
 *   home       - HOME root; skills are read from <home>/.claude. Tests pass a temp dir.
 *   configDir  - overrides <home>/.claude (defaults to $CLAUDE_CONFIG_DIR only when home is not given).
 *   ttlMs      - in-process cache lifetime (default 60 s, 0 disables).
 *   includeCommands - also index plugin commands/*.md (default true; they are Skill-tool invocable).
 * @returns {Promise<Skill[]>} a fresh array (never throws; unreadable parts are skipped).
 */
export async function buildIndex(opts = {}) {
  const home = opts.home ?? process.env.HOME ?? os.homedir();
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const configDir = opts.configDir
    ?? (opts.home == null && process.env.CLAUDE_CONFIG_DIR ? process.env.CLAUDE_CONFIG_DIR : path.join(home, '.claude'));
  const ttlMs = opts.ttlMs ?? INDEX_TTL_MS;
  const includeCommands = opts.includeCommands !== false;
  const now = Date.now();

  let projectDirs = [cwd];
  let sig = '';
  try {
    projectDirs = findProjectDirs(cwd);
    sig = computeSignature(configDir, projectDirs);
  } catch { /* signature is best-effort */ }

  const key = `${configDir}\0${cwd}\0${includeCommands ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit && ttlMs > 0 && now - hit.ts < ttlMs && hit.sig === sig) return hit.skills.slice();

  let skills = [];
  try {
    skills = scan({ configDir, home, projectDirs, includeCommands });
  } catch { /* never throw from the hook path */ }
  cache.set(key, { ts: now, sig, skills });
  return skills.slice();
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

function scan({ configDir, home, projectDirs, includeCommands }) {
  const settings = readJson(path.join(configDir, 'settings.json'));
  const enabledPlugins = settings && settings.enabledPlugins && typeof settings.enabledPlugins === 'object'
    ? settings.enabledPlugins : {};
  const isEnabled = (id) => enabledPlugins[id] !== false;

  const pluginRoots = []; // { root, pluginName, pluginId, pluginJson? }
  const userSkills = [];
  const projectSkills = [];
  const out = [];

  // 1. <cfg>/skills: user skills, synced skills, skills-dir plugins.
  try {
    scanSkillsRoot(path.join(configDir, 'skills'), 'user', userSkills, pluginRoots, isEnabled, out);
  } catch { /* skip */ }

  // 2. Project skills, nearest directory first, up to the repository root.
  for (const dir of projectDirs) {
    try {
      scanSkillsRoot(path.join(dir, '.claude', 'skills'), 'project', projectSkills, pluginRoots, isEnabled, null);
    } catch { /* skip */ }
  }

  // 3. Marketplace plugins from installed_plugins.json (fallback: newest cached version).
  const installed = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'));
  if (installed && installed.plugins && typeof installed.plugins === 'object') {
    for (const [id, value] of Object.entries(installed.plugins)) {
      if (!isEnabled(id)) continue;
      const entry = Array.isArray(value) ? value[0] : value;
      if (!entry || typeof entry.installPath !== 'string' || !entry.installPath) continue;
      const root = expandHome(entry.installPath, home);
      pluginRoots.push({ root, pluginName: id.split('@')[0] || id, pluginId: id });
    }
  } else {
    scanCacheFallback(path.join(configDir, 'plugins', 'cache'), pluginRoots, isEnabled);
  }

  // 4. claude.ai-synced plugins: <cfg>/plugins/synced/<bucket>/<name>[~g<N>]/ (highest generation wins;
  //    only directories that look like a plugin — skills/ or .claude-plugin/ — count).
  try {
    const syncedRoot = path.join(configDir, 'plugins', 'synced');
    for (const bucket of listDirs(syncedRoot)) {
      const best = new Map();
      for (const ent of listDirs(bucket.path)) {
        const m = SYNCED_PLUGIN_RE.exec(ent.name);
        if (!m || !m[1]) continue;
        if (!isDir(path.join(ent.path, 'skills')) && !isDir(path.join(ent.path, '.claude-plugin'))) continue;
        const gen = m[2] ? Number(m[2]) : 0;
        const prev = best.get(m[1]);
        if (!prev || gen > prev.gen) best.set(m[1], { gen, root: ent.path });
      }
      for (const [name, { root }] of best) {
        const pluginId = `${name}@synced`;
        if (isEnabled(pluginId)) pluginRoots.push({ root, pluginName: name, pluginId });
      }
    }
  } catch { /* skip */ }

  // 5. Dedupe bare names: personal (user) beats project (docs: "personal over project").
  const seenBare = new Set();
  for (const s of userSkills) {
    if (seenBare.has(s.invocableName)) continue;
    seenBare.add(s.invocableName);
    out.push(s);
  }
  for (const s of projectSkills) {
    if (seenBare.has(s.invocableName)) continue;
    seenBare.add(s.invocableName);
    out.push(s);
  }

  // 6. Plugin skills are unique by namespaced name; first plugin root wins.
  const seenNamespaced = new Set();
  for (const p of pluginRoots) {
    try {
      scanPluginRoot(p, out, seenNamespaced, includeCommands);
    } catch { /* skip this plugin */ }
  }
  return out;
}

/**
 * Scan a skills root (<cfg>/skills or <project>/.claude/skills).
 * - bare skills go to `bareOut` (deduped later)
 * - skills-dir plugins go to `pluginRoots`
 * - synced skills (only under <cfg>/skills/synced) go straight to `syncedOut`
 */
function scanSkillsRoot(root, scope, bareOut, pluginRoots, isEnabled, syncedOut) {
  for (const ent of listDirs(root)) {
    if (ent.name === 'synced' && syncedOut) {
      scanSyncedSkills(ent.path, syncedOut);
      continue;
    }
    const pluginJson = readJson(path.join(ent.path, '.claude-plugin', 'plugin.json'));
    if (pluginJson) {
      const pluginName = typeof pluginJson.name === 'string' && pluginJson.name ? pluginJson.name : ent.name;
      const pluginId = `${pluginName}@skills-dir`;
      if (isEnabled(pluginId)) pluginRoots.push({ root: ent.path, pluginName, pluginId, pluginJson });
      continue;
    }
    const skillFile = path.join(ent.path, 'SKILL.md');
    if (isFile(skillFile)) {
      const s = makeSkill({ file: skillFile, dirName: ent.name, scope, invocableName: ent.name });
      if (s) bareOut.push(s);
      continue;
    }
    // One nested level: <root>/<sub>/<name>/SKILL.md is invocable as <sub>:<name>.
    for (const sub of listDirs(ent.path)) {
      const nestedFile = path.join(sub.path, 'SKILL.md');
      if (!isFile(nestedFile)) continue;
      const s = makeSkill({ file: nestedFile, dirName: sub.name, scope, invocableName: `${ent.name}:${sub.name}` });
      if (s) bareOut.push(s);
    }
  }
}

/** <cfg>/skills/synced/<bucket>/<name>/SKILL.md -> scope 'synced', invocable as anthropic-skills:<name>. */
function scanSyncedSkills(syncedDir, out) {
  for (const bucket of listDirs(syncedDir)) {
    const manifest = readJson(path.join(bucket.path, 'manifest.json'));
    const sourceByName = new Map();
    if (manifest && Array.isArray(manifest.skills)) {
      for (const m of manifest.skills) {
        if (m && typeof m.name === 'string') sourceByName.set(m.name, m.source);
      }
    }
    for (const ent of listDirs(bucket.path)) {
      const file = path.join(ent.path, 'SKILL.md');
      if (!isFile(file)) continue;
      // Binary constants on 2.1.282: "anthropic-skills" normally, "claude-ai" when the source is the user's account.
      const pluginName = sourceByName.get(ent.name) === 'account' ? 'claude-ai' : 'anthropic-skills';
      const s = makeSkill({
        file, dirName: ent.name, scope: 'synced', pluginName,
        invocableName: `${pluginName}:${ent.name}`,
      });
      if (s) out.push(s);
    }
  }
}

/** Fallback when installed_plugins.json is missing: newest version dir of each cached plugin. */
function scanCacheFallback(cacheRoot, pluginRoots, isEnabled) {
  for (const mk of listDirs(cacheRoot)) {
    for (const plugin of listDirs(mk.path)) {
      let best = null;
      for (const ver of listDirs(plugin.path)) {
        const st = statSafe(ver.path);
        if (!st) continue;
        if (!best || st.mtimeMs > best.mtimeMs) best = { root: ver.path, mtimeMs: st.mtimeMs };
      }
      if (!best) continue;
      const pluginId = `${plugin.name}@${mk.name}`;
      if (isEnabled(pluginId)) pluginRoots.push({ root: best.root, pluginName: plugin.name, pluginId });
    }
  }
}

/** Index one plugin root: skills/<name>/SKILL.md (depth 1), plugin.json `skills`, commands/*.md. */
function scanPluginRoot(p, out, seenNamespaced, includeCommands) {
  const { root, pluginName, pluginId } = p;
  const pluginJson = p.pluginJson ?? readJson(path.join(root, '.claude-plugin', 'plugin.json'));
  const prefix = `${pluginName}:`;

  const add = (file, baseName, kind) => {
    const bare = baseName.startsWith(prefix) ? baseName.slice(prefix.length) : baseName;
    if (!bare || bare.startsWith('_')) return; // `_conventions.md`: internal partial, not routable
    const invocableName = prefix + bare;
    if (seenNamespaced.has(invocableName)) return;
    const s = makeSkill({ file, dirName: bare, scope: 'plugin', pluginName, pluginId, invocableName, kind });
    if (!s || (s.frontmatterName && s.frontmatterName.startsWith('_'))) return;
    seenNamespaced.add(invocableName);
    out.push(s);
  };

  // Default skills directory: exactly one level, never recurse into a skill dir.
  for (const ent of listDirs(path.join(root, 'skills'))) {
    const file = path.join(ent.path, 'SKILL.md');
    if (isFile(file)) add(file, ent.name, 'skill');
  }

  // plugin.json "skills": string|array of dirs; each is either a skill dir or a container of skill dirs.
  for (const entry of toArray(pluginJson && pluginJson.skills)) {
    if (typeof entry !== 'string' || !entry) continue;
    const abs = path.resolve(root, entry);
    if (!isWithin(root, abs)) continue;
    const direct = path.join(abs, 'SKILL.md');
    if (isFile(direct)) {
      add(direct, path.basename(abs), 'skill');
      continue;
    }
    for (const ent of listDirs(abs)) {
      const file = path.join(ent.path, 'SKILL.md');
      if (isFile(file)) add(file, ent.name, 'skill');
    }
  }

  if (!includeCommands) return;

  // commands/*.md are exposed through the Skill tool as <plugin>:<file sans .md>.
  const commandDirs = [path.join(root, 'commands')];
  for (const entry of toArray(pluginJson && pluginJson.commands)) {
    if (typeof entry !== 'string' || !entry) continue;
    const abs = path.resolve(root, entry);
    if (!isWithin(root, abs)) continue;
    if (abs.endsWith('.md') && isFile(abs)) add(abs, path.basename(abs, '.md'), 'command');
    else commandDirs.push(abs);
  }
  for (const dir of commandDirs) {
    for (const ent of listFiles(dir)) {
      if (!ent.name.endsWith('.md')) continue;
      add(ent.path, ent.name.slice(0, -3), 'command');
    }
  }
}

// ---------------------------------------------------------------------------
// Skill construction
// ---------------------------------------------------------------------------

function makeSkill({ file, dirName, scope, pluginName, pluginId, invocableName, kind = 'skill' }) {
  const text = readHead(file);
  if (text == null) return null;
  const fm = parseFrontmatter(text);
  const frontmatterName = fm.name || undefined;
  const aliases = frontmatterName && frontmatterName !== dirName ? [frontmatterName] : [];
  const description = fm.description || firstBodyLine(fm.body);
  const skill = {
    name: dirName,
    description,
    path: file,
    scope,
  };
  if (pluginName) skill.pluginName = pluginName;
  if (pluginId) skill.pluginId = pluginId;
  skill.invocableName = invocableName;
  skill.kind = kind;
  if (frontmatterName) skill.frontmatterName = frontmatterName;
  skill.aliases = aliases;
  const whenToUse = fm.fields['when_to_use'];
  if (typeof whenToUse === 'string' && whenToUse) skill.whenToUse = whenToUse;
  skill.userInvocable = !isFalse(fm.fields['user-invocable']);
  skill.modelInvocable = !isTrue(fm.fields['disable-model-invocation']);
  return skill;
}

function firstBodyLine(body) {
  if (!body) return '';
  let inFence = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!line || line.startsWith('#') || line.startsWith('<')) continue;
    const clean = line.replace(/[*_`>]/g, '').trim();
    if (clean) return clean.length > 200 ? clean.slice(0, 200) : clean;
  }
  return '';
}

function isTrue(v) { return typeof v === 'string' && /^(true|yes|on)$/i.test(v.trim()); }
function isFalse(v) { return typeof v === 'string' && /^(false|no|off)$/i.test(v.trim()); }

// ---------------------------------------------------------------------------
// Frontmatter (minimal YAML: top-level scalars only, nested blocks kept raw)
// ---------------------------------------------------------------------------

/**
 * Parse the YAML frontmatter block of a SKILL.md / command file.
 * Handles: BOM, CRLF, `# comments`, plain / "double" / 'single' quoted scalars (multi-line too),
 * `>` folded and `|` literal block scalars (with chomping indicators), nested maps/lists (kept as
 * raw text under `fields[key]` so callers can still detect keys such as `hooks`).
 * Only top-level keys are extracted. Never throws.
 * @returns {{name: string|null, description: string|null, fields: Record<string,string>, hasFrontmatter: boolean, body: string}}
 */
export function parseFrontmatter(text) {
  const out = { name: null, description: null, fields: {}, hasFrontmatter: false, body: '' };
  if (typeof text !== 'string') return out;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    out.body = src;
    return out;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') { end = i; break; }
  }
  if (end === -1) {
    out.body = src;
    return out;
  }
  out.hasFrontmatter = true;
  out.body = lines.slice(end + 1).join('\n');
  const fm = lines.slice(1, end);

  let i = 0;
  while (i < fm.length) {
    const line = fm[i];
    if (!line.trim() || /^\s*#/.test(line)) { i++; continue; }
    const m = /^([A-Za-z0-9_][A-Za-z0-9_.\-]*)\s*:(?:\s+(.*))?$/.exec(line);
    if (!m) { i++; continue; } // indented stray line or not a top-level mapping entry
    const key = m[1];
    const rest = (m[2] ?? '').trim();
    let value;
    let next = i + 1;

    if (rest === '') {
      const block = collectIndented(fm, next);
      next = block.next;
      if (block.lines.length === 0) value = '';
      else if (looksStructured(block.lines)) value = dedent(block.lines).join('\n');
      else value = foldPlain(dedent(block.lines));
    } else if (/^[>|]/.test(rest)) {
      const indicator = rest[0];
      const keep = /\+/.test(rest);
      const strip = /-/.test(rest.slice(0, 3));
      const block = collectIndented(fm, next);
      next = block.next;
      const body = dedent(block.lines);
      value = indicator === '>' ? foldBlock(body) : body.join('\n');
      value = strip ? value.replace(/\n+$/, '') : keep ? value : value.replace(/\n+$/, '');
    } else if (rest[0] === '"') {
      const q = readQuoted(fm, i, line.indexOf('"'), '"');
      value = unescapeDouble(q.raw);
      next = q.next;
    } else if (rest[0] === "'") {
      const q = readQuoted(fm, i, line.indexOf("'"), "'");
      value = q.raw.replace(/''/g, "'");
      next = q.next;
    } else {
      value = stripComment(rest);
      const block = collectIndented(fm, next, true);
      if (block.lines.length) {
        value = foldPlain([value, ...dedent(block.lines)]);
        next = block.next;
      }
    }
    out.fields[key] = value;
    i = next;
  }
  if (typeof out.fields.name === 'string' && out.fields.name.trim()) out.name = out.fields.name.trim();
  if (typeof out.fields.description === 'string' && out.fields.description.trim()) {
    out.description = out.fields.description.trim();
  }
  return out;
}

/** Collect the run of indented (or blank) lines starting at `from`; trailing blanks are dropped. */
function collectIndented(fm, from, stopAtBlank = false) {
  const lines = [];
  let j = from;
  while (j < fm.length) {
    const l = fm[j];
    if (l.trim() === '') {
      if (stopAtBlank) break;
      lines.push('');
      j++;
      continue;
    }
    if (!/^\s/.test(l)) break;
    lines.push(l);
    j++;
  }
  while (lines.length && lines[lines.length - 1] === '') { lines.pop(); j--; }
  return { lines, next: j };
}

function looksStructured(lines) {
  const first = lines.find((l) => l.trim() !== '') ?? '';
  return /^\s*-(\s|$)/.test(first) || /^\s*[^\s:#][^:]*:(\s|$)/.test(first);
}

function dedent(lines) {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    const n = /^\s*/.exec(l)[0].length;
    if (n < min) min = n;
  }
  if (!Number.isFinite(min)) min = 0;
  return lines.map((l) => (l.trim() === '' ? '' : l.slice(min)));
}

/** YAML folded block: lines joined by spaces, blank lines become newlines, more-indented lines kept. */
function foldBlock(lines) {
  let outText = '';
  let prevBlank = true;
  let prevIndented = false;
  for (const l of lines) {
    if (l === '') { outText += '\n'; prevBlank = true; continue; }
    const indented = /^\s/.test(l);
    if (!prevBlank && !indented && !prevIndented) outText += ' ';
    else if (!prevBlank && (indented || prevIndented)) outText += '\n';
    outText += l;
    prevBlank = false;
    prevIndented = indented;
  }
  return outText.trim();
}

/** Plain multi-line scalar: continuation lines fold with single spaces. */
function foldPlain(lines) {
  return lines.map((l) => stripComment(l.trim())).filter(Boolean).join(' ').trim();
}

function stripComment(s) {
  return s.replace(/\s+#.*$/, '').trim();
}

/** Read a quoted scalar that may span lines; returns the raw inner text (escapes intact). */
function readQuoted(fm, startLine, startCol, quote) {
  let j = startLine;
  let buf = fm[j].slice(startCol + 1);
  let closeAt = findClose(buf, quote, 0);
  while (closeAt === -1 && j + 1 < fm.length) {
    j++;
    const cont = fm[j].trim();
    buf += cont === '' ? '\n' : (buf.endsWith('\n') ? '' : ' ') + cont;
    closeAt = findClose(buf, quote, 0);
  }
  if (closeAt === -1) return { raw: buf.trim(), next: j + 1 };
  return { raw: buf.slice(0, closeAt), next: j + 1 };
}

function findClose(s, quote, from) {
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (quote === '"' && c === '\\') { k++; continue; }
    if (c === quote) {
      if (quote === "'" && s[k + 1] === "'") { k++; continue; }
      return k;
    }
  }
  return -1;
}

function unescapeDouble(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e) => {
    switch (e[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case '0': return '\0';
      case ' ': return ' ';
      case 'u': return String.fromCharCode(parseInt(e.slice(1), 16));
      case 'x': return String.fromCharCode(parseInt(e.slice(1), 16));
      default: return e;
    }
  });
}

// ---------------------------------------------------------------------------
// Cache signature and project discovery
// ---------------------------------------------------------------------------

/** cwd and its parents up to (and including) the first directory that contains .git; else just cwd. */
export function findProjectDirs(cwd) {
  const dirs = [];
  let d = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    dirs.push(d);
    if (exists(path.join(d, '.git'))) return dirs;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return [path.resolve(cwd)];
}

function computeSignature(configDir, projectDirs) {
  const parts = [];
  const push = (p) => { const st = statSafe(p); parts.push(st ? Math.floor(st.mtimeMs) : 0); };
  const skillsDir = path.join(configDir, 'skills');
  push(skillsDir);
  for (const b of listDirs(path.join(skillsDir, 'synced'))) push(b.path);
  push(path.join(configDir, 'plugins', 'installed_plugins.json'));
  for (const b of listDirs(path.join(configDir, 'plugins', 'synced'))) push(b.path);
  push(path.join(configDir, 'settings.json'));
  for (const d of projectDirs) push(path.join(d, '.claude', 'skills'));
  return parts.join(',');
}

// ---------------------------------------------------------------------------
// fs helpers (all swallow errors)
// ---------------------------------------------------------------------------

function listDirs(dir) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of ents) {
    if (SKIP_NAME_RE.test(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push({ name: ent.name, path: full });
    else if (ent.isSymbolicLink()) {
      const st = statSafe(full);
      if (st && st.isDirectory()) out.push({ name: ent.name, path: full });
    }
  }
  return out;
}

function listFiles(dir) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of ents) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isFile()) out.push({ name: ent.name, path: full });
    else if (ent.isSymbolicLink()) {
      const st = statSafe(full);
      if (st && st.isFile()) out.push({ name: ent.name, path: full });
    }
  }
  return out;
}

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}
function exists(p) { return statSafe(p) !== null; }
function isFile(p) { const st = statSafe(p); return !!st && st.isFile(); }
function isDir(p) { const st = statSafe(p); return !!st && st.isDirectory(); }

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

const HEAD_BYTES = 16 * 1024;

/**
 * Read enough of a skill file to parse its frontmatter (and the first body line): the first 16 KB,
 * or the whole file when it is small or its frontmatter has not closed within that window.
 * Large SKILL.md bodies (vercel ships 48 KB ones) are otherwise the dominant indexing cost.
 */
function readHead(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const text = buf.toString('utf8', 0, n);
    if (n < HEAD_BYTES) return text; // whole file
    const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    if (!text.startsWith('---', start)) return text; // no frontmatter; head is enough
    if (text.indexOf('\n---', start + 3) !== -1 || text.indexOf('\n...', start + 3) !== -1) return text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return readText(p);
}
function readJson(p) {
  const t = readText(p);
  if (t == null) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}
