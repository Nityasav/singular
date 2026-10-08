// /scout-status runs node bin/scout-status.js through the Bash tool and the output reaches the model; a natural
// prompt about the status cannot invoke it (user-only) but gets the command-list hint.
import { seamEnv } from '../lib/prompts.mjs';

export default {
  name: '/scout-status via slash (Bash tool_use + output) and the user-only hint for a natural prompt',
  tags: ['commands', 'status'],
  costCapUsd: 0.03,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' } });
    const env = seamEnv({ registry: reg, gitBase: ctx.gitBase });
    const r = await ctx.claude('/scout-status', { world: w, label: 'status', extraEnv: env, allowedTools: 'Bash(node:*)' });
    const bash = r.bashCommands.find((c) => /bin\/scout-status\.js/.test(c));
    ctx.check(bash, 'Bash tool_use runs bin/scout-status.js', r.bashCommands);
    ctx.check(bash && /^node\s+"?[^"]*skill-scout[^"]*|^node\s+"?\//.test(bash) && !/unset|export SKILL_SCOUT_HOME/.test(bash), 'the command is a plain node invocation (no env tampering)', bash);
    const out = r.toolResultText;
    ctx.includes(out, '[skill-scout] skill-scout 0.1.0', 'script output: version line');
    ctx.includes(out, `state dir: ${w.home}`, 'script output: the redirected state dir');
    ctx.match(out, /mode: "suggest"/, 'script output: mode suggest');
    ctx.includes(out, 'TEST SEAMS ACTIVE', 'script output lists the active test seams');
    ctx.includes(out, 'stack (', 'script output: stack line');
    ctx.match(r.result, /suggest/, 'model relays the mode');
    const p = ctx.promptHook(r);
    ctx.check(!p || p.context === '', 'UserPromptSubmit injects nothing for the slash prompt');
    ctx.check(r.costUsd < 0.02, 'cost under 2 cents', r.costUsd);
    ctx.info(`/scout-status: $${r.costUsd.toFixed(4)}, ${r.wallMs} ms, ${r.toolUses.join(',')}`);

    const r2 = await ctx.claude('show me the skill-scout status', { world: w, label: 'natural-status', extraEnv: env });
    ctx.eq(r2.skillUses.filter((s) => /scout-status/.test(s)).length, 0, 'scout-status is not model-invocable (no Skill tool_use)');
    ctx.includes(ctx.promptContext(r2), '/scout-status', 'hook context carries the command-list hint for a prompt about skill-scout');
    ctx.info(`natural prompt: tools=${r2.toolUses.join(',') || 'none'}; result: ${r2.result.replace(/\s+/g, ' ').slice(0, 120)}`);
  },
};
