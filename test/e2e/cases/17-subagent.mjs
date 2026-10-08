// Subagent turn: the SubagentStart hook injects the Stack line into the subagent, the parent's follow-up
// <task-notification> prompt is skipped by UserPromptSubmit (exactly one non-empty context per turn), tool_use
// blocks carry parent_tool_use_id, and the LAST result event is the real one.
import { seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'subagent: SubagentStart injects Stack, task-notification skipped, last result used',
  tags: ['subagent', 'core'],
  costCapUsd: 0.06,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' } });
    const prompt = 'Use the Agent tool to spawn exactly one subagent (subagent_type general-purpose) with this task: "Count the .json files in the current directory with `find . -maxdepth 1 -name \'*.json\'` and report two lines: (a) count: <n> and (b) the full text of any line in your context that begins with [skill-scout] Stack: (or NONE)." Wait for it to finish, then reply with the subagent\'s two lines verbatim and nothing else.';
    const r = await ctx.claude(prompt, { world: w, label: 'subagent', extraEnv: seamEnv({ registry: reg, gitBase: ctx.gitBase }), allowedTools: 'Agent,Bash(find:*),Bash(ls:*),Glob', timeoutMs: 300000 });
    const sub = r.hooks('SubagentStart');
    ctx.check(sub.length >= 1, 'SubagentStart hook_response present', r.hookStarted);
    ctx.check(sub.some((h) => h.exitCode === 0 && /^\[skill-scout\] Stack: Next\.js 16/.test(h.context)), 'SubagentStart injected the Stack line (exit 0)', sub.map((h) => h.context));
    ctx.check(sub.every((h) => !/Installed skills|Third-party|scout-load/.test(h.context)), 'SubagentStart injects the stack line only (no routing, no third-party text)', sub.map((h) => h.context));
    ctx.check(r.toolUseBlocks.some((b) => b.name === 'Agent'), 'Agent tool_use present', r.toolUses);
    ctx.check(r.toolUseBlocks.some((b) => b.parentToolUseId), 'a subagent tool_use carries parent_tool_use_id', r.toolUseBlocks.map((b) => `${b.name}:${b.parentToolUseId}`));
    const prompts = r.hooks('UserPromptSubmit');
    ctx.eq(prompts.filter((h) => h.context).length, 1, 'exactly one UserPromptSubmit with non-empty context (the task notification is skipped)');
    ctx.check(prompts.every((h) => h.exitCode === 0), 'every UserPromptSubmit exit 0');
    const log = ctx.readLog(w.home);
    ctx.check(log.some((l) => l.msg === 'on-subagent' && l.chars > 0), 'scout.log: on-subagent line with injected chars', log.filter((l) => l.msg === 'on-subagent'));
    // Claude Code backgrounds the Agent tool only sometimes in -p mode (observed both ways on 2.1.293): when it
    // does, the parent is resumed with a synthetic <task-notification> prompt that must be skipped by the hook and
    // the stream carries two result events; when the subagent finishes inline there is one result and no such prompt.
    const backgrounded = r.results.length >= 2 || prompts.length >= 2;
    if (backgrounded) ctx.check(log.some((l) => l.msg === 'on-prompt' && /task notification/.test(String(l.skipped))), 'scout.log: the task-notification prompt was skipped', log.filter((l) => l.msg === 'on-prompt').map((l) => l.skipped));
    else ctx.check(log.filter((l) => l.msg === 'on-prompt').length === 1, 'inline subagent: exactly one on-prompt log line', log.filter((l) => l.msg === 'on-prompt').map((l) => l.skipped));
    ctx.info(`subagent was ${backgrounded ? 'backgrounded (task-notification prompt delivered and skipped)' : 'run inline (no task-notification prompt)'}`);
    ctx.check(r.results.length >= 1, 'at least one result event', r.results.length);
    ctx.match(r.result, /count: ?\d/, 'last result carries the json count');
    ctx.info(`${r.results.length} result event(s); SubagentStart ${sub.length}; UserPromptSubmit ${prompts.length}; tools=${r.toolUses.join(',')}; $${r.costUsd.toFixed(4)}; ${r.wallMs} ms`);
    ctx.info(`subagent relayed the Stack line: ${/Stack: Next\.js 16/.test(r.result) ? 'yes' : 'no'} (not asserted); last result: ${r.result.replace(/\s+/g, ' ').slice(0, 160)}`);
  },
};
