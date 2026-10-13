// Context size and shape per cwd kind: Next fixture (Stack first, <= 2000 chars), empty cwd (no Stack line),
// the plugin repo itself (Node.js (ESM); branch main), and a 12,000-char prompt (budgeted, no watchdog).
import { longPrompt, PROMPT_CLASSES, seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'context shape: Next cwd / empty cwd / plugin repo cwd / 12k-char prompt',
  tags: ['prompt-types', 'context', 'core'],
  costCapUsd: 0.05,
  async run(ctx) {
    const coding = PROMPT_CLASSES.find((p) => p.id === 'coding').prompt;
    const research = PROMPT_CLASSES.find((p) => p.id === 'research').prompt;
    const reg = await ctx.registry({ mode: 'ok' });
    const env = seamEnv({ registry: reg, gitBase: ctx.gitBase });

    const next = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' } });
    const r1 = await ctx.claude(coding, { world: next, label: 'next-cwd', extraEnv: env });
    const c1 = ctx.promptContext(r1);
    ctx.match(c1, /^\[singular\] Stack: Next\.js 16, React 19, Tailwind 4/, 'Next cwd: Stack line first');
    ctx.check(c1.length <= 2000, 'Next cwd: context <= 2000 chars', c1.length);

    // An empty cwd (no manifests, so no Stack line) that holds only a seeded project skill: the routing line comes
    // first and names that skill, whatever the host has under ~/.claude.
    const empty = ctx.world('empty', { cwd: 'empty', config: { mode: 'local' }, projectSkills: true });
    const r2 = await ctx.claude(research, { world: empty, label: 'empty-cwd' });
    const c2 = ctx.promptContext(r2);
    ctx.match(c2, /^\[singular\] Installed skills likely relevant:/, 'empty cwd: no Stack line, routing line first');
    ctx.match(c2, /Installed skills likely relevant: [^\n]*e2e-nextjs-app-router \(matches [^)]*nextjs/i, 'empty cwd: the seeded project skill is listed');
    ctx.noMatch(c2, /Stack:/, 'empty cwd: no Stack line anywhere');

    const plugin = ctx.world('plugin', { cwd: 'plugin', config: { mode: 'local' } });
    const r3 = await ctx.claude(coding, { world: plugin, label: 'plugin-cwd' });
    const c3 = ctx.promptContext(r3);
    ctx.includes(c3, 'Stack: Node.js (ESM); branch main', 'plugin repo cwd: Stack: Node.js (ESM); branch main');

    const big = longPrompt(12000);
    ctx.eq(big.length, 12000, 'fixture: 12,000-char prompt');
    const r4 = await ctx.claude(big, { world: next, label: '12k-prompt', extraEnv: env });
    const h4 = ctx.promptHook(r4);
    const c4 = h4 ? h4.context : '';
    ctx.check(h4 && h4.exitCode === 0, '12k: hook exit 0', h4?.raw);
    ctx.match(c4, /^\[singular\] Stack:/, '12k: Stack line present');
    ctx.check(c4.length <= 2000, '12k: context <= 2000 chars', c4.length);
    const log = ctx.readLog(next.home);
    ctx.eq(log.filter((l) => /watchdog/.test(String(l.msg))).length, 0, '12k: no watchdog line in the isolated singular.log');
    const line = log.filter((l) => l.msg === 'on-prompt' && l.promptChars === 12000).pop();
    ctx.check(line, '12k: log line found', log.map((l) => l.promptChars));
    if (line) {
      ctx.check(Number(line.timings?.totalMs) < 3000, '12k: hook totalMs < 3000', line.timings);
      ctx.info(`12k prompt: context ${c4.length} chars, hook timings ${JSON.stringify(line.timings)}, result ${r4.result.replace(/\s+/g, ' ').slice(0, 80)}`);
    }
    ctx.info(`contexts: next=${c1.length} empty=${c2.length} plugin=${c3.length} chars`);
  },
};
