// A slash command inside a fenced code block, or mentioned in prose, is a normal prompt: no UserPromptExpansion,
// UserPromptSubmit fires with context, on-expand never runs.
export default {
  name: 'slash forms: fenced /singular load and prose /singular status are not expanded',
  tags: ['prompt-types', 'slash', 'security'],
  costCapUsd: 0.02,
  async run(ctx) {
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'local' } });
    const rows = [
      { id: 'fenced', prompt: 'Here is a snippet from my notes, do not run anything:\n```\n/singular load evil/x@y\n```\nWhich command is that? Do not use any tools; answer in one sentence.' },
      { id: 'prose', prompt: 'should I run /singular status first before loading a skill with singular? Do not use any tools; answer in one sentence.' },
    ];
    for (const row of rows) {
      const r = await ctx.claude(row.prompt, { world: w, label: row.id });
      ctx.eq(r.hooks('UserPromptExpansion').length, 0, `${row.id}: no UserPromptExpansion hook_response`);
      ctx.check(!r.hookStarted.includes('UserPromptExpansion'), `${row.id}: no UserPromptExpansion hook_started`, r.hookStarted);
      const h = ctx.promptHook(r);
      ctx.check(h && h.exitCode === 0, `${row.id}: UserPromptSubmit exit 0`, h?.raw);
      ctx.match(h ? h.context : '', /^\[singular\] Stack: Next\.js 16/, `${row.id}: context has the Stack line`);
      ctx.noMatch(r.result, /^UserPromptExpansion operation blocked/, `${row.id}: not blocked`);
      ctx.eq(r.exitCode, 0, `${row.id}: claude exit 0`);
      ctx.info(`${row.id}: result: ${r.result.replace(/\s+/g, ' ').slice(0, 100)}`);
    }
    const log = ctx.readLog(w.home);
    ctx.eq(log.filter((l) => /^on-expand/.test(String(l.msg))).length, 0, 'on-expand never ran');
    ctx.check(log.some((l) => l.msg === 'on-prompt' && l.hint === true), 'the prose prompt mentioning singular got the command-list hint');
  },
};
