// --permission-mode plan and acceptEdits do not change hook behaviour.
import { STACK_ECHO } from '../lib/prompts.mjs';

export default {
  name: 'permission modes plan / acceptEdits: hook unchanged',
  tags: ['permissions'],
  costCapUsd: 0.08, // --permission-mode plan bills sonnet (~$0.04 observed); the cap is enforced per call since 2026-10-08
  async run(ctx) {
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'local' } });
    for (const mode of ['plan', 'acceptEdits']) {
      const r = await ctx.claude(STACK_ECHO, { world: w, label: mode, permissionMode: mode });
      ctx.eq(r.permissionMode, mode, `${mode}: init event reports the permission mode`);
      const hs = r.hooks('UserPromptSubmit');
      ctx.eq(hs.length, 1, `${mode}: one UserPromptSubmit hook_response`);
      ctx.check(hs[0] && hs[0].exitCode === 0 && /Stack: Next\.js 16/.test(hs[0].context), `${mode}: exit 0 with the Stack line`, hs[0]?.raw);
      ctx.includes(r.result, 'Next.js 16', `${mode}: model echoed the Stack line`);
      // Observed 2026-10-08: plan mode bills claude-sonnet-5-5 even with --model haiku ($0.039 vs $0.002); acceptEdits stays on haiku.
      ctx.info(`${mode}: billed models ${Object.keys(r.resultEvent?.modelUsage ?? {}).join(',') || '?'}, $${r.costUsd.toFixed(4)}, ${r.numTurns} turn(s)`);
    }
  },
};
