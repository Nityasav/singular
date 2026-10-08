#!/usr/bin/env node
// bin/on-subagent.js — SubagentStart hook entrypoint for skill-scout.
//
// A subagent's prompt never passes through UserPromptSubmit and the parent's additionalContext is not
// inherited (verified on Claude Code 2.1.293: a subagent reported no [skill-scout] line at all), but a
// SubagentStart hook may return hookSpecificOutput.additionalContext ("Context only" in the hooks docs;
// exit 2 does not block). This entrypoint injects ONLY the one-line project stack: no index scoring,
// no network, no prefetch, no third-party text (ephemeral /scout-load text is never forwarded to
// subagents), so it finishes in well under 100 ms.
//
// stdin JSON (2.1.293): {session_id, transcript_path, cwd, prompt_id, agent_id, agent_type, hook_event_name: "SubagentStart"}
// stdout: {"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"[skill-scout] Stack: ..."}} or nothing
// Exit 0 always. Nothing when mode is off, stackDetection is false, or the cwd has no detectable stack.
//
// Dry-run: node bin/on-subagent.js --dry-run [--cwd <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { hardenEnv, loadConfig } from '../lib/config.js';
import { hookOutput, TAG } from '../lib/context.js';
import { log, timer } from '../lib/log.js';
import { detectStack } from '../lib/stack.js';

export const EVENT = 'SubagentStart';

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Pure core: {context, skipped, stack, warnings, elapsedMs}. Never throws.
 */
export async function runOnSubagent({ cwd, env: rawEnv = process.env, config: cfgOverride } = {}) {
  const t = timer();
  const dir = path.resolve(cwd || rawEnv.PWD || process.cwd());
  const hardened = hardenEnv(rawEnv, { cwd: dir });
  const config = cfgOverride ?? loadConfig(hardened.env);
  const result = { context: '', skipped: null, stack: null, warnings: [...hardened.warnings, ...(config.warnings ?? [])], elapsedMs: 0 };
  if (config.mode === 'off') result.skipped = 'mode off';
  else if (config.stackDetection === false) result.skipped = 'stackDetection false';
  else {
    try {
      result.stack = await detectStack(dir);
    } catch {
      result.stack = { summary: '', tags: [] };
    }
    if (result.stack.summary) result.context = `${TAG} Stack: ${result.stack.summary}`;
    else result.skipped = 'no detectable stack';
  }
  result.elapsedMs = t.elapsed();
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: on-subagent.js [--dry-run] [--cwd <dir>]\n  (no args: read the SubagentStart hook JSON from stdin)\n');
    return 0;
  }
  const dryRun = argv.includes('--dry-run');
  const i = argv.indexOf('--cwd');
  let cwd = i >= 0 ? argv[i + 1] : null;
  let input = {};
  if (!dryRun) {
    const raw = readStdinSync();
    try {
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      log('warn', 'on-subagent: stdin is not JSON', { error: err.message });
      return 0;
    }
    if (input.hook_event_name && input.hook_event_name !== EVENT) {
      log('debug', 'on-subagent: ignoring event', { event: input.hook_event_name });
      return 0;
    }
    cwd = cwd ?? (typeof input.cwd === 'string' && input.cwd ? input.cwd : null);
    if (!cwd) {
      // A real SubagentStart always carries cwd; malformed or empty input must not describe this process's cwd.
      log('debug', 'on-subagent: no cwd in hook input; nothing injected');
      return 0;
    }
  }
  const dir = path.resolve(cwd || process.cwd());
  const hardened = hardenEnv(process.env, { cwd: dir });
  for (const k of Object.keys(process.env)) if (!(k in hardened.env)) delete process.env[k];
  for (const [k, v] of Object.entries(hardened.env)) process.env[k] = v;
  try {
    const result = await runOnSubagent({ cwd: dir, env: process.env });
    log('info', 'on-subagent', {
      sessionId: typeof input.session_id === 'string' ? input.session_id : null,
      agentId: typeof input.agent_id === 'string' ? input.agent_id : null,
      agentType: typeof input.agent_type === 'string' ? input.agent_type : null,
      skipped: result.skipped,
      chars: result.context.length,
      ms: Math.round(result.elapsedMs * 10) / 10,
    });
    if (dryRun) process.stdout.write(`${result.context || `${TAG} (no context: ${result.skipped})`}\n`);
    else if (result.context) process.stdout.write(hookOutput(EVENT, result.context));
    return 0;
  } catch (err) {
    log('error', 'on-subagent failed', { error: String(err?.stack ?? err?.message ?? err) });
    return 0;
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
      log('error', 'on-subagent crashed', { error: String(err?.stack ?? err) });
      process.exit(0);
    },
  );
}
