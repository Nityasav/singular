# Anthropic-vetted skill/plugin supply: what the screening actually does

Research date: 2026-09-24. Closes the one gap left open in `2026-09-15-auto-skill-discovery-feasibility.md` (section 4, "Trust anchor for the Anthropic-only alternative is unverified"). GitHub facts pulled live via `gh api`; docs quoted verbatim.

## 1. `anthropics/claude-plugins-community` — what "automated validation and safety screening" means

The public repo is a *mirror*, not the review pipeline: "A read-only mirror of the community plugin marketplace … synced nightly from Anthropic's internal review pipeline. Every plugin listed here has been submitted via claude.ai, passed automated security scanning, and been approved for distribution" (README). What the internal pipeline does is not published. What is public is the CI on the mirror:

- **`validate-plugins` (the only blocking gate)** — schema + static invariants only: `claude plugin validate` plus invariants (sort, dups, desc bounds, https-only, SHA-pin required, filename match, no-direct-edit, vendored-path-exists, no shell metacharacters), hidden-Unicode and slug-shape checks. Its own security model: "runs only `claude plugin validate` (a static manifest check). No code from the cloned repo is executed." No malware scanner, no dependency audit. (https://github.com/anthropics/claude-plugins-community/blob/main/.github/actions/validate-plugins/README.md)
- **`scan-plugins` (LLM policy review)** — exists as an action (`claude -p` headless with a security-reviewer policy prompt, read-only tools) returning `{passes, summary, violations, may_make_external_network_calls, may_download_additional_software}`. **Not wired into this repo's CI.** The PR that would wire it (#1394, opened 2026-07-24) is an open draft "held pending Workload Identity Federation provisioning"; its justification: "This is the only one of the three live marketplace surfaces whose entries merge without a policy scan." Recent community PRs show only `close` and `validate` checks.
- **No human content review** is described; Anthropic staff merge PRs.

**Updates / SHA drift.** `bump-plugin-shas` resolves `git ls-remote HEAD` nightly, re-runs schema validation only, opens a PR. No content scan on bump in public CI. The workflow is currently `disabled_manually` (last run 2026-08-13), while docs promise "runs automated screening on each update" — unverifiable and currently contradicted by the workflow state.

**Corpus drift.** Daily `owner-liveness-sweep` is report-only and has failed 19 of the last 30 runs. 2026-09-24 run: `{"identity_changed":1,"owner_missing":14,"repo_moved":63,"repo_missing":52}`. `identity_changed` = "the login was released and re-registered — every entry under it needs review before any further bumps." Open ~2.5 weeks, no entries removed.

**Counts.** 2,282 plugins; 2,274 SHA-pinned (3 unpinned: `geo-audit-by-alignment-ai`, `seedflip`, `telegram`); 5 vendored. Entry fields carry **no** badge/tier/verified key.

**Official marketplace (`anthropics/claude-plugins-official`).** 313 plugins: 52 vendored (39 `author: Anthropic`, e.g. code-review, commit-commands, feature-dev, frontend-design, security-guidance, skill-creator, plugin-dev, hookify, ralph-loop, 11 `*-lsp`; ~13 third-party vendored under `external_plugins/` such as github, gitlab, linear, playwright, context7, terraform) and **261 external SHA-pinned third-party entries** (Google 14, SAP 9, AWS 7, Pendo 5; 70 with no author). So "official" ≠ "Anthropic-authored": ~83% third-party. README: "Anthropic does not control what MCP servers, files, or other software are included in plugins and cannot verify that they will work as intended or that they won't change." The official repo *does* run the LLM scan as a required check (`scan-plugins.yml`, `fail-on-findings: true`, verdicts cached per (plugin, sha), `revert-failed-bumps` drops failing SHAs). Nightly bumps ran 2026-09-15/16/17, human-merged.

**Policy.** Anthropic Software Directory Policy (2026-04-15): "We review submissions … to ensure they meet our standards for safety, security, and compatibility … both initial and ongoing reviews." No mechanism specified.

Confidence: high on public CI; low on the private pipeline (undisclosed).

## 2. claude.com/plugins — "Anthropic verified" badge

Yes. claude.com/plugins (340 plugins) shows **"Anthropic verified"** on e.g. Frontend Design, Code Review, Code Simplifier; **"Official"** on first-party integrations (GitHub, Slack). Definition (https://claude.com/docs/plugins/submit): "Anthropic performs basic automated review on submissions before adding them to the directory. Plugins with an 'Anthropic Verified' badge have undergone additional review from a quality and safety perspective. That said, there are limits to what Anthropic is able to review — you should only install plugins from developers you trust." Security section: "community plugins may install unverified, third-party software that could be malicious … Prefer Anthropic Verified plugins for production workflows." The badge is **not** in either `marketplace.json`; web directory only. Docs inconsistency: submit page says directory = `claude-plugins-official`; Claude Code docs say in-app submissions go to the **community** marketplace.

Confidence: high.

## 3. claude.ai skills — catalogue, scanning, `CLAUDE_CODE_SYNC_SKILLS`

**Catalogue.** In-app "Browse skills" directory exists for all plans (support article 14328846): "Skills you install from the directory are view-only." Partner-built skills (Atlassian, Canva, Cloudflare, Figma, Sentry, Vercel, Zapier, Notion) announced 2025-12-18. No Anthropic page says non-partner third parties can publish standalone skills to the consumer catalogue; the individual third-party path is *plugins* (all paid plans). Local evidence (this account): `~/.claude/skills/synced/…/manifest.json` lists 8 skills, all `creatorType: anthropic` (pdf, docx, pptx, xlsx, docs, morning, import-memory, skill-creator).

**Scanning.** "Get started with skill and plugin scanning" (support article 15927065, launched 2026-08-06, beta): **Enterprise plans only**; "Claude reviews the contents, looks for signs of malicious behavior, and returns pass, warn, or fail"; excludes "MCP servers and hooks" and MCP-shared skills; "A pass result … isn't a guarantee." Off by default until 2026-10-02. Pro/Max uploads: no stated scan.

**`CLAUDE_CODE_SYNC_SKILLS`.** Changes timing, not source: "make Claude Code download the skills enabled for your claude.ai account in that run and wait." Interactive sessions resync `~/.claude/skills/synced/` every ~10 minutes anyway. It pulls what is enabled on your account; never the catalogue itself. Synced skills hardened since v2.1.228 (descriptions sanitized, no `!` commands, no `@` expansion).

Confidence: high on scanning tiers and env var; medium on which third-party skills Pro/Max "Browse skills" shows (UI not inspected).

## 4. `anthropics/skills` vs skills.sh

19 skill folders as of 2026-09-24 (last push 2026-09-24T16:20Z): academy-guide, algorithmic-art, brand-guidelines, canvas-design, claude-api, discernment-nudge, doc-coauthoring, docx, frontend-design, internal-comms, mcp-builder, pdf, pptx, skill-creator, slack-gif-creator, theme-factory, web-artifacts-builder, webapp-testing, xlsx. Per-folder licenses: Apache 2.0 mostly; docx/pdf/pptx/xlsx "All rights reserved" (source-available). README: "provided for demonstration and educational purposes only." Ships `.claude-plugin/marketplace.json` (`anthropic-agent-skills`). skills.sh/anthropics/skills lists 21 (the 19 plus stale `claude-academy-guide` and `template-skill`); it is a Vercel-run index of the GitHub repo, not an Anthropic feed; its audits are third-party (e.g. pdf: Gen Pass / Socket Pass / Snyk Warn).

Confidence: high.

## 5. Skill signing / provenance / scanned registry (2026)

None. Claude Code CHANGELOG through 2.1.282: no skill sign/provenance/attest entry; nearest are 2.1.228 (hardened synced skills), 2.1.275 (claude.ai skills/plugins sync), npm plugins fetched with `npm pack --ignore-scripts` and integrity-verified, `--accept-command <sha256>`. Security page: Anthropic "does not security-audit or manage any MCP server." Only scanned registry = Enterprise scanning beta. Only "verified" tier = the plugin-directory badge.

Confidence: high (absence after changelog, docs, release notes, web search).

## Bottom line

A Pro/Max individual can get a genuinely Anthropic-authored, no-third-party supply today, but it is small: 4 built-in document skills + ~4 `anthropic-example` skills that auto-sync, the 19 demo skills in `anthropics/skills` (installable as a marketplace from that repo), and ~39 `author: Anthropic` plugins in `claude-plugins-official` (workflow/LSP tooling, not domain skills). Everything beyond that — the other ~270 "official" entries, 2,282 community entries, the partner catalogue — is third-party code where Anthropic's disclosed public screening is schema validation plus (official marketplace only) a Claude-based policy read of the pinned SHA, with an explicit "cannot verify" disclaimer, no code execution or malware scanning, SHAs that move nightly, and a community mirror whose LLM scan is unmerged, bump loop disabled, and liveness sweep flagging 1 re-registered owner and 52 missing repos. The only Anthropic-run content scan of arbitrary uploads is Enterprise-only. For a Pro/Max user the "Anthropic verified" badge on claude.com/plugins is the strongest available signal, and it is a human review of a snapshot, not a continuous or cryptographic guarantee.

## Consequence for skill-scout

- Default allowlist should prefer `anthropics` and official-marketplace `author: Anthropic` plugins; treat `@claude-community` and skills.sh entries alike (third-party, schema-checked only).
- "Anthropic verified" is not machine-readable from any marketplace.json; it cannot be used as an automatic gate.
- SHA pinning by the user is the only stable content guarantee; official/community SHAs move nightly.
