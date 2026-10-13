// /singular add through the script directly (never through claude: it writes under ~/.claude/skills), with HOME and
// SINGULAR_SKILLS_DIR pointed at temp dirs and the local git base: a plugin-shaped skill is REJECTED before the
// copy, a clean one is INSTALLED and recorded, a rerun is REFUSED, a non-allowlisted owner is REJECTED, and a
// non-interactive run without --yes does nothing.
import fs from 'node:fs';
import path from 'node:path';
import { seamEnv } from '../lib/prompts.mjs';

export default {
  name: '/singular add (direct node): REJECTED malicious, INSTALLED clean, REFUSED rerun, allowlist, --yes',
  tags: ['commands', 'add', 'security', 'free'],
  costCapUsd: 0.0,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest', allowlist: ['anthropics', 'vercel-labs', 'microsoft', 'multica-ai', 'evil-local'] } });
    const fakeHome = path.join(w.base, 'fakehome');
    const skills = path.join(w.base, 'skills-dir');
    const tmp = path.join(w.base, 'tmp');
    for (const d of [fakeHome, skills, tmp]) fs.mkdirSync(d, { recursive: true });
    const env = { ...seamEnv({ registry: reg, gitBase: ctx.gitBase }), SINGULAR_HOME: w.home, HOME: fakeHome, SINGULAR_SKILLS_DIR: skills, TMPDIR: tmp };
    const sha = ctx.gitBase.shas['evil-local/repo'];
    const leftovers = () => fs.readdirSync(tmp).filter((n) => n.startsWith('singular-add-'));

    const a = await ctx.runNode('singular.js', ['add', 'evil-local/repo@helpful-setup', '--yes'], { env, cwd: w.cwd });
    ctx.eq(a.status, 1, 'malicious: exit 1');
    ctx.match(a.stdout, new RegExp(`^REJECTED: evil-local/repo#${sha}@helpful-setup\\n`), 'malicious: REJECTED with the pinned ref');
    for (const needle of ['executable bit in repository tree: helpful-setup/bin/pwn (mode 100755)', 'symlink in repository tree: helpful-setup/link (mode 120000)', 'plugin component directory hooks/', 'plugin component file .mcp.json', 'frontmatter key "allowed-tools"', 'inline shell (!`)', 'fenced shell block (```!)', `Nothing was written to ${skills}`]) ctx.includes(a.stdout, needle, `malicious: ${needle}`);
    ctx.check(!fs.existsSync(path.join(skills, 'helpful-setup')), 'malicious: nothing under the skills dir');
    ctx.eq(leftovers().length, 0, 'malicious: no singular-add-* temp dir left');

    const b = await ctx.runNode('singular.js', ['add', 'evil-local/repo@clean-guidelines', '--yes'], { env, cwd: w.cwd });
    ctx.eq(b.status, 0, 'clean: exit 0');
    ctx.includes(b.stdout, `INSTALLED evil-local/repo#${sha}@clean-guidelines sha ${sha}`, 'clean: INSTALLED line');
    ctx.includes(b.stdout, '"status": "pass"', 'clean: audit from the mock registry (pass)');
    ctx.check(fs.existsSync(path.join(skills, 'clean-guidelines', 'SKILL.md')), 'clean: SKILL.md copied');
    ctx.check(fs.existsSync(path.join(skills, 'clean-guidelines', 'reference.md')), 'clean: sibling file copied');
    ctx.eq(fs.readdirSync(skills).length, 1, 'clean: exactly one entry in the skills dir');
    const installed = ctx.readJson(path.join(w.home, 'installed.json')) ?? {};
    ctx.eq(installed['evil-local/repo@clean-guidelines']?.sha, sha, 'clean: installed.json records the pin');
    ctx.eq(leftovers().length, 0, 'clean: no temp dir left');
    ctx.check(reg.summary().audits.includes('evil-local/repo/clean-guidelines'), 'clean: audit endpoint consulted', reg.summary().audits);

    const auditsBefore = reg.summary().audits.length;
    const c = await ctx.runNode('singular.js', ['add', 'evil-local/repo@clean-guidelines', '--yes'], { env, cwd: w.cwd });
    ctx.eq(c.status, 1, 'rerun: exit 1');
    ctx.match(c.stdout, /REFUSED: .*clean-guidelines already exists \(directory\)/, 'rerun: REFUSED, never overwrites');
    ctx.eq(reg.summary().audits.length, auditsBefore, 'rerun: refused before any network call');

    const d = await ctx.runNode('singular.js', ['add', 'evil/repo@x', '--yes'], { env, cwd: w.cwd });
    ctx.eq(d.status, 1, 'non-allowlisted: exit 1');
    ctx.match(d.stdout, /REJECTED: owner "evil" is not allowlisted/, 'non-allowlisted: reason');

    const e = await ctx.runNode('singular.js', ['add', 'evil-local/repo@playwright-helper'], { env, cwd: w.cwd });
    ctx.eq(e.status, 1, 'no --yes: exit 1');
    ctx.match(e.stderr, /not installed \(pass --yes/, 'no --yes: refuses non-interactively');
    ctx.check(!fs.existsSync(path.join(skills, 'playwright-helper')), 'no --yes: nothing written');

    const f = await ctx.runNode('singular.js', ['add', 'evil-local/repo@-y', '--yes'], { env, cwd: w.cwd });
    ctx.match(f.stdout + f.stderr, /invalid ref/, 'flag-shaped skill name rejected before any subprocess');
    ctx.check(!fs.existsSync(path.join(fakeHome, '.claude', 'skills')), 'nothing ever written under the fake HOME/.claude/skills (seam target used)');
    ctx.info(`skills dir: ${fs.readdirSync(skills).join(',')}; registry audits: ${reg.summary().audits.join(',')}`);
  },
};
