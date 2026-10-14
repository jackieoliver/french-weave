---
description: Paste-ready French Weave block for claude.ai preferences or ChatGPT custom instructions
argument-hint: "[--claude-ai | --chatgpt] [--log-day]"
allowed-tools: Bash(python3:*)
---
!`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/fw.py" export $ARGUMENTS`

Show the output above to the user exactly as printed, inside one code block per pasted field so it is easy to copy, with no French and nothing added inside the blocks. After the blocks, one plain-English line: paste it where the output says, and re-export about once a week.
