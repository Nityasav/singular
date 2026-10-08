// Registry down / slow / timing out / 429 / 500 / garbage / hostile: the hook always answers within its timeout with
// a sane context (Stack line first), records the failure (fail marker or cooldown) and never relays hostile entries.
import { PLAYWRIGHT, seamEnv, loadRefs, REF_RE } from '../lib/prompts.mjs';

export default {
  name: 'registry faults: down / slow / timeout / 429 / 500 / garbage / hostile',
  tags: ['discovery', 'registry', 'resilience', 'security'],
  costCapUsd: 0.05,
  async run(ctx) {
    const rows = [
      { id: 'down', mode: 'down', candidates: false, marker: 'fail' },
      { id: 'slow', mode: 'delay', delayMs: 900, candidates: true, marker: null },
      { id: 'timeout', mode: 'delay', delayMs: 3500, candidates: false, marker: 'fail' },
      { id: '429', mode: '429', candidates: false, marker: 'cooldown' },
      { id: '500', mode: '500', candidates: false, marker: 'fail' },
      { id: 'garbage', mode: 'garbage', candidates: false, marker: 'fail' },
      { id: 'hostile', mode: 'hostile', candidates: true, marker: null },
    ];
    for (const row of rows) {
      const reg = await ctx.registry({ mode: row.mode, delayMs: row.delayMs });
      const w = ctx.world(row.id, { cwd: 'next', config: { mode: 'suggest' } });
      const r = await ctx.claude(PLAYWRIGHT, { world: w, label: row.id, extraEnv: seamEnv({ registry: reg, gitBase: ctx.gitBase }) });
      const h = ctx.promptHook(r);
      const c = h ? h.context : '';
      ctx.check(h && h.exitCode === 0, `${row.id}: hook exit 0 (answered within the timeout)`, h?.raw ?? r.hookStarted);
      ctx.match(c, /^\[skill-scout\] Stack: Next\.js 16/, `${row.id}: Stack line first`);
      ctx.check(c.length <= 2000, `${row.id}: context within budget`, c.length);
      ctx.eq(r.exitCode, 0, `${row.id}: claude exit 0`);
      const line = ctx.readLog(w.home).filter((l) => l.msg === 'on-prompt').pop();
      const errors = line?.discover?.errors ?? [];
      if (row.candidates) ctx.includes(c, 'Third-party candidates (not loaded):', `${row.id}: candidates present`);
      else {
        ctx.excludes(c, 'Third-party candidates', `${row.id}: no candidates`);
        ctx.check(errors.length > 0, `${row.id}: discover errors logged`, line?.discover);
      }
      if (row.marker === 'fail') ctx.check(ctx.cacheEntry(w.home, 'fail:catalog:anthropics'), `${row.id}: fail marker written (not retried for 5 min)`);
      if (row.marker === 'cooldown') {
        ctx.check(ctx.cacheEntry(w.home, 'cooldown:skills.sh'), `${row.id}: cooldown written after the 429`);
        ctx.check(errors.some((e) => /rate limited/.test(e)), `${row.id}: 429 reported as rate limited`, errors);
      }
      if (row.id === 'hostile') {
        for (const needle of ['../../etc/passwd', '-rf', '<script>', 'IGNORE ALL PREVIOUS', 'rm -rf', 'evil.invalid', 'x'.repeat(100)]) ctx.excludes(c, needle, `hostile: ${needle} never reaches the context`);
        ctx.check(loadRefs(c).length > 0 && loadRefs(c).every((ref) => REF_RE.test(ref)), 'hostile: every suggested ref is grammatical', loadRefs(c));
        ctx.check(!/[^\x20-\x7E\n—]/.test(c.replace(/[—–]/g, '')), 'hostile: no control characters in the context');
      }
      if (row.id === 'timeout') ctx.check(Number(line?.timings?.discoverMs) < 7000, 'timeout: discovery stayed under the hook budget', line?.timings);
      ctx.info(`${row.id}: discoverMs=${line?.timings?.discoverMs} totalMs=${line?.timings?.totalMs} requests=${reg.requests.length} errors=${errors.length ? errors[0].slice(0, 70) : 'none'} wall=${r.wallMs} ms $${r.costUsd.toFixed(4)}`);
      await reg.close();
    }
  },
};
