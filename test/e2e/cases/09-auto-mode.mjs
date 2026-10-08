// mode auto (honoured in a redirected home only through SKILL_SCOUT_TEST_ALLOW_AUTO=1): the top gated candidate's
// text is pinned, fetched from the local git base, sanitized, truncated to the hook budget and injected; the
// one-time WARNING is a systemMessage on the first run only; head: and text: cache entries record the pin.
import { PLAYWRIGHT, seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'auto mode: loaded block in context, sanitized, truncated, pin cached, warning once',
  tags: ['modes', 'auto', 'security'],
  costCapUsd: 0.04,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'auto' } });
    const env = { ...seamEnv({ registry: reg, gitBase: ctx.gitBase }), SKILL_SCOUT_TEST_ALLOW_AUTO: '1' };
    const sha = ctx.gitBase.shas['vercel-labs/agent-skills'];
    const ref = `vercel-labs/agent-skills#${sha}@playwright-testing`;

    const r1 = await ctx.claude(PLAYWRIGHT, { world: w, label: 'auto-first', extraEnv: env });
    const h1 = ctx.promptHook(r1);
    const c1 = h1 ? h1.context : '';
    ctx.check(h1 && h1.exitCode === 0, 'hook exit 0', h1?.raw);
    ctx.match(c1, /^\[skill-scout\] Stack: Next\.js 16/, 'Stack line kept');
    ctx.includes(c1, `Loaded third-party skill ${ref} (auto mode, user-configured; text only, nothing installed).`, 'loaded header with the pinned ref');
    ctx.includes(c1, `<skill-scout-loaded ref="${ref}">`, 'loaded block tag');
    ctx.includes(c1, 'MARKER-FIRST-LINE', 'skill body present');
    // The header lists what was stripped (by design), so the sanitizer is judged on the body inside the tags.
    const open1 = c1.indexOf(`<skill-scout-loaded ref="${ref}">\n`);
    const body1 = open1 >= 0 ? c1.slice(open1 + `<skill-scout-loaded ref="${ref}">\n`.length).split('</skill-scout-loaded>')[0] : '';
    ctx.check(body1.length > 1000, 'loaded body extracted', body1.length);
    for (const needle of ['allowed-tools:', 'steal.js', 'curl -s https://example.invalid', 'cat ~/.ssh/id_rsa', '@~/.aws/credentials', '@../../outside/secret.txt', 'context: fork', 'agent: rogue', '```!']) ctx.excludes(body1, needle, `sanitized body: ${needle} removed`);
    ctx.match(body1, /^---\nname: playwright-testing\ndescription: [^\n]+\nlicense: MIT\n---/, 'frontmatter keeps only name/description/license');
    ctx.excludes(c1, 'MARKER-LAST-LINE', 'tail truncated to the hook budget');
    ctx.match(c1, /Stripped: [^\n]*frontmatter: allowed-tools[^\n]*frontmatter: hooks[^\n]*inline shell[^\n]*fenced shell block[^\n]*@-file reference[^\n]*truncated/, 'Stripped list names every removed form and the truncation');
    ctx.includes(c1, '[skill-scout: truncated]', 'truncation marker');
    ctx.check(c1.length <= 9500, 'whole context <= 9,500 chars', c1.length);
    ctx.match(h1 ? h1.systemMessage : '', /^\[skill-scout\] WARNING: mode "auto" is enabled/, 'first run: one-time auto WARNING as systemMessage');
    ctx.excludes(c1, 'vercel-labs/agent-skills@playwright-testing (', 'the loaded candidate is not also listed as a candidate');
    ctx.eq(ctx.cacheEntry(w.home, 'head:vercel-labs/agent-skills'), sha, 'pin recorded: head:<source> cache entry');
    const text = ctx.cacheEntry(w.home, `text:${ref}`);
    ctx.check(text && typeof text.text === 'string', 'text:<pinned ref> cached forever', text && Object.keys(text));
    const log1 = ctx.readLog(w.home).filter((l) => l.msg === 'on-prompt').pop();
    ctx.eq(log1?.loaded, ref, 'log: loaded ref');
    ctx.eq(log1?.mode, 'auto', 'log: mode auto');
    ctx.check(log1?.autoSkipped == null, 'log: not autoSkipped', log1?.autoSkipped);
    ctx.info(`first auto run: timings ${JSON.stringify(log1?.timings)}, context ${c1.length} chars, result: ${r1.result.replace(/\s+/g, ' ').slice(0, 100)}`);

    const r2 = await ctx.claude(PLAYWRIGHT, { world: w, label: 'auto-second', extraEnv: env });
    const h2 = ctx.promptHook(r2);
    ctx.includes(h2 ? h2.context : '', `<skill-scout-loaded ref="${ref}">`, 'second run: loaded again from the text cache');
    ctx.noMatch(h2 ? h2.systemMessage : '', /WARNING/, 'second run: no WARNING (marker written)');
    const log2 = ctx.readLog(w.home).filter((l) => l.msg === 'on-prompt').pop();
    ctx.info(`second auto run: timings ${JSON.stringify(log2?.timings)}`);
    ctx.check(Number(log2?.timings?.totalMs) < 2000, 'second run served from caches in < 2 s', log2?.timings);
  },
};
