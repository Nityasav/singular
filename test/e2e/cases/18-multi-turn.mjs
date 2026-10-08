// Loaded text survives --resume and --continue in a persisted session: the transcript stores the hook context as a
// hook_additional_context attachment; teardown removes only ~/.claude/projects/<encoded temp cwd>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seamEnv } from '../lib/prompts.mjs';

export default {
  name: 'multi-turn: /scout-load then --resume and --continue recall the loaded skill',
  tags: ['session', 'multi-turn', 'load'],
  costCapUsd: 0.05,
  async run(ctx) {
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'local' } });
    const env = seamEnv({ gitBase: ctx.gitBase });
    const t1 = await ctx.claude('/scout-load multica-ai/andrej-karpathy-skills@karpathy-guidelines', { world: w, label: 'turn1-load', extraEnv: env, persist: true });
    const x1 = t1.hooks('UserPromptExpansion')[0];
    ctx.check(x1 && x1.exitCode === 0 && /<skill-scout-loaded/.test(x1.context), 'turn 1: skill loaded through the expansion hook', x1?.raw);
    ctx.check(t1.sessionId, 'turn 1: session id parsed', t1.sessionId);
    const t2 = await ctx.claude('List the four numbered section titles of the karpathy-guidelines skill that was loaded earlier in this session, one per line. Do not use any tools.', { world: w, label: 'turn2-resume', extraEnv: env, persist: true, resume: t1.sessionId });
    ctx.match(t2.result, /Think Before Coding/, 'turn 2 (--resume): section 1 recalled');
    ctx.match(t2.result, /Surgical Changes/, 'turn 2 (--resume): section 3 recalled');
    ctx.eq(t2.hooks('UserPromptExpansion').length, 0, 'turn 2: no expansion (plain prompt)');
    ctx.excludes(ctx.promptContext(t2), '<skill-scout-loaded', 'turn 2: the loaded text is not re-injected (it lives in the transcript)');
    const t3 = await ctx.claude('Quote verbatim the first bullet under the "Surgical Changes" section of the skill loaded in this session. Do not use any tools.', { world: w, label: 'turn3-continue', extraEnv: env, persist: true, continueSession: true });
    ctx.includes(t3.result, 'adjacent code, comments, or formatting', 'turn 3 (--continue): verbatim bullet recalled');
    const projDir = path.join(os.homedir(), '.claude', 'projects', ctx.projectDirName(w.cwd));
    const transcript = path.join(projDir, `${t1.sessionId}.jsonl`);
    ctx.check(fs.existsSync(transcript), 'persisted transcript exists under ~/.claude/projects/<encoded temp cwd>', transcript);
    if (fs.existsSync(transcript)) {
      const text = fs.readFileSync(transcript, 'utf8');
      ctx.includes(text, '"type":"hook_additional_context"', 'transcript stores the hook context as hook_additional_context');
      ctx.includes(text, '<skill-scout-loaded', 'transcript carries the loaded block');
    }
    ctx.info(`session ${t1.sessionId}; costs $${t1.costUsd.toFixed(4)} + $${t2.costUsd.toFixed(4)} + $${t3.costUsd.toFixed(4)}; turn 2: ${t2.result.replace(/\s+/g, ' ').slice(0, 120)}`);
    ctx.info(`transcript dir ${projDir} is removed by the runner after this case`);
  },
};
