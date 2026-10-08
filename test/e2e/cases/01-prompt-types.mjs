// Every prompt class (research, question, coding, design, data, non-English) fires UserPromptSubmit with exit 0,
// never UserPromptExpansion, and gets a context that starts with the Stack line; the CLI exits 0 with empty stderr.
import { PROMPT_CLASSES, seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'prompt-types: research / question / coding / design / data / non-English',
  tags: ['prompt-types', 'core'],
  costCapUsd: 0.08,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    // Two project-scope skills are seeded into the temp cwd (test/e2e/lib/world.mjs PROJECT_SKILLS) so the routing
    // assertion below does not depend on what the host machine has under ~/.claude.
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' }, projectSkills: true });
    const env = seamEnv({ registry: reg, gitBase: ctx.gitBase });
    for (const { id, prompt } of PROMPT_CLASSES) {
      const r = await ctx.claude(prompt, { world: w, label: id, extraEnv: env });
      const h = ctx.promptHook(r);
      ctx.check(h && h.exitCode === 0, `${id}: UserPromptSubmit hook_response exit 0`, h ? h.raw : 'no hook_response');
      ctx.eq(r.hooks('UserPromptExpansion').length, 0, `${id}: no UserPromptExpansion event`);
      ctx.eq(r.exitCode, 0, `${id}: claude exit 0`);
      ctx.check(!r.isError, `${id}: result is_error false`, r.result);
      ctx.eq(r.stderr.trim(), '', `${id}: claude stderr empty`);
      ctx.eq(h ? h.stderr.trim() : '', '', `${id}: hook stderr empty`);
      const c = h ? h.context : '';
      ctx.match(c, /^\[skill-scout\] Stack: Next\.js 16/, `${id}: context starts with the Stack line`);
      ctx.check(c.length <= 2000, `${id}: context within contextBudgetChars (2000)`, c.length);
      ctx.check(r.result.trim().length > 0, `${id}: model produced a result`, r.result);
      if (id === 'non-english') {
        ctx.match(c, /Installed skills likely relevant: [^\n]*e2e-(nextjs-app-router|tailwind-landing) \(matches [^)]*(nextjs|tailwind)/i, 'non-English prompt routes to a seeded project skill on tech nouns (nextjs/tailwind)');
      }
      if (id === 'research') ctx.match(c, /Installed skills likely relevant: [^\n]*e2e-nextjs-app-router \(matches [^)]*nextjs/i, 'research prompt lists the seeded nextjs project skill');
      ctx.info(`${id}: ${(c.split('\n').length)} context lines, ${c.length} chars, ${r.wallMs} ms, $${r.costUsd.toFixed(4)}; result: ${r.result.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    const sum = reg.summary();
    ctx.check(sum.searches.every((q) => !/\s/.test(q)), 'only single-word tech-lexicon searches left the machine', sum.searches);
    ctx.info(`registry: catalogs=${sum.catalogs.join(',')} searches=${sum.searches.join(',')} audits=${sum.audits.length}`);
  },
};
