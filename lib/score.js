// lib/score.js — lexical routing of a prompt to installed skills. Zero dependencies.
//
// tokenize()        lowercase, split on non-alphanumerics, drop stopwords and 1-char tokens, light stemming
// scoreSkills()     BM25-lite over name (x3) + description, exact multi-word phrase boost, thresholded
// extractKeywords() top prompt tokens for a registry query, tech nouns first, generic verbs last
// expandIntent()    small intent lexicon: "landing page / pricing / tailwind" -> "frontend design", etc.
// isWeakMatch()     true when every matched token is a hyper-common routing word (file, function, build, ...)

export const STOPWORDS = new Set((
  'a an the and or but nor so yet for of to in on at by from with without into onto over under about ' +
  'above below between through during before after again further then once here there when where why how ' +
  'all any both each every few more most other some such no none not only own same than too very just also ever ' +
  'is are was were be been being am do does did doing done have has had having ' +
  'i me my mine myself we us our ours ourselves you your yours yourself yourselves he him his himself ' +
  'she her hers herself it its itself they them their theirs themselves this that these those what which ' +
  'who whom whose ' +
  'can could may might must shall should will would ought ' +
  'if unless while as until because although though whether either neither ' +
  'up down out off away back around off in out ' +
  'please thanks thank hey hi hello ok okay yes no yeah nope help helps helped helping ' +
  'want wants wanted need needs needed like likes liked make makes made making use uses used using get gets ' +
  'got getting let lets know knows thing things stuff something anything everything nothing someone anyone ' +
  'everyone one ones way ways kind kinds sort sorts lot lots bit bits able re ' +
  'two three four five six seven eight nine ten ' +
  'dont doesnt didnt isnt arent wasnt werent cant cannot couldnt wont wouldnt shouldnt im ive youre ' +
  'youve thats whats heres theres lets ill well ahead ' +
  'now then also still already always never sometimes often usually really quite rather pretty much many ' +
  'new old good bad best better right wrong first last next previous current currently ' +
  'here there where everywhere somewhere ' +
  'go going goes went gone come comes came coming ' +
  'see sees seen saw look looks looked looking take takes took taken give gives gave given ' +
  'say says said tell tells told ask asks asked ' +
  'try tries tried trying put puts keep keeps kept ' +
  'etc eg ie via per vs'
).split(/\s+/).filter(Boolean));

// Tech nouns are never stemmed and are preferred by extractKeywords().
export const TECH_LEXICON = new Set((
  'react nextjs nodejs node vue nuxt svelte sveltekit astro remix angular solidjs qwik preact ember ' +
  'htmx alpinejs ' +
  'tailwind tailwindcss css scss sass postcss shadcn radix mui chakra bootstrap bulma html ' +
  'javascript typescript js ts jsx tsx wasm ' +
  'python django flask fastapi pydantic sqlalchemy celery jupyter pandas numpy scipy sklearn pytorch ' +
  'tensorflow keras cuda ' +
  'rust cargo tokio go golang gin java spring kotlin swift swiftui objc csharp dotnet fsharp ruby rails ' +
  'php laravel symfony elixir phoenix erlang scala haskell ocaml clojure lua perl dart flutter expo ' +
  'ios android macos linux windows electron tauri capacitor ' +
  'postgres postgresql mysql mariadb sqlite mongodb mongo redis memcached dynamodb cassandra elasticsearch ' +
  'opensearch clickhouse duckdb snowflake bigquery redshift databricks dbt kafka rabbitmq nats ' +
  'prisma drizzle typeorm sequelize knex kysely mongoose supabase firebase firestore convex planetscale neon ' +
  'turso upstash cockroachdb ' +
  'graphql trpc grpc openapi swagger websocket websockets sse webhook webhooks oauth oidc jwt saml ' +
  'stripe paddle lemonsqueezy paypal braintree plaid twilio sendgrid resend postmark mailgun ' +
  'auth auth0 clerk cognito okta ' +
  'playwright cypress puppeteer selenium jest vitest mocha jasmine pytest rspec junit storybook msw ' +
  'docker dockerfile kubernetes k8s helm terraform pulumi ansible nix vagrant ' +
  'aws gcp azure vercel netlify cloudflare heroku railway lambda s3 ec2 ecs eks gke ' +
  'github gitlab bitbucket git ci cicd jenkins circleci ' +
  'nginx caddy apache traefik envoy ' +
  'openai anthropic claude gpt llm llms langchain llamaindex rag embed mcp agent agents ' +
  'pdf docx xlsx pptx csv json yaml toml xml markdown mdx latex ' +
  'figma sketch canva ' +
  'seo a11y accessibility i18n l10n analytics ' +
  'tanstack zod vite webpack esbuild rollup turbopack parcel babel swc pnpm npm yarn bun deno ' +
  'eslint prettier biome ' +
  'sentry datadog grafana prometheus opentelemetry otel loki ' +
  'threejs webgl webgpu d3 recharts chartjs plotly matplotlib seaborn ' +
  'ffmpeg opencv ' +
  'bash zsh shell powershell sql nosql orm api sdk cli tui ' +
  'gsap framer motion lottie ' +
  'unity unreal godot blender ' +
  'solidity ethereum web3 ' +
  'e2e ssr ssg isr spa pwa cors csp'
).split(/\s+/).filter(Boolean));

// Spellings collapsed to a canonical lexicon term (applied to both prompt and skill text).
export const TECH_ALIASES = Object.freeze({
  tailwindcss: 'tailwind',
  postgresql: 'postgres',
  pg: 'postgres',
  k8s: 'kubernetes',
  golang: 'go',
  reactjs: 'react',
  vuejs: 'vue',
  sveltejs: 'svelte',
  py: 'python',
  'e2e': 'e2e',
  mongo: 'mongodb',
  'web-socket': 'websocket',
  gh: 'github',
});

// Deprioritised by extractKeywords() (kept for scoring): verbs that say what, not about what.
const GENERIC_VERBS = new Set((
  'build builds building built create creates creating created make write writes writing written wrote ' +
  'add adds adding added update updates updating updated implement implements implementing implemented ' +
  'set sets setting setup run runs running ran show shows showing give ' +
  'fix fixes fixing fixed change changes changing changed edit edits editing edited modify remove removes ' +
  'removing removed delete deletes deleting deleted move moves moving moved find finds finding found ' +
  'check checks checking checked start starts starting started stop stops stopping stopped ' +
  'work works working worked improve improves improving improved generate generates generating generated ' +
  'refactor refactors refactoring refactored explain explains explaining explained ' +
  'convert converts converting converted turn turns turning turned ' +
  'configure configures configuring configured'
).split(/\s+/).filter(Boolean));

// Routing-only stoplist: a single hit on one of these must not make a skill "likely relevant"
// (measured 2026-09-24: `clean_gone` scored 17.7 for a pandas prompt via "cleans", `vercel-functions`
// 18.6 via "function", `figma-create-new-file` 11.3 via "file"). Kept for extractKeywords().
// 2026-10-07: `claude`, `code`, `plugin`, `skill`, `command`, `slash`, `hook` ... appear in a large share
// of Claude Code prompts AND in most plugin descriptions, so `claude-mem:version-bump` (46.9) routed every
// prompt that mentioned "Claude Code hooks"; `rules` / `guide` matched `writing-hookify-rules` and
// `kyc-rules` for a terraform prompt. None of them says what a prompt is about.
export const ROUTING_STOPLIST = new Set((
  'file files function functions build builds page pages test tests testing script scripts clean cleans ' +
  'module modules failure failures review reviews create new update change changes data code project ' +
  'app apps run runs start setup config configuration error errors issue issues task tasks list lists ' +
  'name names value values type types user users item items text string strings number numbers ' +
  'call calls result results output input version versions plan plans note notes docs doc document documents ' +
  'write writes read reads check checks fix fixes add adds remove removes generate generates ' +
  'implement implements refactor refactors improve improves work works ' +
  'tool tools pull request requests handler handlers flow flows link links post posts open daily weekly ' +
  'digest digests message messages send sends get gets use uses using help helps need needs want wants ' +
  'question questions answer answers way ways thing things ' +
  'claude anthropic code codes plugin plugins skill skills command commands slash hook hooks ' +
  'rule rules guide guides repo repos repository repositories'
).split(/\s+/).filter(Boolean));

/** True for tokens that carry no routing signal on their own (stoplist or generic verb, raw or stemmed). */
export function isGenericToken(t) {
  const w = String(t).toLowerCase();
  const st = stem(w);
  return ROUTING_STOPLIST.has(w) || ROUTING_STOPLIST.has(st) || GENERIC_VERBS.has(w) || GENERIC_VERBS.has(st);
}

/** True when the token (surface or stemmed form, aliases applied) is a tech-lexicon noun such as nextjs, stripe, pdf. */
export function isTechToken(t) {
  const w = String(t ?? '').toLowerCase();
  if (!w) return false;
  const alias = TECH_ALIASES[w] ?? w;
  return TECH_LEXICON.has(w) || TECH_LEXICON.has(alias) || TECH_LEXICON.has(stem(w));
}

let NOISE_STEMS = null;
/** Stemmed forms of the routing stoplist + generic verbs (computed lazily: stem() needs its cache initialised). */
function noiseStems() {
  if (!NOISE_STEMS) {
    NOISE_STEMS = new Set();
    for (const w of [...ROUTING_STOPLIST, ...GENERIC_VERBS]) {
      NOISE_STEMS.add(w);
      NOISE_STEMS.add(stem(w));
    }
  }
  return NOISE_STEMS;
}

// Intent lexicon: prompt stems -> extra query terms so a prompt reaches skills that are *named* after the
// task ("landing page" -> frontend-design, "flaky e2e" -> webapp-testing, "surgical refactor" -> guidelines).
// Only used for third-party catalog matching; installed-skill routing is unchanged.
export const INTENT_LEXICON = Object.freeze([
  { triggers: 'landing hero pricing ui tailwind css homepage navbar responsive layout modal theme typography font animation styling stylesheet design frontend website webpage', terms: 'frontend design web ui' },
  { triggers: 'flaky e2e spec playwright cypress jest vitest coverage assertion assert mock mocks fixture fixtures regression', terms: 'testing tests webapp' },
  { triggers: 'refactor simplify simplification overengineer overengineered overengineering surgical cleanup minimal concise guideline guidelines principle principles convention conventions', terms: 'coding guidelines best practices' },
  { triggers: 'stripe payment payments checkout subscription subscriptions invoice invoices billing', terms: 'stripe payments billing' },
  { triggers: 'pandas dataframe csv plot chart charts visualization visualize statistics statistical regression', terms: 'data analysis visualization statistical' },
  { triggers: 'mcp agent agents subagent subagents', terms: 'mcp builder agent development' },
  { triggers: 'deploy deployment deploying hosting host', terms: 'deploy deployment' },
  { triggers: 'pdf docx xlsx pptx spreadsheet slides presentation', terms: 'document' },
  { triggers: 'react hooks component components composition', terms: 'react best practices' },
]);
const INTENT_INDEX = new Map();
for (const entry of INTENT_LEXICON) {
  for (const t of entry.triggers.split(/\s+/)) if (t) INTENT_INDEX.set(t, entry.terms);
}
const BEHAVIOURAL_VERBS = new Set('write implement fix refactor edit change update improve rewrite'.split(' '));

const STEM_CACHE = new Map();

/** Lowercase and normalise spellings ("Next.js" -> "nextjs", "C#" -> "csharp") before splitting. */
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/\bc\+\+/g, 'cpp')
    .replace(/\bc#/g, 'csharp')
    .replace(/\bf#/g, 'fsharp')
    .replace(/(^|[^a-z0-9])\.net\b/g, '$1dotnet')
    // "end-to-end" is the lexicon term e2e; split, it leaves the noise token "end" that matched
    // marketing:email-sequence ("end", "timing") strongly enough to hide discovery (2026-10-07)
    .replace(/\bend[ \-_]?to[ \-_]?end\b/g, 'e2e')
    .replace(/\b(next|node|vue|nuxt|three|express|nest|ember|alpine|solid|svelte|react|preact)[ .\-_]?js\b/g, '$1js')
    // "go" is a stopword on its own; count it as the language only in a tech context.
    .replace(/\b(in|with|using|to|into)\s+go\b/g, '$1 golang')
    .replace(/\bgo\s+(server|service|code|module|package|program|app|api|cli|binary|project|lang|backend|microservice)\b/g, 'golang $1');
}

/** Light stemmer: plural -> singular, strip -ing / -ed, undouble, strip trailing e. Stable on both sides. */
export function stem(word) {
  const cached = STEM_CACHE.get(word);
  if (cached !== undefined) return cached;
  let w = TECH_ALIASES[word] ?? word;
  let s = w;
  if (w.length > 3 && !TECH_LEXICON.has(w) && !/\d/.test(w) && !w.endsWith('js')) {
    let stripped = false;
    if (s.endsWith('ies') && s.length > 4) { s = s.slice(0, -3) + 'y'; stripped = true; }
    else if (s.endsWith('sses')) { s = s.slice(0, -2); stripped = true; }
    else if (s.endsWith('es') && s.length > 4 && /(s|x|z|ch|sh)es$/.test(s)) { s = s.slice(0, -2); stripped = true; }
    else if (s.endsWith('s') && !/(ss|us|is|os|ys)$/.test(s)) { s = s.slice(0, -1); stripped = true; }
    if (s.endsWith('ing') && s.length >= 6 && s[s.length - 4] !== 'e') { s = s.slice(0, -3); stripped = true; }
    else if (s.endsWith('ed') && s.length >= 5 && s[s.length - 3] !== 'e') { s = s.slice(0, -2); stripped = true; }
    if (stripped && /([bdfgkmnprt])\1$/.test(s)) s = s.slice(0, -1);
    if (s.endsWith('e') && s.length >= 4 && !s.endsWith('ee')) s = s.slice(0, -1);
    if (s.length < 2) s = w;
  }
  STEM_CACHE.set(word, s);
  return s;
}

/**
 * Tokens with their surface form, in order.
 * @returns {{raw: string, stem: string}[]}
 */
export function tokenizeDetailed(text) {
  const out = [];
  const parts = normalizeText(text).split(/[^a-z0-9]+/);
  for (const p of parts) {
    if (p.length < 2 || STOPWORDS.has(p) || /^\d+$/.test(p)) continue;
    const raw = TECH_ALIASES[p] ?? p;
    out.push({ raw, stem: stem(p) });
  }
  return out;
}

/** @returns {string[]} stemmed tokens */
export function tokenize(text) {
  return tokenizeDetailed(text).map((t) => t.stem);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const K1 = 1.2;
const B = 0.5;
const NAME_WEIGHT = 3;
const PSEUDO_DOCS = 10; // smooths idf for tiny corpora so a 1-skill index can still match
const GENERIC_WEIGHT = 0.4; // "write", "build", "fix" alone must not clear minScore

function isGenericStem(stem, raw) {
  return GENERIC_VERBS.has(stem) || GENERIC_VERBS.has(raw);
}

const DOC_CACHE = new WeakMap();

function prepareDoc(skill) {
  const hit = DOC_CACHE.get(skill);
  if (hit) return hit;
  const nameText = [skill.name, skill.frontmatterName, ...(Array.isArray(skill.aliases) ? skill.aliases : [])]
    .filter(Boolean).join(' ');
  const descText = [skill.description, skill.whenToUse, skill.pluginName].filter(Boolean).join(' ');
  const nameStems = tokenize(nameText);
  const descStems = tokenize(descText);
  const tfName = new Map();
  const tfDesc = new Map();
  for (const t of nameStems) tfName.set(t, (tfName.get(t) ?? 0) + 1);
  for (const t of descStems) tfDesc.set(t, (tfDesc.get(t) ?? 0) + 1);
  const doc = { nameStems, descStems, tfName, tfDesc, len: descStems.length };
  if (skill && typeof skill === 'object') DOC_CACHE.set(skill, doc);
  return doc;
}

function saturate(tf, norm) {
  return (tf * (K1 + 1)) / (tf + K1 * norm);
}

function bigramsOf(stems) {
  const set = new Set();
  for (let i = 0; i + 1 < stems.length; i++) set.add(`${stems[i]} ${stems[i + 1]}`);
  return set;
}

/**
 * Rank installed skills against a prompt.
 * @param {string} prompt
 * @param {Array<{name: string, description?: string}>} skills
 * @param {{max?: number, minScore?: number}} [opts]
 * @returns {{skill: object, score: number, matched: string[]}[]} sorted by score desc, score >= minScore
 */
export function scoreSkills(prompt, skills, opts = {}) {
  const max = opts.max ?? 3;
  const minScore = opts.minScore ?? 1.5;
  if (!Array.isArray(skills) || skills.length === 0) return [];
  const qTokens = tokenizeDetailed(prompt);
  if (qTokens.length === 0) return [];

  const qTerms = new Map(); // stem -> first surface form
  for (const t of qTokens) if (!qTerms.has(t.stem)) qTerms.set(t.stem, t.raw);
  // Phrase boost: a bigram made only of routing noise ("claude code", "pull request", "new file") says
  // nothing about the task and must not triple a score.
  const noise = noiseStems();
  const qBigrams = new Set([...bigramsOf(qTokens.map((t) => t.stem))].filter((bg) => !bg.split(' ').every((s) => noise.has(s))));

  const docs = skills.map(prepareDoc);
  const N = docs.length;
  const avgdl = docs.reduce((a, d) => a + d.len, 0) / N || 1;

  const df = new Map();
  for (const term of qTerms.keys()) {
    let n = 0;
    for (const d of docs) if (d.tfName.has(term) || d.tfDesc.has(term)) n++;
    df.set(term, n);
  }
  const idf = (term) => {
    const n = df.get(term) ?? 0;
    return Math.log(1 + (N + PSEUDO_DOCS - n + 0.5) / (n + 0.5));
  };

  const results = [];
  for (let i = 0; i < N; i++) {
    const d = docs[i];
    const norm = 1 - B + B * (d.len / avgdl);
    let score = 0;
    const matched = [];
    const nameMatched = [];
    for (const [term, raw] of qTerms) {
      const tn = d.tfName.get(term) ?? 0;
      const td = d.tfDesc.get(term) ?? 0;
      if (!tn && !td) continue;
      const weight = isGenericStem(term, raw) ? GENERIC_WEIGHT : 1;
      score += weight * idf(term) * (NAME_WEIGHT * saturate(tn, 1) + saturate(td, norm));
      matched.push(raw);
      if (tn) nameMatched.push(raw);
    }
    if (score <= 0) continue;
    if (qBigrams.size) {
      const nameBi = bigramsOf(d.nameStems);
      const descBi = bigramsOf(d.descStems);
      let phrases = 0;
      for (const bg of qBigrams) if (nameBi.has(bg) || descBi.has(bg)) phrases++;
      if (phrases) score *= 1 + Math.min(phrases, 2);
    }
    if (score < minScore) continue;
    results.push({ skill: skills[i], score: Math.round(score * 1000) / 1000, matched, nameMatched });
  }
  results.sort((a, b) => b.score - a.score || String(a.skill.name).localeCompare(String(b.skill.name)));
  return results.slice(0, Math.max(0, max));
}

/**
 * A match is weak when every matched prompt token is a hyper-common routing word (or a generic verb):
 * one shared word such as "file" or "function" says nothing about relevance.
 * @param {string[]} matched  surface forms as returned by scoreSkills()
 */
export function isWeakMatch(matched) {
  const toks = (Array.isArray(matched) ? matched : []).map((t) => String(t ?? '').toLowerCase()).filter(Boolean);
  if (toks.length === 0) return true;
  return toks.every((t) => ROUTING_STOPLIST.has(t) || ROUTING_STOPLIST.has(stem(t)) || GENERIC_VERBS.has(t) || GENERIC_VERBS.has(stem(t)));
}

/**
 * Extra query terms implied by the prompt (intent lexicon). Behavioural prompts (an action verb and no
 * tech noun, e.g. "fix this and keep it simple") map to "coding guidelines best practices".
 * @returns {string[]} distinct terms, possibly empty
 */
export function expandIntent(prompt) {
  const toks = tokenizeDetailed(prompt);
  const out = [];
  const add = (terms) => { for (const t of String(terms).split(/\s+/)) if (t && !out.includes(t)) out.push(t); };
  let tech = false;
  let behavioural = false;
  for (const t of toks) {
    if (TECH_LEXICON.has(t.raw) || TECH_LEXICON.has(t.stem)) tech = true;
    if (BEHAVIOURAL_VERBS.has(t.raw) || BEHAVIOURAL_VERBS.has(t.stem)) behavioural = true;
    const terms = INTENT_INDEX.get(t.raw) ?? INTENT_INDEX.get(t.stem);
    if (terms) add(terms);
  }
  if (behavioural && !tech) add('coding guidelines best practices');
  return out;
}

// ---------------------------------------------------------------------------
// Keyword extraction (for registry queries)
// ---------------------------------------------------------------------------

/**
 * Top prompt tokens for a search query: tech nouns first, then content words by frequency and position;
 * generic action verbs (build, fix, add, ...) only fill in when fewer than two content words exist.
 * Returns surface forms (lowercased, spelling-normalised), not stems.
 * @param {string} prompt
 * @param {{max?: number}} [opts]
 * @returns {string[]}
 */
export function extractKeywords(prompt, opts = {}) {
  const max = opts.max ?? 4;
  if (max <= 0) return [];
  const groups = new Map(); // stem -> {raw, count, first, tech, generic}
  const toks = tokenizeDetailed(prompt);
  toks.forEach((t, idx) => {
    const g = groups.get(t.stem);
    if (g) { g.count++; return; }
    groups.set(t.stem, {
      raw: t.raw,
      count: 1,
      first: idx,
      tech: TECH_LEXICON.has(t.raw) || TECH_LEXICON.has(t.stem),
      generic: GENERIC_VERBS.has(t.raw) || GENERIC_VERBS.has(t.stem),
    });
  });
  const all = [...groups.values()];
  const rank = (a, b) => (b.tech - a.tech) || (b.count - a.count) || (a.first - b.first);
  const content = all.filter((g) => !g.generic).sort(rank);
  const generic = all.filter((g) => g.generic).sort(rank);
  const picked = content.slice(0, max);
  if (picked.length < 2) for (const g of generic) { if (picked.length >= max) break; picked.push(g); }
  return picked.map((g) => g.raw);
}
