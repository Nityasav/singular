// Three parallel claude runs share one SKILL_SCOUT_HOME: every hook answers, the log has one line per session,
// no error lines, no leftover temp files in the cache.
import fs from 'node:fs';
import path from 'node:path';
import { PLAYWRIGHT, PRICING, PROMPT_CLASSES, seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'concurrency: 3 parallel runs against one state dir',
  tags: ['concurrency', 'resilience'],
  costCapUsd: 0.03,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('shared', { cwd: 'next', config: { mode: 'suggest' } });
    const env = seamEnv({ registry: reg, gitBase: ctx.gitBase });
    const prompts = [PLAYWRIGHT, PRICING, PROMPT_CLASSES.find((p) => p.id === 'coding').prompt];
    const started = Date.now();
    const rs = await Promise.all(prompts.map((p, i) => ctx.claude(p, { world: w, label: `parallel-${i + 1}`, extraEnv: env })));
    const wall = Date.now() - started;
    rs.forEach((r, i) => {
      const h = ctx.promptHook(r);
      ctx.check(h && h.exitCode === 0, `run ${i + 1}: hook exit 0`, h?.raw);
      ctx.match(h ? h.context : '', /^\[skill-scout\] Stack: Next\.js 16/, `run ${i + 1}: Stack line`);
      ctx.eq(r.exitCode, 0, `run ${i + 1}: claude exit 0`);
    });
    const ids = new Set(rs.map((r) => r.sessionId));
    ctx.eq(ids.size, 3, 'three distinct session ids');
    const log = ctx.readLog(w.home);
    const lines = log.filter((l) => l.msg === 'on-prompt');
    ctx.eq(lines.length, 3, 'three on-prompt log lines');
    ctx.check(lines.every((l) => ids.has(l.sessionId)), 'log lines carry the session ids', lines.map((l) => l.sessionId));
    ctx.eq(log.filter((l) => l.level === 'error').length, 0, 'no error-level log lines');
    ctx.eq(log.filter((l) => l.msg === 'unparsable').length, 0, 'every log line is valid JSON (no interleaving)');
    const cacheDir = path.join(w.home, 'cache');
    ctx.eq(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((n) => n.endsWith('.tmp')).length : 0, 0, 'no leftover .tmp files in the cache');
    ctx.info(`3 parallel runs in ${wall} ms; costs ${rs.map((r) => `$${r.costUsd.toFixed(4)}`).join(' + ')}; registry requests ${reg.requests.length}`);
  },
};
