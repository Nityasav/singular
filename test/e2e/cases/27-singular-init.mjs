// /singular init: (a) direct node from a temp copy of the Next.js fixture with the mock registry and the local git base:
// the report (Stack, Needs, Covered / Not covered against the seeded project skills, numbered #sha7 candidates, the
// Approve line) and init-plan.json in SINGULAR_HOME; (b) --apply <n> of the playwright-cli candidate into
// SINGULAR_SKILLS_DIR: INSTALLED, SKILL.md only, kickoff prompt, SKIPPED (exists) on a rerun; (c) a malicious skill under
// an allowlisted owner (the malicious fixture folder + exec bit + symlink, 2M installs) that init discovers and pins:
// --apply REJECTS it before the copy and leaves nothing behind; (d) live: `/singular init --no-remote` through
// `claude -p` runs the init command through the Bash tool, the Needs line reaches the model, no --apply is attempted.
//
// Like /singular add (case 15), the installing paths run `node bin/singular.js` directly with HOME and SINGULAR_SKILLS_DIR
// pointed at temp dirs; only the read-only --no-remote report goes through claude. PWD is set the way a shell does: every
// entrypoint resolves the project as PWD || process.cwd().
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { buildCatalog } from '../lib/catalog.mjs';
import { REF_RE, seamEnv } from '../lib/prompts.mjs';

const INIT_RE = /bin\/singular\.js"?\s+init\b/;
const STACK = 'Stack: Next.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm; branch main';
const NEEDS = 'Needs (8): next (dep), react (dep), supabase (dep), stripe (dep), tailwind (dep), vitest (dep), playwright (dep), typescript (dep)';
const CANDIDATE_LINE_RE = /^  \d+\. [A-Za-z0-9-]+\/[A-Za-z0-9._-]+(#[0-9a-f]{7})?@[A-Za-z0-9._-]+   [\d.]+[KM]? installs   audit (pass|warn|unknown|fail)   for: [a-z-]+( \(also\))?(   \(HEAD not resolved: not approvable\))?$/;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid', LC_ALL: 'C' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A case-local copy of the run's git base (every bare repo, so every other candidate still resolves) plus
 * evil-local/playwright-kit: the malicious fixture folder with an exec bit and a symlink, named so that the
 * `playwright` need finds it. Returns {base (file:// URL for SINGULAR_GIT_BASE), sha (its HEAD)}.
 */
function maliciousGitBase(ctx, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(ctx.gitBase.dir, dir, { recursive: true, filter: (src) => path.basename(src) !== '.src' });
  const src = path.join(dir, '.src-playwright-kit');
  fs.cpSync(path.join(ctx.root, 'test', 'fixtures', 'skill-folders', 'malicious'), path.join(src, 'playwright-kit'), { recursive: true });
  fs.chmodSync(path.join(src, 'playwright-kit', 'bin', 'pwn'), 0o755);
  fs.symlinkSync('../../etc/passwd', path.join(src, 'playwright-kit', 'link'));
  git(['init', '-q', '-b', 'main'], src);
  git(['add', '-A'], src);
  git(['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'fixture'], src);
  const sha = git(['rev-parse', 'HEAD'], src);
  fs.mkdirSync(path.join(dir, 'evil-local'), { recursive: true });
  git(['clone', '-q', '--bare', src, path.join(dir, 'evil-local', 'playwright-kit')], dir);
  return { base: `file://${dir}`, sha };
}

export default {
  name: '/singular init: report + plan (direct node), --apply INSTALLED / SKIPPED, REJECTED malicious candidate, live --no-remote via slash',
  tags: ['commands', 'init', 'add', 'security'],
  costCapUsd: 0.05,
  async run(ctx) {
    // ------------------------------------------------------------------ (a) report + plan
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' }, projectSkills: true });
    const fakeHome = path.join(w.base, 'fakehome');
    const skills = path.join(w.base, 'skills-dir');
    const tmp = path.join(w.base, 'tmp');
    for (const d of [fakeHome, skills, tmp]) fs.mkdirSync(d, { recursive: true });
    const env = { ...seamEnv({ registry: reg, gitBase: ctx.gitBase }), SINGULAR_HOME: w.home, HOME: fakeHome, SINGULAR_SKILLS_DIR: skills, TMPDIR: tmp, PWD: w.cwd };
    const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('singular-add-'));

    const t0 = Date.now();
    const a = await ctx.runNode('singular.js', ['init'], { env, cwd: w.cwd });
    const initMs = Date.now() - t0;
    ctx.eq(a.status, 0, 'init: exit 0');
    ctx.eq(a.stderr, '', 'init: nothing on stderr');
    const lines = a.stdout.split('\n');
    ctx.eq(lines[0], '[singular] init: cwd', 'init: header names the cwd basename');
    ctx.eq(lines[1], STACK, 'init: Stack line');
    ctx.eq(lines[2], NEEDS, 'init: Needs line (8 dependency needs, weight order, one-word reasons)');
    ctx.eq(lines[3], 'Covered by installed skills: next -> e2e-nextjs-app-router; tailwind -> e2e-tailwind-landing', 'init: the two seeded project skills cover next and tailwind (name-token hits)');
    ctx.eq(lines[4], 'Not covered: react, supabase, stripe, vitest, playwright, typescript', 'init: Not covered line');
    ctx.eq(lines[5], 'Suggested third-party skills (pinned, not installed):', 'init: candidates header');
    const candLines = lines.filter((l) => /^  \d+\. /.test(l));
    ctx.check(candLines.length >= 2 && candLines.length <= 8, 'init: between 2 and 8 numbered candidates (initMaxCandidates 8)', candLines.length);
    ctx.check(candLines.every((l) => CANDIDATE_LINE_RE.test(l)), 'init: every candidate line has the fixed shape (ref #sha7, installs, audit, for: need)', candLines);
    ctx.check(candLines.every((l, i) => l.startsWith(`  ${i + 1}. `)), 'init: candidates numbered 1..N in order', candLines);
    const cliSha = ctx.gitBase.shas['microsoft/playwright-cli'];
    const vlSha7 = ctx.gitBase.shas['vercel-labs/agent-skills'].slice(0, 7);
    const stripeSha7 = ctx.gitBase.shas['anthropics/claude-plugins-official'].slice(0, 7);
    ctx.check(candLines.some((l) => l.endsWith(`microsoft/playwright-cli#${cliSha.slice(0, 7)}@playwright-cli   61.2K installs   audit pass   for: playwright`)), 'init: playwright-cli pinned to the git base HEAD, audit pass, for playwright', candLines);
    ctx.check(candLines.some((l) => l.endsWith(`vercel-labs/agent-skills#${vlSha7}@playwright-testing   15.0K installs   audit warn   for: playwright`)), 'init: playwright-testing pinned, audit warn', candLines);
    ctx.check(candLines.some((l) => l.endsWith(`anthropics/claude-plugins-official#${stripeSha7}@stripe-best-practices   1.4K installs   audit warn   for: stripe`)), 'init: stripe-best-practices pinned, for stripe', candLines);
    ctx.excludes(a.stdout, 'evil-local', 'init: the non-allowlisted owner never appears (playwright-helper 777K / helpful-setup 999K installs)');
    ctx.excludes(a.stdout, 'playwright-flaky', 'init: 800 installs is under the install floor');
    const approve = lines.find((l) => l.startsWith('Approve: '));
    ctx.match(approve, /^Approve: \/singular init --apply \d+,\d+   \(or: all\)   Add --project to install into \.\/\.claude\/skills instead of ~\/\.claude\/skills$/, 'init: the Approve line');
    ctx.check(!/INSTALLED|REJECTED/.test(a.stdout), 'init: installs nothing');
    ctx.eq(fs.readdirSync(skills).length, 0, 'init: the skills dir is untouched');
    ctx.eq(leftovers(tmp).length, 0, 'init: no singular-add-* temp dir');

    const planFile = path.join(w.home, 'init-plan.json');
    ctx.check(fs.existsSync(planFile), 'init: init-plan.json exists in SINGULAR_HOME', w.home);
    const plan = ctx.readJson(planFile) ?? {};
    ctx.eq(plan.version, 1, 'plan: version 1');
    ctx.eq(plan.cwd, w.cwd, 'plan: made for this cwd');
    ctx.check(Number.isFinite(Date.parse(plan.createdAt)), 'plan: createdAt is a date', plan.createdAt);
    ctx.eq(plan.stack?.summary, STACK.slice('Stack: '.length), 'plan: stack summary');
    ctx.eq((plan.needs ?? []).map((n) => n.need).join(','), 'next,react,supabase,stripe,tailwind,vitest,playwright,typescript', 'plan: needs');
    ctx.eq((plan.coverage?.uncovered ?? []).join(','), 'react,supabase,stripe,vitest,playwright,typescript', 'plan: uncovered needs');
    ctx.eq((plan.candidates ?? []).length, candLines.length, 'plan: one entry per report line');
    ctx.check((plan.candidates ?? []).every((c, i) => c.n === i + 1 && REF_RE.test(c.ref) && typeof c.need === 'string'), 'plan: every candidate numbered, grammatical ref, need attached', plan.candidates);
    ctx.check((plan.candidates ?? []).every((c) => (c.approvable ? /#[0-9a-f]{40}@/.test(c.ref) && c.sha : !/#/.test(c.ref) && !c.sha)), 'plan: approvable candidates carry a 40-hex sha in the ref; unresolved ones carry none', plan.candidates);
    const unresolved = (plan.candidates ?? []).filter((c) => !c.approvable);
    ctx.check(unresolved.every((c) => candLines.some((l) => l.includes(`${c.source}@${c.skill}`) && l.endsWith('(HEAD not resolved: not approvable)'))), 'plan/report: a candidate outside the git base is listed as not approvable', unresolved);
    const s = reg.summary();
    for (const q of ['react', 'supabase', 'stripe', 'vitest', 'playwright', 'typescript']) ctx.check(s.searches.includes(q), `init: one search for the uncovered need ${q}`, s.searches);
    ctx.check(s.searches.includes('nextjs'), 'init: the top need is searched even though covered ("also")', s.searches);
    ctx.check(!s.searches.includes('tailwind'), 'init: a covered need outside the top 3 is not searched', s.searches);
    ctx.eq(s.catalogs.length, 0, 'init: no owner catalog fetch (per-need searches only)');
    ctx.check(s.audits.includes('microsoft/playwright-cli/playwright-cli'), 'init: audit consulted for playwright-cli', s.audits);
    ctx.info(`init: ${initMs} ms, ${candLines.length} candidates (${unresolved.length} unresolved), ${s.total} registry requests (${s.searches.length} searches, ${s.audits.length} audits); ${candLines.map((l) => l.trim()).join(' | ')}`);

    // ------------------------------------------------------------------ (b) --apply the playwright-cli candidate
    const cli = (plan.candidates ?? []).find((c) => c.source === 'microsoft/playwright-cli' && c.skill === 'playwright-cli');
    if (!cli) ctx.fail('no microsoft/playwright-cli@playwright-cli candidate in the plan');
    const nCand = plan.candidates.length;
    const header = (sel, k) => `[singular] init --apply ${sel}: ${k} of ${nCand} candidate${nCand === 1 ? '' : 's'} for cwd (plan from ${plan.createdAt}) -> ${skills}`;
    const b = await ctx.runNode('singular.js', ['init', '--apply', String(cli.n)], { env, cwd: w.cwd });
    ctx.eq(b.status, 0, 'apply: exit 0');
    ctx.eq(b.stderr, '', 'apply: nothing on stderr');
    const bl = b.stdout.split('\n');
    ctx.eq(bl[0], header(cli.n, 1), 'apply: header line');
    ctx.eq(bl[1], `INSTALLED ${cli.n}. microsoft/playwright-cli#${cliSha.slice(0, 7)}@playwright-cli -> ${path.join(skills, 'playwright-cli')} (audit pass)`, 'apply: INSTALLED line with the pinned ref');
    ctx.eq(bl[2], 'Installed: playwright-cli', 'apply: Installed line');
    ctx.eq(bl[3], 'Kickoff prompt (copy or say "run it"):', 'apply: kickoff header');
    ctx.eq(bl[4], '  Using the skill playwright-cli, review this Next.js 16 + React 19 project: list the 3 highest-impact improvements for playwright, then implement the first one.', 'apply: deterministic kickoff prompt naming the skill');
    ctx.check(bl[4].trim().length <= 400, 'apply: kickoff prompt <= 400 chars', bl[4].length);
    ctx.eq(bl[5], 'Reload: new skills are picked up automatically; run /reload-skills if /singular status does not list them.', 'apply: Reload line');
    ctx.eq(bl.slice(6).join('\n'), '', 'apply: nothing after the Reload line');
    ctx.eq(fs.readdirSync(skills).join(','), 'playwright-cli', 'apply: exactly one folder in the skills dir');
    ctx.eq(fs.readdirSync(path.join(skills, 'playwright-cli')).join(','), 'SKILL.md', 'apply: the folder holds SKILL.md only');
    ctx.match(fs.readFileSync(path.join(skills, 'playwright-cli', 'SKILL.md'), 'utf8'), /^---\nname: playwright-cli\n/, 'apply: the installed SKILL.md is the git base copy');
    ctx.eq(leftovers(tmp).length, 0, 'apply: no singular-add-* temp dir left');
    ctx.check(!fs.existsSync(path.join(fakeHome, '.claude', 'skills')), 'apply: nothing under the fake HOME/.claude/skills (seam target used)');
    ctx.eq(fs.readdirSync(path.join(w.cwd, '.claude', 'skills')).sort().join(','), [...w.projectSkills].sort().join(','), 'apply: the project .claude/skills still holds only the seeded skills (no --project)');
    const installed = ctx.readJson(path.join(w.home, 'installed.json')) ?? {};
    ctx.eq(installed['microsoft/playwright-cli@playwright-cli']?.sha, cliSha, 'apply: installed.json records the plan sha');
    ctx.eq(installed['microsoft/playwright-cli@playwright-cli']?.sha, cli.sha, 'apply: the installed sha is the plan sha (never re-resolved)');
    const applyLog = ctx.readLog(w.home).filter((l) => l.msg === 'init apply');
    ctx.eq(applyLog.length, 1, 'apply: one "init apply" log line');
    ctx.eq(JSON.stringify(applyLog[0]?.installed), '["playwright-cli"]', 'apply: log names the installed skill');

    const b2 = await ctx.runNode('singular.js', ['init', '--apply', String(cli.n)], { env, cwd: w.cwd });
    ctx.eq(b2.status, 0, 'apply again: exit 0');
    ctx.eq(b2.stdout, [header(cli.n, 1), `SKIPPED ${cli.n}. microsoft/playwright-cli#${cliSha.slice(0, 7)}@playwright-cli (exists: ${path.join(skills, 'playwright-cli')})`, 'Installed: none', 'Kickoff prompt: none (nothing new was installed)', ''].join('\n'), 'apply again: SKIPPED (exists), no kickoff');
    ctx.eq(fs.readdirSync(path.join(skills, 'playwright-cli')).join(','), 'SKILL.md', 'apply again: the folder is untouched');
    ctx.info(`apply: ${cli.n}. ${cli.ref} -> INSTALLED, then SKIPPED (exists); $0`);

    // ------------------------------------------------------------------ (c) a malicious candidate: REJECTED, nothing left
    const kit = maliciousGitBase(ctx, path.join(ctx.caseDir, 'gitbase-malicious'));
    const catalog = buildCatalog(ctx.root);
    catalog.entries.push({ id: 'evil-local/playwright-kit/playwright-kit', source: 'evil-local/playwright-kit', skillId: 'playwright-kit', name: 'playwright-kit', installs: 2000000 });
    const reg2 = await ctx.registry({ mode: 'ok', catalog });
    const w2 = ctx.world('malicious', { cwd: 'next', config: { mode: 'suggest', allowlist: ['anthropics', 'vercel-labs', 'microsoft', 'multica-ai', 'evil-local'] } });
    const fakeHome2 = path.join(w2.base, 'fakehome');
    const skills2 = path.join(w2.base, 'skills-dir');
    const tmp2 = path.join(w2.base, 'tmp');
    for (const d of [fakeHome2, skills2, tmp2]) fs.mkdirSync(d, { recursive: true });
    const env2 = { SINGULAR_REGISTRY_BASE: reg2.base, SINGULAR_GIT_BASE: kit.base, SINGULAR_HOME: w2.home, HOME: fakeHome2, SINGULAR_SKILLS_DIR: skills2, TMPDIR: tmp2, PWD: w2.cwd };
    const c0 = await ctx.runNode('singular.js', ['init'], { env: env2, cwd: w2.cwd });
    ctx.eq(c0.status, 0, 'malicious init: exit 0');
    const kitLine = c0.stdout.split('\n').find((l) => /^  \d+\. evil-local\/playwright-kit[#@]/.test(l));
    ctx.check(kitLine, 'malicious init: the allowlisted 2M-install playwright-kit is listed (pinned, not installed)', c0.stdout);
    ctx.match(kitLine, new RegExp(`^  \\d+\\. evil-local/playwright-kit#${kit.sha.slice(0, 7)}@playwright-kit   2\\.0M installs   audit unknown   for: playwright$`), 'malicious init: candidate line pinned to its HEAD, no audit on record');
    ctx.eq(fs.readdirSync(skills2).length, 0, 'malicious init: nothing installed by the report');
    const plan2 = ctx.readJson(path.join(w2.home, 'init-plan.json')) ?? { candidates: [] };
    const bad = (plan2.candidates ?? []).find((c) => c.source === 'evil-local/playwright-kit');
    if (!bad) ctx.fail('the malicious candidate is not in the plan');
    ctx.eq(bad.sha, kit.sha, 'malicious plan: pinned to the repository HEAD');
    const c1 = await ctx.runNode('singular.js', ['init', '--apply', String(bad.n)], { env: env2, cwd: w2.cwd });
    ctx.eq(c1.status, 1, 'malicious apply: exit 1');
    const cl = c1.stdout.split('\n');
    const n2 = plan2.candidates.length;
    ctx.eq(cl[0], `[singular] init --apply ${bad.n}: 1 of ${n2} candidate${n2 === 1 ? '' : 's'} for cwd (plan from ${plan2.createdAt}) -> ${skills2}`, 'malicious apply: header');
    ctx.match(cl[1], new RegExp(`^REJECTED ${bad.n}\\. evil-local/playwright-kit#${kit.sha.slice(0, 7)}@playwright-kit: executable bit in repository tree: playwright-kit/bin/pwn \\(mode 100755\\); symlink in repository tree: playwright-kit/link \\(mode 120000\\); `), 'malicious apply: REJECTED before the copy (ls-tree exec bit + symlink first)');
    ctx.match(cl[1], /; \+\d+ more \(nothing was written\)$/, 'malicious apply: more problems counted, nothing was written');
    ctx.eq(cl[2], 'Installed: none', 'malicious apply: Installed none');
    ctx.eq(cl[3], 'Kickoff prompt: none (nothing new was installed)', 'malicious apply: no kickoff prompt');
    ctx.eq(fs.readdirSync(skills2).length, 0, 'malicious apply: nothing under the skills dir');
    ctx.eq(leftovers(tmp2).length, 0, 'malicious apply: no singular-add-* temp dir left');
    ctx.check(!fs.existsSync(path.join(fakeHome2, '.claude', 'skills')), 'malicious apply: nothing under the fake HOME');
    ctx.check(!fs.existsSync(path.join(w2.cwd, '.claude')), 'malicious apply: nothing in the project');
    ctx.check(!(ctx.readJson(path.join(w2.home, 'installed.json')) ?? {})['evil-local/playwright-kit@playwright-kit'], 'malicious apply: not recorded in installed.json');
    ctx.info(`malicious: ${kitLine?.trim()} -> ${cl[1]?.slice(0, 160)}`);

    // ------------------------------------------------------------------ (d) live: /singular init --no-remote via slash
    const w3 = ctx.world('live', { cwd: 'next', config: { mode: 'suggest' }, projectSkills: true });
    const requestsBefore = reg.requests.length;
    const r = await ctx.claude('/singular init --no-remote', { world: w3, label: 'init-no-remote', extraEnv: seamEnv({ registry: reg, gitBase: ctx.gitBase }), allowedTools: 'Bash(node:*)' });
    const bash = r.bashCommands.find((c) => INIT_RE.test(c));
    ctx.check(bash, 'live: Bash tool_use runs bin/singular.js init', r.bashCommands);
    ctx.check(bash && /--no-remote/.test(bash), 'live: --no-remote passed through', bash);
    ctx.check(bash && !/unset|export SINGULAR_HOME/.test(bash), 'live: plain node invocation (no env tampering)', bash);
    ctx.check(!r.bashCommands.some((c) => /--apply/.test(c)), 'live: never --apply without the user choosing', r.bashCommands);
    ctx.eq(r.hooks('UserPromptExpansion').filter((h) => h.exitCode !== 0 || h.context).length, 0, 'live: the expansion hook stays silent for init (exit 0, no context)');
    const p = ctx.promptHook(r);
    ctx.check(!p || p.context === '', 'live: UserPromptSubmit injects nothing for the slash prompt');
    const out = r.toolResultText;
    ctx.includes(out, '[singular] init: cwd', 'live: report header in the tool output');
    ctx.includes(out, STACK, 'live: Stack line in the tool output');
    ctx.includes(out, NEEDS, 'live: the Needs line in the tool output');
    ctx.match(out, /^Covered by installed skills: /m, 'live: Covered line (host index + seeded project skills)');
    ctx.match(out, /^Not covered: /m, 'live: Not covered line');
    ctx.includes(out, 'Suggested third-party skills: skipped (--no-remote)', 'live: --no-remote skips the suggest step');
    ctx.excludes(out, 'Approve:', 'live: no Approve line without candidates');
    ctx.match(r.result, /Needs/, 'live: the model relays the Needs line');
    ctx.check(fs.existsSync(path.join(w3.home, 'init-plan.json')), 'live: the plan was written into the redirected SINGULAR_HOME', w3.home);
    ctx.eq(reg.requests.length, requestsBefore, 'live: --no-remote makes no registry request');
    ctx.check(r.costUsd < 0.02, 'live: under 2 cents', r.costUsd);
    const verbatim = r.result.includes(NEEDS);
    // With --no-remote there are no numbered candidates, so the skill body's "ask which numbers" step has nothing to
    // ask about; what haiku does instead (explains that nothing can be installed from this report, points at a run
    // without --no-remote, or still asks) is observed, not asserted.
    const asked = /which (numbers?|candidates?|ones?)|pick (the )?numbers?|would you like (me )?to install|choose/i.test(r.result);
    const explained = /without `?--no-remote`?|nothing (to install|installs)/i.test(r.result);
    ctx.info(`live: $${r.costUsd.toFixed(4)}, ${r.wallMs} ms, tools=${r.toolUses.join(',')}; Needs line verbatim in the answer: ${verbatim ? 'yes' : 'no'}; asked which to install: ${asked ? 'yes' : 'no'}; explained that --no-remote lists no candidates: ${explained ? 'yes' : 'no'}; bash: ${bash?.slice(0, 120)}; result: ${r.result.replace(/\s+/g, ' ').slice(0, 160)}`);
  },
};
