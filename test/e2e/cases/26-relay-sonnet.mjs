// Non-asserting metric on sonnet: does the model end its reply with `Load with /singular load <ref>` when the hook
// offers candidates? The hook side (candidates present, systemMessage) is asserted; the relay is reported as INFO.
import { PLAYWRIGHT, seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'suggestion relay on sonnet (INFO metric, 1 run)',
  tags: ['sonnet', 'relay', 'model'],
  costCapUsd: 0.1,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' } });
    const r = await ctx.claude(PLAYWRIGHT, { world: w, label: 'sonnet-relay', extraEnv: seamEnv({ registry: reg, gitBase: ctx.gitBase }), model: 'sonnet' });
    const h = ctx.promptHook(r);
    const c = h ? h.context : '';
    ctx.check(h && h.exitCode === 0, 'hook exit 0', h?.raw);
    ctx.includes(c, 'Third-party candidates (not loaded):', 'candidates offered to the model');
    ctx.match(h ? h.systemMessage : '', /may fit this prompt/, 'user told through systemMessage regardless of the relay');
    const relayed = /\/singular load [A-Za-z0-9-]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+/.test(r.result);
    ctx.info(`sonnet (${r.model}) relay: ${relayed ? 'RELAYED a /singular load line' : 'did not relay'}; $${r.costUsd.toFixed(4)}; ${r.wallMs} ms; result tail: ${r.result.replace(/\s+/g, ' ').slice(-160)}`);
  },
};
