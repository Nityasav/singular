// test/e2e/lib/snapshot.mjs — before/after fingerprints of everything a live run must never change.
//
//   globalSnapshot()  -> text: sha256 of ~/.claude/settings.json, ~/.claude/settings.local.json,
//                        ~/.claude/plugins/installed_plugins.json and the listing of ~/.claude/skills (a change FAILS the run)
//   singularSnapshot()   -> text: mtime/size of the REAL ~/.claude/singular state files (config.json, loaded.json,
//                        installed.json, singular.log, cache entry count); the plugin is loaded only via --plugin-dir with a
//                        redirected SINGULAR_HOME, so any change means isolation leaked (reported as a FAIL too)

import fs from 'node:fs';
import path from 'node:path';

import { realHome, sha256File, listDirSafe } from './world.mjs';

export function globalSnapshot(home = realHome()) {
  const lines = [];
  for (const f of ['settings.json', 'settings.local.json', path.join('plugins', 'installed_plugins.json')]) {
    const file = path.join(home, '.claude', f);
    lines.push(`${sha256File(file)}  ${file}`);
  }
  const skills = path.join(home, '.claude', 'skills');
  const names = listDirSafe(skills).sort();
  for (const n of names) {
    let kind = '?';
    try {
      const st = fs.lstatSync(path.join(skills, n));
      kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file';
    } catch {
      kind = 'gone';
    }
    lines.push(`skills/${n} ${kind}`);
  }
  if (names.length === 0) lines.push('skills/ (empty or absent)');
  return lines.join('\n');
}

export function singularSnapshot(home = realHome()) {
  const dir = path.join(home, '.claude', 'singular');
  const lines = [];
  for (const f of ['config.json', 'loaded.json', 'installed.json', 'singular.log', '.auto-mode-warned']) {
    const file = path.join(dir, f);
    try {
      const st = fs.statSync(file);
      lines.push(`${f} size=${st.size} mtime=${Math.round(st.mtimeMs)}`);
    } catch {
      lines.push(`${f} absent`);
    }
  }
  lines.push(`cache entries=${listDirSafe(path.join(dir, 'cache')).filter((n) => n.endsWith('.json')).length}`);
  return lines.join('\n');
}

export function diffSnapshots(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) out.push(`- ${a[i] ?? ''}`, `+ ${b[i] ?? ''}`);
  }
  return out;
}
