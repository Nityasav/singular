// /singular status runs `node bin/singular.js status` through the Bash tool and the output reaches the model; a bare
// /singular does the same and ends with the one-screen help; a natural prompt about the status cannot invoke the
// user-only command but gets the command-list hint.
import { seamEnv } from '../lib/prompts.mjs';

export default {
  name: '/singular status and bare /singular via slash (Bash tool_use + output) and the user-only hint for a natural prompt',
  tags: ['commands', 'status'],
  costCapUsd: 0.04,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' } });
    const env = seamEnv({ registry: reg, gitBase: ctx.gitBase });
    const r = await ctx.claude('/singular status', { world: w, label: 'status', extraEnv: env, allowedTools: 'Bash(node:*)' });
    const bash = r.bashCommands.find((c) => /bin\/singular\.js"?\s+status\b/.test(c));
    ctx.check(bash, 'Bash tool_use runs bin/singular.js status', r.bashCommands);
    ctx.check(bash && /^node\s+"?[^"]*singular[^"]*|^node\s+"?\//.test(bash) && !/unset|export SINGULAR_HOME/.test(bash), 'the command is a plain node invocation (no env tampering)', bash);
    ctx.eq(r.hooks('UserPromptExpansion').filter((h) => h.exitCode !== 0 || h.context).length, 0, 'the expansion hook stays silent for a non-load subcommand (exit 0, no context)');
    const out = r.toolResultText;
    ctx.includes(out, '[singular] singular 0.2.0', 'script output: version line');
    ctx.includes(out, `state dir: ${w.home}`, 'script output: the redirected state dir');
    ctx.match(out, /mode: "suggest"/, 'script output: mode suggest');
    ctx.includes(out, 'TEST SEAMS ACTIVE', 'script output lists the active test seams');
    ctx.includes(out, 'stack (', 'script output: stack line');
    ctx.includes(out, 'Singular — find, load, add and manage third-party skills for Claude Code', 'script output ends with the one-screen help');
    ctx.match(r.result, /suggest/, 'model relays the mode');
    const p = ctx.promptHook(r);
    ctx.check(!p || p.context === '', 'UserPromptSubmit injects nothing for the slash prompt');
    ctx.check(r.costUsd < 0.02, 'cost under 2 cents', r.costUsd);
    ctx.info(`/singular status: $${r.costUsd.toFixed(4)}, ${r.wallMs} ms, ${r.toolUses.join(',')}`);

    const r1 = await ctx.claude('/singular', { world: w, label: 'bare', extraEnv: env, allowedTools: 'Bash(node:*)' });
    const bash1 = r1.bashCommands.find((c) => /bin\/singular\.js"?(\s+status\b)?\s*$/.test(c.trim()));
    ctx.check(bash1, 'bare /singular: Bash runs bin/singular.js with no subcommand (or status)', r1.bashCommands);
    ctx.includes(r1.toolResultText, '[singular] singular 0.2.0', 'bare /singular: status in the tool output');
    ctx.includes(r1.toolResultText, '/singular find <query>', 'bare /singular: the help lists the subcommands');
    ctx.eq(r1.hooks('UserPromptExpansion').filter((h) => h.exitCode !== 0 || h.context).length, 0, 'bare /singular: expansion hook silent');
    ctx.info(`bare /singular: $${r1.costUsd.toFixed(4)}, ${r1.wallMs} ms, ${r1.toolUses.join(',')}; result: ${r1.result.replace(/\s+/g, ' ').slice(0, 100)}`);

    const r2 = await ctx.claude('show me the singular status', { world: w, label: 'natural-status', extraEnv: env });
    ctx.eq(r2.skillUses.filter((s) => /^singular(:singular)?$/.test(s)).length, 0, '/singular is not model-invocable (no Skill tool_use)');
    ctx.includes(ctx.promptContext(r2), '/singular', 'hook context carries the command-list hint for a prompt about singular');
    ctx.info(`natural prompt: tools=${r2.toolUses.join(',') || 'none'}; result: ${r2.result.replace(/\s+/g, ' ').slice(0, 120)}`);
  },
};
