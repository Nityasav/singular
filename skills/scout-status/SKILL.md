---
name: scout-status
description: Show skill-scout's configuration, mode, cache statistics, ephemeral pins (/scout-load) and persistent installs (/scout-add). Usage - /scout-status
disable-model-invocation: true
---

Run with the Bash tool:

`node "${CLAUDE_PLUGIN_ROOT}/bin/scout-status.js"`

If `${CLAUDE_PLUGIN_ROOT}` was not expanded in this text, the plugin root is the directory two levels above the base directory shown above.

Show the output verbatim. If `mode` is `auto`, remind the user that third-party skill text is injected without confirmation and that `suggest` is the safe default. If config warnings are listed, point at the config path so the user can fix them.
