// /singular load through the UserPromptExpansion hook against the local git base: first load pins HEAD, #sha pins the
// argument, --update re-resolves, owner/repo case is normalized to one pin, a long skill is truncated and the
// model acknowledges the loaded skill.
import { seamEnv } from '../lib/prompts.mjs';

export default {
  name: '/singular load happy: pin, #sha, --update, case-normalized, truncation, model acknowledges',
  tags: ['load', 'expansion', 'core'],
  costCapUsd: 0.05,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' } });
    const env = seamEnv({ registry: reg, gitBase: ctx.gitBase });
    const sha = ctx.gitBase.shas['multica-ai/andrej-karpathy-skills'];
    const key = 'multica-ai/andrej-karpathy-skills@karpathy-guidelines';
    const pinned = `multica-ai/andrej-karpathy-skills#${sha}@karpathy-guidelines`;
    const loaded = () => ctx.readJson(`${w.home}/loaded.json`) ?? {};

    const r1 = await ctx.claude(`/singular load ${key}`, { world: w, label: 'load-first', extraEnv: env });
    const x1 = r1.hooks('UserPromptExpansion')[0];
    ctx.check(x1 && x1.exitCode === 0, 'UserPromptExpansion hook exit 0', x1?.raw);
    const c1 = x1 ? x1.context : '';
    ctx.includes(c1, `[singular] The user explicitly loaded third-party skill ${pinned} via /singular load (pinned resolved; text only, nothing installed).`, 'header: pinned resolved');
    ctx.includes(c1, `<singular-loaded ref="${pinned}">`, 'loaded tag with the pinned ref');
    ctx.includes(c1, '## 3. Surgical Changes', 'skill body present');
    ctx.includes(c1, 'stripped: nothing', 'nothing stripped from the clean skill');
    const p1 = ctx.promptHook(r1);
    ctx.check(!p1 || p1.context === '', 'UserPromptSubmit injects nothing for a slash prompt', p1?.context);
    ctx.match(r1.result, /karpathy/i, 'model acknowledges the loaded skill');
    ctx.eq(loaded()[key]?.sha, sha, 'loaded.json pin = git base HEAD');
    ctx.eq(loaded()[key]?.loads, 1, 'loads 1');
    ctx.eq(ctx.cacheEntry(w.home, 'head:multica-ai/andrej-karpathy-skills'), sha, 'head: cache entry');
    ctx.info(`first load: ${c1.length} context chars, $${r1.costUsd.toFixed(4)}, ${r1.wallMs} ms; result: ${r1.result.replace(/\s+/g, ' ').slice(0, 120)}`);

    const r2 = await ctx.claude(`/singular load ${pinned}`, { world: w, label: 'load-sha', extraEnv: env });
    ctx.includes(r2.hooks('UserPromptExpansion')[0]?.context ?? '', '(pinned arg;', '#sha form: pinned arg');
    ctx.eq(loaded()[key]?.loads, 2, 'loads 2');

    const r3 = await ctx.claude(`/singular load ${key} --update`, { world: w, label: 'load-update', extraEnv: env });
    ctx.includes(r3.hooks('UserPromptExpansion')[0]?.context ?? '', '(pinned resolved (--update);', '--update: re-resolved');
    ctx.eq(loaded()[key]?.loads, 3, 'loads 3');

    const r4 = await ctx.claude(`/singular load MULTICA-AI/Andrej-Karpathy-Skills@karpathy-guidelines`, { world: w, label: 'load-case', extraEnv: env });
    ctx.includes(r4.hooks('UserPromptExpansion')[0]?.context ?? '', `<singular-loaded ref="${pinned}">`, 'owner/repo case normalized in the ref');
    ctx.eq(Object.keys(loaded()).length, 1, 'still exactly one loaded.json key');
    ctx.eq(loaded()[key]?.loads, 4, 'loads 4 (same pin)');

    const r5 = await ctx.claude('/singular load anthropics/skills@frontend-design', { world: w, label: 'load-long', extraEnv: env });
    const c5 = r5.hooks('UserPromptExpansion')[0]?.context ?? '';
    ctx.match(c5, /stripped: [^\n]*truncated \d+ chars to 9000/, 'long skill: truncation listed under stripped');
    ctx.check(c5.length <= 9500, 'long skill: context <= 9,500 chars', c5.length);
    ctx.eq(Object.keys(loaded()).length, 2, 'two loaded.json keys after the second ref');
    ctx.check(Array.isArray(loaded()['anthropics/skills@frontend-design']?.stripped) && loaded()['anthropics/skills@frontend-design'].stripped.some((s) => /truncated/.test(s)), 'loaded.json records the truncation', loaded()['anthropics/skills@frontend-design']);
    const log = ctx.readLog(w.home);
    ctx.eq(log.filter((l) => l.msg === 'on-expand: loaded').length, 5, 'five on-expand: loaded log lines');
    for (const r of [r1, r2, r3, r4, r5]) ctx.eq(r.exitCode, 0, 'claude exit 0');
  },
};
