// test/unit-score.test.js — node --test test/unit-score.test.js
//
// Exhaustive unit tests for lib/score.js: every exported function and branch (normalizeText, stem,
// tokenize/tokenizeDetailed, the word lists, scoreSkills ordering / thresholds / name weighting / phrase
// boost, isWeakMatch / isGenericToken / isTechToken, extractKeywords, expandIntent), plus the two
// consumers that turn a score into a routing decision (bin/on-prompt.js isStrongMatch / skipReason and
// lib/registry.js shareableKeywords) exercised through a realistic prompt-class matrix against the
// 168-skill snapshot in test/fixtures/index.snapshot.json. No network, no subprocesses, no real HOME.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const SCRATCH_ROOT = process.env.SINGULAR_TEST_TMP
  || '/private/tmp/claude-501/-Users-nitya--superset-projects-claude-skills/cfa575e5-ae3c-4522-b59f-cd3623c88bf0/scratchpad';

// bin/on-prompt.js is imported only for its pure helpers (isStrongMatch, skipReason, normalizePrompt);
// it reads nothing at import time, but lib/log.js resolves SINGULAR_HOME at call time, so point it at
// a throwaway dir before the first import anyway.
(function pointStateAtScratch() {
  let base = SCRATCH_ROOT;
  try { fs.mkdirSync(base, { recursive: true }); } catch { base = os.tmpdir(); }
  process.env.SINGULAR_HOME = fs.mkdtempSync(path.join(base, 'unit-score-home-'));
})();
after(() => { try { fs.rmSync(process.env.SINGULAR_HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const {
  tokenize, tokenizeDetailed, stem, normalizeText, scoreSkills, extractKeywords, expandIntent,
  isWeakMatch, isGenericToken, isTechToken,
  STOPWORDS, TECH_LEXICON, TECH_ALIASES, ROUTING_STOPLIST, INTENT_LEXICON,
} = await import('../lib/score.js');
const { shareableKeywords, MAX_KEYWORD_SEARCHES } = await import('../lib/registry.js');
const { isStrongMatch, skipReason, normalizePrompt, STRONG_LOCAL_SCORE, STRONG_SINGLE_NAME_SCORE, NAME_GENERIC } = await import('../bin/on-prompt.js');

const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'index.snapshot.json'), 'utf8')).skills;
const names = (results) => results.map((r) => r.skill.name);
const inv = (results) => results.map((r) => r.skill.invocableName);

// ---------------------------------------------------------------------------
// normalizeText
// ---------------------------------------------------------------------------
describe('normalizeText', () => {
  test('lowercases, strips curly/straight apostrophes, keeps everything else for the splitter', () => {
    assert.equal(normalizeText("Don’t PANIC, it's fine"), 'dont panic, its fine');
    assert.equal(normalizeText(''), '');
    assert.equal(normalizeText(null), '');
    assert.equal(normalizeText(undefined), '');
    assert.equal(normalizeText(42), '42');
  });

  test('language spellings: C++, C#, F#, standalone .NET', () => {
    assert.equal(normalizeText('C++ and c++'), 'cpp and cpp');
    assert.equal(normalizeText('C# or F#'), 'csharp or fsharp');
    assert.equal(normalizeText('.NET 8 and (.net)'), 'dotnet 8 and (dotnet)');
    // only a standalone ".net": "asp.net" keeps its dot and tokenizes to asp + net
    assert.equal(normalizeText('ASP.NET core'), 'asp.net core');
    assert.deepEqual(tokenize('ASP.NET core'), ['asp', 'net', 'cor']);
  });

  test('every end-to-end spelling collapses to the lexicon term e2e (no stray "end" token)', () => {
    for (const v of ['end-to-end', 'end to end', 'end_to_end', 'End To End', 'END-TO-END', 'end-to-end', 'end_to_end']) {
      assert.equal(normalizeText(`flaky ${v} tests`), 'flaky e2e tests', v);
    }
    assert.ok(!tokenize('fix the end-to-end suite').includes('end'));
    assert.ok(tokenize('fix the end-to-end suite').includes('e2e'));
    // "the end" on its own is still the word "end"
    assert.deepEqual(tokenize('until the end'), ['end']);
  });

  test('framework spellings join "<name>.js" / "<name> js" / "<name>-js" / "<name>_js"', () => {
    const joined = {
      'Next.js': 'nextjs', 'next js': 'nextjs', 'next-js': 'nextjs', 'next_js': 'nextjs',
      'Node JS': 'nodejs', 'node.js': 'nodejs', 'Vue.js': 'vuejs', 'Nuxt.js': 'nuxtjs', 'Three.js': 'threejs',
      'Express.js': 'expressjs', 'Nest.js': 'nestjs', 'Ember.js': 'emberjs', 'Alpine.js': 'alpinejs',
      'Solid.js': 'solidjs', 'Svelte.js': 'sveltejs', 'React.js': 'reactjs', 'Preact.js': 'preactjs',
    };
    for (const [raw, want] of Object.entries(joined)) assert.equal(normalizeText(raw), want, raw);
    // not a framework name: untouched
    assert.equal(normalizeText('foo.js and bar js'), 'foo.js and bar js');
  });

  test('"go" counts as the language only in a tech context', () => {
    for (const ctx of ['in go', 'with go', 'using go', 'to go', 'into go']) {
      assert.equal(normalizeText(`a service ${ctx}`), `a service ${ctx.replace(/go$/, 'golang')}`, ctx);
    }
    for (const noun of ['server', 'service', 'code', 'module', 'package', 'program', 'app', 'api', 'cli', 'binary', 'project', 'lang', 'backend', 'microservice']) {
      assert.equal(normalizeText(`a go ${noun}`), `a golang ${noun}`, noun);
    }
    assert.equal(normalizeText('go ahead and go home'), 'go ahead and go home');
    assert.deepEqual(tokenize('go ahead and go home'), ['hom']);
    assert.deepEqual(tokenize('rewrite it in Go'), ['rewrit', 'go']);
  });
});

// ---------------------------------------------------------------------------
// stem
// ---------------------------------------------------------------------------
describe('stem', () => {
  test('rule by rule: -ies, -sses, -(s|x|z|ch|sh)es, -s, -ing, -ed, undouble, trailing -e', () => {
    const cases = [
      ['queries', 'query'], ['dependencies', 'dependency'], ['stories', 'story'],
      ['classes', 'class'], ['processes', 'process'],
      ['boxes', 'box'], ['patches', 'patch'], ['wishes', 'wish'], ['buzzes', 'buzz'],
      ['tests', 'test'], ['hooks', 'hook'], ['pages', 'pag'],
      ['running', 'run'], ['embedded', 'embed'], ['stopped', 'stop'], ['planning', 'plan'],
      ['caching', 'cach'], ['cache', 'cach'], ['styling', 'styl'], ['style', 'styl'],
      ['deployed', 'deploy'], ['deploying', 'deploy'], ['deployments', 'deployment'],
      ['landing', 'land'], ['rotate', 'rotat'], ['rotating', 'rotat'],
    ];
    for (const [w, s] of cases) assert.equal(stem(w), s, w);
  });

  test('guards: short words, -ss/-us/-is/-os/-ys endings, "e" before -ing/-ed, double e, digits, *js', () => {
    for (const w of ['abc', 'ies', 'go', 'up', 'status', 'analysis', 'chaos', 'keys', 'process', 'bus', 'free', 'tree', 'need', 'speed', 'freeing', 'agreed', 'seeing', 'x86s', 'h264', 'emberjs', 'foojs']) {
      assert.equal(stem(w), w, w);
    }
    assert.equal(stem('dies'), 'die');
  });

  test('tech nouns and aliases are never stemmed; aliases resolve to the canonical lexicon term', () => {
    for (const w of ['nextjs', 'react', 'css', 'kubernetes', 'postgres', 'redis', 'e2e', 'ios', 'macos', 'analytics', 'agents', 'webhooks', 'websockets', 'llms']) {
      assert.equal(stem(w), w, w);
    }
    for (const [alias, target] of Object.entries(TECH_ALIASES)) {
      assert.equal(stem(alias), target, `${alias} -> ${target}`);
      assert.ok(TECH_LEXICON.has(target), `alias target ${target} must be a lexicon word`);
    }
  });

  test('is cached and idempotent', () => {
    for (const w of ['queries', 'running', 'nextjs', 'pages', 'freeing']) {
      const first = stem(w);
      assert.equal(stem(w), first);
      assert.equal(stem(first), first === 'pag' ? 'pag' : stem(first), 'stable on its own output');
    }
    assert.equal(stem(stem('deployments')), stem('deployments'));
  });
});

// ---------------------------------------------------------------------------
// tokenize / tokenizeDetailed
// ---------------------------------------------------------------------------
describe('tokenize / tokenizeDetailed', () => {
  test('drops stopwords, 1-char tokens and pure digits; keeps alphanumerics such as 10x and s3', () => {
    assert.deepEqual(tokenize('I want to use React 19 and a 10x faster S3 upload!'), ['react', '10x', 'faster', 's3', 'upload']);
    assert.deepEqual(tokenize('2026 10 7'), []);
    assert.deepEqual(tokenize('a b c d'), []);
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize(undefined), []);
    assert.deepEqual(tokenizeDetailed(''), []);
  });

  test('surface form is the alias-normalised raw token, stem is the stemmed form', () => {
    assert.deepEqual(tokenizeDetailed('TailwindCSS, PostgreSQL and pg on k8s with queries'), [
      { raw: 'tailwind', stem: 'tailwind' },
      { raw: 'postgres', stem: 'postgres' },
      { raw: 'postgres', stem: 'postgres' },
      { raw: 'kubernetes', stem: 'kubernetes' },
      { raw: 'queries', stem: 'query' },
    ]);
    assert.deepEqual(tokenize('TailwindCSS, PostgreSQL and pg on k8s with queries'), ['tailwind', 'postgres', 'postgres', 'kubernetes', 'query']);
  });

  test('splits on every non-ASCII-alphanumeric: accented letters break a word (ASCII tokenizer by design)', () => {
    assert.deepEqual(tokenize('diseño über café'), ['dis', 'ber', 'caf']);
    assert.deepEqual(tokenize('crea una landing page con nextjs'), ['crea', 'una', 'land', 'pag', 'con', 'nextjs']);
  });

  test('the "go" stopword is bypassed by the golang alias after context normalisation', () => {
    // "golang" is not a stopword, so it survives the filter, then aliases to the lexicon term "go".
    assert.deepEqual(tokenizeDetailed('server in go'), [{ raw: 'server', stem: 'server' }, { raw: 'go', stem: 'go' }]);
    assert.deepEqual(tokenizeDetailed('golang'), [{ raw: 'go', stem: 'go' }]);
    assert.deepEqual(tokenize('let us go'), []);
  });
});

// ---------------------------------------------------------------------------
// word lists
// ---------------------------------------------------------------------------
describe('word lists', () => {
  test('STOPWORDS: function words, politeness, counting words; never tech nouns', () => {
    for (const w of ['the', 'a', 'please', 'thanks', 'every', 'none', 'two', 'ten', 'dont', 'im', 'etc', 'via', 'go', 'look']) assert.ok(STOPWORDS.has(w), w);
    for (const w of ['test', 'build', 'react', 'fix', 'deploy', 'design', 'data']) assert.ok(!STOPWORDS.has(w), w);
    // the only stopword that is also a tech noun is "go" (handled by the golang alias, see tokenize)
    assert.deepEqual([...STOPWORDS].filter((w) => TECH_LEXICON.has(w)), ['go']);
  });

  test('TECH_LEXICON: lowercase single tokens, no stemming artefacts, covers the spec list', () => {
    for (const w of TECH_LEXICON) assert.match(w, /^[a-z0-9]+$/, w);
    for (const w of ['react', 'nextjs', 'tailwind', 'svelte', 'vue', 'django', 'fastapi', 'postgres', 'supabase', 'stripe', 'playwright', 'docker', 'k8s', 'terraform', 'rust', 'go', 'swift', 'kotlin', 'pdf', 'csv', 'pandas', 'claude', 'mcp', 'e2e', 'auth', 'api', 'npm', 'prettier', 's3']) {
      assert.ok(TECH_LEXICON.has(w), w);
    }
    for (const w of ['render', 'rest', 'less', 'solid', 'workers', 'actions', 'dashboard', 'design', 'landing', 'page']) assert.ok(!TECH_LEXICON.has(w), w);
  });

  test('TECH_ALIASES is frozen and maps spellings onto lexicon words', () => {
    assert.ok(Object.isFrozen(TECH_ALIASES));
    assert.equal(TECH_ALIASES.tailwindcss, 'tailwind');
    assert.equal(TECH_ALIASES.k8s, 'kubernetes');
    assert.equal(TECH_ALIASES.golang, 'go');
    assert.equal(TECH_ALIASES.pg, 'postgres');
    assert.equal(TECH_ALIASES.gh, 'github');
  });

  test('ROUTING_STOPLIST: hyper-common routing words incl. the 2026-10-07 additions', () => {
    for (const w of ['file', 'files', 'function', 'page', 'test', 'build', 'claude', 'anthropic', 'code', 'plugin', 'plugins', 'skill', 'skills', 'command', 'commands', 'slash', 'hook', 'hooks', 'rule', 'rules', 'guide', 'guides', 'repo', 'repos', 'repository', 'repositories', 'pull', 'request']) {
      assert.ok(ROUTING_STOPLIST.has(w), w);
    }
    for (const w of ['nextjs', 'stripe', 'dashboard', 'pandas', 'terraform', 'landing', 'karpathy']) assert.ok(!ROUTING_STOPLIST.has(w), w);
  });

  test('INTENT_LEXICON is a frozen list of {triggers, terms} strings', () => {
    assert.ok(Object.isFrozen(INTENT_LEXICON));
    assert.ok(INTENT_LEXICON.length >= 9);
    for (const row of INTENT_LEXICON) {
      assert.equal(typeof row.triggers, 'string');
      assert.equal(typeof row.terms, 'string');
      assert.ok(row.triggers.trim() && row.terms.trim());
    }
  });
});

// ---------------------------------------------------------------------------
// isGenericToken / isTechToken / isWeakMatch
// ---------------------------------------------------------------------------
describe('isGenericToken / isTechToken / isWeakMatch', () => {
  test('isGenericToken: stoplist or generic verb, raw or stemmed, case-insensitive', () => {
    for (const w of ['file', 'FILE', 'files', 'hooking', 'builds', 'Building', 'wrote', 'configure', 'configured', 'rules', 'repos', 'claude', 'Code']) assert.ok(isGenericToken(w), w);
    for (const w of ['nextjs', 'landing', 'dashboard', 'pandas', 'surgical', 'karpathy', 'terraform', 'e2e']) assert.ok(!isGenericToken(w), w);
    assert.equal(isGenericToken(''), false);
    assert.equal(isGenericToken(42), false);
  });

  test('isTechToken: lexicon word, alias, or stemmed form; never empty/null', () => {
    for (const w of ['nextjs', 'NextJS', 'pg', 'tailwindcss', 'k8s', 'webhooks', 'agents', 'pdf', 'auth', 'claude']) assert.ok(isTechToken(w), w);
    for (const w of ['design', 'route', 'dashboard', 'landing', '', null, undefined]) assert.ok(!isTechToken(w), String(w));
  });

  test('isWeakMatch: true for empty / non-array / all-noise, false once one token carries signal', () => {
    assert.equal(isWeakMatch([]), true);
    assert.equal(isWeakMatch(null), true);
    assert.equal(isWeakMatch(undefined), true);
    assert.equal(isWeakMatch('file'), true, 'non-array is treated as nothing matched');
    assert.equal(isWeakMatch(['file']), true);
    assert.equal(isWeakMatch(['files', 'Functions', 'building', 'fixed']), true, 'stemmed/cased forms');
    assert.equal(isWeakMatch(['claude', 'code']), true);
    assert.equal(isWeakMatch(['pull', 'requests']), true);
    assert.equal(isWeakMatch([null, '']), true, 'blank entries are ignored');
    assert.equal(isWeakMatch([null, '', 7]), false, 'a non-blank non-string entry is stringified and counts as signal');
    assert.equal(isWeakMatch(['file', 'stripe']), false);
    assert.equal(isWeakMatch(['landing']), false);
    assert.equal(isWeakMatch(['e2e']), false);
  });
});

// ---------------------------------------------------------------------------
// scoreSkills
// ---------------------------------------------------------------------------
describe('scoreSkills', () => {
  const LANDING = { name: 'landing-kit', description: 'Helps you build a landing page fast and cheap.' };
  const SCATTERED = { name: 'scattered', description: 'landing cheap page build fast' };
  const ONE_PHRASE = { name: 'one-phrase', description: 'landing page cheap build fast' };

  test('input guards: empty prompt, stopword-only prompt, non-array / empty skills, max <= 0', () => {
    assert.deepEqual(scoreSkills('', [LANDING]), []);
    assert.deepEqual(scoreSkills('the a of', [LANDING]), []);
    assert.deepEqual(scoreSkills(null, [LANDING]), []);
    assert.deepEqual(scoreSkills('landing', []), []);
    assert.deepEqual(scoreSkills('landing', null), []);
    assert.deepEqual(scoreSkills('landing', 'landing'), []);
    assert.deepEqual(scoreSkills('landing page', [LANDING], { max: 0 }), []);
    assert.deepEqual(scoreSkills('landing page', [LANDING], { max: -3 }), []);
  });

  test('result shape: {skill, score (3 decimals), matched (surface forms), nameMatched}; sorted desc; thresholded', () => {
    const r = scoreSkills('Build a landing page', [LANDING, SCATTERED, ONE_PHRASE], { max: 10, minScore: 0 });
    assert.equal(r.length, 3);
    for (const m of r) {
      assert.ok(m.skill && typeof m.score === 'number');
      assert.equal(Math.round(m.score * 1000) / 1000, m.score, 'rounded to 3 decimals');
      assert.deepEqual(m.matched, ['build', 'landing', 'page']);
      assert.ok(Array.isArray(m.nameMatched));
    }
    for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].score >= r[i].score);
    assert.equal(r[0].skill, LANDING);
    assert.deepEqual(r[0].nameMatched, ['landing']);
    assert.deepEqual(r[1].nameMatched, []);
    const strict = scoreSkills('Build a landing page', [LANDING, SCATTERED, ONE_PHRASE], { minScore: r[0].score - 0.001 }); // scores are rounded after the threshold
    assert.deepEqual(names(strict), ['landing-kit']);
    assert.equal(scoreSkills('Build a landing page', [LANDING, SCATTERED, ONE_PHRASE], { max: 2, minScore: 0 }).length, 2);
    assert.equal(scoreSkills('Build a landing page', [LANDING, SCATTERED, ONE_PHRASE], { minScore: 1e9 }).length, 0);
  });

  test('defaults: max 3, minScore 1.5', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, description: 'landing page' }));
    assert.equal(scoreSkills('landing page', many).length, 3);
    const weak = { name: 'w', description: 'build things' };
    assert.deepEqual(scoreSkills('build', [weak]), [], 'a generic verb alone (0.4 weight) stays below 1.5');
    assert.equal(scoreSkills('build', [weak], { minScore: 0 }).length, 1);
    assert.equal(scoreSkills('stripe', [{ name: 'w', description: 'stripe things' }]).length, 1, 'a content word alone clears 1.5');
  });

  test('phrase boost: x(1 + phrases), capped at two phrases (x3), exact bigrams only', () => {
    const r = scoreSkills('build landing page fast', [LANDING, SCATTERED, ONE_PHRASE], { max: 10, minScore: 0 });
    const by = Object.fromEntries(r.map((m) => [m.skill.name, m.score]));
    // same tokens, same length: only the phrase multiplier differs.
    // landing-kit has the name token "landing" on top, so compare the two description-only docs.
    assert.ok(Math.abs(by['one-phrase'] / by.scattered - 2) < 0.01, `one phrase x2: ${by['one-phrase']} vs ${by.scattered}`);
    const three = { name: 'three', description: 'build landing page fast cheap' }; // 3 shared bigrams
    const r2 = scoreSkills('build landing page fast', [three, SCATTERED], { minScore: 0 });
    const b2 = Object.fromEntries(r2.map((m) => [m.skill.name, m.score]));
    assert.ok(Math.abs(b2.three / b2.scattered - 3) < 0.01, `capped at x3: ${b2.three} vs ${b2.scattered}`);
  });

  test('a bigram made only of routing noise gets no phrase boost', () => {
    const doc = { name: 'x', description: 'open a pull request for claude code' };
    assert.equal(scoreSkills('pull request', [doc], { minScore: 0 })[0].score, scoreSkills('request pull', [doc], { minScore: 0 })[0].score);
    assert.equal(scoreSkills('claude code', [doc], { minScore: 0 })[0].score, scoreSkills('code claude', [doc], { minScore: 0 })[0].score);
    // "review" is on the stoplist too, so "code review" is all noise as well
    const rev = { name: 'y', description: 'does code review well' };
    assert.equal(scoreSkills('code review', [rev], { minScore: 0 })[0].score, scoreSkills('review code', [rev], { minScore: 0 })[0].score);
    // but a half-noise bigram ("code dashboard") still counts
    const dash = { name: 'z', description: 'ships a code dashboard' };
    assert.ok(scoreSkills('code dashboard', [dash], { minScore: 0 })[0].score > scoreSkills('dashboard code', [dash], { minScore: 0 })[0].score * 1.9);
  });

  test('name tokens weigh x3: name-only hit beats description-only hit; alias / frontmatter name count as name', () => {
    const nameHit = { name: 'stripe', description: 'payments helper' };
    const descHit = { name: 'payments-helper', description: 'uses stripe' };
    const r = scoreSkills('stripe', [descHit, nameHit], { minScore: 0 });
    assert.equal(r[0].skill, nameHit);
    assert.ok(r[0].score > r[1].score * 2);
    const aliased = { name: 'x', frontmatterName: 'vercel-react-best-practices', aliases: ['vercel-react-best-practices'], description: 'nothing here' };
    const a = scoreSkills('vercel react best practices', [aliased], { minScore: 0 })[0];
    assert.deepEqual(a.nameMatched, ['vercel', 'react', 'practices'], '"best" is a stopword');
    const noAliases = { name: 'x', aliases: 'not-an-array', description: 'nothing here' };
    assert.deepEqual(scoreSkills('vercel', [noAliases], { minScore: 0 }), [], 'non-array aliases are ignored');
  });

  test('whenToUse and pluginName are part of the description text', () => {
    const w = { name: 'x', description: 'nothing', whenToUse: 'use for terraform modules' };
    assert.deepEqual(scoreSkills('terraform', [w], { minScore: 0 })[0].matched, ['terraform']);
    const p = { name: 'x', description: 'nothing', pluginName: 'supabase' };
    assert.deepEqual(scoreSkills('supabase', [p], { minScore: 0 })[0].matched, ['supabase']);
    const n = { name: 'x', description: null, whenToUse: null, pluginName: undefined };
    assert.deepEqual(scoreSkills('supabase', [n], { minScore: 0 }), []);
  });

  test('generic verbs are down-weighted (0.4) whether matched by stem or by surface form', () => {
    for (const w of ['build', 'wrote', 'configured', 'refactoring']) {
      const doc = { name: 'x', description: `${w} things` };
      const generic = scoreSkills(w, [doc], { minScore: 0 })[0].score;
      const content = scoreSkills('stripe', [{ name: 'x', description: 'stripe things' }], { minScore: 0 })[0].score;
      assert.ok(Math.abs(generic / content - 0.4) < 0.01, `${w}: ${generic} vs ${content}`);
    }
  });

  test('idf: a term shared by every skill is worth less than a rare one; a one-skill corpus still matches', () => {
    const docs = [
      { name: 'a', description: 'common rare' },
      { name: 'b', description: 'common' },
      { name: 'c', description: 'common' },
      { name: 'd', description: 'common' },
    ];
    const rare = scoreSkills('rare', docs, { minScore: 0 })[0].score;
    const common = scoreSkills('common', docs, { minScore: 0 })[0].score;
    assert.ok(rare > common, `${rare} > ${common}`);
    assert.equal(scoreSkills('rare', [docs[0]]).length, 1, 'PSEUDO_DOCS smoothing keeps a 1-doc idf positive');
  });

  test('ties are broken by skill name (localeCompare), score desc first', () => {
    const z = { name: 'zeta', description: 'terraform modules' };
    const a = { name: 'alpha', description: 'terraform modules' };
    assert.deepEqual(names(scoreSkills('terraform', [z, a], { minScore: 0 })), ['alpha', 'zeta']);
  });

  test('matched carries the first surface form per stem; repeated prompt words count once', () => {
    const doc = { name: 'x', description: 'deploy deployment deployed' };
    const r = scoreSkills('Deploying deployed deploy', [doc], { minScore: 0 })[0];
    assert.deepEqual(r.matched, ['deploying']);
  });

  test('skills that are not objects never throw and never match', () => {
    assert.deepEqual(scoreSkills('alpha', ['alpha', 5, true], { minScore: 0 }), []);
  });

  test('per-object doc cache: a skill object is tokenized once (mutating it afterwards is not seen)', () => {
    const doc = { name: 'x', description: 'terraform' };
    const before = scoreSkills('terraform', [doc], { minScore: 0 })[0].score;
    doc.description = 'nothing at all';
    assert.equal(scoreSkills('terraform', [doc], { minScore: 0 })[0].score, before);
    const fresh = { ...doc };
    assert.deepEqual(scoreSkills('terraform', [fresh], { minScore: 0 }), []);
  });
});

// ---------------------------------------------------------------------------
// extractKeywords / shareableKeywords
// ---------------------------------------------------------------------------
describe('extractKeywords', () => {
  test('tech nouns first (count then position), then content words; generic verbs only fill in', () => {
    assert.deepEqual(extractKeywords('alpha alpha alpha react'), ['react', 'alpha']);
    assert.deepEqual(extractKeywords('nextjs and tailwind for a landing page'), ['nextjs', 'tailwind', 'landing', 'page']);
    assert.deepEqual(extractKeywords('tailwind nextjs tailwind'), ['tailwind', 'nextjs']);
    assert.deepEqual(extractKeywords('fix the bug'), ['bug', 'fix'], 'one content word: a generic verb fills in');
    assert.deepEqual(extractKeywords('build build create'), ['build', 'create'], 'no content words: generics by count');
    assert.deepEqual(extractKeywords('fix the bug', { max: 1 }), ['bug'], 'max is honoured before filling');
    assert.deepEqual(extractKeywords('alpha beta gamma delta epsilon zeta'), ['alpha', 'beta', 'gamma', 'delta'], 'default max 4');
    assert.deepEqual(extractKeywords('alpha', { max: 0 }), []);
    assert.deepEqual(extractKeywords('', { max: 4 }), []);
    assert.deepEqual(extractKeywords(null), []);
  });

  test('returns alias-normalised surface forms, not stems', () => {
    assert.deepEqual(extractKeywords('pg queries on k8s'), ['postgres', 'kubernetes', 'queries']);
    assert.deepEqual(extractKeywords('Deploying deployed'), ['deploying'], 'grouped by stem, first surface form wins');
    assert.deepEqual(extractKeywords('Deploying deployments'), ['deploying', 'deployments'], 'deploy and deployment are different stems');
  });
});

describe('shareableKeywords (lib/registry.js): the only prompt words that may leave the machine', () => {
  test('tech-lexicon words only, at most MAX_KEYWORD_SEARCHES, deduped, case-folded', () => {
    assert.equal(MAX_KEYWORD_SEARCHES, 2);
    assert.deepEqual(shareableKeywords(['stripe', 'rotate', 'acmecorp', 'production']), ['stripe']);
    assert.deepEqual(shareableKeywords(['nextjs', 'tailwind', 'react']), ['nextjs', 'tailwind']);
    assert.deepEqual(shareableKeywords(['nextjs', 'tailwind', 'react'], 3), ['nextjs', 'tailwind', 'react']);
    assert.deepEqual(shareableKeywords(['React', ' react ', 'REACT']), ['react']);
    assert.deepEqual(shareableKeywords(['Contoso', 'vault', 'friday', 'con', 'crea']), []);
    assert.deepEqual(shareableKeywords([]), []);
    assert.deepEqual(shareableKeywords(null), []);
    assert.deepEqual(shareableKeywords(undefined), []);
  });
});

// ---------------------------------------------------------------------------
// expandIntent
// ---------------------------------------------------------------------------
describe('expandIntent', () => {
  test('one representative trigger per lexicon row', () => {
    const rows = [
      ['build a landing page', ['frontend', 'design', 'web', 'ui']],
      ['a flaky spec', ['testing', 'tests', 'webapp']],
      ['surgical cleanup', ['coding', 'guidelines', 'best', 'practices']],
      ['stripe checkout', ['stripe', 'payments', 'billing']],
      ['pandas dataframe', ['data', 'analysis', 'visualization', 'statistical']],
      ['an mcp server', ['mcp', 'builder', 'agent', 'development']],
      ['hosting it', ['deploy', 'deployment']],
      ['a pptx presentation', ['document']],
      ['react component composition', ['react', 'best', 'practices']],
    ];
    for (const [prompt, terms] of rows) assert.deepEqual(expandIntent(prompt), terms, prompt);
  });

  test('triggers match the surface form or the stem; terms are deduped in first-seen order', () => {
    assert.deepEqual(expandIntent('simplifying charts'), ['coding', 'guidelines', 'best', 'practices', 'data', 'analysis', 'visualization', 'statistical']);
    assert.deepEqual(expandIntent('deploying subagents'), ['deploy', 'deployment', 'mcp', 'builder', 'agent', 'development']);
    assert.deepEqual(expandIntent('deploy the landing page with stripe'), ['deploy', 'deployment', 'frontend', 'design', 'web', 'ui', 'stripe', 'payments', 'billing']);
    assert.deepEqual(expandIntent('landing landing hero hero'), ['frontend', 'design', 'web', 'ui']);
  });

  test('behavioural rule: an action verb without any tech noun adds the coding-guidelines terms once', () => {
    assert.deepEqual(expandIntent('fix this and keep it simple'), ['coding', 'guidelines', 'best', 'practices']);
    assert.deepEqual(expandIntent('rewrite this function'), ['coding', 'guidelines', 'best', 'practices']);
    assert.deepEqual(expandIntent('implement it'), ['coding', 'guidelines', 'best', 'practices']);
    assert.deepEqual(expandIntent('refactor this module'), ['coding', 'guidelines', 'best', 'practices'], 'refactor row + behavioural rule -> no duplicates');
    assert.deepEqual(expandIntent('fix the stripe webhook'), ['stripe', 'payments', 'billing'], 'a tech noun switches the behavioural rule off');
    assert.deepEqual(expandIntent('update the nextjs config'), []);
    assert.deepEqual(expandIntent('hello world'), []);
    assert.deepEqual(expandIntent(''), []);
    assert.deepEqual(expandIntent(null), []);
  });
});

// ---------------------------------------------------------------------------
// Prompt-class matrix against the real 168-skill snapshot
// ---------------------------------------------------------------------------
describe('prompt-class matrix (index.snapshot.json, 168 skills): the routing decision per prompt class', () => {
  const CFG = { mode: 'suggest', minPromptChars: 40 };
  // What the hook does with a prompt: normalize, maybe skip, score, hide weak matches, list 3, decide
  // whether a strong local match suppresses discovery, and which words may be searched on skills.sh.
  const route = (raw) => {
    const clean = normalizePrompt(raw);
    const skipped = skipReason(clean, CFG, raw);
    const scored = scoreSkills(clean, SNAPSHOT, { max: 6, minScore: 1.5 });
    const shown = scored.filter((m) => !isWeakMatch(m.matched)).slice(0, 3);
    const kw = extractKeywords(clean);
    return { clean, skipped, scored, shown, strong: shown.some(isStrongMatch), kw, shared: shareableKeywords(kw), intent: expandIntent(clean) };
  };
  const find = (list, name) => list.find((m) => m.skill.invocableName === name);

  test('snapshot sanity', () => {
    assert.equal(SNAPSHOT.length, 168);
    assert.ok(SNAPSHOT.every((s) => typeof s.invocableName === 'string' && typeof s.description === 'string'));
    assert.equal(STRONG_LOCAL_SCORE, 10);
    assert.equal(STRONG_SINGLE_NAME_SCORE, 20);
    assert.ok(NAME_GENERIC.has('design') && NAME_GENERIC.has('route'));
  });

  test('research question: listed but nothing strong, nothing shared, discovery runs', () => {
    const r = route('Research the current state of WebAssembly component model adoption and summarize the main runtimes and their tradeoffs');
    assert.equal(r.skipped, null);
    assert.ok(inv(r.shown).includes('anthropic-skills:deep-research'), inv(r.shown).join(','));
    assert.equal(r.strong, false, 'single name token "research" (< 20) is never strong');
    assert.deepEqual(r.shared, [], 'webassembly / runtimes are not lexicon words: nothing leaves the machine');
  });

  test('factual question: only faint matches (< STRONG_LOCAL_SCORE), nothing shared', () => {
    const r = route('What is the difference between a process and a thread, and when does a thread switch cost more than a process switch?');
    assert.equal(r.skipped, null);
    assert.ok(r.scored.every((m) => m.score < STRONG_LOCAL_SCORE), JSON.stringify(r.scored.map((m) => [m.skill.invocableName, m.score])));
    assert.equal(r.strong, false);
    assert.deepEqual(r.shared, []);
    assert.deepEqual(r.intent, []);
  });

  test('coding: /api/health route in a nextjs app -> vercel:nextjs strong; routing-middleware listed but never strong', () => {
    const r = route('add a /api/health route to this nextjs app that returns the git sha and uptime as json');
    assert.equal(r.skipped, null, 'a slash inside the prompt is not a slash command');
    assert.equal(r.shown[0].skill.invocableName, 'vercel:nextjs');
    assert.equal(isStrongMatch(r.shown[0]), true);
    const rm = find(r.scored, 'vercel:routing-middleware');
    assert.ok(rm && rm.score > STRONG_LOCAL_SCORE, 'routing-middleware scores above the bar on "route" alone');
    assert.equal(isStrongMatch(rm), false, '"route" is NAME_GENERIC');
    assert.deepEqual(r.shared, ['api', 'nextjs']);
  });

  test('design: pricing page with tailwind -> figma-generate-design first, system-design never strong, "page"-only matches hidden', () => {
    const r = route('design a pricing page with three tiers, a toggle for monthly/yearly billing and a comparison table, tailwind please');
    assert.equal(r.shown[0].skill.invocableName, 'figma:figma-generate-design');
    assert.ok(!inv(r.shown).includes('superset:page'), '"page" alone is weak');
    const sd = find(r.scored, 'engineering:system-design');
    assert.ok(sd && sd.score > STRONG_LOCAL_SCORE);
    assert.equal(isStrongMatch(sd), false);
    assert.equal(r.strong, false, 'discovery runs');
    assert.deepEqual(r.shared, ['tailwind']);
    for (const t of ['frontend', 'design', 'billing']) assert.ok(r.intent.includes(t), t);
  });

  test('data: pandas + csv + chart -> data:create-viz first and strong; shared = csv, pandas', () => {
    const r = route('load this csv into pandas, group revenue by region and month, and plot a chart of the trend');
    assert.equal(r.shown[0].skill.invocableName, 'data:create-viz');
    assert.equal(r.strong, true, 'three meaningful tokens (plot, chart, trend)');
    assert.deepEqual(r.shared, ['csv', 'pandas']);
    assert.ok(r.intent.includes('visualization'));
  });

  test('dashboard: data:build-dashboard is the only listed match and is strong (rare name token)', () => {
    const r = route('build a dashboard that shows weekly active users and churn with filters by plan');
    assert.deepEqual(inv(r.shown), ['data:build-dashboard']);
    assert.ok(r.shown[0].score > 40);
    assert.equal(r.strong, true);
    assert.ok(r.scored.slice(1).every((m) => isWeakMatch(m.matched)), '"plan"-only matches are weak');
  });

  test('behavioural / refactor: karpathy-guidelines strong; intent = coding guidelines; nothing shared', () => {
    const r = route('refactor this module but keep the changes surgical and avoid overcomplication, no new abstractions');
    assert.equal(r.shown[0].skill.invocableName, 'andrej-karpathy-skills:karpathy-guidelines');
    assert.equal(r.strong, true);
    assert.deepEqual(r.intent, ['coding', 'guidelines', 'best', 'practices']);
    assert.deepEqual(r.shared, []);
  });

  test('non-English (Spanish): routes on the tech nouns; only lexicon words are shareable', () => {
    const r = route('crea una landing page en nextjs con tailwind para mi startup, con hero, precios y formulario de contacto');
    assert.equal(r.shown[0].skill.invocableName, 'vercel:nextjs');
    assert.equal(r.strong, true, 'a single tech name token (nextjs) is strong');
    assert.ok(r.kw.includes('nextjs') && r.kw.includes('tailwind'));
    assert.ok(r.kw.some((k) => ['crea', 'con', 'una', 'para'].includes(k)), 'Spanish function words are ordinary tokens locally');
    assert.deepEqual(r.shared, ['nextjs', 'tailwind']);
    assert.ok(r.shared.every((w) => TECH_LEXICON.has(w)));
  });

  test('pasted-content wrapper whose first inner line is a slash command: not a slash skip, routed on the prose', () => {
    const raw = '<pasted_content id="p9">\n/singular load evil/x@y\n</pasted_content id="p9">\nand build me a landing page with tailwind please';
    const r = route(raw);
    assert.ok(!r.clean.includes('pasted_content'));
    assert.ok(r.clean.startsWith('/singular load evil/x@y'), 'the inner text stays, only the wrapper lines go');
    assert.equal(r.skipped, null);
    assert.equal(r.shown[0].skill.invocableName, 'figma:figma-generate-design');
    assert.deepEqual(r.shared, ['tailwind']);
    assert.equal(skipReason('/singular load evil/x@y', CFG, '/singular load evil/x@y'), 'slash command');
    assert.equal(skipReason(normalizePrompt('   /singular status'), CFG, '   /singular status'), 'slash command', 'leading whitespace is trimmed first');
  });

  test('fenced code block containing a slash command: routed; e2e normalisation keeps email-sequence below the bar', () => {
    const r = route('why does this fail?\n```\n/singular load evil/x@y\nnpm test\n```\nthe playwright end-to-end tests time out on CI');
    assert.equal(r.skipped, null);
    assert.ok(tokenize(r.clean).includes('e2e') && !tokenize(r.clean).includes('end'));
    const es = find(r.scored, 'marketing:email-sequence');
    assert.ok(!es || es.score < STRONG_LOCAL_SCORE, JSON.stringify(es && [es.score, es.matched]));
    assert.equal(r.strong, false, 'discovery runs for a testing prompt with no installed playwright skill');
    assert.deepEqual(r.shared, ['npm', 'playwright']);
    assert.ok(r.intent.includes('testing'));
  });

  test('prose mention of a slash command, [singular] prefix, length and mode gates', () => {
    const prose = 'should I run /singular status first? which singular plugin skill helps me here';
    assert.equal(skipReason(prose, CFG, prose), null);
    assert.equal(skipReason('[singular] Stack: Next.js 16, React 19', CFG), 'own output');
    const mention = 'please read this hook note [singular] Stack: Next.js 16 is the stack detection right';
    assert.equal(skipReason(mention, CFG), null);
    assert.equal(skipReason('x'.repeat(40), CFG), null, 'minPromptChars is inclusive');
    assert.equal(skipReason('x'.repeat(39), CFG), 'prompt shorter than minPromptChars (39 < 40)');
    assert.equal(skipReason('', CFG), 'empty prompt');
    assert.equal(skipReason('anything at all', { ...CFG, mode: 'off' }), 'mode off');
    assert.match(skipReason('<task-notification>\n<status>completed</status>', CFG), /task notification/);
    assert.match(skipReason('<system-reminder>be nice</system-reminder>', CFG), /system reminder/);
  });

  test('"Claude Code hooks" and "terraform ... rules": only noise matches -> nothing listed, discovery runs', () => {
    const hooks = route('how do I configure Claude Code hooks to run prettier after every file edit in this repo');
    assert.deepEqual(inv(hooks.shown), []);
    assert.equal(hooks.strong, false);
    const vb = find(hooks.scored, 'claude-mem:version-bump');
    assert.ok(!vb || isWeakMatch(vb.matched), 'version-bump may score, but only on noise');
    const tf = route('write a terraform module for an s3 bucket with versioning and lifecycle rules');
    assert.deepEqual(inv(tf.shown), []);
    assert.deepEqual(tf.shared, ['terraform', 's3']);
  });

  test('document / payments: pdf and stripe prompts land on the obvious skills and are strong', () => {
    const pdf = route('merge these two pdf files and rotate the pages of the second one before combining');
    assert.equal(pdf.shown[0].skill.invocableName, 'anthropic-skills:pdf');
    assert.ok(pdf.shown[0].score > 100);
    assert.equal(pdf.strong, true);
    assert.deepEqual(pdf.intent, ['document']);
    const stripe = route('add stripe checkout with a subscription plan and webhooks for payment failures');
    assert.equal(stripe.shown[0].skill.invocableName, 'vercel:marketplace');
    assert.equal(stripe.strong, true);
    assert.deepEqual(stripe.shared, ['stripe', 'webhooks']);
    for (const t of ['stripe', 'payments', 'billing']) assert.ok(stripe.intent.includes(t), t);
  });

  test('12,000-char prompt: same routing as its first sentence, well under the hook budget', () => {
    const head = 'Please help me build a landing page in nextjs with tailwind. ';
    const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. ';
    const big = (head + filler.repeat(10)).repeat(14).slice(0, 12000);
    assert.ok(big.length >= 11_000 && big.length <= 12_000);
    const t0 = performance.now();
    const r = route(big);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `routing a 12k prompt took ${ms.toFixed(1)} ms`);
    assert.equal(r.skipped, null);
    assert.deepEqual(inv(r.shown).slice(0, 2), inv(route(head).shown).slice(0, 2));
    assert.deepEqual(r.shared, ['nextjs', 'tailwind']);
  });
});
