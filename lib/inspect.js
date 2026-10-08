// lib/inspect.js — decide whether a downloaded skill folder is prose or a plugin in disguise.
//
//   inspectSkillFolder(dir) -> {ok: boolean, problems: string[], files: number}
//
// A folder copied under ~/.claude/skills becomes a `<name>@skills-dir` plugin (hooks, MCP, LSP,
// bin/ on PATH, agents) with no trust dialog when it carries plugin components, and SKILL.md
// frontmatter itself can grant capability (allowed-tools, hooks, context/agent, shell, paths).
// This module only reads; it never modifies anything.

import fs from 'node:fs';
import path from 'node:path';

import { parseFrontmatter } from './skill-index.js';

export const FORBIDDEN_DIRS = ['.claude-plugin', 'hooks', 'bin', 'monitors', 'agents', 'commands', 'scripts', '.claude'];
export const FORBIDDEN_FILES = ['plugin.json', '.mcp.json', '.lsp.json', 'settings.json', 'hooks.json', 'marketplace.json'];
export const FORBIDDEN_FRONTMATTER = ['hooks', 'allowed-tools', 'disallowed-tools', 'context', 'agent', 'shell', 'paths', 'model'];
const MAX_DEPTH = 8;
const MAX_ENTRIES = 5000;

const FENCE_BANG_RE = /^\s*(`{3,}|~{3,})\s*!/;
const AT_REF_RE = /^\s*(?:[-*+]\s+)?@[^\s@]/;
// Raw frontmatter scan (fail closed): Claude Code 2.1.282 honours quoted (`"allowed-tools":`) and
// uniformly indented (`  hooks:`) keys that the minimal parser above does not see as top-level.
const RAW_CAPABILITY_KEY_RE = /^\s*["']?(hooks|allowed-tools|disallowed-tools|context|agent|shell|paths|model|user-invocable)["']?\s*:/i;
const RAW_QUOTED_KEY_RE = /^\s*["'][^"']*["']\s*:/;
const RAW_FLOW_RE = /^\s*[{[]/;
const RAW_KEY_RE = /^(\s*)[A-Za-z0-9_"'][^:]*:/;
const PLAIN_TOP_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\s*:(?:\s|$)/;

function rel(root, p) {
  const r = path.relative(root, p);
  return r || '.';
}

function walk(root, problems, counters) {
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      problems.push(`unreadable directory ${rel(root, dir)}: ${err.code ?? err.message}`);
      continue;
    }
    for (const ent of ents) {
      if (++counters.entries > MAX_ENTRIES) {
        problems.push(`more than ${MAX_ENTRIES} entries; inspection aborted`);
        return;
      }
      const full = path.join(dir, ent.name);
      const r = rel(root, full);
      let lst;
      try {
        lst = fs.lstatSync(full);
      } catch {
        problems.push(`unreadable entry ${r}`);
        continue;
      }
      if (lst.isSymbolicLink()) {
        let target = '?';
        try {
          target = fs.readlinkSync(full);
        } catch {
          /* ignore */
        }
        problems.push(`symlink ${r} -> ${target}`);
        continue; // never follow
      }
      if (lst.isDirectory()) {
        if (ent.name === '.git') continue; // not copied by the CLI; ignore
        if (FORBIDDEN_DIRS.includes(ent.name)) problems.push(`plugin component directory ${r}/`);
        if (depth + 1 <= MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
        else problems.push(`directory nesting deeper than ${MAX_DEPTH}: ${r}`);
        continue;
      }
      if (!lst.isFile()) {
        problems.push(`special file ${r}`);
        continue;
      }
      counters.files++;
      if (FORBIDDEN_FILES.includes(ent.name)) problems.push(`plugin component file ${r}`);
      if (lst.mode & 0o111) problems.push(`executable bit on ${r}`);
    }
  }
}

function inspectSkillMd(file, problems) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    problems.push(`SKILL.md unreadable: ${err.code ?? err.message}`);
    return;
  }
  const fm = parseFrontmatter(text);
  for (const key of Object.keys(fm.fields)) {
    const k = key.toLowerCase();
    if (FORBIDDEN_FRONTMATTER.includes(k)) problems.push(`frontmatter key "${key}"`);
    if (k === 'user-invocable' && /^(false|no|off)$/i.test(String(fm.fields[key]).trim())) problems.push('frontmatter user-invocable: false');
  }
  const lines = fm.body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('!`')) problems.push(`inline shell (!\`) in SKILL.md line ${i + 1}`);
    if (FENCE_BANG_RE.test(line)) problems.push(`fenced shell block (\`\`\`!) in SKILL.md line ${i + 1}`);
    if (AT_REF_RE.test(line)) problems.push(`@-file reference in SKILL.md line ${i + 1}: ${line.trim().slice(0, 60)}`);
  }
  // Frontmatter lines can carry shell forms too (e.g. description: !`cmd`).
  const fmText = text.slice(0, Math.max(0, text.length - fm.body.length));
  if (fm.hasFrontmatter && fmText.includes('!`')) problems.push('inline shell (!`) in SKILL.md frontmatter');
  if (fm.hasFrontmatter) scanRawFrontmatter(fmText, problems);
}

/**
 * Line-by-line scan of the raw frontmatter block. Rejects any capability key in any spelling
 * (quoted, indented, mixed case), any quoted key at all, any flow mapping line (`{` / `[`), and a
 * first key that is indented: whatever the minimal parser cannot fully interpret is refused.
 */
export function scanRawFrontmatter(fmText, problems) {
  const lines = String(fmText ?? '').replace(/\r\n?/g, '\n').split('\n');
  const inner = lines.slice(1); // drop the opening ---
  let firstKeySeen = false;
  for (let i = 0; i < inner.length; i++) {
    const line = inner[i];
    const t = line.trim();
    if (t === '---' || t === '...') break;
    if (!t || t.startsWith('#')) continue;
    const cap = RAW_CAPABILITY_KEY_RE.exec(line);
    // Plain top-level keys (`hooks:` at column 0, unquoted) are already reported from the parsed fields;
    // the raw scan adds the spellings the parser does not see (quoted, indented, mixed case).
    if (cap && !PLAIN_TOP_KEY_RE.test(line)) {
      const key = cap[1].toLowerCase();
      const value = line.slice(line.indexOf(':') + 1).trim();
      if (key === 'user-invocable') {
        if (/^(false|no|off)$/i.test(value)) problems.push(`frontmatter user-invocable: false (raw line ${i + 1})`);
      } else {
        problems.push(`frontmatter key "${key}" (raw line ${i + 1})`);
      }
    }
    if (RAW_QUOTED_KEY_RE.test(line)) problems.push(`frontmatter quoted key (raw line ${i + 1}): ${t.slice(0, 40)}`);
    if (RAW_FLOW_RE.test(line)) problems.push(`frontmatter flow mapping (raw line ${i + 1}): ${t.slice(0, 40)}`);
    const km = RAW_KEY_RE.exec(line);
    if (km && !firstKeySeen) {
      firstKeySeen = true;
      if (km[1].length > 0) problems.push(`frontmatter first key is indented (raw line ${i + 1}): ${t.slice(0, 40)}`);
    }
  }
}

/**
 * @param {string} dir  the skill folder (must contain SKILL.md)
 * @returns {Promise<{ok: boolean, problems: string[], files: number}>}
 */
export async function inspectSkillFolder(dir) {
  const problems = [];
  const counters = { entries: 0, files: 0 };
  const root = path.resolve(String(dir ?? ''));
  let st;
  try {
    st = fs.lstatSync(root);
  } catch {
    return { ok: false, problems: [`not found: ${root}`], files: 0 };
  }
  if (st.isSymbolicLink()) return { ok: false, problems: [`skill folder itself is a symlink: ${root}`], files: 0 };
  if (!st.isDirectory()) return { ok: false, problems: [`not a directory: ${root}`], files: 0 };

  walk(root, problems, counters);

  const skillMd = path.join(root, 'SKILL.md');
  let skillSt = null;
  try {
    skillSt = fs.lstatSync(skillMd);
  } catch {
    skillSt = null;
  }
  if (!skillSt || !skillSt.isFile()) problems.push('SKILL.md missing');
  else inspectSkillMd(skillMd, problems);

  const unique = [...new Set(problems)];
  return { ok: unique.length === 0, problems: unique, files: counters.files };
}
