# singular — testing

How the unit suite, the coverage run and the live end-to-end checks work, what the test-only seams are, and what a live run costs. Numbers below were measured on 2026-10-07/08 on macOS with Node v26.5.0 and Claude Code 2.1.293, and re-measured on 2026-10-13 (Claude Code 2.1.296) where stated.

## 1. Unit suite

```bash
npm test                           # = node --test 'test/*.test.js'
node --test test/unit-bin.test.js  # one file (each file is self-contained and runs alone, in any order)
```

524 tests in 15 files, ~14 s (2026-10-13), no network beyond the loopback mock, no real `npx`; the one deliberate exception is `test/cli-install.test.js`, which runs the real `claude plugin ...` commands against an isolated `CLAUDE_CONFIG_DIR` and `HOME` (no login needed; SKIPs when `claude` or `npm` is not on PATH). Every subprocess and HTTP call goes through an injectable `deps` object (`fetchImpl`, `execFileImpl`, `spawnImpl`, `cacheGet`/`cacheSet`, `now`), so a test hands the code a fake `git ls-remote` / `npx skills use` / skills.sh response and asserts the exact argv, URLs **and child environment**. The exceptions are deliberate: `unit-bin.test.js`, `unit-refs.test.js` and `unit-registry.test.js` build local bare git repositories from `test/fixtures/skill-folders/*` and drive `/singular load`, `auto`, the prefetch, `/singular add` and `resolveHeadSha` through **real git** via the `SINGULAR_GIT_BASE` seam (skipped when `git` is not on PATH), and `unit-bin.test.js` serves a loopback skills.sh mock (`node:http`) to the child processes through `SINGULAR_REGISTRY_BASE`.

| file | covers |
| :-- | :-- |
| `test/unit-config.test.js` | `lib/config.js`: defaults, validation, `loadConfig` (EISDIR, corrupt JSON, mode ladder), `hardenEnv` (relative / in-project / **ancestor** `SINGULAR_HOME`, foreign `HOME`, in-project `TMPDIR`), the test seams (loopback registry, local git base and skills dir, neither inside nor above the project), `tmpdirOf`, `isAllowlisted` |
| `test/unit-git.test.js` | `lib/git.js`: `childEnv` (the allowlisted environment every git / npx child gets), `repoUrl`/`gitBase`, `describeGitFailure`, `runExecFile`, `cloneAtSha` (faked git), `findSkillDirs` |
| `test/unit-refs.test.js` | `lib/refs.js`: grammar, `parseRef`/`formatRef`/`normalizeRefCase`, `resolveHeadSha` faked and against **real git** (local bare repository; a `GIT_CONFIG_*` `insteadOf` rewrite in the caller env never reaches git) |
| `test/unit-registry.test.js` | `lib/registry.js`: search/catalog/audit clients, gates, ranking, sanitizer, text cache, `fetchSkillText` (npx path with a faked execFile: argv, env allowlist, work dir outside the project; git seam with real git), `discover` (budget, 429 cooldown, failure marker + stale catalogs) |
| `test/unit-cache.test.js`, `unit-log.test.js`, `unit-context.test.js`, `unit-inspect.test.js`, `unit-stack.test.js`, `unit-score.test.js` | one lib module each: key hashing / TTL / atomic writes; JSON-lines log; context composition and budget; folder inspection (plugin components, frontmatter spellings, shell forms, symlinks, exec bits); manifests, lockfiles, `.git/HEAD`, cache; tokenizer, stemmer, BM25-lite, stoplist regressions, keyword extraction |
| `test/unit-skill-index.test.js` | `lib/skill-index.js` on a fake `HOME` that mirrors every layout seen on a real machine (user, project, synced, skills-dir plugins, marketplace plugins, claude.ai-synced plugins with and without `~g<N>`, trash, stale versions, underscore partials), cache signature, frontmatter parser, performance |
| `test/unit-bin.test.js` | every entrypoint in `bin/` as a **child process** with real hook stdin fixtures, real git and the loopback registry (`on-prompt` suggest/local/off/auto, `on-expand` happy/hostile/prefetch and the silent exit for non-`load` subcommands, the `singular.js` dispatcher (help, unknown subcommand, `--json` passthrough, case-insensitive subcommands, plugin layout), the `mentionsSingular` rule behind the command-list hint, `singular add` INSTALLED/REJECTED/REFUSED with one HOME per test, `singular find`, `singular status` (+ the help trailer), `singular mode`, `on-subagent`), plus in-process branches with injected deps (spawn failure, throwing cache, post-copy rejection that leaves a concurrent writer's folder alone, credential prompt, "no skill named" listing, installed names never suggested); the privilege-escalation replay; the isolation check that nothing under the real `~/.claude` was named |
| `test/bin.test.js` | the golden routing table (`test/fixtures/index.snapshot.json`, 168 skills, the explorers' prompts) and the `isStrongMatch` regressions; pure |
| `test/unit-cli.test.js` | `lib/cli-core.js` + `bin/singular-cli.js` (the `singular` binary) with a fake `claude` through the injectable `deps` (`execFileImpl`, `spawnImpl`, `env`, `fs`): argument parsing, the five `install` steps and every failure path (environment, payload copy and rollback, marketplace add/update/re-point, plugin install/update, verify + enable), the marketplace removal that keeps a failed run from staying half-registered, `uninstall` / `--purge`, `status` / `doctor` output and hints, `--dry-run` / `--json`, the `--dir` guards, and the terminal proxies against the real `bin/singular.js` (cwd outside the scratch HOME, so `hardenEnv` never falls back to the real state dir) |
| `test/cli-install.test.js` | the real thing: `npm pack` -> `npm install -g --prefix <scratch>` -> `singular install` / `status` / `update` / `uninstall --purge` against the real `claude` with `HOME` and `CLAUDE_CONFIG_DIR` under the scratch dir (~13 s, no network, npm cache redirected); `claude plugin list --json` must show `singular@singular` enabled in between. The real `~/.claude` settings and plugin files are fingerprinted before and after (`known_marketplaces.json` with its `lastUpdated` stamps stripped: Claude Code refreshes those itself whenever a session starts, which happened once on 2026-10-13 while this file ran) |

Until 2026-10-08 six older files (`core`, `score`, `stack`, `skill-index`, `registry`, `bin.test.js` in full) duplicated the `unit-*` files almost line for line (224 tests, 5,348 lines, 0.24 % extra line coverage); they were removed and the handful of paths only they covered were ported into `unit-bin.test.js` and `unit-git.test.js`.

Fixtures under `test/fixtures/`: real skills.sh search and audit responses, a real `skills use` stdout, captured hook stdin for `UserPromptSubmit`, `UserPromptExpansion` and a `<task-notification>` prompt, a Next.js project, a clean and a malicious skill folder, and `index.snapshot.json` (names and descriptions of the skills Claude Code loaded on the authoring machine, no paths).

State: every test points `SINGULAR_HOME` (and `HOME` where it matters) at a throwaway directory under the scratchpad (`SINGULAR_TEST_TMP` overrides the root) that its `after()` removes; nothing under the real `~/.claude` is read or written, and no fixed path under `/tmp` is created (the isolation assertion in `unit-cache.test.js` captures the account's real home before `$HOME` is redirected, because `os.homedir()` follows `$HOME`).

## 2. Coverage

```bash
node --test --experimental-test-coverage 'test/*.test.js'
```

Node's built-in coverage prints a per-file table after the test summary (no dependency). Measured 2026-10-13 (15 files, 524 tests, Node v26.5.0, after the rename and the CLI integration; the whole run takes ~16 s):

| file | line % | branch % | funcs % |
| :-- | --: | --: | --: |
| `lib/cache.js` | 100 | 100 | 100 |
| `lib/cli-core.js` | 95.4 | 76.2 | 95.1 |
| `lib/commands/add.js` | 93.5 | 72.1 | 90.0 |
| `lib/commands/find.js` | 99.0 | 61.4 | 90.9 |
| `lib/commands/mode.js` | 100 | 80.0 | 83.3 |
| `lib/commands/status.js` | 98.4 | 51.3 | 83.3 |
| `lib/config.js` | 99.3 | 98.3 | 100 |
| `lib/context.js` | 100 | 97.7 | 100 |
| `lib/git.js` | 98.8 | 94.7 | 100 |
| `lib/inspect.js` | 96.7 | 96.3 | 100 |
| `lib/log.js` | 100 | 100 | 100 |
| `lib/refs.js` | 100 | 100 | 100 |
| `lib/registry.js` | 100 | 97.6 | 100 |
| `lib/score.js` | 100 | 99.4 | 100 |
| `lib/skill-index.js` | 100 | 97.1 | 100 |
| `lib/stack.js` | 99.0 | 98.7 | 100 |
| `bin/on-prompt.js` | 97.5 | 76.0 | 89.1 |
| `bin/on-expand.js` | 97.5 | 59.1 | 94.7 |
| `bin/on-subagent.js` | 91.3 | 44.4 | 83.3 |
| `bin/singular.js` | 95.6 | 78.6 | 83.3 |
| `bin/singular-cli.js` | 88.5 | 55.6 | 80.0 |
| all files | 98.1 | 89.2 | 95.9 |

The uncovered lines are `catch` arms for I/O failures and the `main()` tails that `process.exit`; the child-process tests in `unit-bin.test.js` exercise those paths (with `PATH` as the only inherited variable, so `NODE_V8_COVERAGE` does not reach the child and V8 does not attribute them). The `bin/*` branch percentages are low for the same reason: every `--json` / `--help` / bad-stdin branch runs in a child.

## 3. End-to-end (live, costs money)

```bash
bash test/e2e/run.sh                 # = npm run e2e = node test/e2e/run.mjs: 27 cases, ~61 haiku calls + 1 sonnet call, about $0.20-0.30, 7-10 min
bash test/e2e/run.sh --list          # names, tags, per-case cost caps
bash test/e2e/run.sh --filter core   # one or more tags (comma-separated); --case <text> selects by name/file
bash test/e2e/run.sh --filter free   # the no-model cases only (hostile /singular load, /singular add): cost 0
node --test test/e2e/stream.test.mjs # unit tests for the stream parser against committed streams (no model)
```

`test/e2e/README.md` is the authoritative description of the runner (`test/e2e/run.mjs`, zero dependencies), its helpers and the isolation recipe. Cost caps: the global cap (`E2E_MAX_COST_USD`) SKIPs; each case's `costCapUsd` is enforced per call (`--max-budget-usd` = min(budget, cap minus what the case spent, >= $0.01)) and reaching it, or ending above it, FAILs the case (since 2026-10-08; before that a case could spend $0.50 per call whatever its cap said). A rejected rate limit (`rate_limit_event`, "You've hit your session limit") SKIPs the case with the reset time, like "Not logged in". `--case` takes a comma-separated list of name/file substrings. The short version of the recipe, used by every live call:

```bash
SINGULAR_HOME=<fresh dir outside the cwd> [SINGULAR_REGISTRY_BASE=http://127.0.0.1:<port>] [SINGULAR_GIT_BASE=file:///<run>/gitbase] \
claude -p "<prompt>" --output-format stream-json --verbose --include-hook-events \
  --model haiku --max-budget-usd 0.5 --no-session-persistence \
  --setting-sources project --strict-mcp-config --plugin-dir /abs/path/to/singular < /dev/null
```

with `cwd` = a temp copy of `test/fixtures/projects/next-tailwind-ts` (plus a `.git/HEAD`), an empty dir, or the plugin root. The plugin loads only via `--plugin-dir`; the user's settings are skipped with `--setting-sources project`; nothing is installed. The runner fingerprints `~/.claude/settings*.json`, `~/.claude/plugins/installed_plugins.json`, the `~/.claude/skills` listing **and** the real `~/.claude/singular` state before and after and fails the run if any changed; it refuses a `SINGULAR_HOME` inside the cwd (`hardenEnv` would silently fall back to the real state dir: never pass `--cwd /tmp` with a home under `/private/tmp/...`); it removes the `~/.claude/projects/<encoded temp cwd>` directories that Claude Code creates even with `--no-session-persistence` (only names derived from the run's own temp cwds); and it stops with SKIPs at a global cost cap (`E2E_MAX_COST_USD`, default 3).

No case needs skills.sh or github.com: a mock registry (`test/e2e/lib/registry.mjs`, node:http on a loopback port, modes `ok | delay | 429 | 500 | garbage | hostile | down`) serves the committed `test/fixtures/search.*.json` / `audit.*.json` responses plus a few synthetic allowlisted entries (`microsoft/playwright-cli@playwright-cli`, `vercel-labs/agent-skills@playwright-testing`, `anthropics/skills@pricing-page-design`, ... names that are not installed on a typical machine, so the playwright and pricing-page prompts get candidates), and a local git base (`test/e2e/lib/gitbase.mjs`: bare repositories for `multica-ai/andrej-karpathy-skills` with the real karpathy text, a plugin-shaped 12k-char `playwright-testing` skill, a 9,388-char `frontend-design`, and `evil-local/repo` with the malicious fixture plus an exec bit and a symlink) is wired through the seams in section 4. `/singular add` is never run through `claude` (it writes under `~/.claude/skills`): its case runs `node bin/singular.js add` with `HOME` and `SINGULAR_SKILLS_DIR` pointed at temp dirs. `/singular init` and `init --apply` are run the same way (case 27, `PWD` set to the temp cwd); only the read-only `/singular init --no-remote` report goes through `claude`. For the REJECTED path that case copies the run's git base (minus its `.src` trees) into a case-local directory and adds `evil-local/playwright-kit` (the malicious fixture folder plus an exec bit and a symlink) with a matching 2M-install catalog entry, so that `init` itself discovers, gates (owner allowlisted for that world) and pins the malicious candidate before `--apply` rejects it.

### Runner behaviour on stalls (added 2026-10-08)

- `runClaude` spawns `claude` in its own process group and, at `timeoutMs` (240 s), kills the whole group, so a hook, `npx` or `git` grandchild that inherited the pipes cannot keep the runner waiting; it resolves on the child's `exit` event (300 ms grace to drain output) instead of `close`.
- A call that is killed with no `result` event and no cost is treated as a transient API/CLI stall and retried once (`retryOnStall`, default true). The first attempt is kept in the artifacts as `<case>.retry.jsonl` next to the original and `r.retried === true` is set. A second stall fails the case as before.
- The login probe's transcript directory under `~/.claude/projects` is removed like every case's (fixed 2026-10-13: `projectDirName` now encodes every character outside `[A-Za-z0-9-]` as `-`, as Claude Code 2.1.296 does; it used to map only `/` and `.`, so the probe's `_probe` directory was computed as `-_probe-` instead of `--probe-` and its empty transcript dir stayed behind).
- Verified 2026-10-08: the two cases that stalled in the 2026-10-07 full run (`01-prompt-types`, `02-skip-classes`) pass alone and together under this runner ($0.025 total).

### Cases (test/e2e/cases/NN-*.mjs)

| # | case | what it asserts | model calls |
| :-- | :-- | :-- | --: |
| 01 | prompt types | research / question / coding / design / data / non-English: `UserPromptSubmit` exit 0, never `UserPromptExpansion`, context starts with `[singular] Stack: Next.js 16`, <= 2000 chars, only single tech words reached the registry; two project-scope skills seeded into the temp cwd (`e2e-nextjs-app-router`, `e2e-tailwind-landing`) are listed for the research and non-English prompts, so routing does not depend on the host's `~/.claude` | 6 haiku |
| 02 | skip classes | `hi`, a 39-char prompt, a `[singular]`-prefixed prompt and a short question inject nothing (log names the reason); the 40-char twin gets the Stack line | 5 haiku |
| 03 | slash forms | `/singular load evil/x@y` inside a fenced block and `/singular status` in prose are never expanded; `on-expand` never runs | 2 haiku |
| 04 | context shape | Next cwd (Stack first, <= 2000), empty cwd holding only a seeded project skill (no Stack line, routing line first and names `e2e-nextjs-app-router`), the plugin repo (`Stack: Node.js (ESM); branch main`), a 12,000-char prompt (budgeted, no watchdog, totalMs < 3 s) | 4 haiku |
| 05 | pasted wrapper | `<pasted_content>` lines stripped: the seeded `e2e-tailwind-landing` matches the inner text, no wrapper token in any `(matches ...)`, log `promptChars` = inner length | 1 haiku |
| 06 | suggest path | candidates + relay line + `systemMessage`; one catalog per owner, single-word searches only; the detached prefetch caches `head:` and `text:`; the next run shows `#sha7` with the unpinned load command; haiku relay rate as INFO | 2 haiku |
| 07 | local mode | routing + Stack, zero registry requests | 1 haiku |
| 08 | off mode | no context, no systemMessage, zero requests, model says NONE | 1 haiku |
| 09 | auto mode | (`SINGULAR_TEST_ALLOW_AUTO=1`) loaded block with the pinned ref, body sanitized (no `allowed-tools`, hooks, `!`/```` ```! ````, `@`-refs), truncated to <= 9,500 chars with the marker, `head:`/`text:` cached, WARNING systemMessage once, second run from cache < 2 s | 2 haiku |
| 10 | /singular load | first load pins HEAD (`loaded.json`), `#sha` = `pinned arg`, `--update` re-resolves, `MULTICA-AI/...` shares the pin, a long skill lists `truncated N chars to 9000`, the model acknowledges the skill | 5 haiku |
| 11 | /singular load hostile | `a/b@c; rm -rf ~`, `../../etc/passwd`, extra words, empty, 490-char segment, `evil/repo@x`, `blockedRefs`, `--yes`: exit 2, no `UserPromptSubmit`, 0 turns, $0, reason in the result, `loaded.json` untouched | 8 (free) |
| 12 | /singular status | Bash runs `bin/singular.js status` and the output (version, redirected state dir, `TEST SEAMS ACTIVE`, the one-screen help) reaches the model; a bare `/singular` does the same; the expansion hook stays silent for both; a natural "show me the singular status" cannot invoke the user-only command but gets the command-list hint | 3 haiku |
| 13 | singular-find | natural question with the hook off -> hard assertions: `Skill` tool_use `singular:singular-find`, Bash `bin/singular.js find`, the gated table with both playwright candidates and `Best allowlist-only rejection: evil-local/repo@playwright-helper` in the tool output, no install/load, the answer relays a candidate, the explicit query reached the registry (haiku first; observed 2026-10-08: haiku reached for WebSearch/WebFetch instead and was denied, so the question is asked once more on sonnet and the assertions run against that stream; if neither invokes the skill the case FAILs, it no longer passes silently); the same question in suggest mode (INFO: haiku answers from the hook's candidates); slash and empty forms | 4 haiku + 1 sonnet fallback |
| 14 | /singular mode | show, `suggest -> local`, `turbo` unknown, `auto` refused in a redirected home, `local -> suggest`; only the mode key changes; a model attempt to retry with `env -u SINGULAR_HOME` is reported as a WARNING | 5 haiku |
| 15 | /singular add | direct node (`bin/singular.js add`): malicious skill REJECTED before the copy (ls-tree exec bit + symlink, plugin dirs, frontmatter, shell forms), clean skill INSTALLED with the mock audit, rerun REFUSED before any network call, non-allowlisted REJECTED, no `--yes` refuses, flag-shaped name rejected; no temp dir left | 0 (free) |
| 16 | tools | `ls` + `cat` turn: exactly one `UserPromptSubmit`, >= 2 Bash tool_use, the model still echoes the Stack line afterwards | 1 haiku |
| 17 | subagent | `SubagentStart` injects the Stack line only, `parent_tool_use_id` set, one non-empty `UserPromptSubmit`; when Claude Code backgrounds the agent, the `<task-notification>` prompt is skipped and the last of two result events is used | 1 haiku |
| 18 | multi-turn | persisted session: `/singular load`, then `--resume` recalls the section titles, `--continue` quotes a bullet verbatim; the transcript holds a `hook_additional_context` attachment; the project dir is removed afterwards | 3 haiku |
| 19 | registry faults | down / slow (900 ms) / timeout (3.5 s) / 429 / 500 / garbage / hostile: hook exit 0 with the Stack line every time, fail markers or the cooldown written, hostile entries never relayed, every suggested ref grammatical | 7 haiku |
| 20 | concurrency | 3 parallel runs on one state dir: three log lines with their session ids, no error lines, no `.tmp` leftovers | 3 haiku |
| 21 | permission modes | `--permission-mode plan` and `acceptEdits`: same hook output (plan bills sonnet, ~$0.04, hence the $0.08 cap) | 2 haiku |
| 22 | piped stdin | prompt only on stdin fires the hook; stdin appended to a `-p` argument is scored (`promptChars` grows) | 2 haiku |
| 23 | project settings env | `.claude/settings.json` `env`: `SINGULAR_MODE=off` honoured, `auto` ignored with a warning; offline: a relative or in-project `SINGULAR_HOME` is ignored, nothing written into the project | 2 haiku |
| 24 | pinnedSkills | ref pinned, fetched, injected once per session (model echoes the 40-hex ref; the resumed turn gets nothing), bad entries warned | 2 haiku |
| 25 | hook timing | warm `totalMs` < 2000 correlated by `session_id`, no warnings other than the test-seam notices | 3 haiku |
| 26 | relay (sonnet) | hook side asserted; whether sonnet ends with `Load with /singular load <ref>` is an INFO metric | 1 sonnet |
| 27 | /singular init | direct node (`bin/singular.js init`, fake `HOME`, two seeded project skills): the exact `Stack`, `Needs (8)`, `Covered by installed skills: next -> e2e-nextjs-app-router; tailwind -> e2e-tailwind-landing` and `Not covered` lines, 2-8 numbered candidates in the fixed shape with `#sha7` = the git base HEAD (`playwright-cli` audit pass, `playwright-testing` / `stripe-best-practices` audit warn, a source outside the git base flagged `HEAD not resolved: not approvable`), no `evil-local` entry (not allowlisted), `playwright-flaky` under the floor, the `Approve:` line, nothing installed; `init-plan.json` in `SINGULAR_HOME` (version 1, cwd, needs, uncovered, every approvable ref pinned to a 40-hex sha); one search per uncovered need plus `nextjs` ("also"), no catalog fetch. `--apply <n of playwright-cli>` into `SINGULAR_SKILLS_DIR`: the exact header, `INSTALLED n. microsoft/playwright-cli#sha7@playwright-cli -> ... (audit pass)`, `Installed:`, the deterministic kickoff prompt (`Using the skill playwright-cli, review this Next.js 16 + React 19 project: ...`, <= 400 chars), `Reload:`; the folder holds `SKILL.md` only, `installed.json` records the plan sha, no temp dir, nothing under the fake `HOME` or the project; a rerun prints `SKIPPED (exists)` with no kickoff. A malicious allowlisted candidate (case-local git base + catalog entry, see above) is listed and pinned by `init`, then `--apply` prints `REJECTED ... executable bit ...; symlink ...; +N more (nothing was written)`, exit 1, nothing in the skills dir, not in `installed.json`. Live: `/singular init --no-remote` runs `node .../bin/singular.js init --no-remote` through Bash (no `--apply` in any command, expansion hook silent), the Stack / Needs / Covered / Not covered lines and `skipped (--no-remote)` reach the model, the answer relays `Needs`, the plan lands in the redirected `SINGULAR_HOME`, zero registry requests; INFO: whether haiku relayed the Needs line verbatim and whether it asked which numbers to install | 1 haiku |

### Last runs

2026-10-13, case 27 alone after `/singular init` was added (Claude Code 2.1.296, Node v26.5.0, haiku; `E2E_MAX_COST_USD=0.5 node test/e2e/run.mjs --case 27-singular-init --tmp <scratch>/e2e`; two runs, both PASS, $0.0039 each including the login probe; the second, with the final case file, shown):

```
PASS  /singular init: report + plan (direct node), --apply INSTALLED / SKIPPED, REJECTED malicious candidate, live --no-remote via slash  ($0.0024, 12.7 s, 1 call)
      INFO    init: 631 ms, 7 candidates (1 unresolved), 14 registry requests (7 searches, 7 audits); 1. vercel-labs/agent-skills#7473556@vercel-react-best-practices   741K installs   audit unknown   for: react | 2. anthropics/claude-plugins-official#cf9c8cb@stripe-best-practices   1.4K installs   audit warn   for: stripe | 3. vercel-labs/agent-skills#7473556@playwright-testing   15.0K installs   audit warn   for: playwright | 4. vercel-labs/agent-skills#7473556@vercel-react-native-skills   221K installs   audit unknown   for: react | 5. microsoft/playwright-cli#68a356a@playwright-cli   61.2K installs   audit pass   for: playwright | 6. vercel-labs/agent-skills#7473556@vercel-react-view-transitions   132K installs   audit unknown   for: react | 7. vercel-labs/json-render@react   11.5K installs   audit unknown   for: react   (HEAD not resolved: not approvable)
      INFO    apply: 5. microsoft/playwright-cli#68a356ac247065884cab35779d7cca3082af00df@playwright-cli -> INSTALLED, then SKIPPED (exists); $0
      INFO    malicious: 5. evil-local/playwright-kit#c69ad26@playwright-kit   2.0M installs   audit unknown   for: playwright -> REJECTED 5. evil-local/playwright-kit#c69ad26@playwright-kit: executable bit in repository tree: playwright-kit/bin/pwn (mode 100755); symlink in repository tre
      INFO    live: $0.0024, 9159 ms, tools=Bash; Needs line verbatim in the answer: yes; asked which to install: no; explained that --no-remote lists no candidates: yes; bash: node "/Users/nitya/.superset/projects/claude-skills/bin/singular.js" init --no-remote; result: ``` [singular] init: cwd Stack: Next.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm; branch main Needs (8): next (
PASS  ~/.claude/settings*.json, installed_plugins.json and ~/.claude/skills unchanged
PASS  real ~/.claude/singular untouched
e2e: 1 passed, 0 failed, 0 skipped; total cost $0.0039 (cap $0.5000)
```

In both runs haiku ran exactly `node "<plugin root>/bin/singular.js" init --no-remote`, relayed the whole report verbatim in a code block (on that machine the host index covered `react` too: `react -> vercel:react-best-practices`), never issued an `--apply`, and explained that nothing can be installed from a `--no-remote` report, pointing at a run without the flag ("Nothing installs until you pick numbers"). The first run's INFO line said "asked which to install: yes" because its heuristic matched the word "install" inside that explanation; the heuristic was narrowed to a real question (`which numbers`, `would you like me to install`, ...) and a separate "explained" flag before the second run. The candidate that `init` ranks first for `react` (`vercel-react-best-practices`) has no folder in the e2e git base (`vercel-labs/agent-skills` there holds only `playwright-testing`), which is why the case approves the `playwright-cli` candidate by the number it reads from the plan (5 in both runs) rather than a literal `--apply 1`. The `init` wall time (2,023 ms cold while the login probe was still winding down, 631 ms the second time) is reported, not asserted.

2026-10-13, full run after the rename to singular, the `/singular` single-command rebuild and the `singular` CLI (Claude Code 2.1.296, Node v26.5.0, haiku + one sonnet call, work dir under the scratchpad): `E2E_MAX_COST_USD=3 node test/e2e/run.mjs --tmp <scratch>/e2e`, 7.2 min wall:

```
PASS  prompt-types: research / question / coding / design / data / non-English  ($0.0079, 26.1 s, 6 calls)
PASS  skip classes: hi / 39 chars / [singular] prefix / short question; 40 chars routes  ($0.0153, 56.7 s, 5 calls)
PASS  slash forms: fenced /singular load and prose /singular status are not expanded  ($0.0028, 6.7 s, 2 calls)
PASS  context shape: Next cwd / empty cwd / plugin repo cwd / 12k-char prompt  ($0.0069, 11.6 s, 4 calls)
PASS  pasted_content wrapper is stripped before scoring  ($0.0032, 13.5 s, 1 call)
PASS  suggest path: candidates + relay line + systemMessage; prefetch caches head/text; #sha7 next time  ($0.0032, 12.4 s, 2 calls)
PASS  local mode: routing without any network request  ($0.0018, 4.7 s, 1 call)
PASS  off mode: hook no-op, model sees no Stack line  ($0.0015, 2.5 s, 1 call)
PASS  auto mode: loaded block in context, sanitized, truncated, pin cached, warning once  ($0.0044, 12.0 s, 2 calls)
PASS  /singular load happy: pin, #sha, --update, case-normalized, truncation, model acknowledges  ($0.0086, 16.4 s, 5 calls)
PASS  /singular load hostile table: shell metachars, traversal, extra words, empty, over-long, non-allowlisted, blockedRefs  ($0.0000, 10.7 s, 8 calls)
PASS  /singular status and bare /singular via slash (Bash tool_use + output) and the user-only hint for a natural prompt  ($0.0090, 36.6 s, 3 calls)
PASS  singular-find: natural prompt (Skill tool_use), /singular find slash form, empty form  ($0.0625, 64.0 s, 5 calls)
PASS  /singular mode: show | local | turbo (unknown) | auto (refused) | suggest  ($0.0103, 33.0 s, 5 calls)
PASS  /singular add (direct node): REJECTED malicious, INSTALLED clean, REFUSED rerun, allowlist, --yes  ($0.0000, 0.8 s, 0 calls)
PASS  tools: ls/cat turn fires the prompt hook once; context honoured after tools  ($0.0020, 4.5 s, 1 call)
PASS  subagent: SubagentStart injects Stack, task-notification skipped, last result used  ($0.0043, 10.0 s, 1 call)
PASS  multi-turn: /singular load then --resume and --continue recall the loaded skill  ($0.0087, 7.9 s, 3 calls)
PASS  registry faults: down / slow / timeout / 429 / 500 / garbage / hostile  ($0.0125, 46.8 s, 7 calls)
PASS  concurrency: 3 parallel runs against one state dir  ($0.0056, 7.9 s, 3 calls)
PASS  permission modes plan / acceptEdits: hook unchanged  ($0.0387, 7.8 s, 2 calls)
PASS  piped stdin: prompt from stdin; stdin appended to the argument  ($0.0026, 4.7 s, 2 calls)
PASS  project settings env: off honoured, auto ignored, in-project SINGULAR_HOME ignored  ($0.0032, 7.4 s, 2 calls)
PASS  pinnedSkills: loaded block once per session, model reads the pinned ref  ($0.0048, 5.0 s, 2 calls)
PASS  hook timing: warm totalMs < 2000, no unexpected warnings  ($0.0038, 9.1 s, 3 calls)
PASS  suggestion relay on sonnet (INFO metric, 1 run)  ($0.0353, 8.6 s, 1 call)
PASS  ~/.claude/settings*.json, installed_plugins.json and ~/.claude/skills unchanged
PASS  real ~/.claude/singular untouched
e2e: 26 passed, 0 failed, 0 skipped; total cost $0.2604 (cap $3.0000)
```

Observations: the natural "show me the singular status" prompt now receives the `/singular` command list (the hint that still listed the pre-rename command names in the partial run earlier that day); haiku relayed a `/singular load` line for the suggest-path prompt and sonnet relayed one in case 26 (`Load with /singular load microsoft/playwright-cli@playwright-cli`); case 13 again needed its sonnet fallback (haiku reached for WebSearch/WebFetch and was denied); the subagent relayed the Stack line. The same day, four calls through the recipe against the payload that `singular install` had copied to a scratch `HOME/.claude/singular/plugin` (`--plugin-dir` pointing at that copy, haiku, $0.0066 in all) behaved identically: `/singular status` ran `node <payload>/bin/singular.js status` through Bash and relayed it ($0.0032); `/singular load multica-ai/andrej-karpathy-skills@karpathy-guidelines` fired `UserPromptExpansion` (exit 0, pinned `2c60614…`) and haiku answered "Loaded `karpathy-guidelines` ... (pinned sha 2c606141936f1eeef17fa3043a72095b4765b9c2)" ($0.0015); `/singular load evil/x@y` was blocked (exit 2, 0 turns, $0); a plain 40+ char prompt got `[singular] Stack: Next.js 16, ...` ($0.0019). The runner's two global-state checks passed; separately, the real `~/.claude/plugins/known_marketplaces.json` had its `claude-plugins-official` `lastUpdated` stamp rewritten by Claude Code at 01:35:27 while `test/cli-install.test.js` ran under coverage (no `singular` entry, no other change; the isolated config dir of that test never held the official marketplace), which is why that guard now ignores `lastUpdated`.

2026-10-08, after the review fixes (Claude Code 2.1.294; the changed cases 01, 04, 05, 10, 13, 21, 23 plus the free 11 and 15): the account's five-hour session window was exhausted (`rate_limit_event` status `rejected`, `resetsAt` 08:50 UTC) and every model call returned "You've hit your session limit" at $0. What that run still proves, because the hooks run before the model is called: the seeded project skills route exactly as asserted (`05` PASS with `matches: build, landing, page, tailwind`; `04` PASS, the empty cwd lists `e2e-nextjs-app-router` first; `01`'s routing lines held, only its exit-code / `is_error` checks failed), `/singular add` with the allowlisted child environment installs and rejects through real git (`15` PASS), the hostile `/singular load` table is blocked before any model call (`11` PASS), `10`'s pin / `#sha` / `--update` hook assertions held, `23`'s env hardening held, and the two global-state fingerprints were unchanged. The runner now reports such calls as SKIP (with the reset time) instead of FAIL; the model-dependent assertions of 01, 10, 13, 21 and 23 have not been re-verified live since the fixes. Re-run after the window resets with:

```bash
node test/e2e/run.mjs --case 01-prompt-types,04-context-shape,05-pasted,10-singular-load,13-singular-find,21-permission,23-project
```

Offline ($0) the same assertions were checked against the mock registry and git base: `node bin/on-prompt.js --dry-run` in the seeded worlds lists `e2e-nextjs-app-router (matches server, components, client, nextjs)` / `e2e-tailwind-landing (matches landing, page, nextjs, tailwind)` first, and `node bin/singular.js find playwright e2e testing` prints both candidates and `Best allowlist-only rejection: evil-local/repo@playwright-helper`.


Two full runs earlier on 2026-10-08 (Claude Code 2.1.293, macOS, Node v26.5.0, haiku + one sonnet call; work dirs under the scratchpad; before the per-case cap was enforced and before cases 01/04/05 seeded project skills):

```
e2e: 19 passed, 7 failed, 0 skipped; total cost $0.2025 (cap $3.0000)   (run 1, before the assertion fixes listed below)
e2e: 25 passed, 1 failed, 0 skipped; total cost $0.2017 (cap $3.0000)   (run 2)
e2e: 1 passed, 0 failed, 0 skipped; total cost $0.0644 (cap $3.0000)   (case 13 alone, after its rework: the natural question is asked with the hook off, haiku first, sonnet once as fallback)
```

| # | case | run 1 | run 2 | cost (run 2) | calls | wall |
| :-- | :-- | :-- | :-- | --: | --: | --: |
| 01 | prompt-types: research / question / coding / design / data / non-English | PASS | PASS | $0.0079 | 6 | 22.4 s |
| 02 | skip classes: hi / 39 chars / [singular] prefix / short question; 40 chars routes | PASS | PASS | $0.0170 | 5 | 60.7 s |
| 03 | slash forms: fenced /singular load and prose /singular status are not expanded | PASS | PASS | $0.0028 | 2 | 6.7 s |
| 04 | context shape: Next cwd / empty cwd / plugin repo cwd / 12k-char prompt | PASS | PASS | $0.0053 | 4 | 11.1 s |
| 05 | pasted_content wrapper is stripped before scoring | PASS | PASS | $0.0040 | 1 | 18.2 s |
| 06 | suggest path: candidates + relay line + systemMessage; prefetch caches head/text; #sha7 next time | FAIL | PASS | $0.0034 | 2 | 12.1 s |
| 07 | local mode: routing without any network request | PASS | PASS | $0.0017 | 1 | 4.8 s |
| 08 | off mode: hook no-op, model sees no Stack line | PASS | PASS | $0.0015 | 1 | 2.2 s |
| 09 | auto mode: loaded block in context, sanitized, truncated, pin cached, warning once | FAIL | PASS | $0.0031 | 2 | 11.6 s |
| 10 | /singular load happy: pin, #sha, --update, case-normalized, truncation, model acknowledges | PASS | PASS | $0.0084 | 5 | 14 s |
| 11 | /singular load hostile table: shell metachars, traversal, extra words, empty, over-long, non-allowlisted, blockedRefs | PASS | PASS | $0.0000 | 8 | 8.9 s |
| 12 | /singular status via slash (Bash tool_use + output) and the user-only hint for a natural prompt | PASS | PASS | $0.0053 | 2 | 16.2 s |
| 13 | singular-find: natural prompt (Skill tool_use), slash form, empty form | FAIL | FAIL | $0.0068 | 4 | 18 s |
| 14 | /singular mode: show | local | turbo (unknown) | auto (refused) | suggest | PASS | PASS | $0.0095 | 5 | 26.4 s |
| 15 | /singular add (direct node): REJECTED malicious, INSTALLED clean, REFUSED rerun, allowlist, --yes | PASS | PASS | $0.0000 | 0 | 0.7 s |
| 16 | tools: ls/cat turn fires the prompt hook once; context honoured after tools | PASS | PASS | $0.0020 | 1 | 3.5 s |
| 17 | subagent: SubagentStart injects Stack, task-notification skipped, last result used | FAIL | PASS | $0.0042 | 1 | 6.5 s |
| 18 | multi-turn: /singular load then --resume and --continue recall the loaded skill | PASS | PASS | $0.0070 | 3 | 7.1 s |
| 19 | registry faults: down / slow / timeout / 429 / 500 / garbage / hostile | FAIL | PASS | $0.0129 | 7 | 46 s |
| 20 | concurrency: 3 parallel runs against one state dir | FAIL | PASS | $0.0059 | 3 | 7.8 s |
| 21 | permission modes plan / acceptEdits: hook unchanged | PASS | PASS | $0.0403 | 2 | 5.6 s |
| 22 | piped stdin: prompt from stdin; stdin appended to the argument | PASS | PASS | $0.0026 | 2 | 4.8 s |
| 23 | project settings env: off honoured, auto ignored, in-project SINGULAR_HOME ignored | PASS | PASS | $0.0031 | 2 | 6.2 s |
| 24 | pinnedSkills: loaded block once per session, model reads the pinned ref | FAIL | PASS | $0.0050 | 2 | 4.1 s |
| 25 | hook timing: warm totalMs < 2000, no unexpected warnings | PASS | PASS | $0.0039 | 3 | 8.4 s |
| 26 | suggestion relay on sonnet (INFO metric, 1 run) | PASS | PASS | $0.0366 | 1 | 9.4 s |

Run 1 failures (all in the suite, none in the plugin), fixed before run 2:
- FAILED  every /singular load ref in the context is grammatical — ["<ref>`","vercel-labs/agent-skills@playwright-testing","microsoft/playwright-cli@playwright-cli"]
- FAILED  frontmatter keeps only name/description/license — /^">\n---\nname: playwright-testing\ndescription: [^\n]+\nlicense: MIT\n---/ did not match: "vercel-labs/agent-skills#7e25d2e66c84e96eadfcccf177f38a90cc66e6cb@playwright-testing"> --- name: playwright-testing description: Write and debug Pl
- FAILED  Skill tool_use singular:singular-find — []
- FAILED  Bash tool_use runs bin/singular.js find — []
- FAILED  script output: gated table — "Third-party candidates (gated: allowlist, install floor, audit; NOT installed):" not found in:
- FAILED  script output: playwright-cli candidate — "microsoft/playwright-cli@playwright-cli" not found in:
- FAILED  script output: playwright-testing candidate — "vercel-labs/agent-skills@playwright-testing" not found in:
- FAILED  script output names the best allowlist-only rejection — "Best allowlist-only rejection: evil-local/repo@playwright-helper" not found in:
- FAILED  singular.log: the task-notification prompt was skipped — [null]
- FAILED  hostile: every suggested ref is grammatical — ["<ref>`","vercel-labs/agent-skills@playwright-testing","microsoft/playwright-cli@playwright-cli"]
- FAILED  undefined — expected no leftover .tmp files in the cache, got 0
- FAILED  unknown pinned name warned
- FAILED  non-allowlisted pinned ref ignored with a warning

Run 2 failures:
- FAILED  Skill tool_use singular:singular-find — []
- FAILED  Bash tool_use runs bin/singular.js find — []
- FAILED  script output: gated table — "Third-party candidates (gated: allowlist, install floor, audit; NOT installed):" not found in:
- FAILED  script output: playwright-cli candidate — "microsoft/playwright-cli@playwright-cli" not found in:
- FAILED  script output: playwright-testing candidate — "vercel-labs/agent-skills@playwright-testing" not found in:
- FAILED  script output names the best allowlist-only rejection — "Best allowlist-only rejection: evil-local/repo@playwright-helper" not found in:
- FAILED  model relays a candidate — /playwright-cli|playwright-testing/ did not match: No installed skill is specifically for Playwright end-to-end testing. The closest matches are: - **`run`**: launches the app and drives it in a browser to confirm a change works. It's for m
- FAILED  the explicit query reached the registry — []

Case 13 re-run:
- PASS  singular-find: natural prompt (Skill tool_use), slash form, empty form  ($0.0629, 42.6 s, 5 calls)
- haiku did not invoke the Skill tool for the natural question (tools=Bash,WebSearch,Bash,Bash,Bash,ToolSearch,WebFetch; $0.0038); retrying once on sonnet. haiku answer: No Playwright skill is installed, but I couldn't check skills.sh because the web fetch was denied. **Installed skills:**
- natural (suggest mode, not asserted): Skill tool NOT used; candidates in the answer: yes (hook context had candidates); $0.0037

Observations worth keeping (INFO lines):
- PASS  suggestion relay on sonnet (INFO metric, 1 run)  ($0.0366, 9.4 s, 1 call)
- cold run (coding): {"indexMs":14.271917,"localMs":25.87275,"discoverMs":24.643958,"totalMs":51.787084}
- warm run (question): {"indexMs":14.257292,"localMs":25.810667,"totalMs":27.146833}
- subagent was run inline (no task-notification prompt)
- plan: billed models claude-sonnet-5-5, $0.0387, 1 turn(s)
- acceptEdits: billed models claude-haiku-5-5, $0.0016, 1 turn(s)
- timeout: discoverMs=5630.817875 totalMs=5658.28775 requests=6 errors=catalog "skill" owner=anthropics: timeout after 2500ms wall=10037 ms $0.0018
- 12k prompt: context 348 chars, hook timings {"indexMs":14.147709,"localMs":27.121125,"totalMs":28.528083}, result The team discussed four workstreams (checkout service migration, the Playwright
- PASS  concurrency: 3 parallel runs against one state dir  ($0.0059, 7.8 s, 3 calls)
- haiku relay: result CONTAINS a /singular load line (not asserted); result: I haven't read the repo, so these bullets are based on the stack (Next.js, Stripe, Supabase, Playwright) and will need a

What the stream contains: `system` events with `subtype: hook_started` / `hook_response` (keys observed on 2.1.293: `type, subtype, hook_id, hook_name, hook_event, output, stdout, stderr, exit_code, outcome, uuid, session_id`; no timing field, so correlate with `singular.log`, whose `on-prompt` lines carry `sessionId` and `promptId`), `assistant` / `user` messages with `tool_use` / `tool_result` blocks (`parent_tool_use_id` set inside a subagent), and `result` events (`result`, `total_cost_usd`, `num_turns`, `is_error`, `permission_denials`). With a backgrounded subagent there are **two** `result` events, so read the last; the runner's parser (`test/e2e/lib/stream.mjs`, unit-tested in `test/e2e/stream.test.mjs` against captured streams) does.

Things that do not work for isolation (verified): `CLAUDE_CONFIG_DIR=<fresh dir>` and `--bare` are "Not logged in"; `HOME=<tmp>` + `CLAUDE_CONFIG_DIR=<real>` also fails to log in **and** writes a stub `.claude.json` into the real config dir; a project `.claude/settings.json` `env.HOME` does not reach the hook (`env.SINGULAR_MODE` does).

`/singular` subcommands other than `load` run `node bin/singular.js` through the Bash tool; in non-interactive mode add `--allowedTools "Bash(node:*)"` or the call is denied. Spawning a subagent needs `--allowedTools Agent`.

## 4. Test seams

These environment variables exist **only** for tests. They are not user features, are not documented anywhere else, are validated narrowly in `lib/config.js testSeams()` (invalid values are dropped by `hardenEnv` with a warning), are logged as `TEST SEAM ACTIVE: ...` by every entrypoint and listed by `/singular status` (`TEST SEAMS ACTIVE`), and the code paths are byte-identical to production when they are unset (`unit-refs.test.js`, `unit-registry.test.js`, `unit-git.test.js` and `unit-bin.test.js` assert the exact production URLs, argv and child environment). The seam variables themselves are never forwarded to a git or npx child (`lib/git.js childEnv`).

| variable | honoured form | effect |
| :-- | :-- | :-- |
| `SINGULAR_REGISTRY_BASE` | `http(s)://localhost`, `127.0.0.1` or `[::1]` with optional port and path, no query | replaces `https://skills.sh` for `/api/search` (catalogs, keyword searches, explicit searches) and `/api/v1/skills/audit/...`; display URLs still point at skills.sh. Any other host is refused |
| `SINGULAR_GIT_BASE` | absolute local path or `file:///abs/path` URL, **neither inside nor an ancestor of** the project cwd | replaces `https://github.com` in `git ls-remote <base>/<owner>/<repo> HEAD` and in the pinned fetch, and makes `fetchSkillText` (so `/singular load`, `auto`, `pinnedSkills`, the prefetch) clone the pinned commit with git and read `SKILL.md` itself instead of running `npx skills use`. `/singular add` uses the same base. `http(s)://` values are refused: a repository's env block must never redirect a trusted ref to another host; an ancestor (`/workspaces` for a project at `/workspaces/anthropics`) is refused since 2026-10-08 because `<base>/<owner>/<repo>` would then be a sibling checkout or the project itself. The e2e runner keeps its base beside the temp cwds, never above them |
| `SINGULAR_SKILLS_DIR` | absolute path neither inside nor an ancestor of the project cwd | replaces `~/.claude/skills` as the `/singular add` target (and the pre-existence check) |
| `SINGULAR_TEST_ALLOW_AUTO` | exactly `1` | honours `mode: "auto"` written in a **redirected** `SINGULAR_HOME/config.json`, which production always downgrades to `suggest`. `SINGULAR_MODE` still cannot raise the mode; the one-time auto warning still fires |

A git fixture is a directory tree `<base>/<owner>/<repo>` where `<repo>` is a bare (or ordinary) repository: `git init -q -b main src && ... && git clone -q --bare src <base>/<owner>/<repo>`. `git ls-remote`, `fetch --depth 1 origin <sha>` and `checkout FETCH_HEAD` all work against it (verified; `unit-bin.test.js` "bin/singular.js add as a child process with real git" is the worked example, including the REJECTED path for a plugin-shaped skill with an executable and a symlink).

A registry fixture is any HTTP server on a loopback port that answers `GET /api/search?q=...&limit=200[&owner=...]` with `{"skills":[{source, skillId, name, installs}]}` and `GET /api/v1/skills/audit/<owner>/<repo>/<skill>` with `{"audits":[{provider, status, riskLevel}]}` (404 = no audit). The fixtures under `test/fixtures/search.*.json` and `audit.*.json` are real captured responses.

Example, end to end without `npx` and without github.com:

```bash
export SINGULAR_HOME=/abs/scratch/home            # fresh, outside the cwd
export SINGULAR_GIT_BASE=file:///abs/scratch/git  # contains evil-local/repo (bare)
printf '{ "mode": "suggest", "allowlist": ["evil-local"] }\n' > "$SINGULAR_HOME/config.json"
node bin/on-expand.js evil-local/repo@helpful-setup          # text fetched with git, sanitized, pinned
HOME=/abs/scratch/fakehome node bin/singular.js add evil-local/repo@helpful-setup --yes   # REJECTED: executable bit, symlink, hooks/, ...
```

## 5. Cost expectations

| run | model calls | cost | time |
| :-- | :-- | --: | --: |
| `npm test` | none | $0 | ~14 s (15 files; the child-process, real-git and the real `claude plugin` integration tests dominate) |
| coverage run | none | $0 | ~16 s |
| `bash test/e2e/run.sh` (27 cases) | 76 haiku calls (8 blocked `/singular load`s cost 0; plan mode bills sonnet) + 1 sonnet relay call + 1 sonnet fallback in case 13 when haiku skips the Skill tool | ~$0.25 | 7-10 min |
| `bash test/e2e/run.sh --filter free` | none (hostile `/singular load`, `/singular add`) | $0 | ~12 s |
| one haiku prompt through the recipe | 1 | $0.001-0.004 | 5-15 s |
| one sonnet prompt (only for model-behaviour checks: relaying suggestions, using a loaded skill) | 1 | $0.02-0.06 | 10-40 s |
| 21 haiku prompt-class probes (the explorers' table) | 21 | $0.12 | ~4 min |

Hook-side time is independent of the model: the `UserPromptSubmit` hook measured 20-130 ms in-process warm, 2.5 s cold for 4 catalogs + 2 searches + 4 audits, up to `remoteTimeoutMs` more once per failing owner per 5 minutes; `SubagentStart` ~1-35 ms; `/singular load` 2-6 s on the first load of a ref (HEAD resolve + pinned `npx skills use`), ~0.3 s from the text cache afterwards.
