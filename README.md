# skill-scout

A Claude Code plugin that, on every prompt:

1. **routes** to skills you already have installed (user, project, plugin and claude.ai-synced skills; lexical BM25-style scoring, 18-52 ms in-process for the 168 skills on the authoring machine),
2. **detects the project stack** (Next.js 16, Tailwind 4, TypeScript strict, pnpm, branch...) from manifests and `.git/HEAD`, no subprocesses,
3. on a local miss, **discovers third-party skills on skills.sh** (cached per-owner catalogs plus at most two single tech-word searches; free-form prompt text never leaves the machine), ranked by relevance to the prompt and gated by an owner allowlist, an install floor and the public audit endpoint, and
4. loads them **ephemerally** (text only, pinned to a commit, sanitized, never written to `~/.claude/skills`) when you type `/scout-load owner/repo@skill` — or automatically if you explicitly turn on `mode: "auto"` (`/scout-mode auto`; read "What auto actually costs" first).

Persistent installs go through `/scout-add`, which pins to a commit SHA, fetches that commit with `git` into a temp dir, checks the tree with `git ls-tree` (symlinks, exec bits, submodules) and inspects the folder **before** anything is copied into `~/.claude/skills`, and **rejects any folder that would become a plugin** (hooks, `bin/`, MCP, agents, executable files, symlinks, capability-granting frontmatter in any spelling, shell forms).

Zero npm dependencies. Node >= 20. Everything the plugin does is a plain `node` script you can run by hand.

Status (2026-10-08): the three hook contracts (`UserPromptSubmit`, `UserPromptExpansion`, `SubagentStart`) are verified live on Claude Code 2.1.293 in `claude -p` (first verified on 2.1.282 on 2026-09-25; events, exit codes and stdin shapes unchanged); `bash test/e2e/run.sh` passed 9/9 on 2026-10-07; the unit suite passes with no network (`npm test`; file list, test count and coverage table in `docs/testing.md`). Design rationale: `research/2026-09-15-auto-skill-discovery-feasibility.md`; module contract: `docs/spec.md`; threat model and outbound data: `docs/security.md`; how to test it: `docs/testing.md`.

---

## How to try it in 2 minutes

Nothing below installs anything or touches your settings; the plugin is loaded for one session only.

```bash
git clone <this repo> ~/code/skill-scout
claude plugin validate ~/code/skill-scout        # prints "✔ Validation passed"
cd ~/some-project
claude --plugin-dir ~/code/skill-scout           # session-only load (shows as skill-scout@inline)
```

Inside that session:

```
/scout-status
```

prints the config path (`~/.claude/skill-scout/config.json`, created by this first run), `mode: "suggest"`, `installed skills indexed: N (...)` and `stack (<cwd>): ...`. Then type any prompt of 40+ characters, for example `our playwright end-to-end tests are flaky on CI, help me stabilise them with retries and proper waits`. The hook adds this to Claude's context (measured 2026-10-08, Next.js fixture project, 793 chars, 2.1 s cold / 30 ms warm):

```
[skill-scout] Stack: Next.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm; branch main
Installed skills likely relevant: vercel:access-protected-vercel-deployment (matches playwright, tests), marketing:email-sequence (matches e2e, tests), vercel:deployments-cicd (matches ci)
If one of the third-party candidates below fits the request, end your reply with exactly one line `Load with /scout-load <ref>` naming the single best fit; omit that line if none fits.
Third-party candidates (not loaded): anthropics/skills@webapp-testing (172K installs, audit warn) — load with /scout-load anthropics/skills@webapp-testing; microsoft/playwright-cli@playwright-cli (177K installs, audit warn) — load with /scout-load microsoft/playwright-cli@playwright-cli
```

and shows you one line in the transcript: `[skill-scout] 2 third-party skills may fit this prompt (not loaded): /scout-load anthropics/skills@webapp-testing, /scout-load microsoft/playwright-cli@playwright-cli`. Type `/scout-load anthropics/skills@webapp-testing` to load that skill's text (pinned to the current commit) into the session; `/scout-mode local` turns the network off; `/scout-find <query>` searches on demand.

Without a model, the same hook runs from your shell and prints what it would inject plus timings and skip reasons:

```bash
node ~/code/skill-scout/bin/on-prompt.js --dry-run "<your prompt>" --cwd ~/some-project --verbose
```

---

## Install (step by step)

Requirements: Claude Code >= 2.1.282 (`claude --version`), Node >= 20 on `PATH` (`node --version`), `git` on `PATH` (used for `git ls-remote` pinning and for the `/scout-add` fetch), network access to `skills.sh` and `github.com` for the remote features. `npx` is used only when a skill's *text* is fetched (`/scout-load`, `mode: "auto"`, `pinnedSkills`, or the background prefetch), always as the pinned `skills@1.5.26`; `/scout-add` uses `git` only.

1. Clone or copy this repository somewhere permanent (the plugin loads **in place** from this directory; do not delete it afterwards):

   ```bash
   git clone <this repo> ~/code/skill-scout
   cd ~/code/skill-scout
   npm test                           # optional: unit suite, no network, a few seconds
   claude plugin validate .           # "✔ Validation passed"
   ```

2. Register the directory as a local marketplace (the marketplace name `skill-scout-local` comes from `.claude-plugin/marketplace.json`):

   ```bash
   claude plugin marketplace add ~/code/skill-scout
   ```

3. Install the plugin from that marketplace (user scope is the default):

   ```bash
   claude plugin install skill-scout@skill-scout-local
   ```

4. Check that it is installed and enabled:

   ```bash
   claude plugin list
   # Installed plugins:
   #
   #   ❯ skill-scout@skill-scout-local
   #     Version: 0.1.0
   #     Scope: user
   #     Status: ✔ enabled
   ```

   (`claude plugin list --json` gives the same as JSON. `claude --plugin-dir <path> plugin details skill-scout` prints the component inventory: `Skills (5) scout-add, scout-find, scout-load, scout-mode, scout-status`, `Hooks (3) UserPromptSubmit, UserPromptExpansion, SubagentStart`, `Always-on: ~507 tok` added to every session.)

5. Start a new Claude Code session (or run `/reload-plugins` in an open one; `/reload-skills` refreshes the skill list only). Then confirm with `/scout-status` (see the 2-minute section above).

6. Type any prompt of 40+ characters. Claude's context now receives one short factual note like the one shown above. It is visible in the transcript as hook context (`claude --verbose`, or `-p --output-format stream-json --verbose --include-hook-events`), **not as a chat message**. When the hook has third-party candidates it also emits a one-line `systemMessage` for you (`[skill-scout] N third-party skill(s) may fit this prompt (not loaded): /scout-load a/b@c, ...`, each ref once per session), because the relay instruction in the context is only advice to the model: measured 2026-10-07 across three live explorations (haiku and sonnet), the model ended its reply with a `/scout-load` line in 2 of 6 runs that had candidates (both for a Playwright prompt whose candidates fit well; none of the four runs for a pandas prompt), and in 1 of 2 haiku runs after the instruction was moved before the candidate list. Treat the `systemMessage` as the way you learn a candidate exists; a relay is a bonus.

   A prompt that mentions skill-scout itself (`show me the skill-scout status`, even under 40 characters) gets one factual line listing the five commands, because four of them are user-only and invisible to Claude.

   Subagents (the Agent tool) do not go through `UserPromptSubmit` and do not inherit the parent's context, so a `SubagentStart` hook injects the one-line stack into every subagent (nothing else: no routing, no third-party text).

**Uninstall:** `claude plugin uninstall skill-scout@skill-scout-local` and optionally `claude plugin marketplace remove skill-scout-local`. State lives in `~/.claude/skill-scout/` (config, cache, log, pins); delete that directory to reset everything. Nothing else on disk is touched by the hooks.

---

## Commands

| Command | Who invokes it | What it does |
| :-- | :-- | :-- |
| *(every prompt)* | the `UserPromptSubmit` hook | stack + installed-skill routing + (suggest/auto) remote candidates; in `suggest` it also prefetches the top candidate's text in a detached background process so `/scout-load` is instant; 8 s hook timeout, 6 s internal budget. Skipped (nothing injected) for prompts under 40 chars, slash commands (raw prompt starting with `/`), prompts starting with `[skill-scout]`, empty/whitespace prompts, and the synthetic `<task-notification>` / `<system-reminder>` prompts Claude Code delivers after a backgrounded subagent finishes. One run per prompt, never per tool call |
| *(every subagent)* | the `SubagentStart` hook | the one-line `Stack:` only (no index, no network, no third-party text; ~1-35 ms); 3 s timeout, context-only event |
| `/scout-load owner/repo@skill`<br>`/scout-load owner/repo#<40-hex-sha>@skill [--update]` | you | loads the skill's SKILL.md **text** into this session via the `UserPromptExpansion` hook. Owner must be allowlisted or the command is blocked before Claude runs (cost 0). First load resolves HEAD and pins it in `loaded.json`; later loads reuse that pin; `--update` re-resolves. Owner/repo case is folded (`MULTICA-AI/x@s` and `multica-ai/x@s` share one pin). Nothing is installed. |
| `/scout-add owner/repo@skill`<br>`/scout-add owner/repo#<sha>@skill` | you | persistent install into `~/.claude/skills/<skill>`: refuses an existing target before any network call, then pinned `git fetch` into a temp dir, `git ls-tree` + folder inspection **before** the copy (exact, case-sensitive skill name), a guarded copy and a re-inspection. Plugin-shaped folders are `REJECTED` without ever touching `~/.claude/skills`. Prints `INSTALLED <ref> sha <sha>` + audit JSON. Then `/reload-skills`. |
| `/scout-find <query>` (also model-invocable: "is there a skill for X?") | you or Claude | prints installed matches, the gated candidates table `ref  installs  audit  allowlisted?`, the rejected count grouped by reason, `Best allowlist-only rejection: <ref> (<installs> installs, matched ...) - add "<owner>" to "allowlist" in <config>` when the most relevant rejected entry was refused only for its owner, and the top 8 rejected entries by **relevance** (`--all` for every entry). This is the one path that sends your query words to skills.sh. Never installs. In `claude -p`, the Bash call it makes needs `--allowedTools "Bash(node:*)"` (or a permission mode). |
| `/scout-mode`<br>`/scout-mode <off\|local\|suggest\|auto>` | you | shows the effective mode and where it comes from, or rewrites **only** the `mode` key of `config.json` (other keys, including unknown ones, are preserved). Takes effect on the next prompt. Refuses to write `auto` into a redirected `SKILL_SCOUT_HOME`, and refuses to touch a corrupt or unreadable file. |
| `/scout-status` | you | config, warnings, env overrides, effective vs. file mode, installed skills indexed, stack of the cwd, cache stats, skills.sh cooldown, ephemeral pins, persistent installs, log tail. |

Every command is also a plain script (useful for debugging and for the fallback path; `--help` on each prints its usage):

```bash
P=~/code/skill-scout            # plugin root
node $P/bin/on-prompt.js --dry-run "build a landing page in nextjs with tailwind and a pricing table" [--cwd DIR] [--verbose] [--json]
node $P/bin/on-subagent.js --dry-run [--cwd DIR]                                                      # the SubagentStart line
node $P/bin/on-expand.js multica-ai/andrej-karpathy-skills@karpathy-guidelines [--update] [--json]   # prints the sanitized text
node $P/bin/on-expand.js anthropics/skills@frontend-design --prefetch                                 # what the background prefetch runs
node $P/bin/scout-add.js anthropics/skills@frontend-design [--yes] [--json]
node $P/bin/scout-find.js "playwright flaky tests" [--limit N] [--all] [--json] [--cwd DIR]
node $P/bin/scout-mode.js [off|local|suggest|auto] [--json]
node $P/bin/scout-status.js [--json] [--cwd DIR]
```

### What each command prints

**`/scout-status`** (observed 2026-10-08 on a fresh state dir; the model relays it verbatim):

```
[skill-scout] skill-scout 0.1.0  plugin root: /Users/you/code/skill-scout
state dir: /Users/you/.claude/skill-scout
config:    /Users/you/.claude/skill-scout/config.json
  mode: "suggest"
  allowlist: ["anthropics","vercel-labs","microsoft","multica-ai"]
  installFloor: 1000
  ... (every config key)
  prefetch: true
installed skills indexed: 168 (synced 13, user 1, plugin 154)
stack (/Users/you/some-project): Next.js 16, React 19, Tailwind 4, Supabase, Stripe, Vitest, Playwright, TypeScript 5 strict, pnpm; branch main
cache: 28 entries, 414.9 KB, newest 0 min ago, oldest 2 min ago (/Users/you/.claude/skill-scout/cache)
loaded pins (/scout-load, ephemeral): 2
  multica-ai/andrej-karpathy-skills@karpathy-guidelines -> 2c606141936f1eeef17fa3043a72095b4765b9c2  loads 6  last 2026-10-08T05:00:46.033Z
  anthropics/skills@frontend-design -> 683bc88e56f3e09ba94f7055977f3d3aa499f202  loads 2  last 2026-10-08T05:00:50.144Z  stripped: 1
persistent installs (/scout-add): 0
log: /Users/you/.claude/skill-scout/scout.log
  {"ts":"...","level":"info","msg":"on-prompt",...}   (last 5 lines)
```

Problems appear as `  ! ...` lines after the config keys: `! config.json is not valid JSON (Expected double-quoted property name in JSON at position 21 (line 1 column 22)); using defaults`, `! mode: must be one of off|local|suggest|auto; using default "suggest"`, `! allowlist: must be an array of strings; using default [...]`, `! installFloor: must be a non-negative number; using default 1000`, `! config is not a JSON object; using defaults`, `! config.json unreadable (EISDIR); using defaults`, `! SKILL_SCOUT_MODE=auto ignored (the environment can only lower the mode below "suggest")`, `! mode "auto" ignored: it is honoured only in the default ~/.claude/skill-scout/config.json, not in a SKILL_SCOUT_HOME redirect; using "suggest"`. When the environment lowers the mode: `effective mode "off" (file says "suggest"; the environment can only lower the mode, and "auto" counts only in ~/.claude/skill-scout/config.json)`. With a skills.sh cooldown: `skills.sh: rate-limited (HTTP 429) — no requests until HH:MM; cached catalogs still rank`. `--json` returns the same facts (`version, pluginRoot, home, configPath, defaultConfigPath, config, fileMode, configWarnings, envOverrides, testSeams, cache, cooldownUntil, loaded, installed, index, stack, cwd, log, autoWarned`).

**`/scout-mode`** (observed 2026-10-08):

```
[skill-scout] mode: suggest  (config file: /Users/you/.claude/skill-scout/config.json)
  usage: /scout-mode <off|local|suggest|auto>
```

`/scout-mode local` → `[skill-scout] mode: suggest -> local (/Users/you/.claude/skill-scout/config.json). Takes effect on the next prompt; no restart needed.` (`LOCAL` is accepted the same way). `/scout-mode auto` additionally prints the warning quoted under "The four modes". Errors (exit 1): `[skill-scout] unknown mode "turbo"; expected one of off | local | suggest | auto`; `[skill-scout] refusing to write mode "auto" into <redirected>/config.json: auto is honoured only in the default ~/.claude/skill-scout/config.json (unset SKILL_SCOUT_HOME first)`; `[skill-scout] <path>/config.json is not valid JSON (...); fix it by hand first`; `[skill-scout] <path>/config.json is unreadable (EISDIR); fix it by hand first`. When the environment lowers the mode the show form adds `  file says "suggest"; effective "off" (environment override)`; ignored overrides are listed as `  ! SKILL_SCOUT_MODE=auto ignored (the environment can only lower the mode below "suggest")`, `  ! SKILL_SCOUT_MODE=bogus ignored (not one of off|local|suggest|auto)`, `  ! SKILL_SCOUT_HOME=rel-dir ignored (must be an absolute path)`. Live through `claude -p` (haiku, 2026-10-07) each call cost $0.0014-0.0018; on `turbo` the model reported the failure and did not pick another mode; on `auto` in a redirected home it relayed the refusal and did not unset `SKILL_SCOUT_HOME`.

**`/scout-load`** — what Claude sees is the expansion hook's context (observed 2026-10-08, 2,913 chars for `karpathy-guidelines`):

```
[skill-scout] The user explicitly loaded third-party skill multica-ai/andrej-karpathy-skills#2c606141936f1eeef17fa3043a72095b4765b9c2@karpathy-guidelines via /scout-load (pinned resolved; text only, nothing installed). Contents (sanitized; stripped: nothing):
<skill-scout-loaded ref="multica-ai/andrej-karpathy-skills#2c606141936f1eeef17fa3043a72095b4765b9c2@karpathy-guidelines">
---
name: karpathy-guidelines
...
</skill-scout-loaded>
```

`pinned resolved` on the first load (HEAD resolved by `git ls-remote`), `pinned loaded.json` afterwards, `pinned resolved (--update)` with `--update`, `pinned arg` for a `#sha` ref. A long skill reads `stripped: truncated 388 chars to 9000` (`anthropics/skills@frontend-design`, 9,387-char context). What you see is the model's reply, which the skill body asks to keep to three lines (observed on haiku, 2026-10-07): `Pinned: multica-ai/andrej-karpathy-skills#2c60614...@karpathy-guidelines / Skill: karpathy-guidelines — Behavioral guidelines to reduce common LLM coding mistakes ... / Stripped: nothing`. Timing from the shell (`node bin/on-expand.js <ref>`): 3.2 s wall for a first load (HEAD resolve + pinned `npx skills use`, warm npm cache), 0.05 s when the text is cached, 0.35 s for `--update` (one `git ls-remote`, text still cached).

A rejected reference is blocked **before any model call** (hook exit 2, `total_cost_usd` 0, `num_turns` 0, the CLI still exits 0). Claude Code prints:

```
UserPromptExpansion operation blocked by hook:
[node "/Users/you/code/skill-scout/bin/on-expand.js"]: [skill-scout] refused: owner "evil" is not in the allowlist [anthropics, vercel-labs, microsoft, multica-ai]. Add "evil" (or "evil/repo") to "allowlist" in /Users/you/.claude/skill-scout/config.json if you trust that source, then retry.
This hook comes from the skill-scout@inline plugin.

Original prompt: /skill-scout:scout-load evil/repo@x
```

**`/scout-find playwright`** (observed 2026-10-08 with the catalogs already cached: 5 requests served from cache, 12 ms; a cold `supabase auth` query made 7 live requests in 1.5 s):

```
[skill-scout] query: "playwright"  keywords: playwright

Installed locally (already available, use the Skill tool / slash command):
  vercel:access-protected-vercel-deployment    plugin   score 4.369  Access and test Vercel deployments protected by ...

Third-party candidates (gated: allowlist, install floor, audit; NOT installed):
  ref                                                              installs  audit    allowlisted?
  anthropics/skills@webapp-testing                                 172K      warn     yes
  microsoft/playwright-cli@playwright-cli                          177K      warn     yes
  microsoft/playwright@playwright-dev                              3.6K      warn     yes
  microsoft/playwright-cli@dev                                     5.2K      warn     yes

  Load ephemerally (text only):  /scout-load <ref>
  Install persistently (pinned): /scout-add <ref>

Rejected: 527
  305 x installs N < floor N
  170 x owner not allowlisted
  27 x already installed locally (...)
  17 x fork of ...
  8 x duplicate skill name; kept ...
  Best allowlist-only rejection: alinaqi/maggy@playwright-testing (3.3K installs, matched playwright, testing) - add "alinaqi" to "allowlist" in /Users/you/.claude/skill-scout/config.json to consider it
  top rejected by relevance (use --all for the full list):
    microsoft/playwright@playwright-test-results                     326       installs 326 < floor 1000  [matched playwright, testing]
    ...

(5 requests, cached: true, 12 ms)
```

With no query it prints `usage: scout-find.js "<query>" [--limit N] [--all] [--json] [--cwd <dir>]` and exits 1; a query with no usable keyword (`a`) prints `keywords: (none)`, `Rejected: 0`, `(0 requests, cached: false, 0 ms)` without touching the network; shell metacharacters in the query are passed as one argv string and never executed (`query: "$(id) ; echo pwned"  keywords: id, echo, pwned`, no `uid=` anywhere). During a skills.sh cooldown the report says `Third-party search failed (skills.sh rate-limited until HH:MM); nothing could be evaluated.` when nothing is cached, or lists the cached candidates with `Rejected: N (from cached catalogs only)`. Through `claude -p` (haiku, 2026-10-07): `/scout-find playwright` ran `node .../bin/scout-find.js "playwright"` and presented the three-part summary ($0.001-0.003); the natural-language form `is there a skill for playwright e2e testing?` invoked `Skill {"skill":"skill-scout:scout-find"}` then the same script, listed the four candidates, said no allowlist change was needed and installed nothing; `/scout-find $(id) ; echo pwned` was refused by the model without running anything.

**`/scout-add`** (observed 2026-10-07/08 with `HOME` pointed at a temp dir):

```
INSTALLED multica-ai/andrej-karpathy-skills#2c606141936f1eeef17fa3043a72095b4765b9c2@karpathy-guidelines sha 2c606141936f1eeef17fa3043a72095b4765b9c2
  path: /Users/you/.claude/skills/karpathy-guidelines (1 files, inspected before and after the copy: clean)
  source: multica-ai/andrej-karpathy-skills skills/karpathy-guidelines
  audit: { "status": "pass", "providers": [ {"provider": "Gen Agent Trust Hub", "status": "pass", ...}, ... ] }
Run /reload-skills or start a new session to use it.
```

A plugin-shaped folder prints `REJECTED: <pinned ref>` followed by one problem per line (`executable bit in repository tree: helpful-setup/bin/pwn (mode 100755)`, `symlink in repository tree: helpful-setup/link (mode 120000)`, plugin component directories, capability frontmatter, inline/fenced shell) and `Nothing was written to ~/.claude/skills.` (verified against a local bare repository built from `test/fixtures/skill-folders/malicious`; see `docs/testing.md`). Other outcomes, all exit 1 with nothing written: `REFUSED: ~/.claude/skills/<skill> already exists (directory). Remove it yourself first; skill-scout never overwrites.` (also `(symlink)`, never followed; checked before any network call), `REJECTED: owner "evil" is not allowlisted [anthropics, vercel-labs, microsoft, multica-ai]. Add it to "allowlist" in <config> if you trust it.`, `REJECTED: <owner/repo@skill> matches blockedRefs`, `no skill named "DOCX" in anthropics/skills at 683bc88 (exact, case-sensitive). Found: academy-guide, ..., docx, ...`, `git fetch failed (exit 128): fatal: remote error: upload-pack: not our ref 0000...` for a bogus sha, `could not resolve HEAD of https://github.com/anthropics/zzz-no-such-repo-qqq: repository not found or private (GitHub asked for credentials): ...`, `invalid ref "not a ref": expected owner/repo@skill or owner/repo#<40-hex-sha>@skill` (same for a 39-hex or uppercase-hex sha), and without `--yes` in a non-interactive run `[skill-scout] not installed (pass --yes to skip this prompt; non-interactive runs require it)`. The skill body passes `--yes` because you typed the command.

### Errors you will see for a bad `/scout-load` reference

All of these are produced by the expansion hook before any subprocess or model call (exit 2, cost 0); the same text ends with the usage line `usage: /scout-load owner/repo@skill  or  /scout-load owner/repo#<40-hex-sha>@skill  [--update]`.

| You typed | Block reason |
| :-- | :-- |
| `/scout-load a/b@c; rm -rf ~` | `[skill-scout] unknown option -rf.` |
| `/scout-load ../../etc/passwd` | `[skill-scout] invalid skill reference "../../etc/passwd".` |
| `/scout-load <ref> extra words` | `[skill-scout] expected exactly one skill reference, got 3.` |
| `/scout-load` | `[skill-scout] missing skill reference.` |
| a 506-char `a/bbbb…@c` | `[skill-scout] invalid skill reference "a/bbbb…"` (sliced to 80 chars; segments are capped at 100) |
| a 39-hex `#sha` | `[skill-scout] invalid skill reference "…"` |
| `/scout-load <ref> --force` | `[skill-scout] unknown option --force.` |
| `/scout-load evil/repo@x` | `[skill-scout] refused: owner "evil" is not in the allowlist [...]. Add "evil" (or "evil/repo") to "allowlist" in <config> if you trust that source, then retry.` |
| a ref listed in `blockedRefs` | `[skill-scout] refused: <owner/repo@skill> matches "blockedRefs" in your config.` |
| unreachable repository | `[skill-scout] could not resolve HEAD of https://github.com/<owner>/<repo>: ...` |

### Fallback when the expansion hook cannot run

The `UserPromptExpansion` hook is confirmed to fire and deliver `additionalContext` on 2.1.282 and 2.1.293. If it ever does not (hooks disabled with `disableAllHooks`, a future CLI change, or a timeout), `/scout-load` still works: the skill body tells Claude to run `node "<plugin root>/bin/on-expand.js" <ref>` with the Bash tool and show you the frontmatter first. That script applies exactly the same validation, pinning and sanitizing; its first line is `[skill-scout] loaded <pinned ref> (pinned <source>; stripped: <list or nothing>)`, and a rejected reference prints the same reason as above and exits 1. `${CLAUDE_PLUGIN_ROOT}` is expanded inside skill bodies (verified), so the path resolves without guesswork.

---

## The four modes

Switch with `/scout-mode <off|local|suggest|auto>` (rewrites only the `mode` key of `~/.claude/skill-scout/config.json`; the file is created by the first hook run or `/scout-status`), or edit the file. `SKILL_SCOUT_MODE=local claude` lowers the mode for one shell; the environment can **only lower** it (a repository's `.claude/settings.json` `env` reaches the hook too, verified on 2.1.293; see `docs/security.md` section 4), and `auto` counts only when it is written in the default config file.

| mode | per-prompt hook | network | third-party text reaches Claude |
| :-- | :-- | :-- | :-- |
| `off` | no-op (`--dry-run` prints `[skill-scout] (no context: mode off)`) | no | never (only `/scout-load` still works) |
| `local` | stack + installed-skill routing | no | only via `/scout-load` |
| `suggest` **(default)** | stack + routing + on a local miss: allowlisted-owner catalogs (cached 24 h) + up to 2 single tech-word searches, relevance ranking, gating, audit, **text suggestion** `load with /scout-load owner/repo@skill`, then a detached background prefetch of the top candidate's text | yes | only after you type `/scout-load` |
| `auto` | everything above, then the single best gated candidate's SKILL.md is pinned, fetched, sanitized and **injected without confirmation** | yes | **yes, automatically** |

What the context looks like per mode, for a prompt with no strong local match (observed 2026-10-07/08):

- `local`: `[skill-scout] Stack: ...` + `Installed skills likely relevant: ...` (301-322 chars typical; 131 chars when nothing local matches; no stack line in a directory without manifests).
- `suggest`: the same two lines, then the relay instruction, then `Third-party candidates (not loaded): ...` (715-833 chars typical), plus the one-line `systemMessage` for you. Identical to `local` when a strong installed match exists (the remote step is skipped) or when every candidate is rejected (see FAQ).
- `auto`: the `suggest` lines for the remaining candidates, then `Loaded third-party skill <owner/repo#sha@skill> (auto mode, user-configured; text only, nothing installed). Stripped: ...` and the sanitized body inside `<skill-scout-loaded ref="...">` tags, truncated so the whole output stays under 9,500 chars (observed: 9,498 chars, 3.8 s on the first prompt that found a cached text); the first injection also carries the one-time `[skill-scout] WARNING: mode "auto" is enabled...` `systemMessage`.

> **Warning about `auto`.** Anthropic's guidance is to use skills only from sources you trust; measured base rates for public registries include ~13% critical findings and live trojanized packages, install counts are not a safety signal, and scanners are advisory and bypassable (see `docs/security.md`). In `auto`, text written by a third party is placed in Claude's context every time your prompt has no strong local match, with only the allowlist, install floor, audit status, commit pin and sanitizer between you and it. The residual risk is prompt injection in prose you did not read. skill-scout shows a one-time warning (as the hook's `systemMessage`, visible in the transcript) when `auto` first injects something, never writes the text to disk, and strips the capability-granting parts of SKILL.md, but it cannot make untrusted prose trustworthy. Keep `suggest` unless you have read the skills your allowlist can reach.

`/scout-mode auto` prints: `[skill-scout] mode "auto": third-party skill text from allowlisted skills.sh sources will be injected into your prompts WITHOUT confirmation (text only, pinned, sanitized, still untrusted prose). Cold prompts add up to ~5 s and up to 9,000 chars of third-party text per prompt; see README "What auto actually costs". Run /scout-mode suggest to go back.`

### What `auto` actually costs

| situation | what happens | added time | added context |
| :-- | :-- | :-- | :-- |
| cold prompt, candidate never seen on this machine | HEAD is resolved (`git ls-remote`, ~0.5-1.8 s); if >= 4.5 s of the 6 s budget remain, `npx skills use` fetches the text inline (~4.2 s measured **with a warm npm cache**; with an empty `~/.npm` the CLI download alone exceeded the inline window and was killed at 4.76 s), otherwise only the **suggestion** is emitted and the text is prefetched in the background (`autoSkipped` / `autoError` in the log / `--verbose`; a `--dry-run` says the text *would be* prefetched because it spawns nothing). In practice the first auto prompt on a machine yields only the suggestion (observed 2026-10-07: cold `discoverMs` 3,368 then `autoSkipped=only 1924ms left`); the next one is served from the cache | ~1-6 s | 0 or up to 9,000 chars |
| the same candidate again (or after the prefetch finished) | text served from the immutable per-sha cache; no git, no npx | ~0 ms | up to 9,000 chars of third-party text **on every such prompt** |
| a strong local match exists | nothing remote, same as `suggest` | 0 | 0 |

`/scout-mode suggest` reverts. Note that `auto` was exercised live only by feeding the hook directly (2026-10-07, `HOME` pointed at a scratch dir, two runs: 3,767 ms with a 9,498-char context, then the cached path); the two recipes for running `claude -p` itself with a scratch `HOME` either failed to log in or did not pass `HOME` to the hook, so there is no model-in-the-loop measurement of `auto`.

### Always-on guidelines (`pinnedSkills`)

Behavioural skills (Karpathy-style coding guidelines) have no task nouns, so keyword routing only finds them when the prompt happens to say "refactor" or "simplify". For "apply these guidelines to every coding prompt", list them in `config.json`:

```json
"pinnedSkills": ["andrej-karpathy-skills:karpathy-guidelines", "multica-ai/andrej-karpathy-skills@karpathy-guidelines"]
```

An **installed** skill name (plain or `plugin:name`) becomes a one-line hint `Pinned installed skills (user-configured, consider invoking): …`; an allowlisted **ref** is pinned like `/scout-load` (first load resolves HEAD and records it in `loaded.json`), fetched once, cached forever by sha, and its sanitized text is injected. Either is emitted **once per session** (`session_id` from the hook input), not on every prompt. Non-allowlisted refs and unknown names are ignored with a warning in `/scout-status`.

### What `suggest` decides

The remote step runs only if `mode` is `suggest`/`auto` **and** no installed skill is a *strong* match. A match is strong when its score is >= 10 **and** it matched at least two meaningful prompt tokens, or a single *name* token that is a tech noun (`nextjs`, `stripe`, `pdf`, `auth`) or a rare word with score >= 20 (`dashboard` -> `data:build-dashboard` at 22.3 on this machine). A single hit on a hyper-common word (`file`, `function`, `build`, `page`, `test`, `clean`, `module`, `failure`, `review`, and since 2026-10-07 also `claude`, `code`, `plugin`, `skill`, `command`, `hook`, `rules`, `guide`, `repo`) is never listed as "likely relevant" and never suppresses discovery (measured: `commit-commands:clean_gone` scored 17.7 for a pandas prompt via "cleans"; `claude-mem:version-bump` scored 46.9 for every prompt mentioning "Claude Code" before the stoplist change and 23.2, dropped as weak, after it). A single common English name word (`design`, `route`, `routing`, `system`, `review`, `plan`, `setup`, `status`) is listed but never strong, so `engineering:system-design` (11.5 for "design a pricing page") and `vercel:routing-middleware` (15.9 for "add a /api/health route") no longer hide discovery. `--dry-run --verbose` prints `local=name:score*` (`*` = strong) and `weak(dropped)=…`; a golden routing table over a 168-skill snapshot lives in `test/bin.test.js`.

Measured on 2026-10-08 with `bin/on-prompt.js --dry-run --verbose` from the Next.js fixture project, 168 installed skills indexed, fresh state dir (hook time is in-process; add ~100 ms of `node` startup for the wall time):

| prompt | result | hook time |
| :-- | :-- | :-- |
| `what are the tradeoffs between server and client components in next.js 16? cite the docs` | stack + `vercel:nextjs` (server, components, nextjs; strong), `vercel:next-cache-components` (strong), `vercel:next-upgrade`; remote skipped | 25 ms |
| `build a landing page with tailwind css!!` (exactly 40 chars) | stack + `figma:figma-generate-design`, `vercel:shadcn` (build, tailwind, css; strong), `marketing:content-creation`; `superset:page` dropped as weak; remote skipped | 19 ms (45 ms on the first run, cold index) |
| the same prompt minus one `!` (39 chars) | skipped: `prompt shorter than minPromptChars (39 < 40)` | < 1 ms |
| `hi` | skipped: `prompt shorter than minPromptChars (2 < 40)` | < 1 ms |
| `design a pricing page with three tiers, dark theme, tailwind` | stack + `vercel:shadcn` (design, theme, tailwind; strong), `figma:figma-generate-design`, `engineering:system-design` (design; not strong); remote skipped | 25 ms |
| `add a /api/health route that returns uptime json` | stack + `vercel:routing-middleware` (route), `vercel:microfrontends`, `vercel:workflow`, none strong → discovery sent `q=api`, `q=json`: `anthropics/skills@claude-api (69.6K, warn)`, `anthropics/knowledge-work-plugins@build-zoom-rest-api-app (2.0K, warn)` — matched only on `api`, a loose fit | 2,424 ms (catalogs cached, 2 new searches) |
| `write a pandas script that plots monthly churn from a csv` | stack + `anthropic-skills:xlsx` (script, csv), `data:create-viz` (plots), `product-management:stakeholder-update`; discovery sent `q=pandas`, `q=csv`, 715 rejected, **0 candidates** because `statistical-analysis` and `data-visualization` are installed here (the synced `data` plugin) and are dropped as `already installed locally`; on a machine without them the same prompt listed `anthropics/knowledge-work-plugins@statistical-analysis (4.3K, pass)` and `@data-visualization (12.8K, pass)` | cold 1,887 ms (4 catalogs + 2 searches, no timeouts) / warm 32 ms (`discoverMs` 5) |
| `our playwright end-to-end tests are flaky on CI, help me stabilise them with retries and proper waits` | stack + three weak-ish locals, then `anthropics/skills@webapp-testing (172K, warn)`, `microsoft/playwright-cli@playwright-cli (177K, warn)`; sent `q=playwright`, `q=e2e` | 2,090 ms |
| `write a terraform module for an s3 bucket with versioning and lifecycle rules` | stack only: no installed match (`version-bump` and five others dropped as weak), discovery sent `q=terraform`, `q=s3`, 0 candidates (no allowlisted owner has one; `writing-hookify-rules`/`kyc-rules` no longer match on `rules`) | 1,240 ms |
| `how do I configure Claude Code hooks to run prettier after every file edit` | stack only; `claude-mem:version-bump` 23.2 and `claude-md-improver` 17.0 dropped as weak (the right skill, the CLI-bundled `update-config`, has no SKILL.md on disk) | 25 ms |
| `refactor this function to be simpler, keep changes surgical and do not touch adjacent code` | stack + `andrej-karpathy-skills:karpathy-guidelines` (refactor, changes, surgical, code; 11.0, not strong); in `suggest` the explorers saw `vercel-labs/agent-skills@vercel-react-best-practices (776K)` and `@web-design-guidelines (707K)` suggested — popular but not fitting; use `pinnedSkills` for guideline skills | 19 ms |
| a 12,000-char prompt (one SaaS billing paragraph repeated) | stack + three strong design-system matches; context 289-320 chars; no watchdog | 20 ms |
| `hazme una landing page para mi startup con nextjs y tailwind, con precios y un formulario de contacto` | routes on the tech nouns (`vercel:nextjs` strong, `marketing:content-creation`, `figma:figma-generate-design`); the context is English, the model answered in Spanish | 19 ms |

Cold discovery depends on skills.sh: 2026-10-07 the `microsoft` catalog request timed out (2,500 ms) and cold discovery took 5,631 ms; that failure is now remembered for 5 minutes (`fail:catalog:<owner>` marker, `queries[].skipped: "recent-failure"`), a stale copy keeps ranking, and the next prompt measured 6 ms.

Ranking: each catalog entry is scored against the prompt plus its intent terms (`landing/pricing/tailwind` → `frontend design`, `flaky/e2e/spec` → `testing`, `refactor/simplify/surgical` → `coding guidelines best practices`, `stripe/checkout` → `payments billing`, …) with the same BM25-lite used for installed skills, then `log10(installs)` is added. A candidate is matched only on an exact stemmed token of its name, so `nextjs` does not match a skill named `next` and `stripe` does not match `fsi-strip-profile`; a project stack tag alone is a weak bonus, never a match. `/scout-find <query>` shows the full gated and rejected lists when a pick looks off.

---

## Configuration reference

`~/.claude/skill-scout/config.json` (or `$SKILL_SCOUT_HOME/config.json`). Created from the defaults on first run; unknown keys are kept; a wrong type falls back to the default and is reported by `/scout-status`. `config.example.json` in this repo is identical to the defaults.

| key | default | meaning |
| :-- | :-- | :-- |
| `mode` | `"suggest"` | `off` / `local` / `suggest` / `auto` (see above) |
| `allowlist` | `["anthropics","vercel-labs","microsoft","multica-ai"]` | GitHub owners (`owner`) or repositories (`owner/repo`) whose skills may be suggested, loaded or installed. Case-insensitive, exact. Everything else is rejected as `owner X not allowlisted`. |
| `installFloor` | `1000` | minimum skills.sh install count for a candidate |
| `maxLocalSkills` | `3` | installed skills named per prompt |
| `maxCandidates` | `2` | third-party candidates named per prompt (suggest) / considered (auto: only the first is loaded) |
| `minPromptChars` | `40` | shorter prompts get no context at all (the boundary is inclusive: 40 chars route, 39 do not; measured after stripping Claude Code's `<pasted_content>` wrapper lines) |
| `remoteTimeoutMs` | `2500` | per-request timeout for skills.sh |
| `totalBudgetMs` | `6000` | hard deadline for the whole per-prompt hook; the remote step is skipped when < 1500 ms remain, an inline `auto` fetch when < 4500 ms remain (a warm `npx skills use` measures ~4.2 s; the text is then prefetched in the background instead); a watchdog flushes the local-only context if anything overruns (hook timeout is 8 s) |
| `contextBudgetChars` | `2000` | cap for the suggestion text (candidates are dropped first, then installed matches). Loaded skill text (auto / `pinnedSkills` / `/scout-load`) is capped separately at 9,000 chars and then truncated further so the whole hook output (stack + routing + skill body) stays under 9,500 chars, because Claude Code only shows a 2 KB preview of hook output above 10,000 chars; spilling to `$SKILL_SCOUT_HOME/spill-<ts>.md` is a last resort for oversized routing text |
| `cacheTtlHours` | `24` | TTL for owner catalogs, tech-word searches, audit verdicts and resolved HEAD SHAs (`$SKILL_SCOUT_HOME/cache/`). Skill text is cached **forever** by pinned ref (`text:owner/repo#sha@skill`): a commit is immutable, so any ref is fetched at most once per machine |
| `skillsCliVersion` | `"1.5.26"` | the `skills` npm CLI version used for `skills use` (text fetch; pinned; never `latest`). `/scout-add` does not use the CLI |
| `requireAuditPass` | `true` | drop candidates whose skills.sh audit status is `fail` (or any provider `CRITICAL`). `warn` and `unknown` (no audit yet, endpoint down) still pass with the status shown, because a strict all-pass rule would reject `anthropics/skills@webapp-testing`, `anthropics/skills@claude-api` and several vercel-labs and microsoft skills that carry a `warn` today |
| `stackDetection` | `true` | read `package.json`/lockfiles/`tsconfig.json`/`pyproject.toml`/`requirements.txt`/`go.mod`/`Cargo.toml`/`Gemfile`/`pom.xml`/`.git/HEAD` in the session's cwd |
| `blockedRefs` | `[]` | never suggest/load/install these: `owner`, `owner/repo` or `owner/repo@skill` |
| `pinnedSkills` | `[]` | always-on skills, injected once per session: installed skill names (`name` or `plugin:name`) become a hint line; allowlisted `owner/repo[#sha]@skill` refs are pinned, fetched once and their sanitized text injected (see "Always-on guidelines") |
| `prefetch` | `true` | in `suggest`, spawn a detached `on-expand.js <ref> --prefetch` for the top candidate so its HEAD and text are cached before you type `/scout-load` (or before the next `auto` prompt). `false` disables the background process |

Environment (untrusted: a repository's committed `.claude/settings.json` `env` block reaches the hook process — verified on 2.1.293 with `SKILL_SCOUT_MODE=off` — so the environment can only **lower** privilege): `SKILL_SCOUT_HOME` (state directory, default `~/.claude/skill-scout`; honoured only as an absolute path outside the project directory, and `mode: "auto"` is never honoured in a redirected home), `SKILL_SCOUT_MODE` (per-process mode override; can only lower the mode below the config file's value), `CLAUDE_CONFIG_DIR` (honoured when indexing installed skills), `SKILL_SCOUT_DEBUG=1` (log the extracted keywords). `/scout-status` lists every override and whether it was ignored, and names any active **test seam** (`SKILL_SCOUT_REGISTRY_BASE`, `SKILL_SCOUT_GIT_BASE`, `SKILL_SCOUT_SKILLS_DIR`, `SKILL_SCOUT_TEST_ALLOW_AUTO`): those exist only for the test suite, are honoured only in forms a repository cannot exploit (loopback / local-path / outside-the-project), and are documented in `docs/testing.md`, not here.

State files under the state directory: `config.json`, `cache/`, `loaded.json` (ephemeral pins: `{ref, sha, ts, lastTs, loads, chars, stripped}` per unpinned ref), `installed.json` (persistent installs made by `/scout-add`), `scout.log` (JSON lines, rotated at 2 MB; `on-prompt` lines carry `sessionId`, `promptId`, `promptChars`, matches, candidates, the shared tech words and timings), `.auto-mode-warned`.

### Adding an allowlist owner

1. Decide whether you trust the **owner** (a GitHub user or org) or only one **repository**. `"expo"` allows every repo under `github.com/expo`; `"expo/skills"` allows only that one.
2. Edit `~/.claude/skill-scout/config.json`:

   ```json
   "allowlist": ["anthropics", "vercel-labs", "microsoft", "multica-ai", "expo/skills"]
   ```

3. No restart needed: every hook run re-reads the config. `/scout-status` shows the effective list and any parse warning. `/scout-find <query>` names the most relevant entry that was refused only for its owner, e.g. for `supabase auth` (2026-10-08): `Best allowlist-only rejection: nice-wolf-studio/claude-code-supabase-skills@supabase-auth (315 installs, matched supabase, auth) - add "nice-wolf-studio" to "allowlist" in ~/.claude/skill-scout/config.json to consider it`. The line is chosen by relevance (both query words matched), not by installs: `supabase/agent-skills@supabase (314K)` matched one word and sits further down the `--all` list. Read the repository before adding an owner.
4. `blockedRefs` wins over the allowlist, so you can allow an owner and still block one of its skills.

---

## Sessions, subagents and tool calls

- **One hook run per prompt, never per tool call.** A turn in which Claude ran `ls` and `cat` through the Bash tool fired `UserPromptSubmit` exactly once; the context injected before the tools was still honoured after them (the reply echoed the `Stack:` line verbatim). `--permission-mode plan` and `acceptEdits` make no difference to the hook (the plan-mode call itself cost $0.038 vs ~$0.001 for the same haiku prompt, unrelated to the plugin).
- **Slash commands.** A typed `/scout-status`, `/scout-mode …`, `/scout-find …` or `/scout-add …` fires `UserPromptSubmit` with the raw slash text, which the hook skips (`skipped: slash command`, also after leading spaces or a newline); the skill body then runs the matching `node` script through the Bash tool with `${CLAUDE_PLUGIN_ROOT}` expanded. Only `/scout-load` has an expansion hook; it fires **before** `UserPromptSubmit`. A slash command mentioned in prose (`should I run /scout-status first?`) is an ordinary prompt and is routed. A natural-language request for a user-only command (`show me the skill-scout status`) cannot invoke it: Claude's skill list contains only `skill-scout:scout-find`, so it answers from the command-list line instead.
- **Subagents.** In `-p` mode the Agent tool is auto-backgrounded on 2.1.293. A subagent's prompt never passes through `UserPromptSubmit` and the parent's context is not inherited; the `SubagentStart` hook (input `{session_id, transcript_path, cwd, prompt_id, agent_id, agent_type, hook_event_name}`) injects `[skill-scout] Stack: ...` into the subagent (verified: the subagent echoed it verbatim; 35 ms wall; $0.0037 for the run). When the subagent finishes, Claude Code resumes the main agent with a synthetic `<task-notification>...` prompt that also fires `UserPromptSubmit`; the hook recognises and skips it (`skipped: task notification (synthetic prompt)`), so tech words from a subagent's output are never searched. Such a run produces **two** `result` events in the stream (an interim "I've started a subagent..." and the real one): read the last.
- **Multi-turn.** Text loaded in turn N (`/scout-load`, `auto`, `pinnedSkills`) stays visible in later turns of the same session: Claude Code stores hook `additionalContext` in the transcript as an attachment of type `hook_additional_context`, so `--resume` / `--continue` keep it (verified: the four section titles and a verbatim bullet of `karpathy-guidelines` were recalled two turns later; a second `/scout-load anthropics/skills@frontend-design` coexisted with it and both were reported as still visible), and it is **not** re-injected on every turn. It is lost when the session is not persisted (`--no-session-persistence`) or after compaction: re-run `/scout-load` after `/compact`. Long skills are truncated at 9,000 chars (`anthropics/skills@frontend-design` loses 388 chars); `/scout-add` keeps the full text on disk.
- **Piped stdin** is part of the prompt the hook sees: `echo "..." | claude -p` works, and `claude -p "prompt" < file` appends the file to the prompt (the hook scored a 210-char combined prompt), so tech words in piped files can trigger the two single-word skills.sh searches in `suggest`; use `mode: "local"` for scripted pipelines.
- **What the hook cannot see.** CLI-bundled skills (`dataviz`, `update-config`, `artifact-design`, `code-review`, `simplify`, …) have no `SKILL.md` on disk, so they are never in the index and never listed; Claude still picks them on its own (observed: `Skill {"skill":"dataviz"}` for a pandas prompt on both haiku and sonnet while the hook listed `xlsx`). Suggested skills are not invoked automatically either: in the sonnet runs the model never called the Skill tool for `vercel:nextjs`, `routing-middleware`, `shadcn` or `karpathy-guidelines` after they were listed; it did reflect the injected stack (`import { NextResponse } from "next/server"`, Tailwind 4 classes, a Next 16 doc citation).

---

## What the hooks send and never do

- `UserPromptSubmit` input: `{session_id, transcript_path, cwd, prompt_id, permission_mode, hook_event_name, prompt}` (captured 2.1.282 and 2.1.293). Output only `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}` plus an optional top-level `systemMessage` (the one-time auto warning; the candidate announcement), or nothing at all. Skipped for slash commands (the **raw** prompt starts with `/`, Claude Code's own rule, so a pasted block whose first inner line is `/scout-load …` is a normal prompt), synthetic `<task-notification>` / `<system-reminder>` prompts, prompts under `minPromptChars` (except the skill-scout command list for prompts about the plugin), prompts starting with `[skill-scout]` (a mid-prompt mention is routed), whitespace-only prompts, and `mode: "off"`. Exit code is always 0; corrupt stdin or another event name produce no output. A hook cannot rewrite your prompt and this one never tries: a prompt that starts with `[skill-scout]` reaches the model unchanged (observed: "Understood, I'll skip the skill-scout lookup for this Next.js 16 project").
- `UserPromptExpansion` input adds `expansion_type`, `command_name` (`skill-scout:scout-load`, matched by `hooks.json` with the regex `(^|:)scout-load$`, because a bare `scout-load` matcher never fires for a plugin skill), `command_args` (the raw text after the command), `command_source`. Output: the same envelope with `hookEventName: "UserPromptExpansion"`, or stderr + exit 2 to block. Owner and repo are lowercased before pinning (`MULTICA-AI/x@s` and `multica-ai/x@s` share one `loaded.json` entry and one text cache entry; the skill segment stays case-sensitive).
- `SubagentStart` input: `{session_id, transcript_path, cwd, prompt_id, agent_id, agent_type, hook_event_name}` (2.1.293). Output: the envelope with `hookEventName: "SubagentStart"` and only the `Stack:` line, or nothing (mode `off`, `stackDetection: false`, no detectable stack, another event name, or input without `cwd`). Context-only event; exit 0 always.
- **Outbound data.** The per-prompt hook never sends your prompt. In `suggest`/`auto` it fetches each allowlisted owner's catalog (`GET skills.sh/api/search?q=skill&owner=<owner>&limit=200`, no prompt content, cached 24 h), searches at most **two single words from your prompt that are in the built-in tech lexicon** (`q=stripe`, `q=react`; names, sentences and other words are never sent; cached per word), and looks up audits by candidate id. `/scout-find` additionally sends your query's keywords as one joined search. Loading a skill runs `git ls-remote` and a pinned `npx skills use` against github.com. `mode: "local"` makes the hook network-free. `docs/security.md` section 5 has the full table; `--dry-run --verbose` prints `shared=[...]`, the exact words sent, and `scout.log` records them as `discover.shared`.
- The hooks never write under `~/.claude/skills`, `~/.claude/plugins` or any settings file; never run a shell string (every subprocess is `execFile` with an argument array, refs validated by `^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._-]*(#[0-9a-f]{40})?@[A-Za-z0-9][A-Za-z0-9._-]*$` first, so a segment can never start with `-` or be `.`/`..`); set `DISABLE_TELEMETRY=1` and `GIT_TERMINAL_PROMPT=0` on every `npx`/`git` call; run `npx`/`git` in a fresh temp directory that is removed afterwards. On the first HTTP 429 from skills.sh they stop for 5 minutes (`/scout-status` shows the cooldown).
- Registry responses and third-party SKILL.md contents are treated as data. The sanitizer removes the frontmatter keys `allowed-tools, disallowed-tools, hooks, context, agent, shell, paths, model` in plain, quoted (`"hooks":`) and indented (`  hooks:`) spellings plus any flow-mapping line, inline `` !`cmd` `` lines, fenced ```` ```! ```` blocks, line-leading `@path` references, ANSI/NUL, and caps at 9,000 chars, listing everything it stripped in the header Claude sees.
- `<pasted_content id="…">` wrapper lines that Claude Code adds around pasted text are removed before the length check, routing and keyword extraction, so a pasted 28-character prompt is still skipped (`28 < 40`), an 83-char pasted prompt routes on its inner text, and the wrapper tokens (`pasted`, `content`, `x1`) never drive a suggestion.

---

## Testing

```bash
npm test                                                   # = node --test 'test/*.test.js'; no network, no real npx (fetch/execFile/spawn are injected; one test drives real git against a local bare repo); a few seconds
node --test --experimental-test-coverage 'test/*.test.js'  # same suite with a per-file line/branch/function table
bash test/e2e/run.sh                                       # live: runs claude -p with the plugin loaded via --plugin-dir (see test/e2e/README.md)
```

`docs/testing.md` is the testing guide: suite layout and what each file covers, the coverage run and its table, the e2e isolation recipe, the test seams (loopback registry, local git base, redirected skills dir, auto in a redirected home) and the cost of live runs. The e2e script needs a logged-in Claude Code (`claude` once, then `/login`); it prints `SKIP` otherwise. It never touches `~/.claude/settings*.json`, `~/.claude/skills` or `~/.claude/plugins` and verifies that with a before/after hash. Last run (2026-10-07, 2.1.293): 9/9; three haiku calls cost under $0.03 in total (the blocked case makes no model call). For your own `-p` experiments: slash commands other than `/scout-load` run `node` through the Bash tool, which non-interactive mode denies unless you pass `--allowedTools "Bash(node:*)"`; spawning a subagent needs `--allowedTools Agent`; always set `SKILL_SCOUT_HOME` to a fresh absolute directory outside the cwd, and never point `HOME` at a directory under the cwd (the hardening in section 4 of `docs/security.md` then silently uses your real home).

Live cost reference (2026-10-07): one haiku prompt through the recipe $0.001-0.004 (a 12,000-char prompt that made the model do 13 tool turns: $0.02); one sonnet prompt $0.02-0.06; the 21-prompt haiku class probe $0.12 in total.

---

## FAQ

**Why are there no third-party candidates?** In order of likelihood: (1) an installed skill was a strong match, so the remote step was skipped (`--dry-run --verbose` shows `local=name:score*`, `*` = strong, and no `discover=` line); (2) every ranked entry was rejected — `/scout-find <query>` shows the reasons: `owner not allowlisted` (by far the largest group), `installs N < floor 1000`, `already installed locally (...)` (a candidate whose name matches an installed skill is dropped in favour of the local one; this is why the pandas prompt lists nothing on a machine with the synced `data` plugin), `fork of ...`, `duplicate skill name`, audit `fail`; (3) no allowlisted owner publishes anything whose *name* contains a word from your prompt (terraform, s3), and names only match on exact stemmed tokens; (4) the mode is `local`/`off`, the prompt is under 40 characters or starts with `/`, or skills.sh is in a 5-minute 429 cooldown (`/scout-status`); (5) a request timed out (`errors` in `--dry-run --json`; that owner is then skipped for 5 minutes and a stale catalog keeps ranking).

**Why did it not suggest X?** Run `/scout-find <the words you expected to match>`. If X appears under `Best allowlist-only rejection`, its owner is not in your allowlist (see below). If X is listed under `fork of ...`, an allowlisted source publishes the same skill name and won. If X is not in the list at all, skills.sh did not return it for the words searched: the hook sends only single tech-lexicon words (`shared=[...]` in `--dry-run --verbose`), and the API is lexical and capped at 200 results per query, so a repository whose skill names contain neither `skill` nor one of your tech words is unreachable from the hook (use `/scout-find`, which also sends the joined query). Install counts come last in the ranking: a 315-install entry that matches two words outranks a 314K-install entry that matches one.

**How do I add an owner?** Edit `~/.claude/skill-scout/config.json` and append `"owner"` (or `"owner/repo"` for one repository) to `allowlist`; no restart. `/scout-find` prints the exact owner to add. Adding an owner means every skill under that GitHub account can be suggested, loaded and installed through the gates; read what you add. Never let Claude edit the allowlist for you (the skill bodies tell it not to).

**Is auto mode safe?** No, and it is not meant to be: it places third-party prose in Claude's context without you reading it. The gates (allowlist, floor, audit, pin, sanitizer) remove executable and capability-granting parts, not persuasion. `auto` is only honoured in the default config file, can never be enabled by a repository or the environment, prints a one-time warning, and `/scout-mode suggest` reverts it. Use it only with an allowlist whose skills you have read.

**Does `/scout-load` survive the next prompt?** Yes, for the whole persisted session (`--resume`/`--continue` included), as a transcript attachment; it is not re-sent each turn, so it does not cost context twice. It does not survive `/compact` or `--no-session-persistence`, and it is never forwarded to subagents.

**Does the model always tell me about candidates?** No. The hook's `systemMessage` line is the reliable channel; the `Load with /scout-load <ref>` relay by the model happened in a minority of the measured runs (see Install step 6).

---

## Troubleshooting

| Symptom | Check |
| :-- | :-- |
| Nothing appears in context | `/scout-status`: is `mode` `off`? Is the prompt >= 40 chars and not a slash command? Run `node <plugin>/bin/on-prompt.js --dry-run "<your prompt>" --cwd <project> --verbose` to see timings, matches and skip reasons (`(no context: prompt shorter than minPromptChars (2 < 40))`, `(no context: slash command)`, `(no context: own output)`, `(no context: empty prompt)`, `(no context: mode off)`). In an interactive session, hook context is not printed as a message; use `claude --verbose` or `-p --output-format stream-json --verbose --include-hook-events`. |
| `claude plugin list` does not show skill-scout | Plugins loaded with `--plugin-dir` show up as `skill-scout@inline ... Status: ✔ loaded` only with `claude --plugin-dir <dir> plugin list`. For a marketplace install, re-run `claude plugin marketplace add <path>` (the path must contain `.claude-plugin/marketplace.json`) and `claude plugin install skill-scout@skill-scout-local`. `claude plugin validate <path>` must print "✔ Validation passed". |
| `/scout-load` says `Unknown skill` or does nothing | The session predates the install: `/reload-plugins` or restart. Typing `/skill-scout:scout-load ...` (the namespaced form) is equivalent. |
| `/scout-load` expands but no `[skill-scout] The user explicitly loaded ...` block appears | The expansion hook did not run. `disableAllHooks` in settings disables it; otherwise look at `$SKILL_SCOUT_HOME/scout.log` for `on-expand`. Claude will fall back to running `bin/on-expand.js` via Bash (it prints the same sanitized text). |
| `UserPromptExpansion operation blocked by hook: ... not in the allowlist` | Intended. Add the owner to `allowlist` if you trust it (see above). |
| `could not resolve HEAD` / `could not fetch` | `git ls-remote https://github.com/<owner>/<repo> HEAD` and `npx -y skills@1.5.26 use <ref>` from your shell; check network/proxy. `repository not found or private (GitHub asked for credentials)` means GitHub answered the request with a credential prompt: the repository does not exist under that owner or is private. The hook has 25 s; a cold `npx` download of the CLI can take most of that the first time, so retry once. |
| `/scout-find` says `Third-party search failed (skills.sh rate-limited until HH:MM)` | skills.sh answered HTTP 429 (burst limit). Nothing is wrong locally; cached catalogs still rank. Wait for the time shown (`/scout-status` shows it too). |
| `/scout-find --json` output ends mid-string | Observed 2026-10-08: when stdout is a pipe (the Bash tool, `\| jq`) the JSON is cut at exactly 65,536 bytes for large result sets (the same run redirected to a file was 115,783 bytes and complete). Redirect to a file (`> out.json`) and read that. The plain report (about 60 KB with `--all`) was not affected. |
| I never see a suggestion | In `suggest` the candidates are in Claude's context and the hook announces them once per session as a `systemMessage` (`[skill-scout] N third-party skills may fit this prompt (not loaded): /scout-load …`); Claude is also asked to end its reply with `Load with /scout-load <ref>` when one fits, which it does only sometimes. `--dry-run --verbose` shows what was produced (`systemMessage=` line); `/scout-find <query>` prints the table directly. |
| Remote suggestions never appear | See FAQ "Why are there no third-party candidates?". |
| `mode` is `auto` in the file but `/scout-status` says `suggest` | `auto` counts only in the default `~/.claude/skill-scout/config.json`; a redirected `SKILL_SCOUT_HOME` or `SKILL_SCOUT_MODE` can only lower the mode. |
| `/scout-add` printed `REJECTED` | The downloaded folder contained plugin components, non-plain files in the git tree or capability frontmatter; nothing was written. That is the point. Use `/scout-load` for the text only, or vet the repository by hand. |
| `/scout-add` printed `REFUSED: ... already exists` | skill-scout never overwrites `~/.claude/skills/<skill>`. Remove it yourself if you want a fresh pinned copy. |
| Config warnings in `/scout-status` | A key has the wrong type or the JSON is invalid; the default is used for that key. Fix the file; no restart needed. A `config.json` that is a directory or unreadable is reported as `config.json unreadable (EISDIR); using defaults` and `/scout-mode` refuses to write to it. |
| The per-prompt hook feels slow | `--dry-run --verbose` prints `indexMs`, `localMs`, `discoverMs`, `autoFetchMs`. Lower `totalBudgetMs`, set `mode: "local"`, or disable `stackDetection`. The index scan is 12-40 ms for 168 skills; the first prompt of the day fetches the owner catalogs (1.8 s measured, up to `remoteTimeoutMs` more once per slow owner); anything else above that is the network or an inline `auto` fetch. |
| I want to reset | `rm -rf ~/.claude/skill-scout` (config, cache, pins, log). |

Logs: `~/.claude/skill-scout/scout.log` (one JSON line per hook run with timings, matches, candidates, errors). Hook stdout/stderr are also in Claude Code's debug output (`claude --debug`).

## Layout

```
.claude-plugin/plugin.json     plugin manifest (name skill-scout, hooks -> ./hooks/hooks.json, skills auto-discovered)
.claude-plugin/marketplace.json local marketplace "skill-scout-local" with one entry, source "./" (loads in place)
hooks/hooks.json               UserPromptSubmit -> bin/on-prompt.js (timeout 8); UserPromptExpansion matcher (^|:)scout-load$ -> bin/on-expand.js (timeout 25); SubagentStart -> bin/on-subagent.js (timeout 3)
skills/scout-*/SKILL.md        the five commands (scout-load/add/mode/status are user-only; scout-find is model-invocable)
bin/                           entrypoints (also usable by hand): on-prompt, on-expand, on-subagent, scout-add, scout-find, scout-mode, scout-status
lib/                           config, cache, log, refs, git, skill-index, score, stack, registry, context, inspect
test/                          node:test unit tests, fixtures (real skills.sh/audit responses, captured hook stdin incl. a task notification, a 168-skill index snapshot, a Next.js project, a clean and a malicious skill folder), e2e/run.sh
docs/spec.md, docs/security.md, docs/testing.md, research/
```

License: MIT.
