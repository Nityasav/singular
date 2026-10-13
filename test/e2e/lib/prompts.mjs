// test/e2e/lib/prompts.mjs — prompts shared by the cases. Every live prompt tells the model not to use tools
// (keeps haiku runs at one turn and under a cent) unless the case is about tools.

export const STACK_ECHO = 'Reply with exactly one line: the full text of the line in your context that begins with [singular] Stack: (or the word NONE if there is no such line). Do not use any tools.';

export const PLAYWRIGHT = 'write playwright e2e tests for the checkout flow in this app. Do not write files or use tools; just outline the test plan in 3 bullets.';
export const PRICING = 'design a pricing page with three tiers and a comparison table for our saas product. Do not use any tools; answer in three bullets.';

export const PROMPT_CLASSES = Object.freeze([
  { id: 'research', prompt: 'research the tradeoffs between server components and client components in nextjs and summarize the main points. Do not use any tools; answer in two sentences.' },
  { id: 'question', prompt: 'what does the useEffect cleanup function do in react and when does it run? Do not use any tools; answer in one sentence.' },
  { id: 'coding', prompt: 'write a typescript function that debounces another function with a configurable delay. Do not use any tools; answer with the code only.' },
  { id: 'design', prompt: PRICING },
  { id: 'data', prompt: 'clean up this pandas dataframe, drop nulls and plot the distribution of each column. Do not use any tools; answer in three bullets.' },
  { id: 'non-english', prompt: 'crea una landing page en nextjs con tailwind y una tabla de precios. No uses herramientas; responde en una frase.' },
]);

/** Pad or trim a sentence to exactly n characters (words first, then dots). */
export function exactly(base, n) {
  let s = String(base);
  if (s.length > n) return s.slice(0, n);
  while (s.length < n) s += s.length === n - 1 ? '.' : s.length % 7 === 0 ? ' ' : 'x';
  return s;
}

export function longPrompt(chars = 12000) {
  const head = 'Summarize the following meeting notes in one sentence. Do not use any tools.\n\n';
  const para = 'We discussed the migration of the checkout service, the playwright suite that guards it, the nextjs upgrade on the marketing site, and the tailwind token cleanup; the team agreed to keep changes surgical and to pin every third-party dependency before the release train leaves on friday. ';
  let body = '';
  while (head.length + body.length < chars) body += para;
  return (head + body).slice(0, chars);
}

export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(#[0-9a-f]{40})?@[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function seamEnv({ registry, gitBase } = {}) {
  const env = {};
  if (registry) env.SINGULAR_REGISTRY_BASE = registry.base;
  if (gitBase) env.SINGULAR_GIT_BASE = gitBase.base;
  return env;
}

/** Every `/singular load <ref>` mentioned in a text (the literal `<ref>` placeholder of the relay instruction excluded). */
export function loadRefs(text) {
  return [...String(text ?? '').matchAll(/\/singular load\s+(\S+)/g)].map((m) => m[1].replace(/[;,.)`]+$/, '')).filter((r) => !r.startsWith('<'));
}
