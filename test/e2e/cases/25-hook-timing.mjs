// Hook in-process timing from the isolated singular.log, correlated by session_id: warm runs stay under 2 s and there
// are no warnings other than the announced test seams.
import { PROMPT_CLASSES, seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'hook timing: warm totalMs < 2000, no unexpected warnings',
  tags: ['timing'],
  costCapUsd: 0.02,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' } });
    const env = seamEnv({ registry: reg, gitBase: ctx.gitBase });
    const runs = [];
    for (const id of ['coding', 'question', 'research']) {
      const r = await ctx.claude(PROMPT_CLASSES.find((p) => p.id === id).prompt, { world: w, label: id, extraEnv: env });
      runs.push({ id, r });
    }
    const log = ctx.readLog(w.home);
    const lines = runs.map(({ id, r }) => ({ id, line: log.find((l) => l.msg === 'on-prompt' && l.sessionId === r.sessionId) }));
    for (const { id, line } of lines) ctx.check(line, `${id}: log line correlated by session_id`, log.map((l) => l.sessionId));
    const [cold, ...warm] = lines;
    ctx.info(`cold run (${cold.id}): ${JSON.stringify(cold.line?.timings)}`);
    for (const { id, line } of warm) {
      ctx.check(Number(line?.timings?.totalMs) < 2000, `${id}: warm totalMs < 2000`, line?.timings);
      ctx.info(`warm run (${id}): ${JSON.stringify(line?.timings)}`);
    }
    const unexpected = log.filter((l) => l.level === 'warn' && !/test seam active/.test(String(l.msg)));
    ctx.eq(unexpected.length, 0, 'no warn lines other than the test-seam notices', unexpected.map((l) => `${l.msg}: ${l.warning ?? l.reason ?? ''}`));
    ctx.eq(log.filter((l) => l.level === 'error').length, 0, 'no error lines');
  },
};
