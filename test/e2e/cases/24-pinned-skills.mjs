// config.pinnedSkills: an allowlisted ref is pinned, fetched from the git base, sanitized and injected once per
// session; the model can read the ref attribute; a second turn in the same session injects nothing.
import { seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'pinnedSkills: loaded block once per session, model reads the pinned ref',
  tags: ['pinned', 'session', 'load'],
  costCapUsd: 0.03,
  async run(ctx) {
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'local', pinnedSkills: ['multica-ai/andrej-karpathy-skills@karpathy-guidelines', 'not-a-real-skill-name', 'evil/repo@x'] } });
    const env = seamEnv({ gitBase: ctx.gitBase });
    const sha = ctx.gitBase.shas['multica-ai/andrej-karpathy-skills'];
    const ref = `multica-ai/andrej-karpathy-skills#${sha}@karpathy-guidelines`;
    const prompt = 'Reply with exactly one line: the value of the ref attribute of the <singular-loaded> tag in your context (or the word NONE if there is no such tag). Do not use any tools.';
    const r1 = await ctx.claude(prompt, { world: w, label: 'pinned-first', extraEnv: env, persist: true });
    const c1 = ctx.promptContext(r1);
    ctx.includes(c1, `Loaded third-party skill ${ref} (pinned in config.pinnedSkills; text only, nothing installed).`, 'loaded header names the pinned ref and reason');
    ctx.includes(c1, `<singular-loaded ref="${ref}">`, 'loaded block tag');
    ctx.includes(c1, '## 1. Think Before Coding', 'skill body present');
    ctx.match(r1.result, new RegExp(`multica-ai/andrej-karpathy-skills#${sha}@karpathy-guidelines`), 'model echoed the pinned ref');
    ctx.eq(ctx.cacheEntry(w.home, 'head:multica-ai/andrej-karpathy-skills'), sha, 'head: cache entry = git base HEAD');
    ctx.check(ctx.cacheEntry(w.home, `text:${ref}`), 'text:<pinned ref> cached');
    // The pinnedSkills warnings are produced by on-prompt's classifyPinned and surface in --dry-run --verbose
    // (hook mode logs only config/env warnings and `singular status` validates the key's type only: reported as a gap).
    const dry = await ctx.runNode('on-prompt.js', ['--dry-run', prompt, '--cwd', w.cwd, '--verbose'], { env: { SINGULAR_HOME: w.home, ...env }, cwd: w.cwd });
    ctx.match(dry.stderr, /config warning: pinnedSkills: not-a-real-skill-name is neither an installed skill name nor an allowlisted owner\/repo@skill ref/, 'unknown pinned name warned (--dry-run --verbose)');
    ctx.match(dry.stderr, /config warning: pinnedSkills: evil\/repo@x ignored \(owner not allowlisted\)/, 'non-allowlisted pinned ref ignored with a warning (--dry-run --verbose)');
    ctx.excludes(dry.stdout, 'evil/repo', 'the non-allowlisted ref never reaches the context');
    const log1 = ctx.readLog(w.home);
    ctx.info(`hook-mode singular.log carries the pinnedSkills warnings: ${log1.some((l) => /pinnedSkills:/.test(String(l.warning))) ? 'yes' : 'no (gap: only --dry-run --verbose shows them)'}`);
    const r2 = await ctx.claude(prompt, { world: w, label: 'pinned-second', extraEnv: env, persist: true, resume: r1.sessionId });
    ctx.eq(r2.sessionId, r1.sessionId, 'resumed session keeps its id');
    ctx.excludes(ctx.promptContext(r2), '<singular-loaded', 'second prompt in the same session injects nothing (once per session)');
    ctx.match(ctx.promptContext(r2), /^\[singular\] Stack:/, 'second prompt still gets the Stack line');
    ctx.info(`first: ${c1.length} chars, $${r1.costUsd.toFixed(4)}; second: ${ctx.promptContext(r2).length} chars; result1: ${r1.result.replace(/\s+/g, ' ').slice(0, 100)}`);
  },
};
