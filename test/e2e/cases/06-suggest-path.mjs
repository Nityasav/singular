// Suggest mode against the mock registry: candidates land in the hook context with the relay instruction and a
// systemMessage; only single tech words leave the machine; the detached prefetch caches head: and text: so the
// next suggestion shows #sha7 while the /scout-load command stays unpinned.
import { PLAYWRIGHT, seamEnv, loadRefs, REF_RE } from '../lib/prompts.mjs';

export default {
  name: 'suggest path: candidates + relay line + systemMessage; prefetch caches head/text; #sha7 next time',
  tags: ['suggest', 'discovery', 'core'],
  costCapUsd: 0.03,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' } });
    const env = seamEnv({ registry: reg, gitBase: ctx.gitBase });
    const r1 = await ctx.claude(PLAYWRIGHT, { world: w, label: 'first', extraEnv: env });
    const h1 = ctx.promptHook(r1);
    const c1 = h1 ? h1.context : '';
    ctx.check(h1 && h1.exitCode === 0, 'hook exit 0', h1?.raw);
    ctx.includes(c1, 'Third-party candidates (not loaded):', 'candidates section present');
    ctx.includes(c1, 'vercel-labs/agent-skills@playwright-testing', 'top candidate named');
    ctx.includes(c1, 'load with /scout-load vercel-labs/agent-skills@playwright-testing', 'load command in the short unpinned form');
    ctx.includes(c1, 'end your reply with exactly one line `Load with /scout-load <ref>`', 'relay instruction precedes the candidates');
    ctx.check(c1.indexOf('end your reply with exactly one line') < c1.indexOf('Third-party candidates'), 'relay line comes before the candidate list');
    ctx.match(h1 ? h1.systemMessage : '', /^\[skill-scout\] \d third-party skills? may fit this prompt \(not loaded\): \/scout-load /, 'systemMessage announces the candidates to the user');
    ctx.check(loadRefs(c1).every((ref) => REF_RE.test(ref)), 'every /scout-load ref in the context is grammatical', loadRefs(c1));
    const s1 = reg.summary();
    ctx.check(['anthropics', 'vercel-labs', 'microsoft', 'multica-ai'].every((o) => s1.catalogs.includes(o)), 'one catalog request per allowlisted owner', s1.catalogs);
    ctx.check(s1.searches.length > 0 && s1.searches.every((q) => ['playwright', 'e2e'].includes(q)), 'keyword searches are single tech-lexicon words only', s1.searches);
    ctx.check(s1.audits.some((a) => a === 'vercel-labs/agent-skills/playwright-testing'), 'audit looked up for the top candidate', s1.audits);
    ctx.info(`haiku relay: result ${/\/scout-load /.test(r1.result) ? 'CONTAINS' : 'does not contain'} a /scout-load line (not asserted); result: ${r1.result.replace(/\s+/g, ' ').slice(0, 120)}`);

    // the detached prefetch (on-expand.js <ref> --prefetch) resolves HEAD from the git base and caches the text
    const sha = ctx.gitBase.shas['vercel-labs/agent-skills'];
    const head = await ctx.waitFor(() => ctx.cacheEntry(w.home, 'head:vercel-labs/agent-skills'), { timeoutMs: 20000 });
    ctx.eq(head, sha, 'prefetch cached head:vercel-labs/agent-skills = the git base HEAD');
    const text = await ctx.waitFor(() => ctx.cacheEntry(w.home, `text:vercel-labs/agent-skills#${sha}@playwright-testing`), { timeoutMs: 20000 });
    ctx.check(text && typeof text.text === 'string' && text.text.includes('MARKER-FIRST-LINE'), 'prefetch cached text:<pinned ref> (raw SKILL.md)', text && Object.keys(text));
    const log = ctx.readLog(w.home);
    ctx.check(log.some((l) => l.msg === 'on-expand: prefetched'), 'scout.log has the prefetch line', log.map((l) => l.msg));

    const r2 = await ctx.claude(PLAYWRIGHT, { world: w, label: 'second', extraEnv: env });
    const c2 = ctx.promptContext(r2);
    ctx.match(c2, new RegExp(`vercel-labs/agent-skills#${sha.slice(0, 7)}@playwright-testing \\(`), 'second run shows the #sha7 display form');
    ctx.includes(c2, 'load with /scout-load vercel-labs/agent-skills@playwright-testing', 'load command stays unpinned');
    const line = log.filter((l) => l.msg === 'on-prompt').pop();
    ctx.info(`cold discoverMs ${log.find((l) => l.msg === 'on-prompt' && l.discover)?.timings?.discoverMs}; registry requests ${reg.requests.length}; second-run timings ${JSON.stringify(ctx.readLog(w.home).filter((l) => l.msg === 'on-prompt').pop()?.timings)}`);
    void line;
  },
};
