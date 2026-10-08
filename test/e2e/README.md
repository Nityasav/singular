# test/e2e — live end-to-end suite

`bash test/e2e/run.sh` (= `npm run e2e`, a thin wrapper around `node test/e2e/run.mjs`) runs Claude Code in `-p` mode with skill-scout loaded **for that session only** and asserts every feature of the plugin against the real hook contracts: prompt classes, skip rules, the suggest / local / off / auto modes, `/scout-load` (happy, `#sha`, `--update`, hostile), `/scout-status`, `/scout-find` (model-invocable), `/scout-mode`, `/scout-add` (direct node), tool-using turns, subagents, multi-turn sessions, registry faults, concurrency, permission modes, piped stdin, a repository's settings `env`, `pinnedSkills` and hook timing. Zero dependencies (node:test is not even needed; the runner is plain Node >= 20).

It needs a logged-in Claude Code (OAuth/keychain), `git` and `node`. Without `claude` on PATH, or without a login, it prints `SKIP` and exits 0; a call refused by the account's session window (`rate_limit_event` status `rejected`, result "You've hit your session limit") SKIPs that case with the reset time (observed 2026-10-08 on 2.1.294; the hook has already run by then, so nothing about the model can be asserted and a hook-only PASS would be misleading). A full run makes 75 `haiku` calls (8 of them blocked `/scout-load`s that never reach the model), one `sonnet` call for the relay metric and, when haiku does not invoke the `scout-find` skill for the natural question (observed), one `sonnet` fallback; it costs about $0.20-0.25 (measured 2026-10-08 on Claude Code 2.1.293; figures in `docs/testing.md` section 3). The hostile `/scout-load` and `/scout-add` cases cost nothing.

```bash
bash test/e2e/run.sh                       # every case (~7-10 min)
bash test/e2e/run.sh --list                # names, tags, per-case cost caps
bash test/e2e/run.sh --filter core         # cases tagged core (one or more tags, comma-separated)
bash test/e2e/run.sh --case scout-load     # cases whose name or file contains the text (comma-separated list allowed: --case 13-scout-find,23-project)
bash test/e2e/run.sh --filter free         # the no-model cases only (cost 0)
bash test/e2e/run.sh --no-sonnet           # skip the sonnet relay metric
E2E_MAX_COST_USD=1 bash test/e2e/run.sh    # lower the global cost cap (default 3 USD)
node --test test/e2e/stream.test.mjs       # unit tests for the stream parser (committed fixtures, no model)
```

Env: `E2E_MAX_COST_USD` (global cap; a case that would exceed it is SKIPped, a call that would exceed it throws SKIP; a case's own `costCapUsd` is enforced per call too: each call gets `--max-budget-usd min(budget, cap - spent)` and reaching the cap mid-case, or ending above it, FAILs that case), `SKILL_SCOUT_E2E_MODEL` (default `haiku`; cases tagged `sonnet` always use sonnet), `SKILL_SCOUT_E2E_BUDGET` (per-call `--max-budget-usd`, default 0.5), `SKILL_SCOUT_E2E_TMP` (work dir, default `$TMPDIR/skill-scout-e2e`), `SKILL_SCOUT_E2E_SONNET=0`.

Output: one `PASS` / `FAIL` / `SKIP` line per case with its cost, wall time and number of `claude` calls, `FAILED` lines naming every assertion that did not hold, `INFO` lines for non-asserting observations (model relay rate, hook timings, what the model answered), the two global-state checks, and a final `e2e: N passed, N failed, N skipped; total cost $X` line. Exit code 1 on any FAIL or when the global state fingerprint changed. Artifacts (`<case>/<nn>-<label>.jsonl` stream, `.err`, `.cmd` with the exact command and env, every temp `home` and `cwd`, `before.txt` / `after.txt`, `summary.txt`) stay under the work dir.

## Layout

```
run.mjs            the runner: discovers cases/*.mjs, preflight, login probe, per-case ctx, cost cap, snapshots, summary
run.sh             thin wrapper (npm run e2e)
lib/claude.mjs     runClaude(prompt, opts): spawns `claude -p` with the recipe below, returns the parsed stream
lib/stream.mjs     parseStream(text): hook events (context, systemMessage, exit code), tool_use/tool_result blocks, result(s), cost
lib/registry.mjs   mock skills.sh on a loopback port (modes ok | delay | 429 | 500 | garbage | hostile | down), request log
lib/catalog.mjs    the data it serves: the real fixtures under test/fixtures plus synthetic allowlisted entries
lib/gitbase.mjs    local bare git repositories for SKILL_SCOUT_GIT_BASE (karpathy-guidelines, a plugin-shaped long skill, ...)
lib/world.mjs      fresh SKILL_SCOUT_HOME + temp cwd per case, scout.log / cache readers, async `node bin/<script>` runner
lib/snapshot.mjs   fingerprints of ~/.claude/settings*.json, installed_plugins.json, ~/.claude/skills and the real skill-scout state
lib/check.mjs      assertion collector (check / eq / match / includes / excludes / info / fail / skip)
lib/prompts.mjs    shared prompts (every live prompt says "do not use tools" unless the case is about tools)
cases/NN-*.mjs     one feature per file: export default { name, tags, costCapUsd, run(ctx) }
fixtures/*.jsonl   captured streams for stream.test.mjs (paths scrubbed; stream-rate-limited.jsonl is the session-limit shape)
stream.test.mjs    node:test for the parser
```

### Writing a case

```js
export default {
  name: 'what it proves',
  tags: ['core'],
  costCapUsd: 0.02,                       // SKIPped when the global cap would be exceeded; enforced per call: FAIL when the case reaches it
  async run(ctx) {
    const reg = await ctx.registry({ mode: 'ok' });                      // mock skills.sh; closed after the case
    const w = ctx.world('next', { cwd: 'next', config: { mode: 'suggest' }, projectSkills: true });   // fresh home + Next.js fixture cwd (+ the two e2e-* project skills, lib/world.mjs PROJECT_SKILLS)
    const r = await ctx.claude('prompt', { world: w, label: 'first', extraEnv: { SKILL_SCOUT_REGISTRY_BASE: reg.base, SKILL_SCOUT_GIT_BASE: ctx.gitBase.base }, allowedTools: 'Bash(node:*)' });
    const h = ctx.promptHook(r);          // the UserPromptSubmit hook_response: {exitCode, context, systemMessage, output, stderr}
    ctx.check(h && h.exitCode === 0, 'hook exit 0', h?.raw);
    ctx.match(h.context, /^\[skill-scout\] Stack:/, 'Stack line');
    ctx.info(`result: ${r.result.slice(0, 80)}`);    // non-asserting
  },
};
```

`ctx` also has `gitBase.shas`, `readLog(home)`, `cacheEntry(home, key)`, `cacheValues(home)`, `waitFor(fn)`, `runNode(script, args, {env, cwd, input})` (async; used for `/scout-add` and the offline hook-mode checks), `readJson`, `writeConfig`, `projectDirName(cwd)`, `fail(msg)`, `skip(msg)`. `ctx.claude` options: `world` or `cwd`+`home`, `model`, `allowedTools`, `permissionMode`, `resume`, `continueSession`, `stdin` (string; `prompt` may then be `null`), `persist` (drops `--no-session-persistence`; the runner removes `~/.claude/projects/<encoded temp cwd>` afterwards), `extraEnv`, `maxBudgetUsd`, `timeoutMs`. The result carries `hookEvents`, `hooks(name)`, `hookStarted`, `toolUses`, `toolUseBlocks` (`parentToolUseId` for subagent calls), `skillUses`, `bashCommands`, `toolResults`, `toolResultText`, `results`, `result` (the LAST result event: a backgrounded subagent produces two), `costUsd`, `numTurns`, `isError`, `sessionId`, `permissionMode`, `plugins`, `wallMs`, `exitCode`, `stderr`.

## The isolation recipe

Every `claude` call the runner makes is:

```bash
cd <temp cwd>      # a copy of test/fixtures/projects/next-tailwind-ts with a .git/HEAD, or an empty dir, or the plugin root
SKILL_SCOUT_HOME=<temp home> [SKILL_SCOUT_REGISTRY_BASE=http://127.0.0.1:<port>] [SKILL_SCOUT_GIT_BASE=file:///<run dir>/gitbase] \
claude -p "<prompt>" --output-format stream-json --verbose --include-hook-events \
  --model haiku --max-budget-usd 0.5 --no-session-persistence \
  --setting-sources project --strict-mcp-config --plugin-dir <plugin root> \
  [--allowedTools "Bash(node:*)"] [--permission-mode plan] [--resume <id>] [--continue] < /dev/null
```

| flag / variable | effect |
| :-- | :-- |
| `--plugin-dir <root>` | loads the plugin as `skill-scout@inline` for this session; nothing is installed or enabled globally |
| `--setting-sources project` | skips `~/.claude/settings.json`, so none of the user's global plugins or hooks load (init lists `skill-scout@inline` plus the `@builtin` plugins) |
| `--strict-mcp-config` | no MCP servers |
| `--no-session-persistence` | no transcript under `~/.claude/projects` (dropped only by the multi-turn and pinnedSkills cases, which clean up the one directory derived from their temp cwd) |
| `--max-budget-usd 0.5`, `--model haiku` | cost cap per call; haiku is enough to echo hook context, run the slash commands and spawn a subagent |
| `< /dev/null` (stdio `ignore`) | otherwise `claude -p` waits 3 s for piped stdin |
| `--output-format stream-json --verbose --include-hook-events` | emits `system` events with `subtype: hook_started` / `hook_response` (`hook_event`, `hook_name`, `exit_code`, `outcome`, `output`, `stdout`, `stderr`) |
| `SKILL_SCOUT_HOME=<temp home>` | fresh state dir per case, **outside** the cwd (the runner refuses otherwise: `hardenEnv` would fall back to the real `~/.claude/skill-scout`) |
| `SKILL_SCOUT_REGISTRY_BASE` / `SKILL_SCOUT_GIT_BASE` | the test seams (`docs/testing.md` section 4): a loopback mock of skills.sh and a local git base, so no case needs skills.sh or github.com; `SKILL_SCOUT_TEST_ALLOW_AUTO=1` for the auto case |
| `--allowedTools "Bash(node:*)"` | the slash commands other than `/scout-load` run `node` through the Bash tool, which non-interactive mode denies otherwise; the subagent case passes `Agent,Bash(find:*),Bash(ls:*),Glob` |

`/scout-add` is never run through `claude`: it writes under `~/.claude/skills`, so its case runs `node bin/scout-add.js` directly with `HOME` and `SKILL_SCOUT_SKILLS_DIR` pointed at temp dirs.

Things that do **not** work for isolation (verified): `CLAUDE_CONFIG_DIR=<fresh dir>` and `--bare` both return `Not logged in` because only the default config dir holds the OAuth session; `HOME=<tmp>` for a live run also breaks the login.

## What the runner guarantees

- `sha256` of `~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.claude/plugins/installed_plugins.json` and the listing of `~/.claude/skills` are identical before and after (otherwise the run FAILs).
- The real `~/.claude/skill-scout` (config.json, loaded.json, installed.json, scout.log, cache count) is identical before and after (an isolation leak FAILs the run).
- Every mock registry is closed and every `~/.claude/projects/<name>` directory derived from a temp cwd of this run is removed after its case (never a real project directory: only names derived from cwds under the run dir).
- A global cost cap (default 3 USD) stops the run with SKIPs instead of spending further; every case prints its cost and the summary prints the total. Each case's `costCapUsd` bounds every call it makes (`--max-budget-usd` = min(per-call budget, cap minus what the case spent, never below $0.01)); reaching the cap before a call, or ending the case above it, is a FAIL of that case, so a model loop in one case cannot starve the later ones.
- Routing assertions never depend on the host's `~/.claude`: a case that asserts an `Installed skills likely relevant:` line seeds project-scope skills into its temp cwd (`ctx.world(..., { projectSkills: true })` writes `<cwd>/.claude/skills/e2e-nextjs-app-router` and `e2e-tailwind-landing`) and asserts on those names (HOME cannot be redirected for a logged-in run, so the user index is whatever the machine has; it is read, never written).

## Hook contract facts the cases rely on

- `UserPromptSubmit` stdin keys: `session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name, prompt`. For a typed slash command `prompt` is the raw slash text, hence `on-prompt.js` skips prompts starting with `/`. A slash command inside a fenced block or in prose is not expanded (case 03). Captured sample: `test/fixtures/hook-stdin-userpromptsubmit.json`.
- `UserPromptExpansion` stdin keys add `expansion_type` (`slash_command`), `command_name` (**plugin-prefixed**, `skill-scout:scout-load`), `command_args`, `command_source` (`plugin`). The `hooks.json` matcher must be the prefixed name or a regex; skill-scout uses `(^|:)scout-load$`. Order in `-p` mode: `UserPromptExpansion` first, then `UserPromptSubmit`; an exit-2 block suppresses `UserPromptSubmit`, makes no model call (`total_cost_usd` 0, `num_turns` 0) and the CLI still exits 0 with the block text as `result` (case 11).
- `SubagentStart` stdin: `{session_id, transcript_path, cwd, prompt_id, agent_id, agent_type, hook_event_name}`; its `additionalContext` reaches the subagent; the Agent tool is auto-backgrounded in `-p` mode, so the stream holds **two** `result` events and the parent is resumed with a synthetic `<task-notification>` prompt that fires `UserPromptSubmit` (skipped by the hook) (case 17).
- `additionalContext` is visible to the model in the same turn; in a persisted transcript it appears as an attachment of type `hook_additional_context` and survives `--resume` / `--continue` (case 18).
- Hook output above 10,000 chars is only previewed, so loaded text is budgeted to 9,500 chars together with the stack and routing lines (cases 09, 10).
- Even with `--no-session-persistence`, Claude Code creates `~/.claude/projects/<encoded cwd>/`; the runner removes the ones derived from its temp cwds.

## Cost

Measured 2026-10-08 (Claude Code 2.1.293, haiku, one sonnet call): see `docs/testing.md` section 3 for the last two full runs, per-case costs and the summary lines.
