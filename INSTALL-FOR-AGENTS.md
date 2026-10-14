# Installing French Weave (instructions for a coding agent)

You are setting up French Weave for the person you are working with. Follow these steps in order. Run every
command yourself; the person only does the steps marked HUMAN. Write no French in anything you say during setup.

`<repo>` below is what the person gave you: a GitHub `owner/name`, a git URL, or a local folder path.

## 0. Tell the person what they will do, in one message, before you start

Send this (fill in nothing yet; you will give the exact folder path at the end):

> Setting up French Weave. You'll do two things; I'll do the rest:
> 1. A Gemini API key for the Chrome extension (free at https://aistudio.google.com/apikey). Give me the path to a
>    file containing it, or skip this and paste it into the extension's popup at the end.
> 2. At the end, in Chrome: open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, and pick
>    the folder I give you. Chrome doesn't let scripts do this part.
> 3. (Only if you use Codex CLI) The next time you start `codex`, it asks you to review a new hook: choose
>    **Trust all and continue**.

Leave out item 3 if `codex --version` fails. Don't wait for an answer: go straight on with the steps. At step 3, pass
the key file if the person has named one by then; otherwise run setup without it (they paste the key in the popup).

Never ask for the key in chat if a file path is possible, and never print the key.

## 1. Check prerequisites

```sh
python3 -c 'import sys; assert sys.version_info >= (3, 9), sys.version; print(sys.version)'
claude --version
```

Python 3.9+ (macOS system `python3` is fine) and Claude Code. Nothing else is needed: no pip installs, no Node.
Also run `codex --version`; if it works, the person uses Codex CLI and setup gets `--codex` below.

## 2. Install the Claude Code plugin

```sh
claude plugin marketplace add <repo>
claude plugin install french-weave@french-weave
claude plugin list | grep -A3 french-weave
```

The plugin is enabled when the list shows it. It adds a prompt hook (the chat weaving) and `/french-weave:*` commands.

## 3. Run setup

Find the installed copy and run its setup script. Pass the key file if the person gave you one:

```sh
FW="$(find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins" -path '*french-weave*' -path '*/scripts/fw.py' 2>/dev/null | sort | tail -1)"
echo "$FW"
python3 "$FW" setup --gemini-key-file /path/to/key-file   # add --codex if codex is installed
```

Without a key file, run setup without `--gemini-key-file`; the person pastes the key in the extension popup later.
With `--codex`, setup adds a UserPromptSubmit hook to `~/.codex/hooks.json` (other hooks are kept; backups end in
`.before-french-weave`) and sets `hooks = true` under `[features]` in `~/.codex/config.toml`. Codex runs a new hook
only after the person trusts it at the next `codex` start; setup cannot do that for them. No AGENTS.md change is
needed: the hook carries the rules every turn.

If `find` prints nothing, run setup from a clone of `<repo>` instead (`python3 <clone>/scripts/fw.py setup ...`);
setup copies what it needs, so the clone can be deleted afterwards.

If the person runs Chrome or Chromium with a custom `--user-data-dir`, add `--user-data-dir <that dir>` (repeatable):
a browser started that way looks for native hosts only inside that dir.

Setup is safe to run again (it keeps the person's word progress). It creates:

- `~/.french-weave/` (or `$FRENCH_WEAVE_HOME`): word state, the extension folder to load, the native host
- Chrome and Chromium native messaging host manifests (user level, no sudo):
  - Linux: `~/.config/google-chrome/NativeMessagingHosts/`, `~/.config/chromium/NativeMessagingHosts/`
  - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, `.../Chromium/NativeMessagingHosts/`

## 4. Verify

```sh
python3 "$FW" check
python3 "$FW" status
```

Every `check` line must say `ok` (a `note` about the Gemini key is fine if the person will paste it in the popup).
If one says `FAIL`, fix it before going on; rerunning setup fixes most.

## 5. Hand over

Tell the person, in plain English:

1. The HUMAN Chrome step with the exact folder from `check` (`~/.french-weave/extension` expanded to a full path):
   `chrome://extensions` -> Developer mode on -> Load unpacked -> that folder.
2. If no key file was given: click the French Weave toolbar icon (puzzle piece menu -> pin it) and paste the Gemini key.
3. Codex users: at the next `codex` start, choose **Trust all and continue** when it asks about the new hook.
4. Chat weaving starts in the next Claude Code or Codex session they open (hooks load at session start), and never
   in one-shot `claude -p` or `codex exec` runs (`FRENCH_WEAVE_OFF=1` turns it off anywhere else).
5. Commands: `/french-weave:status`, `/french-weave:known <word>`, `/french-weave:learn <word>`,
   `/french-weave:stage 1-4|auto`, `/french-weave:pause`, `/french-weave:resume`, and `/french-weave:export` for a
   claude.ai or ChatGPT preferences block.

You are done when `check` is all `ok` and only the HUMAN steps above remain. If you cloned the repo only to read
these instructions, delete that clone (setup keeps its own copy in `~/.french-weave`).

## Uninstall

```sh
python3 "$FW" uninstall --codex  # removes the native host manifests and the Codex hook; keeps ~/.french-weave
claude plugin uninstall french-weave@french-weave
```

Then remove the extension in `chrome://extensions`, and delete `~/.french-weave` to drop the word progress.
