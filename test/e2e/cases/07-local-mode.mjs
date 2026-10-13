// mode local: stack + installed-skill routing, no candidates, zero registry requests.
import { PLAYWRIGHT, seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'local mode: routing without any network request',
  tags: ['modes', 'core'],
  costCapUsd: 0.01,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'local' } });
    const r = await ctx.claude(PLAYWRIGHT, { world: w, label: 'local', extraEnv: seamEnv({ registry: reg, gitBase: ctx.gitBase }) });
    const h = ctx.promptHook(r);
    const c = h ? h.context : '';
    ctx.check(h && h.exitCode === 0, 'hook exit 0', h?.raw);
    ctx.match(c, /^\[singular\] Stack: Next\.js 16/, 'Stack line present');
    ctx.excludes(c, 'Third-party candidates', 'no third-party candidates');
    ctx.excludes(c, '/singular load', 'no /singular load suggestion');
    ctx.eq(reg.requests.length, 0, 'the mock registry received zero requests');
    ctx.eq(h ? h.systemMessage : '', '', 'no systemMessage');
    const line = ctx.readLog(w.home).filter((l) => l.msg === 'on-prompt').pop();
    ctx.eq(line?.mode, 'local', 'log mode local');
    ctx.eq(line?.discover ?? null, null, 'log: no discover phase');
  },
};
