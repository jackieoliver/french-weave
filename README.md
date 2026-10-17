# French Weave

Learn languages from the English you already read. French Weave swaps a few French words into your AI chat replies
and the web pages you read, at your level, and moves each word from learning to known as you keep seeing it.

> The build passes maintenant, mais the cache is stale, donc I cleared it.
> (maintenant = now, "man-tuh-nahn"; mais = but, "meh"; donc = so, "donk")

<!-- TODO: screenshot of a woven Claude Code reply and of a web page with a hover gloss -->

Free and open source (MIT). From English to French, with lists for Spanish, German, Italian, Portuguese and Japanese and a starter list for
Indonesian.

## Where it works

| Where | Status | How |
|---|---|---|
| Claude Code (terminal, desktop, IDE, claude.ai/code) | Yes | Plugin with a prompt hook; follows your progress every turn |
| Codex CLI | Yes | Same hook; you approve it once at the next `codex` start |
| claude.ai | Yes, static | Paste a block into your preferences; refresh it about weekly |
| ChatGPT | Yes, static | Paste a block into custom instructions (two boxes, 1,500 characters each) |
| Chrome or Chromium, any website | Yes | Unpacked extension 0.2 (not in the Chrome Web Store); all your words with a Gemini API key, a few fixed words without one |
| Brave, Edge, Arc | Not tested | |
| Firefox, Safari | Not yet | |
| macOS, Linux | Yes | Python 3.9 or newer |
| Windows | Not yet | Use the paste-in blocks, or Claude Code or Codex inside WSL (the extension can't sync with it) |
| Other languages | Yes, unreviewed | Spanish, German, Italian, Portuguese, Japanese (Indonesian: starter list), or any word list you give setup; see [Other languages](#other-languages) |

## Set up

**Claude Code or Codex.** Tell your agent:

```
Set up French Weave from https://github.com/jackieoliver/french-weave
```

In Codex, first run `/permissions` and pick **Ask for approval**: a new Codex install blocks the download and setup
without asking.

It asks four questions in one go (how much French you know, where French should show up, which websites, whether
and how you'll give it a Gemini key; skip any to take the default), installs everything, and then hands you up to
four steps it can't do:

1. Extension, optional: get a Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). A
   free key lets Google use the page text it's sent to improve its products; see [What leaves your machine](#what-leaves-your-machine).
   Without a key the extension still works, with a few fixed words only; see [What it costs](#what-it-costs).
2. Extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the folder it names.
3. Extension: click the French Weave toolbar icon, then **Allow all websites** (until then it only runs on x.com), and
   paste the key if you have one and didn't give setup a key file. If you chose only sites you turn on, tick the box next to
   the site's name in the same popup on each site you want.
4. Codex only: at the next `codex` start, choose **Trust all and continue** for the new hook.

Chat weaving and the `/french-weave:*` commands start in your next Claude Code session, or in the current one
after you type `/reload-plugins`. Rerunning `/french-weave:setup` asks again and never resets your progress. Agents: follow
[INSTALL-FOR-AGENTS.md](INSTALL-FOR-AGENTS.md).

**claude.ai or ChatGPT, nothing to install.** Open [blocks/level-01.md](blocks/level-01.md) and copy the block
for your app (one for claude.ai, two for ChatGPT) into the settings box it names. When its 30 words feel easy, paste level 2 instead, and so on through level 35.

**claude.ai or ChatGPT, with Claude Code installed.** Run `/french-weave:export` (or `/french-weave:export --chatgpt`)
and paste the block it prints. It carries your real progress; re-export about once a week (Claude Code reminds you).

## What it costs

- French Weave itself: nothing.
- Chat: it runs inside the Claude Code, Codex, claude.ai or ChatGPT you already use. In Claude Code and Codex the
  hook adds about 2.5 KB of instructions to each message you send.
- Extension with a key: your own Gemini API key. A free AI Studio key works (Google's free tier allowed 500 Gemini 3.5
  Flash-Lite requests a day when tested in October 2026); the extension stops itself at 500 Gemini calls a day per
  key (see [Models and keys](#models-and-keys-extension) for the backup key and the paid Anthropic and OpenRouter
  steps), and
  when Google says the key's daily limit is reached it waits until just after midnight Pacific time, when Google
  resets it, showing "Daily Gemini limit reached (429); resumes about ..." (in your own time) in its popup. Whenever Gemini calls fail (limit, rejected key, Gemini busy, no
  connection), the toolbar icon shows a small muted dot and the popup says why, with the HTTP code, until a call works again.
- Extension without a key: nothing, and it makes no network calls. It swaps only words whose French is the same in
  any sentence (and, but, with, without, because, always, also, maybe, often, together, between and about 25 more),
  skips the uses where that isn't true ("because of", "all but one", "the very end", names and quoted text), and
  leaves pages and passages that name a health, crime, safety, legal or money topic alone (a word list, so it can miss
  one that names none of its words). On 309 passages from real pages
  that came to about one swap every three sentences at level 1 and one every two at level 2 (Gemini aims for one every
  sentence or two at level 1, one or two per sentence at level 2), and a blind check found 2 wrong swaps in 446, both
  inside quoted titles, which it now skips. The popup shows
  "Built-in list, no key" while it works this way. With the plugin installed it uses the words in your list only, in
  French only: for another language it needs a key. Chrome's on-device Gemini Nano was tested as a free middle
  option and left out: 14-25% of its swaps were wrong.

## What leaves your machine

- Your word list and progress stay in `~/.french-weave` (or `$FRENCH_WEAVE_HOME`).
- The hook reads your local Claude Code and Codex transcripts to count which words you saw, and never sends them
  anywhere. Its instructions go to Anthropic or OpenAI as part of your message, like the rest of your prompt.
- Updates come from GitHub through Claude Code's own plugin updater. The hook and scripts make no network calls.
- With a Gemini key, the extension sends readable text from the sites where it's on to Google's Gemini API with
  your key. Links and inline code go with their sentence but are never changed; code blocks, forms and editable text
  are skipped. Without a key, no page text leaves your computer: swaps come from a list inside the extension.
- With an Anthropic key (optional), the same text goes straight to Anthropic (Claude Haiku 5.5) first for every batch,
  unless you pick a Gemini model in the popup. Without that key nothing goes there directly.
- With an OpenRouter key (optional), the same text goes to OpenRouter and the model's provider: Anthropic (Claude
  Haiku 5.5) first for every batch if you have no Anthropic key (unless you pick a Gemini model), and OpenAI
  (gpt-6-luna) for any batch both Gemini steps failed to answer. Without that key nothing goes there.
- With a free Gemini key, Google may use that text to improve its products, and human reviewers may read it. If you
  don't want that, use a paid key (turn on billing for the key's Google Cloud project): Google doesn't use paid-key
  prompts that way. In the EEA, UK and Switzerland the paid terms cover free keys too.
- Off by default even in every-site mode: webmail and messaging, AI chat sites, password managers, banking and
  payments, health portals, government sites, Google Docs and Drive, and local or intranet addresses (the list is in
  `extension/src/settings.js`). No list catches every sensitive site, so turn others off in the popup, or choose
  **Only sites I turn on**.
- The extension reads your word list through a Chrome native messaging host that only this extension's ID may call.
  Key files you gave setup are copied to `~/.french-weave/` (`gemini_key`, `gemini_backup_key`, `openrouter_key`,
  `anthropic_key`, mode 600) and handed only to the extension's background worker, never to the pages it runs on.

## Models and keys (extension)

Each batch of page text goes through a chain of models until one answers. The chain and the prompt design are set
per language in `extension/src/model-config.js` (today the same for every language):

| Step | Model | Key | Cost | Waits |
|---|---|---|---|---|
| first | Claude Haiku 5.5 direct from Anthropic, low effort, 4 passages a request | Anthropic key, optional | paid, about $0.0006 a batch | 35 s |
| or, without an Anthropic key | Claude Haiku 5.5 through OpenRouter, low reasoning | OpenRouter key, optional | paid, about $0.0015-0.002 a batch | 35 s |
| 1 | Gemini 3.1 Flash-Lite, medium thinking | your Gemini key, then the backup key | free tier | 30 s |
| 2 | Gemini 3.5 Flash-Lite, low thinking | your Gemini key, then the backup key | free tier (a separate daily quota) | 8 s |
| 3 | gpt-6-luna through OpenRouter, reasoning off | OpenRouter key, optional | paid, about $0.0006 a batch | 20 s |

- Claude Haiku 5.5 goes first at every level (Levels 1-2 only before 0.2.9): direct to Anthropic with an Anthropic
  key, else through OpenRouter with an OpenRouter key, never both for one batch. Graded by Opus on 24 real passages
  in six languages at Levels 1-2, 2.3% of its swaps were bad, against 15.3% for Gemini 3.1 Flash-Lite and 8.1% for
  the best Gemini setting; for French at Levels 3-4, 4.7% and 4.0%. Through OpenRouter
  it's slower (about 12 s a batch). Direct, a batch of more than 4 passages goes as requests of 4 at once (median
  5.6 s against 9.5 s for 8 in one request, about 22% more cost); a real-browser run took 4-5 s a batch. Without
  either key, past that provider's daily cap, after it refused the key or ran out of credit, or with a Gemini model
  picked in the popup, the chain starts at step 1 (or the picked model).
- A per-day 429 (the key's daily quota) moves on to the next key or step until Google resets it; a per-minute 429
  waits a minute; a busy model (503) or one that doesn't answer in time moves straight to the next step.
- The model only picks which of the places the extension found to swap (the "candidates" design), so it can't
  invent English that isn't on the page. `"design": "freeform"` in the config lets the model write the swaps itself.
- Add the keys in the toolbar popup under **Backup and paid keys**: a second Gemini key from another Google account
  (its own daily quota), an Anthropic key from [platform.claude.com](https://platform.claude.com/settings/keys) and
  an OpenRouter key from [openrouter.ai/keys](https://openrouter.ai/keys), each with a few dollars of credit. They're
  stored like the Gemini key, only in the extension's background worker. Setup can hand them over instead:
  `--backup-key-file <path>`, `--anthropic-key-file <path>` and `--openrouter-key-file <path>`; a key pasted in the
  popup wins.
- Anthropic stops for the day once today's spend (worked out from each reply's token counts at Anthropic's published
  Claude Haiku 5.5 price) reaches its cap (default $5.00, set in the popup), or when Anthropic refuses the key (401,
  403) or says the credit balance is too low.
- OpenRouter stops for the day once its reported spend reaches the cap (default $0.25, about 125-165 Claude Haiku
  batches; set in the popup), or when OpenRouter answers 402 (credits used up). The popup shows which model served
  the last batch and through which provider, today's count per model, and today's Anthropic and OpenRouter spend.
- **Model** in the popup: **Recommended** (the default) follows the chain and says what it resolves to: Claude Haiku
  5.5 with an Anthropic or OpenRouter key, else Gemini 3.1 Flash-Lite. Below it each model is listed by name: Claude
  Haiku 5.5 (only with one of those keys; without one it says a Claude key is needed), Gemini 3.1 Flash-Lite, Gemini
  3.5 Flash-Lite and Gemini 3.8 Flash (paid key). The picked model goes first; the rest of the chain stays behind it.
- **Reasoning**: **Recommended** keeps each model's measured setting (Claude Haiku low, Gemini 3.1 Flash-Lite
  medium, 3.5 Flash-Lite and 3.8 Flash low); a level applies to the first model only. Claude Haiku takes off (no
  thinking), low, medium and high (adaptive thinking at that effort); Gemini takes minimal, low, medium and high. A
  level the newly picked model doesn't take goes back to Recommended.
- The **Mode** line says what that comes to, e.g. "Mode: Recommended → Claude Haiku 5.5 · low reasoning · Level 2
  (Auto)"; **Next batch** names the model that will serve the next batch (after daily caps and busy models), and
  **Last batch** the one that served the last. The header shows the running version, and "dev build" for a plugin
  installed from the french-weave-dev marketplace.

## Turn it off

- Everywhere for now: `/french-weave:pause`, then `/french-weave:resume`. Pasted claude.ai or ChatGPT blocks stay
  until you delete them.
- One site: click the toolbar icon and untick the box next to the site's name. All sites: untick **On**.
- One shell or script: `FRENCH_WEAVE_OFF=1`. One-shot runs (`claude -p`, Agent SDK scripts, `codex exec`) never
  get French.
- Claude Code: `claude plugin disable french-weave@french-weave`.

## Update

Setup turns on Claude Code's auto-update for French Weave, so new versions install themselves: a few minutes into
a session Claude Code shows "Plugin updated", and your next session runs the new version and says so, keeping your
progress. If you use the extension, it reloads itself with the new version within about 5 minutes while Chrome is
open, or right away when you open its toolbar popup, which says "Updating to X…" and closes as it reloads; the next
time you open it, it says "Updated to X" (the reload arrow on French Weave in `chrome://extensions` also works). `python3 ~/.french-weave/app/scripts/fw.py check` shows the version Chrome last reported running and
when, and warns if it differs from the copy on disk.
Keep Developer mode on in `chrome://extensions`: with it off, Chrome turns the extension off when it reloads.
Auto-update is a switch in `/plugin` (Marketplaces, french-weave); setup leaves it alone if you've set it, or with
`--no-auto-update`.

Setup also turns off Claude Code's mid-turn narration (`CLAUDE_CODE_THINKING_DISPLAY_UPDATES` set to `"0"` in the
`env` of `~/.claude/settings.json`). With narration on, Claude Code's server rewrites some progress notes into short
updates of its own, and those drop the French or, now and then, come out entirely in French. Setup keeps a value
you've already set, `--keep-narration` skips it, and deleting the line turns narration back on. If you installed
before this, run `/french-weave:setup` again.

To update right away:

```sh
claude plugin marketplace update french-weave
claude plugin update french-weave@french-weave
```

Then send any message in a new Claude Code session. Or just tell your agent: "Update French Weave from
https://github.com/jackieoliver/french-weave".

## Uninstall

```sh
python3 ~/.french-weave/app/scripts/fw.py uninstall --codex   # native host and Codex hook; keeps your words
claude plugin uninstall french-weave@french-weave
claude plugin marketplace remove french-weave
```

Then remove the extension in `chrome://extensions`, delete `~/.french-weave` to drop your progress, and delete any
pasted block from claude.ai or ChatGPT settings.

## Commands (Claude Code)

| Command | What it does |
|---|---|
| `/french-weave:status` | Stage, word counts, the words you're learning |
| `/french-weave:known <word>` | Mark a word known (no more glosses) |
| `/french-weave:learn <word>` | Put a word back into the learning set |
| `/french-weave:stage 1-4\|auto` | Pin your stage, or let it follow your known words |
| `/french-weave:pause` / `resume` | Stop or restart French in chat and on websites |
| `/french-weave:export [--chatgpt] [--log-day]` | Paste-ready block for claude.ai or ChatGPT |
| `/french-weave:setup` | Ask the setup questions again; keeps your progress |

The same commands work from a terminal as `python3 ~/.french-weave/app/scripts/fw.py <command>`.

## FAQ

**How long from Stage 1 to Stage 4?** Stage 4 means about 400 known words. At most 5 new words start a day, and
each needs sightings on 3 different days, so if you see your learning words every day it takes about 10 days to
Stage 2, a month to Stage 3 and 12 weeks to Stage 4. If each word shows up on about half your days: about 2 weeks,
7 weeks and 4 months. Starting with some French skips ahead. These are estimates from simulating the rules below.
Pasted claude.ai and ChatGPT blocks don't advance on their own.

**Spanish, German, Italian, Portuguese, Japanese...?** Yes, with lists of about 1,000 words not yet checked by native
speakers; see [Other languages](#other-languages). French is the most tested.

**Do I need a subscription?** You need whichever chat tool you already use. French Weave adds no account. The
extension works without a key, with a few fixed words; a Gemini API key (a free one works) weaves your whole word
list.

**Where do the words come from?** [`data/lexicon.csv`](data/lexicon.csv): about 1,000 French words and short
phrases in frequency and usefulness order (connectors and adverbs first), each with a gloss and a sound hint.

## How words advance

- **Exposure day**: a day you saw the word in a Claude Code or Codex reply, or on a web page.
- **Learning**: up to 20 words at a time; at most 5 new a day, and none while 5 or more are shaky.
- **Learning -> known**: 3 exposure days, with no flip, `learn` or peek on the last 3.
- **Shaky**: clicking a French word on a page back to English, or `/french-weave:learn`. The meaning shows as soon as
  you hover; a **peek** (keeping the pointer on a word for 0.7 seconds or more) holds back a learning word, and a
  known word peeked on 2 days within a week turns shaky.
  **Shaky -> known** after 7 days with no flip or peek.
- **Stage** follows your known words: 1 to start, 2 at 40 known, 3 at 150, 4 at 400.

| Stage | French in a reply | Per sentence | Shape |
|---|---|---|---|
| 1 | about 6%, never over 10% | at most 2 | English sentences with swapped words |
| 2 | about 12%, never over 20% | at most 4 | same |
| 3 | about 25%, never over 35% | at most 4 | plus one short French sentence in five |
| 4 | about 40%, never over 55% | at most 4 | plus two in five |

In chat, new words get a one-line gloss with a sound hint at the end of the reply, and every third reply opens
with a recall question. French never goes into code, files, commits or anything meant to be shared, and the model
is told to use none for health, medication, legal, money, safety, emergency or driving topics. On web pages, hover
for the meaning and click to flip a word back to English. The extension's prompts are built for levels 1-2; at
Stage 3-4 it uses the level 2 rules.

From 150 known words, the chat instructions and exports name a band ("about the 400 most common French words")
plus exceptions instead of listing every word, so they stay about 3 KB.

claude.ai and ChatGPT can't be scanned, so reading there doesn't count. If you mostly read French there,
`fw.py log-chat-day` (or `export --log-day`) counts today as exposure for your learning words. It's off by default
because it's a guess: it never makes a word known on its own.

## Other languages

French is the default and the only full list (about 1,000 ranked words). For another language, give setup a word
list; the hook, the commands, `export` and the extension then weave that language instead:

```sh
python3 ~/.french-weave/app/scripts/fw.py setup --language Spanish --lexicon ~/spanish.csv
```

(or `/french-weave:setup --language Spanish --lexicon ~/spanish.csv`). Lists of about 1,000 ranked words, each with a profile,
for Spanish (Latin American), German, Italian, Portuguese (Brazilian) and Japanese, and a starter list of 44 words for
Indonesian are in [`data/lexicons/`](data/lexicons/); with one of those, `--language Spanish` (or German, Italian,
Portuguese, Japanese) alone is enough. Setup copies the list to `~/.french-weave/lexicon.csv`. Switching language sets the old one's progress and
word list aside (`state-<language>.json`, `lexicon-<language>.csv`); `setup --language French` brings French back.
These lists were drafted with AI and not yet checked by a native speaker; corrections are welcome. The order of
these lists uses word frequencies from [wordfreq](https://github.com/rspeer/wordfreq) by Robyn Speer (data CC BY-SA
4.0), used only to rank the rows.

The list is a CSV with the header `word,en,hint` (`fr` works too), most useful words first: connectors and adverbs,
then everyday nouns, adjectives and verbs.

- `en`: the English it replaces. Put a narrow sense in parentheses, like `so (therefore)`. Sense notes for the whole
  language (French: pour, avant, plus) live in its profile (below).
- `hint`: the sound hint shown in footers. For a new alphabet, use a romanization (Japanese: romaji) and write the
  word itself in its own script, so you learn to read it.
- Nouns: write them as they should appear in English sentences. A noun listed with an article (`el problema`) only
  counts when the reply uses the article too, unless the language's profile lists its articles.
- Optional `scan` column: `no` for a word that is also an English word (`solo`, `dan`), so English text never counts
  as seeing it.
- Optional `reading` column: the word in a phonetic script (Japanese: kana), for a profile that shows readings above
  words on web pages.

Everything else that differs between languages is in a profile, [`data/profiles/<language>.json`](data/profiles/):
the example sentences in the rules, sense notes, default swaps, the grammar words that show a reply sliding into full
sentences in the language, articles, and script details. The rules themselves are written once for every language.
A language without a profile still works: the rules just carry no examples or sense notes. The fields are listed in
[`data/profiles/README.md`](data/profiles/README.md).

Not covered yet: the ready-made [`blocks/`](blocks/) are French only (use `fw.py export` for a block in your
language), the extension without the plugin uses its built-in French lists, and the extension without a Gemini key
weaves French only. In languages written without spaces
(Japanese, Chinese, Thai), a short word also counts inside a longer one (今 inside 今日).

## Layout

```
.claude-plugin/   marketplace.json + plugin.json (the repo is both)
hooks/            UserPromptSubmit hook -> scripts/weave.py
commands/         /french-weave:* slash commands
scripts/          fwlib.py (state, rules, transcript scan), weave.py (hook), fw.py (CLI, setup),
                  fw_host.py (native host), export.py (claude.ai / ChatGPT blocks), make_blocks.py (blocks/),
                  make_profiles.py (checks data/profiles/, writes extension/src/profile-data.js)
data/lexicon.csv  ranked words: fr, en, sound hint (data/lexicons/: word lists for other languages)
data/profiles/    one profile per language: examples, sense notes, articles, script (extension copy generated)
blocks/           ready-made claude.ai / ChatGPT blocks, one per level (generated)
extension/        Chrome MV3 extension (no build step, no runtime dependencies)
tests/            python tests, live model checks, extension end-to-end check
```

## Develop

```sh
python3 -m unittest discover -s tests            # hook, rules, exports, native host, setup, Codex merge
python3 tests/check_version_bump.py --base origin/main   # shipped files changed? warns until a release bumps the version (--release: fail)
python3 scripts/make_blocks.py                   # regenerate blocks/ after changing the rules or lexicon
python3 scripts/make_profiles.py                 # check data/profiles/ and regenerate the extension's copy
cd extension && bun install && bun test           # extension (happy-dom)
python3 tests/model_eval.py --out /tmp/fw-eval    # live check via claude -p, isolated from your own config
python3 tests/model_eval.py --paste level-01 --stages 1 --out /tmp/fw-eval   # simulate claude.ai with a block
node tests/extension_e2e.mjs                      # after setup: Playwright Chromium + fake X and article pages + real Gemini
```

## License

MIT
