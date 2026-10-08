// mode off: the hook is a no-op (no context, no systemMessage, no network); the model sees NONE.
import { STACK_ECHO, seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'off mode: hook no-op, model sees no Stack line',
  tags: ['modes', 'core'],
  costCapUsd: 0.01,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'off' } });
    const r = await ctx.claude(STACK_ECHO, { world: w, label: 'off', extraEnv: seamEnv({ registry: reg, gitBase: ctx.gitBase }) });
    const h = ctx.promptHook(r);
    ctx.check(r.hookStarted.includes('UserPromptSubmit') || h, 'hook ran', r.hookStarted);
    if (h) ctx.eq(h.exitCode, 0, 'hook exit 0');
    ctx.eq(h ? h.context : '', '', 'no context');
    ctx.eq(h ? h.systemMessage : '', '', 'no systemMessage');
    ctx.eq(reg.requests.length, 0, 'zero registry requests');
    ctx.match(r.result, /NONE/, 'model reports NONE (no Stack line in its context)');
    const line = ctx.readLog(w.home).filter((l) => l.msg === 'on-prompt').pop();
    ctx.eq(line?.skipped, 'mode off', 'log skipped: mode off');
  },
};
