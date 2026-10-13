// Skip classes produce zero context: "hi", a 39-char prompt, a [singular]-prefixed prompt and a short factual
// question; the 40-char twin gets the Stack line. The log names each skip reason.
import { exactly } from '../lib/prompts.mjs';

export default {
  name: 'skip classes: hi / 39 chars / [singular] prefix / short question; 40 chars routes',
  tags: ['prompt-types', 'skip', 'core'],
  costCapUsd: 0.04,
  async run(ctx) {
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'local' } });
    const p39 = exactly('build a landing page with tailwind now', 39);
    const p40 = exactly('build a landing page with tailwind now', 40);
    const rows = [
      { id: 'hi', prompt: 'hi', skip: /shorter than minPromptChars \(2 < 40\)/ },
      { id: '39-chars', prompt: p39, skip: /shorter than minPromptChars \(39 < 40\)/ },
      { id: 'own-output', prompt: '[singular] Stack: Next.js 16, React 19; this is the hook line pasted back, ignore it', skip: /own output/ },
      { id: 'short-question', prompt: 'what is 2 plus 2? just say', skip: /shorter than minPromptChars/ },
      { id: '40-chars', prompt: p40, skip: null },
    ];
    ctx.eq(p39.length, 39, 'fixture: 39-char prompt');
    ctx.eq(p40.length, 40, 'fixture: 40-char prompt');
    for (const row of rows) {
      const r = await ctx.claude(row.prompt, { world: w, label: row.id });
      const h = ctx.promptHook(r);
      ctx.check(r.hookStarted.includes('UserPromptSubmit') || h, `${row.id}: UserPromptSubmit hook ran`, r.hookStarted);
      if (h) ctx.eq(h.exitCode, 0, `${row.id}: hook exit 0`);
      const c = h ? h.context : '';
      if (row.skip) {
        ctx.eq(c, '', `${row.id}: no context injected`);
        ctx.check(!(h && h.json && h.json.hookSpecificOutput), `${row.id}: no hookSpecificOutput at all`, h?.output);
      } else ctx.match(c, /^\[singular\] Stack: Next\.js 16/, `${row.id}: context starts with the Stack line`);
      ctx.eq(r.exitCode, 0, `${row.id}: claude exit 0`);
      ctx.info(`${row.id}: ${c.length} context chars, $${r.costUsd.toFixed(4)}`);
    }
    const log = ctx.readLog(w.home).filter((l) => l.msg === 'on-prompt');
    for (const row of rows) {
      const line = log.find((l) => (row.id === 'hi' ? l.promptChars === 2 : row.id === '39-chars' ? l.promptChars === 39 : row.id === '40-chars' ? l.promptChars === 40 : row.id === 'short-question' ? l.promptChars === 26 : l.skipped === 'own output'));
      ctx.check(line, `${row.id}: singular.log has the on-prompt line`, log.map((l) => `${l.promptChars}:${l.skipped}`));
      if (line && row.skip) ctx.match(String(line.skipped), row.skip, `${row.id}: log skip reason`);
      if (line && !row.skip) ctx.eq(line.skipped, null, `${row.id}: not skipped in the log`);
    }
  },
};
