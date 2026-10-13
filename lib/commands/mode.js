// lib/commands/mode.js — `singular mode`: show or switch singular's mode by rewriting ONLY the `mode` key of config.json.
//
//   node bin/singular.js mode                            prints the current mode and where it comes from
//   node bin/singular.js mode <off|local|suggest|auto> [--json]        (bin/singular.js dispatches here)
//
// Writes to the default ~/.claude/singular/config.json (or $SINGULAR_HOME/config.json when that is
// an absolute path). `auto` is only honoured by the hooks when it lives in the default file, so this
// command refuses to write `auto` into a redirected home. Every other key in the file is left untouched
// (unknown keys, comments are not supported by JSON anyway).

import fs from 'node:fs';
import path from 'node:path';

import { configPath, DEFAULTS, defaultHomeDir, hardenEnv, loadConfig, MODES, redirectedHome } from '../config.js';
import { TAG } from '../context.js';
import { log } from '../log.js';

export const USAGE = `usage: singular mode [${MODES.join('|')}] [--json]`;
export const AUTO_WARNING = `${TAG} mode "auto": third-party skill text from allowlisted skills.sh sources will be injected into your prompts WITHOUT confirmation (text only, pinned, sanitized, still untrusted prose). Cold prompts add up to ~5 s and up to 9,000 chars of third-party text per prompt; see README "What auto actually costs". Run /singular mode suggest to go back.`;

/**
 * @returns {{status:'ok'|'error', mode, previous?, path, message}}
 */
export function setMode(mode, env = process.env) {
  const m = String(mode ?? '').trim().toLowerCase();
  const file = configPath(env);
  if (!MODES.includes(m)) return { status: 'error', mode: null, path: file, message: `${TAG} unknown mode "${mode}"; expected one of ${MODES.join(' | ')}` };
  if (m === 'auto' && redirectedHome(env)) {
    return { status: 'error', mode: null, path: file, message: `${TAG} refusing to write mode "auto" into ${file}: auto is honoured only in the default ${defaultHomeDir(env)}/config.json (unset SINGULAR_HOME first)` };
  }
  let raw = {};
  let previous = DEFAULTS.mode;
  try {
    const text = fs.readFileSync(file, 'utf8');
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
      else return { status: 'error', mode: null, path: file, message: `${TAG} ${file} is not a JSON object; fix it by hand first` };
    } catch (err) {
      return { status: 'error', mode: null, path: file, message: `${TAG} ${file} is not valid JSON (${err.message}); fix it by hand first` };
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') return { status: 'error', mode: null, path: file, message: `${TAG} ${file} is unreadable (${err.code ?? err.message}); fix it by hand first` };
    raw = { ...DEFAULTS };
  }
  if (typeof raw.mode === 'string') previous = raw.mode;
  raw.mode = m;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    return { status: 'error', mode: null, path: file, message: `${TAG} could not write ${file}: ${err.message}` };
  }
  log('info', 'mode', { mode: m, previous, path: file });
  const note = m === 'auto' ? `\n${AUTO_WARNING}` : '';
  return { status: 'ok', mode: m, previous, path: file, message: `${TAG} mode: ${previous} -> ${m} (${file}). Takes effect on the next prompt; no restart needed.${note}` };
}

/** @param {string[]} [envWarnings] hardenEnv warnings (ignored overrides, active test seams), printed as "! ..." lines like `singular status` does */
export function describeMode(env = process.env, envWarnings = []) {
  const config = loadConfig(env);
  const lines = [`${TAG} mode: ${config.mode}  (config file: ${config.path})`];
  if (config.fileMode && config.fileMode !== config.mode) lines.push(`  file says "${config.fileMode}"; effective "${config.mode}" (${config.warnings.filter((w) => /mode/i.test(w)).join('; ') || 'environment override'})`);
  for (const w of [...envWarnings, ...config.warnings]) lines.push(`  ! ${w}`);
  lines.push(`  usage: /singular mode <${MODES.join('|')}>`);
  return lines.join('\n');
}

/** `singular mode [...]`: returns the exit code. */
export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const positional = argv.filter((a) => !a.startsWith('-'));
  if (argv.includes('--help') || argv.includes('-h') || positional.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return positional.length > 1 ? 1 : 0;
  }
  // A relative SINGULAR_HOME (or one inside the project) is ignored: say so instead of silently
  // reading or writing the real ~/.claude/singular/config.json.
  const hardened = hardenEnv(process.env, { cwd: process.cwd() });
  const env = hardened.env;
  for (const w of hardened.warnings) log('warn', 'mode: environment note', { warning: w });
  if (positional.length === 0) {
    process.stdout.write(`${describeMode(env, hardened.warnings)}\n`);
    return 0;
  }
  const r = setMode(positional[0], env);
  r.warnings = hardened.warnings;
  if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else process.stdout.write(`${r.message}\n${hardened.warnings.map((w) => `  ! ${w}\n`).join('')}`);
  return r.status === 'ok' ? 0 : 1;
}
