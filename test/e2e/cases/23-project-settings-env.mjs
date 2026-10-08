// A repository's committed .claude/settings.json env block can only LOWER the mode (regression for
// docs/security.md section 4): off switches the hook off, auto is ignored, and a relative or in-project
// SKILL_SCOUT_HOME is ignored without writing into the project (checked offline in hook mode with HOME redirected).
import fs from 'node:fs';
import path from 'node:path';
import { STACK_ECHO, seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'project settings env: off honoured, auto ignored, in-project SKILL_SCOUT_HOME ignored',
  tags: ['security', 'env'],
  costCapUsd: 0.02,
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });
    const env = seamEnv({ registry: reg, gitBase: ctx.gitBase });
    const settings = (w, obj) => {
      fs.mkdirSync(path.join(w.cwd, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(w.cwd, '.claude', 'settings.json'), `${JSON.stringify(obj, null, 2)}\n`);
    };

    const off = ctx.world('off', { cwd: 'next', config: { mode: 'suggest' } });
    settings(off, { env: { SKILL_SCOUT_MODE: 'off' } });
    const r1 = await ctx.claude(STACK_ECHO, { world: off, label: 'env-off', extraEnv: env });
    ctx.eq(ctx.promptContext(r1), '', 'env off: no context');
    const l1 = ctx.readLog(off.home).filter((l) => l.msg === 'on-prompt').pop();
    ctx.eq(l1?.mode, 'off', 'env off: log mode off');
    ctx.eq(l1?.skipped, 'mode off', 'env off: skipped mode off');
    ctx.match(r1.result, /NONE/, 'env off: model reports NONE');

    const auto = ctx.world('auto', { cwd: 'next', config: { mode: 'suggest' } });
    settings(auto, { env: { SKILL_SCOUT_MODE: 'auto' } });
    const r2 = await ctx.claude(STACK_ECHO, { world: auto, label: 'env-auto', extraEnv: env });
    ctx.match(ctx.promptContext(r2), /^\[skill-scout\] Stack:/, 'env auto: hook still runs');
    const log2 = ctx.readLog(auto.home);
    const l2 = log2.filter((l) => l.msg === 'on-prompt').pop();
    ctx.eq(l2?.mode, 'suggest', 'env auto: mode stays suggest');
    ctx.check(log2.some((l) => /SKILL_SCOUT_MODE=auto ignored \(the environment can only lower the mode/.test(String(l.warning))), 'env auto: ignored warning logged', log2.filter((l) => l.level === 'warn').map((l) => l.warning));
    ctx.excludes(ctx.promptContext(r2), '<skill-scout-loaded', 'env auto: nothing loaded');

    // offline (no model): a relative SKILL_SCOUT_HOME and an absolute one inside the project are ignored; the
    // fallback is <HOME>/.claude/skill-scout, so HOME is pointed at a temp dir outside the project.
    const w3 = ctx.world('home', { cwd: 'next', config: { mode: 'local' } });
    const fakeHome = path.join(w3.base, 'fakehome');
    fs.mkdirSync(fakeHome, { recursive: true });
    const stdin = JSON.stringify({ session_id: 'e2e-env', transcript_path: '/dev/null', cwd: w3.cwd, prompt_id: 'p1', permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: STACK_ECHO });
    for (const value of ['.scout', path.join(w3.cwd, '.scout')]) {
      const r = await ctx.runNode('on-prompt.js', [], { env: { HOME: fakeHome, SKILL_SCOUT_HOME: value, SKILL_SCOUT_MODE: 'auto' }, cwd: w3.cwd, input: stdin });
      ctx.eq(r.status, 0, `SKILL_SCOUT_HOME=${value}: exit 0`);
      ctx.match(r.stdout, /"hookEventName":"UserPromptSubmit"/, `SKILL_SCOUT_HOME=${value}: envelope printed`);
      ctx.check(!fs.existsSync(path.join(w3.cwd, '.scout')), `SKILL_SCOUT_HOME=${value}: no .scout directory in the project`);
    }
    const fallbackLog = ctx.readLog(path.join(fakeHome, '.claude', 'skill-scout'));
    ctx.check(fallbackLog.some((l) => /SKILL_SCOUT_HOME=\.scout ignored \(must be an absolute path\)/.test(String(l.warning))), 'relative SKILL_SCOUT_HOME ignored (warning in the fallback home log)', fallbackLog.map((l) => l.warning).filter(Boolean));
    ctx.check(fallbackLog.some((l) => /ignored \(inside the project directory/.test(String(l.warning))), 'in-project SKILL_SCOUT_HOME ignored', fallbackLog.map((l) => l.warning).filter(Boolean));
    ctx.check(fallbackLog.some((l) => /SKILL_SCOUT_MODE=auto ignored/.test(String(l.warning))), 'SKILL_SCOUT_MODE=auto ignored in the fallback home too');
    ctx.check(fs.existsSync(path.join(fakeHome, '.claude', 'skill-scout', 'config.json')), 'the fallback home (fake HOME) got the default config, not the project');
  },
};
