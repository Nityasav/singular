// <pasted_content id="..."> wrapper lines are stripped before scoring: the wrapper tokens never appear in a
// "(matches ...)" clause and the log's promptChars equals the inner text length.
import { seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'pasted_content wrapper is stripped before scoring',
  tags: ['prompt-types', 'pasted'],
  costCapUsd: 0.01,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' }, projectSkills: true });
    const inner = 'build me a landing page with tailwind and a pricing table please, do not use any tools';
    const prompt = `<pasted_content id="p9">\n${inner}\n</pasted_content id="p9">`;
    const r = await ctx.claude(prompt, { world: w, label: 'pasted', extraEnv: seamEnv({ registry: reg, gitBase: ctx.gitBase }) });
    const h = ctx.promptHook(r);
    const c = h ? h.context : '';
    ctx.check(h && h.exitCode === 0, 'hook exit 0', h?.raw);
    ctx.match(c, /^\[skill-scout\] Stack: Next\.js 16/, 'context has the Stack line');
    ctx.match(c, /Installed skills likely relevant: [^\n]*e2e-tailwind-landing \(matches [^)]*(tailwind|landing|pricing)/i, 'routing matched the inner text against the seeded project skill');
    const clauses = [...c.matchAll(/\(matches ([^)]*)\)/g)].map((m) => m[1]);
    ctx.check(clauses.every((cl) => !/\b(pasted|content|p9)\b/i.test(cl)), 'no wrapper token in any (matches ...) clause', clauses);
    const line = ctx.readLog(w.home).filter((l) => l.msg === 'on-prompt').pop();
    ctx.check(line, 'log line found');
    if (line) ctx.eq(line.promptChars, inner.length, `log promptChars equals the inner length (${inner.length})`);
    ctx.info(`matches: ${clauses.join(' | ')}`);
  },
};
