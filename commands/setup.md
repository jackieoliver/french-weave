---
description: Set up the French Weave Chrome extension sync (native host, extension folder)
argument-hint: [--gemini-key-file <path>]
allowed-tools: Bash(python3:*)
---
!`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/fw.py" setup $ARGUMENTS`

Relay the human steps from the output above to the user as a short numbered list, in plain English with no French. If setup failed, say why and how to fix it.
