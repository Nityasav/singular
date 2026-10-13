// Hostile /singular load arguments are blocked by the expansion hook before any model call: exit 2, no
// UserPromptSubmit, zero turns, zero cost, the reason in the result, loaded.json untouched.
import fs from 'node:fs';
import { seamEnv } from '../lib/prompts.mjs';

export default {
  name: '/singular load hostile table: shell metachars, traversal, extra words, empty, over-long, non-allowlisted, blockedRefs',
  tags: ['load', 'security', 'free'],
  costCapUsd: 0.0,
  async run(ctx) {
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest', blockedRefs: ['multica-ai/andrej-karpathy-skills@karpathy-guidelines'] } });
    const env = seamEnv({ gitBase: ctx.gitBase });
    const rows = [
      { args: 'a/b@c; rm -rf ~', reason: /unknown option -rf/ },
      { args: '../../etc/passwd', reason: /invalid skill reference/ },
      { args: 'multica-ai/andrej-karpathy-skills@karpathy-guidelines extra words', reason: /expected exactly one skill reference, got 3/ },
      { args: '', reason: /missing skill reference/ },
      { args: `a/${'b'.repeat(490)}@c`, reason: /invalid skill reference "a\/b{78}/ },
      { args: 'evil/repo@x', reason: /owner "evil" is not in the allowlist/ },
      { args: 'multica-ai/andrej-karpathy-skills@karpathy-guidelines', reason: /matches "blockedRefs"/ },
      { args: 'anthropics/skills@frontend-design --yes', reason: /unknown option --yes/ },
    ];
    const loadedFile = `${w.home}/loaded.json`;
    const before = fs.existsSync(loadedFile) ? fs.readFileSync(loadedFile, 'utf8') : 'absent';
    let cost = 0;
    for (const row of rows) {
      const label = row.args.slice(0, 24) || '(empty)';
      const r = await ctx.claude(`/singular load ${row.args}`.trim(), { world: w, label: `hostile-${label}`, extraEnv: env });
      cost += r.costUsd;
      const x = r.hooks('UserPromptExpansion')[0];
      ctx.check(x && x.exitCode === 2, `${label}: UserPromptExpansion exit 2`, x?.raw);
      ctx.eq(r.hooks('UserPromptSubmit').length, 0, `${label}: no UserPromptSubmit hook_response`);
      ctx.eq(r.numTurns, 0, `${label}: num_turns 0`);
      ctx.eq(r.costUsd, 0, `${label}: total_cost_usd 0`);
      ctx.match(r.result, /^UserPromptExpansion operation blocked by hook:/, `${label}: result starts with the block line`);
      ctx.match(r.result, row.reason, `${label}: expected reason`);
      ctx.match(x ? x.output : '', row.reason, `${label}: reason on hook stderr`);
      ctx.eq(r.exitCode, 0, `${label}: claude exit 0 (block is not a CLI error)`);
    }
    const after = fs.existsSync(loadedFile) ? fs.readFileSync(loadedFile, 'utf8') : 'absent';
    ctx.eq(after, before, 'loaded.json unchanged (absent before and after)');
    const log = ctx.readLog(w.home);
    ctx.eq(log.filter((l) => l.msg === 'on-expand: blocked').length, rows.length, 'every block logged');
    ctx.eq(log.filter((l) => l.msg === 'on-expand: loaded').length, 0, 'nothing loaded');
    ctx.info(`${rows.length} blocked loads, total cost $${cost.toFixed(4)}`);
  },
};
