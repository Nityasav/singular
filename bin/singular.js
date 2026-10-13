#!/usr/bin/env node
// bin/singular.js — the `/singular` command dispatcher (and the terminal entrypoint behind `singular <subcommand>`).
//
//   node bin/singular.js                       status + one-screen help
//   node bin/singular.js status [--json] [--cwd <dir>]
//   node bin/singular.js help
//   node bin/singular.js find "<query>" [--limit N] [--all] [--json] [--cwd <dir>]
//   node bin/singular.js add <owner/repo[#sha]@skill> [--yes] [--json]
//   node bin/singular.js mode [off|local|suggest|auto] [--json]
//   node bin/singular.js init [--no-remote] [--json] [--cwd <dir>]            inspect the project, report needs,
//                                                                             coverage and pinned candidates (plan)
//   node bin/singular.js init --apply <1,3|1-3|all> [--project] [--json]      install the approved candidates
//   node bin/singular.js load <owner/repo[#sha]@skill> [--update] [--json]   (terminal convenience; in Claude Code
//                                                                             `/singular load` is handled by the
//                                                                             UserPromptExpansion hook, bin/on-expand.js)
//
// A leading option (`--json`, `--cwd`) without a subcommand means `status`. An unknown subcommand prints the help
// on stderr and exits 1. Output formats and exit codes of the subcommands are those of the former per-command
// scripts; the code lives in lib/commands/{status,find,add,mode,init}.js and is re-exported here for in-process use.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { TAG } from '../lib/context.js';
import { log } from '../lib/log.js';
import { main as addMain } from '../lib/commands/add.js';
import { main as findMain } from '../lib/commands/find.js';
import { main as initMain } from '../lib/commands/init.js';
import { main as modeMain } from '../lib/commands/mode.js';
import { main as statusMain } from '../lib/commands/status.js';
import { main as expandMain } from './on-expand.js';

export { collectStatus, formatStatus } from '../lib/commands/status.js';
export { runFind, formatReport, rankRejected, FIND_TIMEOUT_MS } from '../lib/commands/find.js';
export { runAdd, parseCliJson, unsafeTreeEntries, skillsDir, findSkillDirs, ADD_TIMEOUT_MS } from '../lib/commands/add.js';
export { setMode, describeMode, AUTO_WARNING } from '../lib/commands/mode.js';
export { runInit, runApply, formatReport as formatInitReport, kickoffPrompt, parseSelection, INIT_REMOTE_BUDGET_MS } from '../lib/commands/init.js';

export const SUBCOMMANDS = Object.freeze(['status', 'help', 'find', 'load', 'add', 'mode', 'init']);

export const HELP = [
  'Singular — find, load, add and manage third-party skills for Claude Code',
  '  /singular                        status + this help',
  '  /singular status [--json]        config, mode, indexed skills, cache, pins, installs, log tail',
  '  /singular find <query>           search skills.sh (gated: owner allowlist, install floor, audit); never installs',
  '  /singular load owner/repo@skill [--update]',
  '                                   load a skill\'s text into this session only (commit-pinned, sanitized; nothing',
  '                                   is written to ~/.claude/skills); owner/repo#<40-hex-sha>@skill pins a commit',
  '  /singular add owner/repo@skill   persistent install into ~/.claude/skills (pinned, inspected before and after the copy)',
  '  /singular init [--no-remote]     inspect this project: needs, which installed skills cover them, numbered pinned',
  '                                   third-party candidates (gated, not installed); writes a plan, installs nothing',
  '  /singular init --apply 1,3|all [--project]',
  '                                   install the approved candidates from the plan (pinned; --project: ./.claude/skills)',
  '  /singular mode [off|local|suggest|auto]',
  '                                   show or switch the mode (rewrites only the "mode" key of config.json)',
  '  /singular help                   this help',
  'Config: ~/.claude/singular/config.json (allowlist, blockedRefs, installFloor, pinnedSkills, initMaxCandidates, ...).',
  'From a terminal: `singular <subcommand> ...` (npm install -g singular-skill) or `node bin/singular.js <subcommand> ...`.',
].join('\n');

const LOAD_USAGE = 'usage: singular load <owner/repo[#sha]@skill> [--update] [--json]';

/** Split argv into {sub, rest}: a leading option means `status`; the subcommand is matched case-insensitively. */
export function parseDispatch(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  if (args.length === 0) return { sub: 'status', rest: [] };
  const first = String(args[0]);
  if (first === '--help' || first === '-h') return { sub: 'help', rest: args.slice(1) };
  if (first.startsWith('-')) return { sub: 'status', rest: args };
  return { sub: first.toLowerCase(), rest: args.slice(1) };
}

export async function main(argv = process.argv.slice(2)) {
  const { sub, rest } = parseDispatch(argv);
  switch (sub) {
    case 'help':
      process.stdout.write(`${HELP}\n`);
      return 0;
    case 'status':
      // `/singular` and `/singular status` both print the status followed by the one-screen help (text mode only).
      return statusMain(rest, { trailer: rest.includes('--json') ? '' : HELP });
    case 'find':
      return findMain(rest);
    case 'add':
      return addMain(rest);
    case 'mode':
      return modeMain(rest);
    case 'init':
      return initMain(rest);
    case 'load': {
      if (rest.includes('--help') || rest.includes('-h')) {
        process.stdout.write(`${LOAD_USAGE}\n`);
        return 0;
      }
      if (!rest.some((a) => !a.startsWith('-'))) {
        // never fall through to on-expand's hook mode (it would wait for stdin JSON)
        process.stderr.write(`${TAG} missing skill reference. ${LOAD_USAGE}\n`);
        return 1;
      }
      return expandMain(['load', ...rest]);
    }
    default:
      process.stderr.write(`${TAG} unknown subcommand "${argv[0]}"; expected one of ${SUBCOMMANDS.join(' | ')}\n${HELP}\n`);
      return 1;
  }
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
      log('error', 'singular crashed', { subcommand: parseDispatch(process.argv.slice(2)).sub, error: String(err?.stack ?? err) });
      process.stderr.write(`${TAG} error: ${String(err?.message ?? err)}\n`);
      process.exit(1);
    },
  );
}
