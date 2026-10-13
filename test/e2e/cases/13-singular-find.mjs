// singular-find is model-invocable: a natural question triggers the Skill tool, then `node bin/singular.js find` via
// Bash, and the gated table reaches the model; the user-typed `/singular find <query>` and the empty form also work.
import { seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'singular-find: natural prompt (Skill tool_use), /singular find slash form, empty form',
  tags: ['commands', 'find', 'core', 'sonnet-fallback'],
  costCapUsd: 0.12,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const env = seamEnv({ registry: reg, gitBase: ctx.gitBase });
    const question = 'is there a skill for playwright end-to-end testing? check what is installed and what skills.sh has, but do not install or load anything';
    const FIND_RE = /bin\/singular\.js"?\s+find\b/;
    const MUTATING_RE = /bin\/singular\.js"?\s+(add|load)\b|on-expand\.js/;

    // The model-invocable path is asserted in mode off: in suggest mode the hook has usually already discovered the
    // candidates and in local mode it lists installed near-matches, and haiku answers from either without searching
    // (observed 2026-10-08 in both modes). With the hook off, the only route to an answer is the singular-find skill.
    // haiku is tried first; when it still does not call the Skill tool, the same question is asked once on sonnet
    // (recorded as INFO) and the assertions run against that stream.
    const off = ctx.world('off', { cwd: 'next', config: { mode: 'off' } });
    let r1 = await ctx.claude(question, { world: off, label: 'natural', extraEnv: env, allowedTools: 'Bash(node:*)' });
    ctx.eq(ctx.promptContext(r1), '', 'off mode: the hook injects nothing, so the model has to search');
    if (!r1.skillUses.includes('singular:singular-find')) {
      ctx.info(`haiku did not invoke the Skill tool for the natural question (tools=${r1.toolUses.join(',') || 'none'}; $${r1.costUsd.toFixed(4)}); retrying once on sonnet. haiku answer: ${r1.result.replace(/\s+/g, ' ').slice(0, 120)}`);
      r1 = await ctx.claude(question, { world: off, label: 'natural-sonnet', extraEnv: env, allowedTools: 'Bash(node:*)', model: 'sonnet' });
    }
    // Hard assertions on whichever stream invoked the skill (haiku, else the one sonnet retry): the model-invocable
    // path IS the feature under test, so a run in which neither model calls the skill is a FAIL, not a pass.
    ctx.check(r1.skillUses.includes('singular:singular-find'), 'natural: Skill tool_use singular:singular-find', r1.toolUses);
    ctx.check(r1.bashCommands.some((c) => FIND_RE.test(c)), 'natural: Bash runs bin/singular.js find', r1.bashCommands);
    ctx.includes(r1.toolResultText, 'Third-party candidates (gated', 'natural: the gated table is in the tool output');
    ctx.includes(r1.toolResultText, 'microsoft/playwright-cli@playwright-cli', 'natural: playwright-cli candidate in the tool output');
    ctx.includes(r1.toolResultText, 'vercel-labs/agent-skills@playwright-testing', 'natural: playwright-testing candidate in the tool output');
    ctx.includes(r1.toolResultText, 'Best allowlist-only rejection: evil-local/repo@playwright-helper', 'natural: the best allowlist-only rejection is named');
    ctx.check(!r1.bashCommands.some((c) => MUTATING_RE.test(c)), 'natural: no install or load attempt', r1.bashCommands);
    ctx.match(r1.result, /playwright-cli|playwright-testing/, 'natural: the answer relays a candidate from the table');
    ctx.check(reg.summary().searches.some((q) => /playwright/.test(q)), 'natural: the explicit query reached the registry', reg.summary().searches);
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' } });
    const r1b = await ctx.claude(question, { world: w, label: 'natural-suggest', extraEnv: env, allowedTools: 'Bash(node:*)' });
    const fromHook = /playwright-testing|playwright-cli/.test(r1b.result);
    ctx.info(`natural (suggest mode, not asserted): Skill tool ${r1b.skillUses.includes('singular:singular-find') ? 'used' : 'NOT used'}; candidates in the answer: ${fromHook ? 'yes' : 'no'} (hook context had ${/Third-party candidates/.test(ctx.promptContext(r1b)) ? 'candidates' : 'none'}); $${r1b.costUsd.toFixed(4)}`);
    ctx.check(fromHook || r1b.skillUses.includes('singular:singular-find'), 'suggest mode: the question is answered either from the hook context or through singular-find', r1b.result);

    const r2 = await ctx.claude('/singular find playwright', { world: w, label: 'slash', extraEnv: env, allowedTools: 'Bash(node:*)' });
    const bash2 = r2.bashCommands.find((c) => FIND_RE.test(c));
    ctx.check(bash2 && /playwright/.test(bash2), 'slash form: Bash runs singular.js find with the argument', r2.bashCommands);
    ctx.eq(r2.hooks('UserPromptExpansion').filter((h) => h.exitCode !== 0 || h.context).length, 0, 'slash form: the expansion hook stays silent (exit 0, no context)');
    ctx.includes(r2.toolResultText, 'microsoft/playwright-cli@playwright-cli', 'slash form: table in the tool output');
    ctx.includes(r2.toolResultText, '/singular load <ref>', 'slash form: the table names the load command');
    ctx.check(r2.costUsd < 0.02, 'slash form under 2 cents', r2.costUsd);

    const r3 = await ctx.claude('/singular find', { world: w, label: 'empty', extraEnv: env, allowedTools: 'Bash(node:*)' });
    ctx.eq(r3.exitCode, 0, 'empty form: claude exit 0');
    ctx.check(r3.result.trim().length > 0, 'empty form: the model answers (usage or a question)', r3.result);
    ctx.check(!r3.bashCommands.some((c) => MUTATING_RE.test(c)), 'empty form: no install/load attempt');
    ctx.info(`empty form: tools=${r3.toolUses.join(',') || 'none'}; result: ${r3.result.replace(/\s+/g, ' ').slice(0, 120)}`);
  },
};
