# French Weave

Learn French passively from the text you already read. French Weave swaps a few French words into English you
read every day, at your level, and moves words from "learning" to "known" as you see them.

- **In Claude Code** (a plugin): Claude weaves French words from your list into its chat replies. Every sentence
  stays an English sentence, new words get a one-line gloss with a sound hint at the end of the reply, and every
  third reply opens with a recall cue. Never in code, files, commits or anything meant to be shared.
- **On X** (a Chrome extension): a few English words in tweets become French. Hover for the meaning, click to flip
  back to English. Swaps are chosen by Gemini on your own API key.

Both share one word list on your machine, so words you see in tweets count toward the chat, and the other way round.

> The build passes maintenant, mais the cache is stale, donc I cleared it.
> (maintenant = now, "man-tuh-nahn"; mais = but, "meh"; donc = so, "donk")

## 30-second install

Tell your Claude Code agent:

```
Set up French Weave from <owner>/<repo>. The Gemini key is in ~/path/to/key-file.
```

It follows [INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md). Your part: a free Gemini API key
([aistudio.google.com/apikey](https://aistudio.google.com/apikey)), then in Chrome open `chrome://extensions`,
turn on **Developer mode**, click **Load unpacked** and pick the folder your agent names (`~/.french-weave/extension`).

By hand instead:

```sh
claude plugin marketplace add <owner>/<repo>
claude plugin install french-weave@french-weave
python3 "$(find ~/.claude/plugins -path '*french-weave*' -path '*/scripts/fw.py' | tail -1)" setup
```

Needs Claude Code, Python 3.9+ (macOS system Python is fine) and Chrome or Chromium. No other dependencies.

## Commands

| Command | What it does |
|---|---|
| `/french-weave:status` | Stage, word counts, the words you're learning |
| `/french-weave:known <word>` | Mark a word known (no more glosses) |
| `/french-weave:learn <word>` | Put a word back into the learning set |
| `/french-weave:stage 1-4\|auto` | Pin your stage, or let it follow your known words |
| `/french-weave:pause` / `resume` | Stop or restart French in chat and on X |

## How words advance

Words start in a queue in [`data/lexicon.csv`](data/lexicon.csv) (about 160 high-frequency words, most common first).

- **Learning (active)**: 8 at a time. A new user starts with 8; up to 3 new ones join per day as others graduate.
- **Learning -> known**: after you've seen it on 4 different days (in a Claude reply or a tweet) with no flip back
  to English since.
- **Flip or `learn` -> shaky**: clicking a French word on X to see the English, or `/french-weave:learn`, puts it
  back in the learning set. Shaky words become known again after 7 days without a flip. While 5 or more words are
  shaky, no new words join.
- **Stage**: 1 to start; 2 at 40 known words; 3 at 150. Stage 4 only by `/french-weave:stage 4`.

| Stage | French in a chat reply | Per sentence | Shape |
|---|---|---|---|
| 1 | about 6%, never over 10% | at most 2 | English sentences with swapped words |
| 2 | about 12%, never over 20% | at most 4 | same |
| 3 | about 25%, never over 35% | at most 4 | plus one short French sentence in five |
| 4 | about 40%, never over 55% | at most 4 | plus two in five |

Chat exposure comes from your own Claude Code transcripts on this machine (read-only, counted from the day you
installed). Health, medication, legal, money, safety, emergency and driving topics get no French at all.
The extension's prompts are built for levels 1-2; at Stage 3-4 it uses the level 2 rules.

## Privacy

Everything stays on your machine in `~/.french-weave` (override with `FRENCH_WEAVE_HOME`). The extension sends
tweet text to Google's Gemini API with your key (free-tier keys allow Google to train on prompts), and talks to the
plugin through a Chrome native messaging host that only this extension's ID may call. The plugin makes no network
calls. If setup stored your Gemini key, it sits in `~/.french-weave/gemini_key` (mode 600) and is handed only to
the extension.

## Layout

```
.claude-plugin/   marketplace.json + plugin.json (the repo is both)
hooks/            UserPromptSubmit hook -> scripts/weave.py
commands/         /french-weave:* slash commands
scripts/          fwlib.py (state, rules, transcript scan), weave.py (hook), fw.py (CLI, setup), fw_host.py (native host)
data/lexicon.csv  starter words: fr, en, sound hint
extension/        Chrome MV3 extension (no build step, no runtime dependencies)
tests/            python tests, live model check
```

## Develop

```sh
python3 -m unittest discover -s tests          # hook, rules, native host, setup
cd extension && bun install && bun test         # extension (happy-dom)
python3 tests/model_eval.py --out /tmp/fw-eval  # live check: 20 claude -p runs, isolated from your config
```

## License

MIT
