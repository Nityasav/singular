---
name: scout-add
description: Persistently install one allowlisted skills.sh skill into ~/.claude/skills, pinned to a commit and inspected for plugin components (hooks, bin, MCP, agents, shell forms) before it is kept. Usage - /scout-add owner/repo@skill or /scout-add owner/repo#<sha>@skill
disable-model-invocation: true
---

The user ran `/scout-add $ARGUMENTS`.

Run this with the Bash tool (the user typed the command, so `--yes` is the confirmation):

`node "${CLAUDE_PLUGIN_ROOT}/bin/scout-add.js" $ARGUMENTS --yes`

If `${CLAUDE_PLUGIN_ROOT}` was not expanded in this text, the plugin root is the directory two levels above the base directory shown above.

Show the output verbatim. It ends in one of:

- `INSTALLED <ref> sha <sha>` followed by the audit JSON and a reminder to run `/reload-skills` or start a new session. Tell the user the skill is now a normal installed skill.
- `REJECTED: ...` with the list of problems found in the downloaded folder (plugin components, executable files, symlinks, capability-granting frontmatter, shell forms). The folder has already been removed. Do not try to install it another way.
- `REFUSED` / an error (not allowlisted, already exists, network). Report it and stop.

Never edit the allowlist yourself; if the owner is not allowlisted, tell the user which line to add to `~/.claude/skill-scout/config.json` and let them decide.
