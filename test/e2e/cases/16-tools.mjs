// A tool-using turn (ls + cat): the UserPromptSubmit hook fires exactly once for the turn and the injected
// context is still honoured after the tool calls.
import { seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'tools: ls/cat turn fires the prompt hook once; context honoured after tools',
  tags: ['tools', 'core'],
  costCapUsd: 0.03,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' } });
    const prompt = 'First run `ls` in this directory with the Bash tool, then run `cat package.json`. Finally reply with exactly two lines: line 1 = the number of entries ls printed, line 2 = the full text of the line in your context that begins with [singular] Stack: (or NONE).';
    const r = await ctx.claude(prompt, { world: w, label: 'tools', extraEnv: seamEnv({ registry: reg, gitBase: ctx.gitBase }), allowedTools: 'Bash(ls:*),Bash(cat:*),Read' });
    ctx.eq(r.hooks('UserPromptSubmit').length, 1, 'exactly one UserPromptSubmit hook_response for the turn');
    ctx.eq(r.hookStarted.filter((h) => h === 'UserPromptSubmit').length, 1, 'exactly one UserPromptSubmit hook_started');
    ctx.check(r.toolUses.filter((t) => t === 'Bash').length >= 2, 'at least two Bash tool_use blocks', r.toolUses);
    ctx.check(r.bashCommands.some((c) => /^ls\b/.test(c)) && r.bashCommands.some((c) => /cat package\.json/.test(c)), 'ls and cat were run', r.bashCommands);
    ctx.includes(r.result, 'Next.js 16', 'model echoed the injected Stack line after the tool calls');
    ctx.match(ctx.promptContext(r), /^\[singular\] Stack: Next\.js 16/, 'hook context has the Stack line');
    ctx.check(r.toolResultText.includes('"name"'), 'cat package.json output reached the model', r.toolResultText.slice(0, 200));
    ctx.eq(r.exitCode, 0, 'claude exit 0');
    ctx.info(`tools=${r.toolUses.join(',')} turns=${r.numTurns} $${r.costUsd.toFixed(4)} ${r.wallMs} ms; result: ${r.result.replace(/\s+/g, ' ').slice(0, 120)}`);
  },
};
