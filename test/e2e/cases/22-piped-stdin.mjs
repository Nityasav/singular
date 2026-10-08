// Piped stdin: a prompt given only on stdin still fires the hook; stdin appended to a -p argument is part of the
// prompt the hook scores (promptChars grows).
import { STACK_ECHO } from '../lib/prompts.mjs';

export default {
  name: 'piped stdin: prompt from stdin; stdin appended to the argument',
  tags: ['stdin'],
  costCapUsd: 0.01,
  async run(ctx) {
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'local' } });
    const a = await ctx.claude(null, { world: w, label: 'stdin-only', stdin: `${STACK_ECHO}\n` });
    const ha = ctx.promptHook(a);
    ctx.check(ha && ha.exitCode === 0, 'stdin-only: hook exit 0', ha?.raw ?? a.stderr);
    ctx.match(ha ? ha.context : '', /Stack: Next\.js 16/, 'stdin-only: context has the Stack line');
    ctx.includes(a.result, 'Next.js 16', 'stdin-only: model echoed it');
    const arg = 'Reply with exactly the text that follows this sentence, and nothing else. Do not use any tools.';
    const b = await ctx.claude(arg, { world: w, label: 'stdin-appended', stdin: 'this text came from stdin\n' });
    ctx.includes(b.result, 'this text came from stdin', 'appended: the model saw the stdin text');
    const line = ctx.readLog(w.home).filter((l) => l.msg === 'on-prompt').pop();
    ctx.check(line && line.promptChars > arg.length, 'appended: the hook saw a longer prompt than the argument', line?.promptChars);
    ctx.info(`promptChars: arg ${arg.length} -> hook ${line?.promptChars}`);
  },
};
