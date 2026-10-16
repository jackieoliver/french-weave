# Installing French Weave (instructions for a coding agent)

You are setting up French Weave for the person you are working with. Follow these steps in order. Run every
command yourself; the person only does the steps marked HUMAN. Write no French in anything you say during setup.

`<repo>` below is what the person gave you: a GitHub `owner/name`, a git URL, or a local folder path. For a GitHub
link such as `https://github.com/jackieoliver/french-weave`, `<repo>` is `jackieoliver/french-weave`, even if you
cloned the repo to read these instructions: a plugin installed from a local clone never updates from GitHub and
depends on that folder staying put.

## 0. Ask a few questions and list the human steps, in one batch, before you start

Run `codex --version` first: if it fails, leave Codex CLI out of question 2. Then, in Claude Code, write the
human steps below, word for word, as the text of the same message that makes the AskUserQuestion call, before
the call; don't skip them, the person needs them before choosing. Ask all four questions in that one
AskUserQuestion call (question 2 multi-select, the default option first with "(default)" in its label). In Codex or anywhere else, send the
human steps and the numbered questions as one chat message. Anyone who skips a question gets the default. If you can't ask at all (a non-interactive run), use every default and say which ones you used.

Human steps (send as written):

> Setting up French Weave. A few quick questions below; I'll do the rest, except these steps for you:
> 1. If you pick the Chrome extension: at the end, open `chrome://extensions`, switch on **Developer mode**, click
>    **Load unpacked**, and pick the folder I give you, then click the French Weave toolbar icon and **Allow all
>    websites** (or, on each site you want, tick the box next to the site's name). Chrome doesn't let scripts do this
>    part.
> 2. If you pick the Chrome extension, optional: a Gemini API key (free at https://aistudio.google.com/apikey), as a
>    file path now or pasted into the extension's popup at the end or later. With a free key, Google may use the page
>    text it's sent to improve its products; a paid key (billing on) avoids that. Without a key the extension swaps
>    only a few fixed words (and, but, with, because...) and sends no page text anywhere.
> 3. If you pick Codex CLI: the next time you start `codex`, it asks you to review a new hook; choose
>    **Trust all and continue**.

Questions:

1. How much French do you know already?
   - None (default)
   - A few basic words
   - I can read simple French
2. Where should French show up? (pick any)
   - Claude Code (always on with the plugin)
   - Codex CLI (default when installed; only offered if `codex --version` works)
   - The Chrome extension on websites (default)
   - A claude.ai / ChatGPT preferences block to paste
3. If you picked the Chrome extension, which websites?
   - Every site; turn any off from the toolbar (default)
   - Only sites I turn on
4. If you picked the Chrome extension, your Gemini API key:
   - Paste it into the extension's popup at the end (default)
   - A file that contains it: type its path (in Claude Code, as your own answer under "Type something"). Never paste the key itself here.
   - No key for now: the extension swaps only a few fixed words until one is pasted into its popup

Steps 1 and 2 below don't depend on the answers: if you can keep working while the person answers, do them now;
otherwise do them right after. Never ask for the key in chat, and never print it. If an answer looks like a key
rather than a file path (for example it starts with `AIza`), don't pass it to setup or repeat it; tell the person to
paste it into the extension popup instead.

How the answers map to setup (step 3) and the hand-over (step 5):

| Answer | Effect |
| --- | --- |
| 1. None / a few basic words / simple French | `--known-top 0` / `--known-top 40` / `--known-top 150` |
| 2. Codex CLI | `--codex` |
| 2. Chrome extension | pass answers 3 and 4; give the Chrome steps at the end |
| 2. Preferences block | run `export` at the end |
| 3. Every site / only sites I turn on | `--sites all` / `--sites ask` |
| 4. A file path | `--gemini-key-file <path>` |
| 4. No key for now | no `--gemini-key-file`; leave out hand-over item 2 |

`--known-top N` marks the N most common words in `data/lexicon.csv` as known, so the stage follows on its own
(Stage 2 at 40 known words, Stage 3 at 150). It only touches words not introduced yet, so a rerun never resets or
lowers anyone's progress.

In Codex: the clone and setup need network access and writes outside the workspace (`~/.codex`,
`~/.french-weave`). If the sandbox blocks a command and you can't request approval, don't fall back to reading
the repo on the web: tell the person to run `/permissions`, pick **Ask for approval**, and say "go on", then
rerun the command.

## 1. Check prerequisites

On native Windows (not WSL), stop here and tell the person Windows isn't supported yet; offer the paste-in
blocks (`blocks/level-01.md`) or running Claude Code or Codex inside WSL.

```sh
python3 -c 'import sys; assert sys.version_info >= (3, 9), sys.version; print(sys.version)'
claude --version
```

Python 3.9+ (macOS system `python3` is fine) and Claude Code. Nothing else is needed: no pip installs, no Node.

No Claude Code (Codex only, or the extension only): skip step 2, `git clone https://github.com/jackieoliver/french-weave`
into a temporary folder, and in step 3 use `FW=<clone>/scripts/fw.py`. Setup copies what it needs into
`~/.french-weave`, so the clone can be deleted afterwards; later commands run as
`python3 ~/.french-weave/app/scripts/fw.py <command>`.

## 2. Install the Claude Code plugin

```sh
claude plugin marketplace add <repo>
claude plugin install french-weave@french-weave
claude plugin list | grep -A3 french-weave
```

The plugin is enabled when the list shows it. It adds a prompt hook (the chat weaving) and `/french-weave:*` commands.

## 3. Run setup

Find the installed copy and run its setup script with the flags from the answers (table in step 0):

```sh
FW="$(find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins" -path '*french-weave*' -path '*/scripts/fw.py' 2>/dev/null | sort | tail -1)"
echo "$FW"
python3 "$FW" setup --known-top 40 --sites all --gemini-key-file /path/to/key-file --codex   # for example
```

Without a key file, run setup without `--gemini-key-file`; the person pastes the key in the extension popup later.
A backup Gemini key (another Google account, its own daily quota) and a paid OpenRouter key can come the same way:
`--backup-key-file <path>`, `--openrouter-key-file <path>`.
Use only a key file the person names: never search their disk for one.
With `--codex`, setup adds a UserPromptSubmit hook to `~/.codex/hooks.json` (other hooks are kept; backups end in
`.before-french-weave`) and sets `hooks = true` under `[features]` in `~/.codex/config.toml`. Codex runs a new hook
only after the person trusts it at the next `codex` start; setup cannot do that for them. No AGENTS.md change is
needed: the hook carries the rules every turn.

If `find` prints nothing, run setup from a clone of `<repo>` instead (`python3 <clone>/scripts/fw.py setup ...`);
setup copies what it needs, so the clone can be deleted afterwards.

If the person runs Chrome or Chromium with a custom `--user-data-dir`, add `--user-data-dir <that dir>` (repeatable):
a browser started that way looks for native hosts only inside that dir.

Setup is safe to run again (it keeps the person's word progress; leaving out `--sites` keeps the earlier choice).
It always installs the extension folder and native host, even if the person didn't pick the extension. It creates:

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

Tell the person, in plain English (leave out the items for things they didn't pick):

1. Chrome extension: the HUMAN Chrome step with the exact folder from `check` (`~/.french-weave/extension` expanded
   to a full path): `chrome://extensions` -> Developer mode on -> Load unpacked -> that folder. Then the French
   Weave toolbar icon (puzzle piece menu -> pin it): every-site mode, click **Allow all websites** (Chrome asks
   once; until then it only runs on x.com); only-sites-I-turn-on mode, tick the box next to the site's name on each site
   they want.
2. Chrome extension, no key file given: click the French Weave toolbar icon (puzzle piece menu -> pin it) and paste
   the Gemini key. Until they do, the extension swaps only a few fixed words, and its popup says "Built-in list, no key".
3. Codex CLI: at the next `codex` start, choose **Trust all and continue** when it asks about the new hook.
4. Chat weaving and the `/french-weave:*` commands start in the next Claude Code session they open, or right away
   in this one after they type `/reload-plugins` (until then the commands answer "Unknown command"); in Codex, at
   the next session. Never in one-shot `claude -p` or `codex exec` runs (`FRENCH_WEAVE_OFF=1` turns it off
   anywhere else).
5. Preferences block: run `python3 "$FW" export` (claude.ai) and `python3 "$FW" export --chatgpt` (ChatGPT) and
   show each block as printed in a code block, with where to paste it; they use whichever applies. Re-export
   about once a week.
6. Commands: `/french-weave:status`, `/french-weave:known <word>`, `/french-weave:learn <word>`,
   `/french-weave:stage 1-4|auto`, `/french-weave:pause`, `/french-weave:resume`, and `/french-weave:export` for a
   claude.ai or ChatGPT preferences block.

You are done when `check` is all `ok` and only the HUMAN steps above remain. If you cloned the repo only to read
these instructions, delete that clone (setup keeps its own copy in `~/.french-weave`).

## Update

Setup turns on Claude Code's auto-update for this marketplace (its `updates:` line; `--no-auto-update` skips
that, and a choice already made in `/plugin` is kept), so new versions arrive on their own. It also turns off Claude Code's
mid-turn narration, whose rewritten progress notes drop the French (its `narration:` line; `--keep-narration` skips
that, and a value already in the settings `env` is kept). To update now:

```sh
claude plugin marketplace update french-weave
claude plugin update french-weave@french-weave
```

Then start a new Claude Code session and send any message: the hook sees the new version and refreshes
`~/.french-weave/extension` and the copy the Codex hook runs from, keeping all progress (rerunning setup does the
same). The Chrome extension reloads itself from that folder within about 30 minutes, or right away when the
person opens its toolbar popup; if its icon still shows NEW after that, they click the reload arrow on French Weave in
`chrome://extensions`. Without Claude Code: `git pull` in a clone, then `python3 <clone>/scripts/fw.py setup`.

## Uninstall

```sh
python3 ~/.french-weave/app/scripts/fw.py uninstall --codex  # removes the native host manifests and the Codex hook; keeps ~/.french-weave
claude plugin uninstall french-weave@french-weave
claude plugin marketplace remove french-weave
```

Then remove the extension in `chrome://extensions`, delete `~/.french-weave` to drop the word progress, and delete
any pasted block from claude.ai or ChatGPT settings.
