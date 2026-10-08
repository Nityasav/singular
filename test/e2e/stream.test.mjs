// test/e2e/stream.test.mjs — unit tests for the e2e stream-json parser against committed streams captured from
// real `claude -p --output-format stream-json --verbose --include-hook-events` runs (Claude Code 2.1.293,
// 2026-10-08; paths scrubbed). No network, no model: `node --test test/e2e/stream.test.mjs`.
//
//   stream-bash-turn.jsonl          /scout-mode local: UserPromptSubmit (empty, slash prompt), one Bash tool_use + tool_result
//   stream-blocked-expansion.jsonl  /scout-load evil/repo@x: UserPromptExpansion exit 2, no model call, cost 0
//   stream-auto-context.jsonl       auto mode: UserPromptSubmit with a 9.5k loaded block and the one-time WARNING systemMessage
//   stream-skill-tool.jsonl         (when present) natural "is there a skill for playwright": Skill tool_use + Bash scout-find.js
//   stream-subagent.jsonl           (when present) Agent tool turn: SubagentStart hook, parent_tool_use_id, two result events
//   stream-rate-limited.jsonl       the account's session window exhausted (2.1.294, 2026-10-08): the hook ran, then a
//                                   rate_limit_event (status rejected, resetsAt) and a synthetic result, no model call, cost 0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseStream, parseStreamLines } from './lib/stream.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const has = (name) => fs.existsSync(path.join(FIX, name));

describe('test/e2e/lib/stream.mjs parseStream', () => {
  test('bash turn: one UserPromptSubmit (empty for a slash prompt), one Bash tool_use with its tool_result, one result', () => {
    const p = parseStream(read('stream-bash-turn.jsonl'));
    assert.equal(p.unparsed, 0);
    assert.ok(p.init && p.sessionId, 'init event with session id');
    assert.ok(p.plugins.includes('skill-scout@inline'), p.plugins);
    const prompts = p.hooks('UserPromptSubmit');
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].exitCode, 0);
    assert.equal(prompts[0].context, '', 'a slash prompt gets no context');
    assert.deepEqual(p.toolUses, ['Bash']);
    assert.match(p.bashCommands[0], /bin\/scout-mode\.js"? local/);
    assert.equal(p.toolResults.length, 1);
    assert.match(p.toolResultText, /mode: suggest -> local/);
    assert.equal(p.results.length, 1);
    assert.ok(p.costUsd > 0 && p.costUsd < 0.01, String(p.costUsd));
    assert.equal(p.isError, false);
    assert.ok(p.numTurns >= 1);
  });

  test('blocked expansion: UserPromptExpansion exit 2 with the reason, no UserPromptSubmit, zero turns, zero cost', () => {
    const p = parseStream(read('stream-blocked-expansion.jsonl'));
    const x = p.hooks('UserPromptExpansion');
    assert.equal(x.length, 1);
    assert.equal(x[0].exitCode, 2);
    assert.equal(x[0].context, '');
    assert.match(x[0].output, /not in the allowlist/);
    assert.equal(p.hooks('UserPromptSubmit').length, 0);
    assert.equal(p.numTurns, 0);
    assert.equal(p.costUsd, 0);
    assert.match(p.result, /^UserPromptExpansion operation blocked by hook:/);
    assert.deepEqual(p.toolUses, []);
  });

  test('auto context: hookSpecificOutput.additionalContext and systemMessage are extracted from the hook stdout', () => {
    const p = parseStream(read('stream-auto-context.jsonl'));
    const h = p.hooks('UserPromptSubmit')[0];
    assert.ok(h.json && h.json.hookSpecificOutput, 'parsed JSON envelope');
    assert.equal(h.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(h.context, /^\[skill-scout\] Stack: Next\.js 16/);
    assert.match(h.context, /<skill-scout-loaded ref="vercel-labs\/agent-skills#[0-9a-f]{40}@playwright-testing">/);
    assert.ok(h.context.length > 9000 && h.context.length <= 9500, String(h.context.length));
    assert.match(h.systemMessage, /^\[skill-scout\] WARNING: mode "auto" is enabled/);
    assert.equal(h.stderr, '');
    assert.ok(p.assistantText.length > 0);
  });

  test('rate-limited stream: the hook ran, then rate_limit_event rejected with resetsAt, a synthetic result, zero cost (runClaude turns this into a SKIP)', () => {
    const p = parseStream(read('stream-rate-limited.jsonl'));
    assert.equal(p.unparsed, 0);
    assert.ok(p.init && p.sessionId);
    const prompts = p.hooks('UserPromptSubmit');
    assert.equal(prompts.length, 1, 'the hook still ran before the model was refused');
    assert.equal(prompts[0].exitCode, 0);
    assert.equal(p.rateLimited, true);
    assert.equal(p.rateLimitResetsAt, 1791449400, 'unix seconds from rate_limit_info.resetsAt');
    assert.equal(new Date(p.rateLimitResetsAt * 1000).toISOString(), '2026-10-08T08:50:00.000Z');
    assert.match(p.result, /hit your session limit/);
    assert.equal(p.costUsd, 0);
    assert.equal(p.numTurns, 1, 'Claude Code reports one (synthetic) turn');
    assert.deepEqual(p.toolUses, []);
    assert.equal(p.model === '<synthetic>' || typeof p.model === 'string', true);
    // a stream whose rate_limit_event is "allowed" is not rate-limited
    const allowed = parseStream(read('stream-rate-limited.jsonl').replace('"status":"rejected"', '"status":"allowed"'));
    assert.equal(allowed.rateLimited, false);
    assert.equal(allowed.rateLimitResetsAt, null);
  });

  test('parseStreamLines counts unparsable lines and ignores blanks', () => {
    const { events, unparsed } = parseStreamLines('{"type":"x"}\n\nnot json\n{"type":"y"}\n');
    assert.equal(events.length, 2);
    assert.equal(unparsed, 1);
  });

  test('a hook_response whose output is stdout+stderr concatenated still yields the context', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'hook_response', hook_event: 'SubagentStart', hook_name: 'SubagentStart', output: '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"[skill-scout] Stack: X"}}\nsome stderr noise', stdout: '', stderr: 'some stderr noise', exit_code: 0, outcome: 'success' });
    const p = parseStream(line);
    assert.equal(p.hooks('SubagentStart')[0].context, '[skill-scout] Stack: X');
  });

  test('skill tool stream (optional fixture): Skill tool_use skill-scout:scout-find followed by Bash scout-find.js', { skip: !has('stream-skill-tool.jsonl') && 'fixture not captured yet' }, () => {
    const p = parseStream(read('stream-skill-tool.jsonl'));
    assert.deepEqual(p.skillUses, ['skill-scout:scout-find']);
    assert.ok(p.bashCommands.some((c) => /bin\/scout-find\.js/.test(c)), p.bashCommands);
    assert.match(p.toolResultText, /Third-party candidates/);
    assert.equal(p.hooks('UserPromptSubmit').length, 1);
  });

  test('subagent stream (optional fixture): SubagentStart hook, parent_tool_use_id on subagent tool_use, last result wins', { skip: !has('stream-subagent.jsonl') && 'fixture not captured yet' }, () => {
    const p = parseStream(read('stream-subagent.jsonl'));
    const sub = p.hooks('SubagentStart');
    assert.ok(sub.length >= 1);
    assert.match(sub[0].context, /^\[skill-scout\] Stack:/);
    assert.ok(p.toolUseBlocks.some((b) => b.name === 'Agent'));
    assert.ok(p.toolUseBlocks.some((b) => b.parentToolUseId), 'a subagent tool_use carries parent_tool_use_id');
    assert.ok(p.results.length >= 1);
    assert.equal(p.result, String(p.results[p.results.length - 1].result ?? ''), 'result is the LAST result event');
    assert.equal(p.hooks('UserPromptSubmit').filter((h) => h.context).length, 1, 'the task-notification prompt injects nothing');
  });
});
