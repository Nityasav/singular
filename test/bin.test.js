// test/bin.test.js — node --test test/bin.test.js
// The golden routing table for bin/on-prompt.js: the 168-skill snapshot of what Claude Code loaded on the authoring
// machine (test/fixtures/index.snapshot.json, names and descriptions only) scored against the prompts the explorers
// used live on 2026-10-07, plus the isStrongMatch regressions. Pure: no state dir, no network, no subprocess.
// Every entrypoint in bin/ is exercised (as a child process with real hook stdin, real git against a local bare
// repository and a loopback registry, and in-process with injected deps) by test/unit-bin.test.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

// bin/on-prompt.js imports lib/log.js, which resolves the state dir lazily; nothing here logs, but keep the
// process pointed at a throwaway location so a stray log line could never reach the real ~/.claude/singular.
const SCRATCH_ROOT = process.env.SINGULAR_TEST_TMP
  || '/private/tmp/claude-501/-Users-nitya--superset-projects-claude-skills/cfa575e5-ae3c-4522-b59f-cd3623c88bf0/scratchpad';
process.env.SINGULAR_HOME = path.join(SCRATCH_ROOT, 'bin-test-never-written', 'singular-home');

// ---------------------------------------------------------------------------

describe('isStrongMatch ignores generic tokens (regression: "tools, code" / "pull, requests" suppressed discovery)', async () => {
  const { isStrongMatch, STRONG_LOCAL_SCORE, STRONG_SINGLE_NAME_SCORE, NAME_GENERIC } = await import('../bin/on-prompt.js');
  test('two generic matched tokens are not strong even above the score bar', () => {
    assert.equal(isStrongMatch({ score: STRONG_LOCAL_SCORE + 3, matched: ['tools', 'code'], nameMatched: ['code'] }), false);
    assert.equal(isStrongMatch({ score: STRONG_LOCAL_SCORE + 3, matched: ['pull', 'requests'], nameMatched: [] }), false);
    assert.equal(isStrongMatch({ score: 46.9, matched: ['claude', 'code'], nameMatched: [] }), false, 'version-bump for "Claude Code hooks" (2026-10-07)');
  });
  test('two meaningful tokens, or one tech-lexicon name token, are strong', () => {
    assert.equal(isStrongMatch({ score: STRONG_LOCAL_SCORE + 1, matched: ['nextjs', 'tailwind'], nameMatched: [] }), true);
    assert.equal(isStrongMatch({ score: STRONG_LOCAL_SCORE + 1, matched: ['auth', 'flow'], nameMatched: ['auth'] }), true);
    assert.equal(isStrongMatch({ score: STRONG_LOCAL_SCORE + 1, matched: ['nextjs'], nameMatched: ['nextjs'] }), true, 'vercel:nextjs on "nextjs" alone');
    assert.equal(isStrongMatch({ score: STRONG_LOCAL_SCORE - 1, matched: ['nextjs', 'tailwind'], nameMatched: [] }), false);
  });
  test('a single common English name token is never strong; a single rare name token needs the higher bar (2026-10-07)', () => {
    assert.equal(STRONG_SINGLE_NAME_SCORE, 20);
    for (const w of ['design', 'route', 'routing', 'system', 'review', 'plan', 'start', 'setup', 'status']) assert.ok(NAME_GENERIC.has(w), w);
    assert.equal(isStrongMatch({ score: 15.55, matched: ['route'], nameMatched: ['route'] }), false, 'vercel:routing-middleware for "/api/health route"');
    assert.equal(isStrongMatch({ score: 11.6, matched: ['design'], nameMatched: ['design'] }), false, 'engineering:system-design for "design a pricing page"');
    assert.equal(isStrongMatch({ score: 99, matched: ['design'], nameMatched: ['design'] }), false, 'never, whatever the score');
    assert.equal(isStrongMatch({ score: 44.6, matched: ['build', 'dashboard'], nameMatched: ['build', 'dashboard'] }), true, 'data:build-dashboard: rare name token above the bar');
    assert.equal(isStrongMatch({ score: 24.5, matched: ['karpathy'], nameMatched: ['karpathy'] }), true);
    assert.equal(isStrongMatch({ score: 15, matched: ['karpathy'], nameMatched: ['karpathy'] }), false, 'below STRONG_SINGLE_NAME_SCORE');
    assert.equal(isStrongMatch({ score: 30, matched: ['dashboard'], nameMatched: [] }), false, 'a description-only single token is not a name token');
  });
});

describe('golden routing table (test/fixtures/index.snapshot.json: the 168 skills Claude Code loads on the authoring machine, 2.1.293)', async () => {
  const { isStrongMatch } = await import('../bin/on-prompt.js');
  const { scoreSkills, isWeakMatch } = await import('../lib/score.js');
  const snapshot = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'index.snapshot.json'), 'utf8'));
  // What the hook lists (top maxLocalSkills=3 non-weak matches) and whether discovery would run (!strong) for
  // the prompts the explorers used live on 2026-10-07. Each row is the post-fix behaviour, with the explorer's
  // complaint named where one existed.
  const TABLE = [
    ['what are the tradeoffs between server and client components in next.js 16? cite the docs', ['vercel:nextjs', 'vercel:next-cache-components', 'vercel:next-upgrade'], true],
    // 03 coding: routing-middleware (single name token "route") is listed but NOT strong any more -> discovery runs
    ['add a /api/health route that returns uptime json', ['vercel:routing-middleware', 'vercel:microfrontends', 'vercel:workflow'], false],
    // 04 design: shadcn is strong via theme + tailwind; system-design ("design" alone) could never be
    ['design a pricing page with three tiers, dark theme, tailwind', ['vercel:shadcn', 'figma:figma-generate-design', 'engineering:system-design'], true],
    // 05 data: the previously invisible synced `data` plugin now routes (create-viz); nothing strong -> discovery
    ['write a pandas script that plots monthly churn from a csv', ['anthropic-skills:xlsx', 'data:create-viz', 'product-management:stakeholder-update'], false],
    ['build a dashboard that shows weekly active users from our postgres database', ['data:build-dashboard', 'claude-mem:mem-search', 'superset:page'], true],
    ['build a landing page with tailwind css!!', ['figma:figma-generate-design', 'vercel:shadcn', 'marketing:content-creation'], true],
    ['build a landing page for my saas product in nextjs with a pricing table and signup form', ['figma:figma-generate-design', 'vercel:nextjs', 'product-management:product-brainstorming'], true],
    ['hazme una landing page para mi startup con nextjs y tailwind, con precios y formulario', ['vercel:nextjs', 'marketing:content-creation', 'figma:figma-generate-design'], true],
    // 12: "claude code" no longer routes to claude-mem:version-bump
    ['review this snippet for correctness: it runs a /singular load evil/x@y command inside a fenced code block in claude code', ['engineering:code-review'], false],
    ['how do I configure Claude Code hooks to run prettier after every file edit in this repo', [], false],
    ['should I run /singular status first? which singular plugin skill helps me here', ['vercel:status'], false],
    ['refactor this function to be simpler, keep changes surgical', ['andrej-karpathy-skills:karpathy-guidelines'], false],
    // 15 skillify: build-dashboard (rare name token, score 22) is strong
    ['make this prompt better: build me a saas dashboard', ['data:build-dashboard', 'vercel:next-forge', 'superset:superset-automation'], true],
    // terraform: "rules" / "write" are noise -> nothing listed, discovery runs
    ['write a terraform module for an s3 bucket with versioning and lifecycle rules', [], false],
    ['add a stripe webhook handler with supabase for subscription payments in this nextjs app', ['vercel:nextjs', 'vercel:marketplace', 'vercel:next-upgrade'], true],
  ];

  test('snapshot shape: names and descriptions only, no paths', () => {
    assert.equal(snapshot.skills.length, 168);
    assert.ok(snapshot.skills.every((s) => typeof s.invocableName === 'string' && typeof s.description === 'string' && s.path === undefined));
    assert.ok(snapshot.skills.some((s) => s.invocableName === 'data:build-dashboard' && s.pluginId === 'data@synced'), 'the unsuffixed synced plugin is in the snapshot');
    assert.ok(!snapshot.skills.some((s) => /^_/.test(s.name)), 'no underscore partials');
  });

  for (const [prompt, listed, strong] of TABLE) {
    test(`routes "${prompt.slice(0, 60)}" -> [${listed.join(', ') || 'nothing'}], discovery ${strong ? 'suppressed' : 'runs'}`, () => {
      const scored = scoreSkills(prompt, snapshot.skills, { max: 6, minScore: 1.5 });
      const shown = scored.filter((m) => !isWeakMatch(m.matched)).slice(0, 3);
      assert.deepEqual(shown.map((m) => m.skill.invocableName), listed, JSON.stringify(shown.map((m) => [m.skill.invocableName, m.score, m.matched])));
      assert.equal(shown.some(isStrongMatch), strong, JSON.stringify(shown.map((m) => [m.skill.invocableName, m.score, m.matched, m.nameMatched])));
    });
  }

  test('never lists the known false positives', () => {
    for (const [prompt, bad] of [
      ['how do I configure Claude Code hooks to run prettier after every file edit in this repo', ['claude-mem:version-bump', 'claude-md-management:claude-md-improver', 'figma:figma-create-new-file']],
      ['write a terraform module for an s3 bucket with versioning and lifecycle rules', ['claude-mem:version-bump', 'vercel:flags-sdk']],
      ['write a function that parses the config file and validates required fields', ['figma:figma-create-new-file', 'vercel:vercel-functions']],
    ]) {
      const shown = scoreSkills(prompt, snapshot.skills, { max: 6, minScore: 1.5 }).filter((m) => !isWeakMatch(m.matched)).map((m) => m.skill.invocableName);
      for (const b of bad) assert.ok(!shown.includes(b), `${b} must not be listed for "${prompt}" (got ${shown.join(', ')})`);
    }
  });
});
