# Singular

Singular is a Claude Code plugin with one command, `/singular`, that finds the right skill for the prompt you are typing. On every prompt it routes to the skills you already have installed and injects the project's stack (Next.js 16, Tailwind 4, TypeScript strict, pnpm, branch) as one factual line; when nothing local fits, it looks up third-party skills on [skills.sh](https://skills.sh), ranks them by relevance to your prompt (never sending the prompt itself), gates them by an owner allowlist, an install floor and the public audit, and offers them as a one-line suggestion. `/singular load owner/repo@skill` then loads that skill's text into the session, pinned to a commit and sanitized, without writing anything to `~/.claude/skills`; `/singular add` installs it persistently only after the folder has been inspected for anything that would turn a skill into a plugin. `/singular init` inspects the project you just opened, says which of its needs your installed skills already cover, proposes numbered, commit-pinned third-party candidates for the rest, and installs only the numbers you approve with `/singular init --apply`. Zero npm dependencies, Node >= 20, every piece is a plain `node` script you can run by hand.

## Get started (30 seconds)

```bash
npm install -g singular-skill      # install the CLI (or: npx singular-skill install)
singular install                   # register the skill with Claude Code
```

Open a new Claude Code session and type `/singular`.

`singular install` checks `node` (>= 20) and `claude` (>= 2.1.282), copies the plugin into `~/.claude/singular/plugin/` (so the path Claude Code holds stays valid across Node upgrades and `nvm` switches), registers that directory as the `singular` marketplace and installs `singular@singular` at user scope. It ends with `Installed. Open a new Claude Code session (or run /reload-plugins) and type /singular`. Nothing else on disk is touched: no `settings.json` edits, nothing under `~/.claude/skills`.

### No npm?

```bash
git clone https://github.com/Nityasav/singular
cd singular
node bin/singular-cli.js install
```

Same result; `node bin/singular-cli.js` is the `singular` binary. To try the plugin for one session without installing anything: `claude --plugin-dir /path/to/singular` (it shows up as `singular@inline`).

Requirements for the remote features: `git` on `PATH` (used for commit pinning and for `/singular add`), network access to `skills.sh` and `github.com`. `npx` runs only when a skill's *text* is fetched (`/singular load`, `mode: "auto"`, `pinnedSkills`, the background prefetch), always as the pinned `skills@1.5.26`; `/singular add` and `/singular init --apply` use `git` only.

## Set up a project (`/singular init`)

"I just opened a project; which skills should I have?" Three steps; nothing is installed until the third.

**1. Report.** Type `/singular init`. Claude runs `node "${CLAUDE_PLUGIN_ROOT}/bin/singular.js" init`, shows the report verbatim and asks which numbered candidates you want (or none). Observed 2026-10-13 from the Next.js fixture project with 171 installed skills indexed (first run 7.9 s wall: 8 skills.sh searches, the audits of the shortlisted candidates and one `git ls-remote` per repository; a rerun within 24 h is served from the cache in 0.12 s):

```
[singular] init: proj
Stack: Next.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm
Needs (8): next (dep), react (dep), supabase (dep), stripe (dep), tailwind (dep), vitest (dep), playwright (dep), typescript (dep)
Covered by installed skills: next -> vercel:nextjs; react -> vercel:react-best-practices
Not covered: supabase, stripe, tailwind, vitest, playwright, typescript
Suggested third-party skills (pinned, not installed):
  1. anthropics/claude-plugins-official#f359d43@stripe-best-practices   1.4K installs   audit warn   for: stripe
  2. anthropics/skills#dbd4588@webapp-testing   176K installs   audit warn   for: playwright
  3. vercel-labs/agent-skills#063bee9@vercel-react-best-practices   794K installs   audit pass   for: react (also)
  4. microsoft/playwright-cli#b85c7a7@playwright-cli   182K installs   audit warn   for: playwright
  5. vercel-labs/agent-skills#063bee9@vercel-react-native-skills   239K installs   audit warn   for: react (also)
  6. microsoft/playwright#a3401cf@playwright-dev   3.6K installs   audit warn   for: playwright
  7. vercel-labs/agent-skills#063bee9@vercel-react-view-transitions   151K installs   audit pass   for: react (also)
  8. vercel-labs/json-render#5473fe1@react   14.6K installs   audit pass   for: react (also)
Approve: /singular init --apply 1,2   (or: all)   Add --project to install into ./.claude/skills instead of ~/.claude/skills
```

**2. Approve.** Answer with the numbers (`2 and 3`, `all`, `none`), or type the command yourself: `/singular init --apply 2,3`. Claude runs `node "${CLAUDE_PLUGIN_ROOT}/bin/singular.js" init --apply 2,3` (plus `--project` if you asked for a project-local install) and shows the result verbatim. Observed for `2,3` (3.5 s: two pinned `git fetch`es; paths shortened):

```
[singular] init --apply 2,3: 2 of 8 candidates for proj (plan from 2026-10-13T08:20:02.197Z) -> /Users/you/.claude/skills
REJECTED 2. anthropics/skills#dbd4588@webapp-testing: executable bit in repository tree: skills/webapp-testing/scripts/with_server.py (mode 100755); plugin component directory scripts/; executable bit on scripts/with_server.py (nothing was written)
INSTALLED 3. vercel-labs/agent-skills#063bee9@vercel-react-best-practices -> /Users/you/.claude/skills/vercel-react-best-practices (audit pass)
Installed: vercel-react-best-practices
Kickoff prompt (copy or say "run it"):
  Using the skill vercel-react-best-practices, review this Next.js 16 + React 19 project: list the 3 highest-impact improvements for react, then implement the first one.
Reload: new skills are picked up automatically; run /reload-skills if /singular status does not list them.
```

Candidate 2 failed the same inspection `/singular add` runs (a `scripts/` directory with an executable file would make the folder a plugin, not prose) and nothing was written; candidate 3 was copied as 76 plain files. Running the same `--apply` again prints `SKIPPED 3. ... (exists: /Users/you/.claude/skills/vercel-react-best-practices)`, `Installed: none`, `Kickoff prompt: none (nothing new was installed)` (exit 0); with `--project` the same candidate goes to `./.claude/skills/vercel-react-best-practices` instead.

**3. Kickoff.** Claude asks whether to run the kickoff prompt now. Say "run it" and it follows that prompt, invoking the named skills with the Skill tool; or copy the line into a later prompt. The prompt is generated deterministically from the stack and the installed skill names (no model call, at most 400 characters), so the skills are named exactly as the Skill tool needs them.

### What the report lines mean

| line | meaning |
| :-- | :-- |
| `Stack:` | the one-line summary the hook injects on every prompt (`(unknown)` without a manifest) |
| `Needs (N):` | up to 12 things this project needs a skill for, strongest first, each with where the signal came from: `dep` (a dependency in `package.json`, `pyproject.toml`, `requirements*.txt`, `Pipfile`, `go.mod`, `Cargo.toml`, `Gemfile` or `pom.xml`, mapped through a built-in lexicon: `next`, `react`, `tailwind`, `prisma`, `supabase`, `stripe`, `auth`, `playwright`, `fastapi`, `django`, `openai`, `mcp`, …), `file` (a tooling file or directory: `Dockerfile`, `docker-compose.yml`, `.github/workflows`, `vercel.json`, `terraform/`, `supabase/`, `prisma/`, `turbo.json`, `pnpm-workspace.yaml`, `nx.json`, `playwright.config.*`, `tsconfig.json`, …, or the dominant language by file extension), `readme` (a tech word in the first 40 lines of `README.md` or `CLAUDE.md`). A directory without signals prints `Needs (0): no signals`. The scan is read-only, three levels deep, skips `node_modules`, `.git`, `dist`, `build`, `.next`, `venv` and the like, never follows symlinks and stops after 5,000 entries |
| `Covered by installed skills:` | `need -> skill` for every need an installed skill (user, project, plugin or claude.ai-synced) already matches by name or description. Covered needs get no candidate, except that the three strongest needs are searched anyway and their candidates are flagged `(also)` |
| `Not covered:` | the needs no installed skill matches; each one is searched on skills.sh as a single need word (`q=supabase`): the word from the lexicon, never your README text or dependency names |
| `1. owner/repo#sha7@skill   installs   audit status   for: need` | a candidate that passed the same gates as the hook (owner allowlist, `blockedRefs`, install floor, fork dedupe, already-installed names, audit `fail` dropped), ranked by relevance x log10(installs), taken round-robin across needs, at most `initMaxCandidates` (8). `#sha7` is the commit the plan is **pinned** to: HEAD was resolved when the report was made, and `--apply` installs exactly that commit even if the repository has moved on since. A candidate whose HEAD could not be resolved is listed with `(HEAD not resolved: not approvable)` and skipped by `--apply` |
| `Approve:` | the exact command to type; `all` takes every approvable candidate; `--project` targets `./.claude/skills` |

When no candidate survives, the line reads `Suggested third-party skills (pinned, not installed): none passed the gates`, `none (skills.sh rate-limited until HH:MM)`, `none (third-party search failed: timeout / network error)` or `none (no needs to search)`, and an `Errors:` line names any failed request.

### Options

- `/singular init --no-remote`: installed-only; no network at all. The report ends with `Suggested third-party skills: skipped (--no-remote)` and the plan is written without candidates (a later `--apply` says `the plan has no candidates; run /singular init again`).
- `/singular init --apply <1,3 | 1-3 | all> [--project]`: install the approved candidates (see "The plan" below). `--project` installs into `./.claude/skills` of the current directory instead of `~/.claude/skills`.
- `--json` prints the plan object plus diagnostics (the inspection: languages, manifests, tooling files, README words; `remote.queries`, the rejected counts by reason, the index size, the plan path, timings) instead of the report; with `--apply` it prints the per-candidate results, `installed`, `kickoff` and `target` as JSON.
- `--yes` is accepted and ignored: typing `--apply` is the approval. `--cwd <dir>` inspects another directory (terminal use).

### The plan

The report writes `~/.claude/singular/init-plan.json` (`$SINGULAR_HOME/init-plan.json`): `{version: 1, cwd, createdAt, stack, needs, coverage, candidates: [{n, ref, source, skill, installs, audit, need, reason, also, sha, approvable}]}`, where `ref` is the pinned `owner/repo#<40-hex-sha>@skill`. Every `init` run overwrites it. `--apply` reads it and refuses with exit 1 when it is missing (`[singular] init --apply: no plan found at …/init-plan.json; run /singular init first`), older than `initPlanTtlHours` (24 h: `the plan at … is 30 h old (older than 24 h); run /singular init again`), made for another directory (`the plan was made for <dir>, not <cwd>; run /singular init here first`), has no candidates, or when a number is out of range (`9 is not in the plan (candidates are 1-8)`).

For each selected number `--apply` runs the `/singular add` flow with the plan's pinned ref (HEAD is **never** re-resolved): the target folder must not exist (`SKIPPED n. <ref> (exists: <path>)`), the pinned commit is fetched with `git`, the tree is checked for symlinks, executable bits and submodules, the folder is inspected before the copy, copied with a before/after snapshot of the skills directory and inspected again. Each candidate prints one line, `INSTALLED n. <ref> -> <path> (audit <status>)`, `REJECTED n. <ref>: <problems> (nothing was written)` (or `removed again; nothing left behind` when the copy had already happened) or `ERROR n. <ref>: <message>`, followed by `Installed: <names>` and the kickoff block. Exit code 0 when everything selected was installed or skipped, 1 when anything was rejected or errored. Nothing is ever installed without a typed `--apply`; `/singular init` alone only reads the project, queries skills.sh and writes the plan.

## Use it

`/singular` is the only user-facing command. Everything after it is a subcommand (`/singular help` lists them). Prompts that are not slash commands need nothing from you: the hook runs on its own (see "How it works").

### `/singular` or `/singular status`

Shows the configuration, effective mode, how many installed skills were indexed, the stack of the current directory, cache statistics, ephemeral pins, persistent installs and the last log lines, followed by the one-screen help. Claude runs `node "${CLAUDE_PLUGIN_ROOT}/bin/singular.js" status` through the Bash tool and relays the output verbatim (observed 2026-10-13 with a fresh state dir, from the Next.js fixture project; paths shortened):

```
[singular] singular 0.3.0  plugin root: /Users/you/.claude/singular/plugin
state dir: /Users/you/.claude/singular
config:    /Users/you/.claude/singular/config.json
  mode: "suggest"
  allowlist: ["anthropics","vercel-labs","microsoft","multica-ai"]
  installFloor: 1000
  maxLocalSkills: 3
  maxCandidates: 2
  minPromptChars: 40
  remoteTimeoutMs: 2500
  totalBudgetMs: 6000
  contextBudgetChars: 2000
  cacheTtlHours: 24
  skillsCliVersion: "1.5.26"
  requireAuditPass: true
  stackDetection: true
  blockedRefs: []
  pinnedSkills: []
  prefetch: true
installed skills indexed: 169 (synced 13, user 2, plugin 154)
stack (/Users/you/some-project): Next.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm; branch main
cache: 0 entries, 0.0 KB, newest -, oldest - (/Users/you/.claude/singular/cache)
loaded pins (/singular load, ephemeral): 0
persistent installs (/singular add): 0
log: /Users/you/.claude/singular/singular.log

Singular — find, load, add and manage third-party skills for Claude Code
  /singular                        status + this help
  ... (the help shown under /singular help)
```

After a few prompts the cache line fills up (`28 entries, 414.9 KB, newest 0 min ago`), the log line is followed by the last 5 JSON lines of `singular.log`, and each ephemeral pin is listed as `  <ref> -> <40-hex sha>  loads N  last <ISO time>`. Problems appear as `  ! ...` lines after the config keys, for example `! config.json is not valid JSON (...); using defaults`, `! mode: must be one of off|local|suggest|auto; using default "suggest"`, `! SINGULAR_MODE=auto ignored (the environment can only lower the mode below "suggest")`, or, when the environment lowers the mode, `effective mode "off" (file says "suggest"; ...)`. With a skills.sh cooldown: `skills.sh: rate-limited (HTTP 429) — no requests until HH:MM; cached catalogs still rank`. `/singular status --json` prints the same facts as one JSON object (no help trailer).

### `/singular help`

Prints the one-screen help (`bin/singular.js help`; no network):

```
Singular — find, load, add and manage third-party skills for Claude Code
  /singular                        status + this help
  /singular status [--json]        config, mode, indexed skills, cache, pins, installs, log tail
  /singular find <query>           search skills.sh (gated: owner allowlist, install floor, audit); never installs
  /singular load owner/repo@skill [--update]
                                   load a skill's text into this session only (commit-pinned, sanitized; nothing
                                   is written to ~/.claude/skills); owner/repo#<40-hex-sha>@skill pins a commit
  /singular add owner/repo@skill   persistent install into ~/.claude/skills (pinned, inspected before and after the copy)
  /singular init [--no-remote]     inspect this project: needs, which installed skills cover them, numbered pinned
                                   third-party candidates (gated, not installed); writes a plan, installs nothing
  /singular init --apply 1,3|all [--project]
                                   install the approved candidates from the plan (pinned; --project: ./.claude/skills)
  /singular mode [off|local|suggest|auto]
                                   show or switch the mode (rewrites only the "mode" key of config.json)
  /singular help                   this help
Config: ~/.claude/singular/config.json (allowlist, blockedRefs, installFloor, pinnedSkills, initMaxCandidates, ...).
From a terminal: `singular <subcommand> ...` (npm install -g singular-skill) or `node bin/singular.js <subcommand> ...`.
```

An unknown subcommand (`/singular turbo`) prints `[singular] unknown subcommand "turbo"; expected one of status | help | find | load | add | mode | init` followed by the same help, and exits 1.

### `/singular find <query>`

```
/singular find playwright flaky tests
```

Searches installed skills first, then skills.sh through the same gates the hook uses. This is the one path that sends your query words to skills.sh (you typed them on purpose). Claude runs `node "${CLAUDE_PLUGIN_ROOT}/bin/singular.js" find "playwright flaky tests"` and summarises the report in three parts: installed matches, the gated candidate table, and the rejected count with reasons. The report itself (observed 2026-10-08 for `playwright` with the catalogs already cached: 5 requests served from cache, 12 ms; a cold `supabase auth` query made 7 live requests in 1.5 s):

```
[singular] query: "playwright"  keywords: playwright

Installed locally (already available, use the Skill tool / slash command):
  vercel:access-protected-vercel-deployment    plugin   score 4.369  Access and test Vercel deployments protected by ...

Third-party candidates (gated: allowlist, install floor, audit; NOT installed):
  ref                                                              installs  audit    allowlisted?
  anthropics/skills@webapp-testing                                 172K      warn     yes
  microsoft/playwright-cli@playwright-cli                          177K      warn     yes

  Load ephemerally (text only):  /singular load <ref>
  Install persistently (pinned): /singular add <ref>

Rejected: 527
  305 x installs N < floor N
  170 x owner not allowlisted
  27 x already installed locally (...)
  17 x fork of ...
  Best allowlist-only rejection: alinaqi/maggy@playwright-testing (3.3K installs, matched playwright, testing) - add "alinaqi" to "allowlist" in /Users/you/.claude/singular/config.json to consider it
  top rejected by relevance (use --all for the full list):
    ...

(5 requests, cached: true, 12 ms)
```

Nothing is installed or loaded by `find`. The same search is also **model-invocable**: ask `is there a skill for playwright e2e testing?` in prose and Claude may invoke the `singular-find` skill itself (observed on sonnet and, less reliably, haiku; see FAQ); `/singular-find <query>` is that skill's own slash form and runs the same script. During a skills.sh cooldown the report says `Third-party search failed (skills.sh rate-limited until HH:MM); nothing could be evaluated.` when nothing is cached.

### `/singular load <owner/repo[#sha]@skill> [--update]`

```
/singular load anthropics/skills@webapp-testing
```

Loads the skill's `SKILL.md` text into this session only. This subcommand is handled entirely by a `UserPromptExpansion` hook **before Claude sees anything**: the reference is validated against the grammar and the owner allowlist, pinned to a commit (the first load resolves `HEAD` with `git ls-remote` and records it in `loaded.json`; later loads reuse that pin; `--update` re-resolves), the text is fetched with the pinned `skills` CLI, sanitized, and injected as context that starts with:

```
[singular] The user explicitly loaded third-party skill anthropics/skills#683bc88e56f3e09ba94f7055977f3d3aa499f202@webapp-testing via /singular load (pinned resolved; text only, nothing installed). Contents (sanitized; stripped: nothing):
<singular-loaded ref="anthropics/skills#683bc88e...@webapp-testing">
---
name: webapp-testing
...
</singular-loaded>
```

What you see is Claude's one-line acknowledgement (skill name and pinned sha); it runs nothing. `pinned resolved` on a first load, `pinned loaded.json` afterwards, `pinned resolved (--update)` with `--update`, `pinned arg` for a `#sha` reference. A long skill reads `stripped: truncated 388 chars to 9000` (`anthropics/skills@frontend-design`; the hook output is budgeted to 9,500 chars). Timing from the shell (measured 2026-10-08): 3.2 s wall for a first load with a warm npm cache, 0.05 s when the text is cached, 0.35 s for `--update`.

A rejected reference is blocked before any model call (hook exit 2; the turn costs $0). Claude Code prints the reason, for example `[singular] refused: owner "evil" is not in the allowlist [anthropics, vercel-labs, microsoft, multica-ai]. Add "evil" (or "evil/repo") to "allowlist" in /Users/you/.claude/singular/config.json if you trust that source, then retry.` Other blocks, all produced before any subprocess exists: `unknown option -rf` (for `a/b@c; rm -rf ~`), `invalid skill reference "../../etc/passwd"`, `expected exactly one skill reference, got 3`, `missing skill reference`, `refused: <ref> matches "blockedRefs" in your config`, `could not resolve HEAD of https://github.com/<owner>/<repo>: ...`.

Owner and repo are case-folded (`MULTICA-AI/x@s` and `multica-ai/x@s` share one pin); the skill segment is case-sensitive. The loaded text stays visible for the rest of the persisted session (see FAQ) and is never forwarded to subagents.

### `/singular add <owner/repo[#sha]@skill>`

```
/singular add multica-ai/andrej-karpathy-skills@karpathy-guidelines
```

Persistent install into `~/.claude/skills/<skill>`, pinned to a commit. Claude runs `node "${CLAUDE_PLUGIN_ROOT}/bin/singular.js" add <ref> --yes` (you typed the command, so `--yes` is the confirmation) and shows the output verbatim. The script refuses an existing target before any network call, fetches the pinned commit with `git` into a temp dir, checks the tree with `git ls-tree` (symlinks, exec bits, submodules), inspects the folder **before** anything is copied, copies with a before/after snapshot of `~/.claude/skills`, and inspects the copy again:

```
INSTALLED multica-ai/andrej-karpathy-skills#2c606141936f1eeef17fa3043a72095b4765b9c2@karpathy-guidelines sha 2c606141936f1eeef17fa3043a72095b4765b9c2
  path: /Users/you/.claude/skills/karpathy-guidelines (1 files, inspected before and after the copy: clean)
  source: multica-ai/andrej-karpathy-skills skills/karpathy-guidelines
  audit: { "status": "pass", "providers": [ ... ] }
Run /reload-skills or start a new session to use it.
```

A folder that would become a plugin (hooks, `bin/`, MCP, agents, executable files, symlinks, capability-granting frontmatter in any spelling, shell forms) prints `REJECTED: <pinned ref>` with one problem per line and `Nothing was written to ~/.claude/skills.` (verified against a local bare repository built from `test/fixtures/skill-folders/malicious`). Other outcomes, all exit 1 with nothing written: `REFUSED: ~/.claude/skills/<skill> already exists (directory). Remove it yourself first; singular never overwrites.`, `REJECTED: owner "evil" is not allowlisted [...]`, `no skill named "DOCX" in anthropics/skills at 683bc88 (exact, case-sensitive). Found: ...`, `git fetch failed (exit 128): ...` for a bogus sha, `could not resolve HEAD of ...: repository not found or private (GitHub asked for credentials)`.

### `/singular init [--apply <1,3|1-3|all>] [--project] [--no-remote] [--json]`

```
/singular init
/singular init --apply 2,3
```

The project set-up flow described under "Set up a project": `init` inspects the current directory, reports its needs, which installed skills cover them and up to 8 pinned third-party candidates, writes the plan and installs nothing; `init --apply <numbers|all>` installs the chosen candidates from that plan through the `add` flow and prints a kickoff prompt. The skill body makes Claude show the report, ask which numbers to install, run `--apply` only with your answer, and offer to run the kickoff prompt. Argument errors exit 1 before anything runs: `[singular] init: --apply needs a selection: numbers like 1,3 or 1-3, or all`, `unexpected argument "--force"`, `cannot parse "1;2": expected numbers like 1,3 or 1-3, or all`, `9 is not in the plan (candidates are 1-8)`; `--help` prints `usage: singular init [--apply <1,3|1-3|all>] [--project] [--no-remote] [--json] [--yes] [--cwd <dir>]`. From a terminal: `singular init [--cwd <project>]` (the npm binary proxies it) or `node ~/.claude/singular/plugin/bin/singular.js init [--cwd <project>]` (see "CLI reference").

### `/singular mode [off|local|suggest|auto]`

```
/singular mode local
```

Shows the effective mode and where it comes from, or rewrites **only** the `mode` key of `config.json` (every other key, including unknown ones, is preserved). Takes effect on the next prompt, no restart. Without an argument:

```
[singular] mode: suggest  (config file: /Users/you/.claude/singular/config.json)
  usage: /singular mode <off|local|suggest|auto>
```

With one: `[singular] mode: suggest -> local (/Users/you/.claude/singular/config.json). Takes effect on the next prompt; no restart needed.` Errors (exit 1): `unknown mode "turbo"; expected one of off | local | suggest | auto`; `refusing to write mode "auto" into <redirected>/config.json: auto is honoured only in the default ~/.claude/singular/config.json (unset SINGULAR_HOME first)`; `<path>/config.json is not valid JSON (...); fix it by hand first`. `/singular mode auto` also prints the warning quoted under "Modes". Live through `claude -p` (haiku, measured 2026-10-07) each call cost $0.0014-0.0018; on `turbo` the model reported the failure and did not pick another mode.

### From a terminal

Every subcommand also works without Claude: `singular status`, `singular find <query>`, `singular load <ref>`, `singular add <ref>`, `singular mode <m>`, `singular init [--apply …]` proxy to the same scripts (see "CLI reference"). The per-prompt hook can be dry-run too:

```bash
node ~/.claude/singular/plugin/bin/on-prompt.js --dry-run "<your prompt>" --cwd ~/some-project --verbose
```

prints exactly what would be injected, the timings, which words (if any) were sent to skills.sh, and the skip reason when nothing is injected.

## How it works

1. **Every prompt of 40+ characters** fires the `UserPromptSubmit` hook (`bin/on-prompt.js`). It indexes your installed skills (user, project, plugin and claude.ai-synced; 18-52 ms in-process for 168 skills, measured 2026-10-08), scores them against the prompt (BM25-style, name tokens weighted), reads the project's manifests and `.git/HEAD` for the stack (no subprocesses), and injects one short factual note, for example:

   ```
   [singular] Stack: Next.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm; branch main
   Installed skills likely relevant: vercel:access-protected-vercel-deployment (matches playwright, tests), vercel:deployments-cicd (matches ci)
   ```

   Slash commands, prompts under 40 characters, prompts starting with `[singular]` and the synthetic `<task-notification>` / `<system-reminder>` prompts are skipped. One run per prompt, never per tool call. Subagents get only the `Stack:` line through a `SubagentStart` hook (they do not inherit the parent's context).

2. **On a local miss** in `suggest` (the default) or `auto` mode, the hook fetches each allowlisted owner's skills.sh catalog (cached 24 h) and runs at most two searches for single words from your prompt that are in a built-in tech lexicon (`q=playwright`, `q=e2e`); free-form prompt text never leaves the machine. Candidates are ranked by relevance plus `log10(installs)`, then gated: owner allowlist, `blockedRefs`, install floor (1000), fork dedupe, already-installed names, audit status. The result is two lines of context and a one-line notice in your transcript:

   ```
   Third-party candidates (not loaded): anthropics/skills@webapp-testing (172K installs, audit warn) — load with /singular load anthropics/skills@webapp-testing; ...
   ```

   ```
   [singular] 2 third-party skills may fit this prompt (not loaded): /singular load anthropics/skills@webapp-testing, /singular load microsoft/playwright-cli@playwright-cli
   ```

   A detached background process prefetches the top candidate's text so the next step is instant. Cold discovery measured 1.2-2.4 s (catalogs plus two searches), warm 5-32 ms (2026-10-08).

3. **You decide.** `/singular load <ref>` loads the text (pinned, sanitized, session-only); `/singular add <ref>` installs it persistently after inspection; `/singular find <query>` shows the full gated and rejected lists when a pick looks off; `/singular init` does the same for a whole project at once (needs, coverage, numbered pinned candidates) and `/singular init --apply <numbers>` installs the ones you chose. Nothing third-party reaches Claude without one of these, unless you turn on `auto`.

4. **State lives in `~/.claude/singular/`**: `config.json`, `cache/`, `loaded.json` (ephemeral pins), `installed.json` (persistent installs), `init-plan.json` (the last `/singular init` plan), `singular.log`, and the installed plugin copy under `plugin/`. The hooks never write anywhere else; `/singular add` and `/singular init --apply` are the only paths that write under `~/.claude/skills` (or `./.claude/skills` with `--project`), and only after inspection.

## Modes

Switch with `/singular mode <off|local|suggest|auto>` or edit `~/.claude/singular/config.json`. `SINGULAR_MODE=local claude` lowers the mode for one shell; the environment can **only lower** it (a repository's committed `.claude/settings.json` `env` reaches the hook too, verified on 2.1.293; `docs/security.md` section 4), and `auto` counts only when it is written in the default config file.

| mode | per-prompt hook | network | third-party text reaches Claude |
| :-- | :-- | :-- | :-- |
| `off` | no-op (`--dry-run` prints `[singular] (no context: mode off)`) | no | never (only `/singular load` still works) |
| `local` | stack + installed-skill routing | no | only via `/singular load` |
| `suggest` **(default)** | stack + routing + on a local miss: allowlisted-owner catalogs (cached 24 h) + up to 2 single tech-word searches, ranking, gating, audit, a **text suggestion**, then a detached background prefetch of the top candidate's text | yes | only after you type `/singular load` |
| `auto` | everything above, then the single best gated candidate's SKILL.md is pinned, fetched, sanitized and **injected without confirmation** | yes | **yes, automatically** |

> **Warning about `auto`.** Anthropic's guidance is to use skills only from sources you trust; measured base rates for public registries include ~13% critical findings and live trojanized packages, install counts are not a safety signal, and scanners are advisory and bypassable (`docs/security.md`). In `auto`, text written by a third party is placed in Claude's context every time your prompt has no strong local match, with only the allowlist, install floor, audit status, commit pin and sanitizer between you and it. The residual risk is prompt injection in prose you did not read. Singular shows a one-time warning when `auto` first injects something, never writes the text to disk, and strips the capability-granting parts of SKILL.md, but it cannot make untrusted prose trustworthy. Keep `suggest` unless you have read the skills your allowlist can reach.

`/singular mode auto` prints: `[singular] mode "auto": third-party skill text from allowlisted skills.sh sources will be injected into your prompts WITHOUT confirmation (text only, pinned, sanitized, still untrusted prose). Cold prompts add up to ~5 s and up to 9,000 chars of third-party text per prompt; see README "What auto actually costs". Run /singular mode suggest to go back.`

### What `auto` actually costs

| situation | what happens | added time | added context |
| :-- | :-- | :-- | :-- |
| cold prompt, candidate never seen on this machine | HEAD is resolved (`git ls-remote`, ~0.5-1.8 s); if >= 4.5 s of the 6 s budget remain, `npx skills use` fetches the text inline (~4.2 s measured with a warm npm cache), otherwise only the **suggestion** is emitted and the text is prefetched in the background. In practice the first auto prompt on a machine yields only the suggestion (measured 2026-10-07: cold `discoverMs` 3,368 then `autoSkipped=only 1924ms left`); the next one is served from the cache | ~1-6 s | 0 or up to 9,000 chars |
| the same candidate again (or after the prefetch finished) | text served from the immutable per-sha cache; no git, no npx | ~0 ms | up to 9,000 chars of third-party text **on every such prompt** |
| a strong local match exists | nothing remote, same as `suggest` | 0 | 0 |

### Always-on guidelines (`pinnedSkills`)

Behavioural skills (Karpathy-style coding guidelines) have no task nouns, so keyword routing only finds them when the prompt happens to say "refactor" or "simplify". For "apply these guidelines to every coding prompt", list them in `config.json`:

```json
"pinnedSkills": ["andrej-karpathy-skills:karpathy-guidelines", "multica-ai/andrej-karpathy-skills@karpathy-guidelines"]
```

An **installed** skill name (plain or `plugin:name`) becomes a one-line hint; an allowlisted **ref** is pinned like `/singular load`, fetched once, cached forever by sha, and its sanitized text injected. Either is emitted **once per session**, not on every prompt. Non-allowlisted refs and unknown names are ignored with a warning in `/singular status`.

### What `suggest` decides

The remote step runs only if `mode` is `suggest`/`auto` **and** no installed skill is a *strong* match: score >= 10 and at least two meaningful matched tokens, or a single *name* token that is a tech noun (`nextjs`, `stripe`, `pdf`, `auth`), or a rare word with score >= 20. A single hit on a hyper-common word (`file`, `function`, `build`, `page`, `test`, `claude`, `code`, `plugin`, `skill`, ...) is never listed and never suppresses discovery; a single common English name word (`design`, `route`, `system`, `review`, `plan`, `setup`, `status`) is listed but never strong. `--dry-run --verbose` prints `local=name:score*` (`*` = strong) and `weak(dropped)=…`; a golden routing table over a 168-skill snapshot lives in `test/bin.test.js`. Examples measured 2026-10-08 from the Next.js fixture project (hook time is in-process; add ~100 ms of `node` startup):

| prompt | result | hook time |
| :-- | :-- | :-- |
| `what are the tradeoffs between server and client components in next.js 16? cite the docs` | stack + `vercel:nextjs` (strong), `vercel:next-cache-components` (strong); remote skipped | 25 ms |
| `build a landing page with tailwind css!!` (exactly 40 chars) | stack + `vercel:shadcn` (strong), `figma:figma-generate-design`; remote skipped | 19 ms |
| the same prompt minus one `!` (39 chars) | skipped: `prompt shorter than minPromptChars (39 < 40)` | < 1 ms |
| `add a /api/health route that returns uptime json` | stack + `vercel:routing-middleware` (route; not strong) → discovery sent `q=api`, `q=json`: `anthropics/skills@claude-api (69.6K, warn)`, a loose fit | 2,424 ms |
| `our playwright end-to-end tests are flaky on CI, help me stabilise them with retries and proper waits` | stack + three weak locals, then `anthropics/skills@webapp-testing (172K, warn)`, `microsoft/playwright-cli@playwright-cli (177K, warn)`; sent `q=playwright`, `q=e2e` | 2,090 ms |
| `write a terraform module for an s3 bucket with versioning and lifecycle rules` | stack only; discovery sent `q=terraform`, `q=s3`, 0 candidates (no allowlisted owner has one) | 1,240 ms |
| a 12,000-char prompt | stack + three strong design-system matches; 289-320 chars of context | 20 ms |

A catalog request that times out is remembered for 5 minutes (`fail:catalog:<owner>` marker), a stale copy keeps ranking, and the next prompt measured 6 ms (2026-10-07).

## Configuration reference

`~/.claude/singular/config.json` (or `$SINGULAR_HOME/config.json`). Created from the defaults on first run; unknown keys are kept; a wrong type falls back to the default and is reported by `/singular status`. `config.example.json` in this repository is identical to the defaults.

| key | default | meaning |
| :-- | :-- | :-- |
| `mode` | `"suggest"` | `off` / `local` / `suggest` / `auto` (see "Modes") |
| `allowlist` | `["anthropics","vercel-labs","microsoft","multica-ai"]` | GitHub owners (`owner`) or repositories (`owner/repo`) whose skills may be suggested, loaded or installed. Case-insensitive, exact. Everything else is rejected as `owner X not allowlisted` |
| `installFloor` | `1000` | minimum skills.sh install count for a candidate |
| `maxLocalSkills` | `3` | installed skills named per prompt |
| `maxCandidates` | `2` | third-party candidates named per prompt (suggest) / considered (auto: only the first is loaded) |
| `minPromptChars` | `40` | shorter prompts get no context at all (inclusive: 40 chars route, 39 do not; measured after stripping Claude Code's `<pasted_content>` wrapper lines) |
| `remoteTimeoutMs` | `2500` | per-request timeout for skills.sh |
| `totalBudgetMs` | `6000` | hard deadline for the whole per-prompt hook; the remote step is skipped when < 1500 ms remain, an inline `auto` fetch when < 4500 ms remain; a watchdog flushes the local-only context if anything overruns (hook timeout is 8 s) |
| `contextBudgetChars` | `2000` | cap for the suggestion text (candidates are dropped first, then installed matches). Loaded skill text (auto / `pinnedSkills` / `/singular load`) is capped separately at 9,000 chars and fitted so the whole hook output stays under 9,500 chars, because Claude Code only previews hook output above 10,000 chars |
| `cacheTtlHours` | `24` | TTL for owner catalogs, tech-word searches, audit verdicts and resolved HEAD SHAs (`$SINGULAR_HOME/cache/`). Skill text is cached **forever** by pinned ref: a commit is immutable, so any ref is fetched at most once per machine |
| `skillsCliVersion` | `"1.5.26"` | the `skills` npm CLI version used for `skills use` (text fetch; pinned; never `latest`). `/singular add` does not use the CLI |
| `requireAuditPass` | `true` | drop candidates whose skills.sh audit status is `fail` (or any provider `CRITICAL`). `warn` and `unknown` still pass with the status shown, because a strict all-pass rule would reject `anthropics/skills@webapp-testing` and several vercel-labs and microsoft skills that carry a `warn` today |
| `stackDetection` | `true` | read `package.json`/lockfiles/`tsconfig.json`/`pyproject.toml`/`requirements.txt`/`go.mod`/`Cargo.toml`/`Gemfile`/`pom.xml`/`.git/HEAD` in the session's cwd |
| `blockedRefs` | `[]` | never suggest/load/install these: `owner`, `owner/repo` or `owner/repo@skill`; wins over the allowlist |
| `pinnedSkills` | `[]` | always-on skills, injected once per session (see "Always-on guidelines") |
| `prefetch` | `true` | in `suggest`, spawn a detached `on-expand.js <ref> --prefetch` for the top candidate so its HEAD and text are cached before you type `/singular load`. `false` disables the background process |
| `initMaxCandidates` | `8` | `/singular init`: at most this many third-party candidates in the plan (`0` skips the skills.sh step; the report then says `none (initMaxCandidates is 0)`) |
| `initPlanTtlHours` | `24` | `/singular init --apply` refuses a plan older than this (`run /singular init again`) |

Environment (untrusted: a repository's committed `.claude/settings.json` `env` block reaches the hook process, so the environment can only **lower** privilege): `SINGULAR_HOME` (state directory, default `~/.claude/singular`; honoured only as an absolute path outside the project directory, and `mode: "auto"` is never honoured in a redirected home), `SINGULAR_MODE` (per-process mode override; can only lower the mode below the config file's value), `CLAUDE_CONFIG_DIR` (honoured when indexing installed skills and by the `singular` CLI), `SINGULAR_DEBUG=1` (log the extracted keywords). `/singular status` lists every override and whether it was ignored, and names any active **test seam** (`SINGULAR_REGISTRY_BASE`, `SINGULAR_GIT_BASE`, `SINGULAR_SKILLS_DIR`, `SINGULAR_TEST_ALLOW_AUTO`): those exist only for the test suite and are documented in `docs/testing.md`.

State files under the state directory: `config.json`, `cache/`, `loaded.json` (ephemeral pins: `{ref, sha, ts, lastTs, loads, chars, stripped}` per unpinned ref), `installed.json` (persistent installs made by `/singular add` and `/singular init --apply`), `init-plan.json` (the last `/singular init` plan: cwd, stack, needs, coverage, pinned candidates; overwritten on every run, refused by `--apply` after `initPlanTtlHours`), `singular.log` (JSON lines, rotated at 2 MB), `.auto-mode-warned`, `spill-*.md` (last-resort overflow of oversized routing text), and `plugin/` (the installed plugin copy, managed by the `singular` CLI; `plugin.prev/` is the previous copy kept for rollback).

### Adding an allowlist owner

1. Decide whether you trust the **owner** (a GitHub user or org) or only one **repository**. `"expo"` allows every repo under `github.com/expo`; `"expo/skills"` allows only that one.
2. Edit `~/.claude/singular/config.json`:

   ```json
   "allowlist": ["anthropics", "vercel-labs", "microsoft", "multica-ai", "expo/skills"]
   ```

3. No restart needed: every hook run re-reads the config. `/singular status` shows the effective list and any parse warning. `/singular find <query>` names the most relevant entry that was refused only for its owner (`Best allowlist-only rejection: ... - add "<owner>" to "allowlist" in ~/.claude/singular/config.json to consider it`). Read the repository before adding an owner.
4. `blockedRefs` wins over the allowlist, so you can allow an owner and still block one of its skills.

## CLI reference

`singular` (from `npm install -g singular-skill`, or `node bin/singular-cli.js` in a checkout) manages the installation and proxies the subcommands to a terminal. Zero dependencies; `--help` prints this list. Every subprocess is `execFile` with an argument array, never a shell string; `CLAUDE_CONFIG_DIR` is passed through to `claude`, so a different Claude Code config directory is honoured.

| command | what it does |
| :-- | :-- |
| `singular install [--dir <path>] [--dry-run] [--json]` | (1) checks `node >= 20` and `claude` on `PATH` with version `>= 2.1.282` (`claude --version`); (2) copies the plugin payload (`.claude-plugin`, `hooks`, `skills`, `bin`, `lib`, `package.json`, `LICENSE`, `README.md`, `config.example.json`) from the installed package to `~/.claude/singular/plugin/` (written to `plugin.tmp` then renamed; the previous copy is kept as `plugin.prev` for rollback); (3) `claude plugin marketplace add ~/.claude/singular/plugin`, or `claude plugin marketplace update singular` when that marketplace already exists; (4) `claude plugin install singular@singular`, or `claude plugin update singular@singular` when already installed; (5) prints `Installed. Open a new Claude Code session (or run /reload-plugins) and type /singular`. `--dir` changes the payload destination; `--dry-run` prints the plan without running anything; `--json` prints the steps as JSON. On any failure it exits 1, names the exact `claude plugin ...` command that failed and how to retry it, and never leaves a half-registered state |
| `singular update` | same as `install`: re-copies the payload from the currently installed npm package, then `marketplace update` + `plugin update`. Run it after `npm update -g singular-skill` |
| `singular uninstall [--purge]` | `claude plugin uninstall singular@singular`, `claude plugin marketplace remove singular`, removes `~/.claude/singular/plugin`. `--purge` also removes the config, cache, log and pins (the whole `~/.claude/singular`) |
| `singular status` | node and claude versions, payload path and version, whether the marketplace is registered and the plugin installed/enabled (from `claude plugin list --json`), config path and mode, the last 5 `singular.log` lines |
| `singular doctor` | `status` plus an actionable hint for each problem it finds (claude missing or too old, marketplace not registered, plugin not installed or disabled, mode `auto`, config warnings) |
| `singular find <query>` · `singular add <ref>` · `singular mode [m]` · `singular init [--apply …]` · `singular load <ref>` | proxies to `bin/singular.js` (`load` to the direct CLI mode of `bin/on-expand.js`, which prints the sanitized text to stdout), so the same commands work from a terminal with the same output and exit codes. `singular init` inspects the shell's current directory (`--cwd <dir>` for another one) and reads/writes the plan under `~/.claude/singular` |

The underlying scripts remain callable directly from the installed copy (`P=~/.claude/singular/plugin`):

```bash
node $P/bin/singular.js status [--json] [--cwd DIR]
node $P/bin/singular.js help
node $P/bin/singular.js find "playwright flaky tests" [--limit N] [--all] [--json] [--cwd DIR]
node $P/bin/singular.js add anthropics/skills@frontend-design [--yes] [--json]
node $P/bin/singular.js init [--no-remote] [--json] [--cwd DIR]                      # report + plan; installs nothing
node $P/bin/singular.js init --apply 1,3 [--project] [--json] [--cwd DIR]            # 1,3 | 1-3 | all: install from the plan
node $P/bin/singular.js mode [off|local|suggest|auto] [--json]
node $P/bin/singular.js load multica-ai/andrej-karpathy-skills@karpathy-guidelines [--update] [--json]   # terminal form of /singular load: prints the sanitized text
node $P/bin/on-expand.js multica-ai/andrej-karpathy-skills@karpathy-guidelines [--update] [--json]   # what /singular load injects
node $P/bin/on-prompt.js --dry-run "build a landing page in nextjs with tailwind" [--cwd DIR] [--verbose] [--json]
node $P/bin/on-subagent.js --dry-run [--cwd DIR]
```

## FAQ

**Why are there no third-party candidates?** In order of likelihood: (1) an installed skill was a strong match, so the remote step was skipped (`--dry-run --verbose` shows `local=name:score*`, `*` = strong, and no `discover=` line); (2) every ranked entry was rejected: `/singular find <query>` shows the reasons: `owner not allowlisted` (by far the largest group), `installs N < floor 1000`, `already installed locally (...)` (a candidate whose name matches an installed skill is dropped in favour of the local one), `fork of ...`, `duplicate skill name`, audit `fail`; (3) no allowlisted owner publishes anything whose *name* contains a word from your prompt (terraform, s3), and names only match on exact stemmed tokens; (4) the mode is `local`/`off`, the prompt is under 40 characters or starts with `/`, or skills.sh is in a 5-minute 429 cooldown (`/singular status`); (5) a request timed out (`errors` in `--dry-run --json`; that owner is then skipped for 5 minutes and a stale catalog keeps ranking).

**Why did it not suggest X?** Run `/singular find <the words you expected to match>`. If X appears under `Best allowlist-only rejection`, its owner is not in your allowlist. If X is listed under `fork of ...`, an allowlisted source publishes the same skill name and won. If X is not in the list at all, skills.sh did not return it for the words searched: the hook sends only single tech-lexicon words (`shared=[...]` in `--dry-run --verbose`), and the API is lexical and capped at 200 results per query, so a repository whose skill names contain neither `skill` nor one of your tech words is unreachable from the hook (use `/singular find`, which also sends the joined query). Install counts come last in the ranking: a 315-install entry that matches two words outranks a 314K-install entry that matches one.

**Why did `/singular init` list nothing for a need (or list a loose fit)?** The candidates come from one skills.sh search per need word (`q=supabase`), through the same gates as the hook, so the reasons under "Why are there no third-party candidates?" apply: `--json` shows `remote.queries` (how many results each word returned, which were cached or skipped) and `remote.rejectedByReason` (`owner not allowlisted`, `installs N < floor N`, `already installed locally (...)`, `fork of ...`, `audit fail`). A covered need is searched only when it is among the three strongest (`(also)` candidates). A need you expected but do not see was not detected: `--json` lists `inspection.manifests`, `inspection.tooling` and `inspection.readme.words`, the only inputs the lexicon maps. A loose fit (a `react` need matched by a `react native` skill name) is still just a numbered line: nothing is installed until you pick it, and `/singular find <word>` shows the full ranking.

**How do I add an owner?** Edit `~/.claude/singular/config.json` and append `"owner"` (or `"owner/repo"` for one repository) to `allowlist`; no restart. `/singular find` prints the exact owner to add. Adding an owner means every skill under that GitHub account can be suggested, loaded and installed through the gates; read what you add. Never let Claude edit the allowlist for you (the skill bodies tell it not to).

**Is auto mode safe?** No, and it is not meant to be: it places third-party prose in Claude's context without you reading it. The gates (allowlist, floor, audit, pin, sanitizer) remove executable and capability-granting parts, not persuasion. `auto` is only honoured in the default config file, can never be enabled by a repository or the environment, prints a one-time warning, and `/singular mode suggest` reverts it. Use it only with an allowlist whose skills you have read.

**Which models relay suggestions?** Candidates are placed in Claude's context together with an instruction to end the reply with one line `Load with /singular load <ref>` when one fits. That is advice to the model, not a guarantee: measured 2026-10-07 across three live explorations, the model ended its reply with a load line in 2 of 6 runs that had candidates (sonnet and haiku, a Playwright prompt whose candidates fit well; none of the four runs for a pandas prompt), and in 1 of 2 haiku runs after the instruction was moved before the candidate list. The hook's own one-line `[singular] N third-party skill(s) may fit this prompt (not loaded): /singular load ...` notice in your transcript is the reliable channel; a relay by the model is a bonus. Likewise the model-invocable `singular-find` skill: for `is there a skill for playwright e2e testing?` sonnet invoked it; haiku reached for `WebSearch`/`WebFetch` instead in one measured run (`docs/testing.md`, case 13). Typing `/singular find ...` yourself always works.

**Does `/singular load` persist across turns?** Yes, for the whole persisted session (`--resume`/`--continue` included): Claude Code stores hook `additionalContext` in the transcript as an attachment of type `hook_additional_context` (verified: section titles and a verbatim bullet of `karpathy-guidelines` were recalled two turns later; a second load coexisted with the first). It is not re-sent each turn, so it does not cost context twice. It does not survive `/compact` or `--no-session-persistence` (re-run `/singular load` after `/compact`), and it is never forwarded to subagents. Long skills are truncated at 9,000 chars; `/singular add` keeps the full text on disk.

**Does the hook see every skill I have?** CLI-bundled skills (`dataviz`, `update-config`, `code-review`, `simplify`, …) have no `SKILL.md` on disk, so they are never indexed or listed; Claude still picks them on its own. Suggested installed skills are not invoked automatically either: in measured sonnet runs the model never called the Skill tool for a listed skill, but it did reflect the injected stack (Tailwind 4 classes, a Next 16 doc citation).

**What leaves the machine?** In `suggest`/`auto`: each allowlisted owner's catalog (`GET skills.sh/api/search?q=skill&owner=<owner>&limit=200`, no prompt content, cached 24 h), at most two single tech-lexicon words from your prompt (`q=stripe`), and audit lookups by candidate id. `/singular find` additionally sends your query's keywords as one joined search. Loading a skill runs `git ls-remote` and a pinned `npx skills use` against github.com. `mode: "local"` makes the hook network-free. Full table in `docs/security.md` section 5; `--dry-run --verbose` prints `shared=[...]`, the exact words sent.

## Troubleshooting


**`zsh: command not found: singular` right after `npm install -g singular-skill`.** The install worked; npm's global `bin` folder just isn't on your PATH (common with a custom prefix, nvm or Volta). Either skip the PATH question entirely:

```bash
npx singular-skill install
```

or put npm's global bin on your PATH once:

```bash
echo "export PATH=\"$(npm prefix -g)/bin:\$PATH\"" >> ~/.zshrc && source ~/.zshrc
singular install
```

| Symptom | Check |
| :-- | :-- |
| `singular install` says `claude: command not found` (or `claude is not on PATH`) | Install Claude Code first (`npm install -g @anthropic-ai/claude-code` or the native installer) and make sure `claude --version` prints in the same shell. The CLI calls `claude` from `PATH`; nothing is registered until it is found |
| `singular install` says the Claude Code version is too old | The hook contracts need Claude Code >= 2.1.282 (`UserPromptExpansion` with `command_args`, `SubagentStart`). Update Claude Code (`claude update`) and re-run `singular install` |
| `claude plugin list` does not show `singular@singular` | Run `singular doctor`: it reports whether the `singular` marketplace is registered and whether the plugin is installed and enabled, with the command to fix each. `singular install` is idempotent: run it again. A session loaded with `--plugin-dir` shows as `singular@inline` only in `claude --plugin-dir <dir> plugin list` |
| `/singular` says `Unknown command` or does nothing | The session predates the install: run `/reload-plugins` or start a new session. `/singular:singular ...` (the namespaced form) is equivalent |
| `/singular load` expands but no `[singular] The user explicitly loaded ...` block appears | The expansion hook did not run. `disableAllHooks` in settings disables it; otherwise look at `~/.claude/singular/singular.log` for `on-expand`. Run `singular load <ref>` from a terminal to see the same sanitized text |
| `UserPromptExpansion operation blocked by hook: ... not in the allowlist` | Intended. Add the owner to `allowlist` if you trust it (see "Adding an allowlist owner") |
| Hook timeout (`singular.log` shows the run was cut, or nothing was injected on a slow network) | The per-prompt hook has 8 s (6 s internal budget) and the load hook 25 s. A cold `npx` download of the `skills` CLI can take most of the 25 s the first time, so retry `/singular load` once; a slow skills.sh owner costs `remoteTimeoutMs` once per 5 minutes and is then skipped. Lower `totalBudgetMs`, set `mode: "local"`, or disable `stackDetection` if prompts feel slow (`--dry-run --verbose` prints `indexMs`, `localMs`, `discoverMs`, `autoFetchMs`) |
| `could not resolve HEAD` / `could not fetch` | `git ls-remote https://github.com/<owner>/<repo> HEAD` and `npx -y skills@1.5.26 use <ref>` from your shell; check network/proxy. `repository not found or private (GitHub asked for credentials)` means the repository does not exist under that owner or is private |
| `/singular find` says `Third-party search failed (skills.sh rate-limited until HH:MM)` | skills.sh answered HTTP 429. Nothing is wrong locally; cached catalogs still rank. Wait for the time shown (`/singular status` shows it too) |
| Nothing appears in context | `/singular status`: is `mode` `off`? Is the prompt >= 40 chars and not a slash command? `node ~/.claude/singular/plugin/bin/on-prompt.js --dry-run "<prompt>" --cwd <project> --verbose` prints the skip reason. In an interactive session hook context is not printed as a message; use `claude --verbose` or `-p --output-format stream-json --verbose --include-hook-events` |
| `mode` is `auto` in the file but `/singular status` says `suggest` | `auto` counts only in the default `~/.claude/singular/config.json`; a redirected `SINGULAR_HOME` or `SINGULAR_MODE` can only lower the mode |
| `/singular add` printed `REJECTED` | The downloaded folder contained plugin components, non-plain files in the git tree or capability frontmatter; nothing was written. Use `/singular load` for the text only, or vet the repository by hand |
| `/singular init --apply` says `no plan found`, `is N h old (older than 24 h)` or `was made for <dir>, not <cwd>` | The plan is per directory and expires after `initPlanTtlHours`. Run `/singular init` again in the project and approve from the fresh report (the shas may have moved on) |
| `/singular init --apply` printed `REJECTED n. <ref>: ...` for one candidate (exit 1) | Same inspection as `/singular add`: that folder would have become a plugin (observed: `anthropics/skills@webapp-testing` carries an executable `scripts/with_server.py`); it was never kept, the other selected candidates were still installed. `/singular load <ref>` gives you its text without installing |
| `/singular init` reports `Needs (0): no signals` or misses a need | Only known manifests, tooling files and the first 40 lines of `README.md`/`CLAUDE.md` are read, three levels deep. Run `node ~/.claude/singular/plugin/bin/singular.js init --json --cwd <project>` and look at `inspection`; `/singular find <word>` searches a need by hand |
| Config warnings in `/singular status` | A key has the wrong type or the JSON is invalid; the default is used for that key. Fix the file; no restart needed |
| I want to reset | `singular uninstall --purge` (or `rm -rf ~/.claude/singular` for the state only) |

Logs: `~/.claude/singular/singular.log` (one JSON line per hook run with timings, matches, candidates, errors). Hook stdout/stderr are also in Claude Code's debug output (`claude --debug`).

## Uninstall

```bash
singular uninstall            # claude plugin uninstall singular@singular, marketplace remove singular, delete ~/.claude/singular/plugin
singular uninstall --purge    # also delete the config, cache, log and pins (~/.claude/singular)
npm uninstall -g singular-skill
```

Skills installed with `/singular add` or `/singular init --apply` live under `~/.claude/skills/<skill>` (or `<project>/.claude/skills/<skill>` with `--project`) as ordinary skills and are **not** removed by either command; delete them yourself.

## Testing

```bash
npm test                      # unit suite: node --test 'test/*.test.js'; no network, no real npx; ~15 s
npm run e2e                   # live: runs claude -p with the plugin loaded via --plugin-dir (needs a login; costs money)
```

`docs/testing.md` is the testing guide: the file list and test count, what each file covers, the coverage table, the e2e isolation recipe (`test/e2e/README.md`), the test seams (loopback registry, local git base, redirected skills dir, auto in a redirected home) and the cost of live runs. The e2e runner never touches `~/.claude/settings*.json`, `~/.claude/skills`, `~/.claude/plugins` or the real `~/.claude/singular`, and verifies that with before/after fingerprints.

## Security

`docs/security.md` has the threat model, the eleven gates in the order they apply, why ephemeral loading is the default, how the environment and a repository's settings are treated (they can only lower privilege), the exact outbound requests, what the hooks never do, and the residual risks you accept. Short version: the hooks never write under `~/.claude/skills`, `~/.claude/plugins` or any settings file; never run a shell string; validate every reference with a strict grammar before any subprocess exists; strip capability-granting frontmatter and shell forms from loaded text; and never block a prompt (only a rejected `/singular load` is blocked, before any model call). `/singular init` pins every candidate at report time and `--apply` installs exactly those commits through the `add` inspection; the typed `--apply` is the approval. `docs/spec.md` is the module contract.

## License

MIT.
