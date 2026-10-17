---
description: Set up French Weave (asks a few questions, then installs the word state, extension folder and native host)
argument-hint: [--gemini-key-file <path>] [--backup-key-file <path>] [--anthropic-key-file <path>] [--openrouter-key-file <path>] [--language <name> [--lexicon <file>]]
allowed-tools: Bash(python3:*), AskUserQuestion
---
Setup plan (a dry run; nothing changed yet; don't show it to the user):
!`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/fw.py" setup --dry-run`

Write no French in anything you say during setup. If the user wants to learn another language (like Spanish), in the
arguments or in their message, ask question 1 about that language and make sure the command below gets
`--language <name>`, plus `--lexicon <file>` if they have a word list (README "Other languages").

Ask these four questions in ONE AskUserQuestion call, the default option first with "(default)" in its label.
Leave Codex CLI out of question 2 if `codex_cli` above is null.

1. "How much French do you know already?" None (default) / A few basic words / I can read simple French.
2. "Where should French show up?" (multi-select) Claude Code (always on with the plugin) / Codex CLI (default when
   installed) / The Chrome extension on websites (default) / A claude.ai or ChatGPT preferences block to paste.
3. "If you picked the Chrome extension, which websites?" Every site; turn any off from the toolbar (default) /
   Only sites I turn on.
4. "If you picked the Chrome extension, your Gemini API key (free at https://aistudio.google.com/apikey; with a free
   key Google may use the page text it's sent to improve its products, a paid key avoids that)?" Paste it into the
   extension's popup at the end (default) / A file that contains it: type its path as your own answer ("Type
   something"). Never paste the key itself here.

Skipped questions get the default. Never ask for the key in chat, and never print it. Use only a key file the person
names: never search their disk for one, and with no path, leave the key for the popup. If the answer to question 4
looks like a key rather than a file path (for example it starts with `AIza`), don't run setup with it, don't repeat
it, and tell them to paste it into the extension popup instead. Then run, with the `source` folder from the plan
above:

`python3 <source>/scripts/fw.py setup $ARGUMENTS` plus:
- question 1: `--known-top 0`, `--known-top 40` or `--known-top 150`
- Codex CLI picked: `--codex`
- Chrome extension picked: `--sites all` or `--sites ask` (leave `--sites` out if they skipped question 3, so a
  rerun keeps their earlier choice), and `--gemini-key-file <path>` if they gave a file (likewise
  `--backup-key-file`, `--anthropic-key-file` and `--openrouter-key-file` for a backup Gemini key, a paid Anthropic
  key and a paid OpenRouter key; with an Anthropic key, Claude Haiku 5.5 goes direct to Anthropic at Levels 1-2)

Relay the human steps from the output to the user as a short numbered list, in plain English, leaving out the
Chrome steps if they didn't pick the extension. If they picked the preferences block, run
`python3 <source>/scripts/fw.py export` and `... export --chatgpt` and show each block exactly as printed, in its own
code block, with where to paste it. If setup failed, say why and how to fix it.
