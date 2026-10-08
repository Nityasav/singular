---
name: scout-mode
description: Show or switch skill-scout's mode (off, local, suggest, auto) by rewriting only the "mode" key of ~/.claude/skill-scout/config.json. Usage - /scout-mode or /scout-mode <off|local|suggest|auto>
disable-model-invocation: true
---

The user ran `/scout-mode $ARGUMENTS`.

Run with the Bash tool:

`node "${CLAUDE_PLUGIN_ROOT}/bin/scout-mode.js" $ARGUMENTS`

If `${CLAUDE_PLUGIN_ROOT}` was not expanded in this text, the plugin root is the directory two levels above the base directory shown above.

Show the output verbatim. With no argument it prints the current mode and where it comes from. With an argument it rewrites only the `mode` key and prints `mode: <old> -> <new>`; the change applies on the next prompt, no restart needed.

If the new mode is `auto`, repeat the printed warning: third-party skill text will be injected without confirmation, cold prompts add up to ~5 s and up to 9,000 chars of third-party text per prompt, and `/scout-mode suggest` reverts it. Never choose `auto` on the user's behalf; only run this command with the argument the user typed.
