# Language profiles

One JSON file per language, named after it in lower case (`french.json`, `spanish.json`): everything the rules need
that differs between languages. The rules themselves (the hook brief in `scripts/weave.py`, the claude.ai and ChatGPT
blocks in `scripts/export.py`, the extension prompt in `extension/src/prompt.js`) are written once, with the
language name and these fields filled in. `_generic.json` holds the defaults: a language with no profile, or a profile
that leaves a field out, gets the generic value, which leaves that slot out of the text (so no French examples ever
show up in another language).

The extension can't read this folder, so `python3 scripts/make_profiles.py` checks the profiles and writes its copy,
`extension/src/profile-data.js`. Tests fail while a profile is malformed or the copy is out of date. `french.json` is
the worked example; French output is pinned byte for byte by `tests/test_french_snapshots.py` and
`extension/test/french-snapshots.test.js`.

Pairs are `[English, word]`. Every text field is plain text inserted as is, so write it the way the sentence around
it reads (see `french.json`).

| Field | What it is |
| --- | --- |
| `language` | Display name, matching the file name: `"Spanish"` |
| `variety` | Which variety to use, like `"Latin American Spanish"`; adds "Use ... words and spellings." Empty: none |
| `script.spaces` | `false` for languages written without spaces: a word counts wherever its characters appear |
| `script.direction` | `"ltr"` or `"rtl"` (not used by the renderer yet) |
| `script.hint` | `"sound"` (an English-style respelling) or `"romanization"` (romaji, pinyin) |
| `script.hint_name` | What the rules call the hint: `"sound hint"`, `"romaji"` |
| `script.marks` | What the word must keep and a learner may leave out when typing: `"accents"` |
| `script.reading` | Web pages only: a reading shown above the word (HTML ruby). `early`: `"none"`, `"romaji"` (the hint) or `"kana"` (the lexicon's `reading` column); `late`: the same choices, used from Stage `late_from_stage` on (0: never); `late_only_with`: `"kanji"` limits the late reading to words containing kanji, `""` for all words; `known_drop`: known words show no reading. Chat never shows readings above words; the footer gloss carries the hint. Defined, not rendered yet |
| `examples.swap_sentence` | Stage 1-2 example: an English sentence with list words swapped in, ending in its own period |
| `examples.full_sentences` | Stage 3-4 examples: two short, fully target-language sentences |
| `examples.gloss` | Footer gloss example, `{"word", "en", "hint"}`. Missing: the first word of the list |
| `examples.default_swaps` | About 10 connector and adverb pairs named as default swaps in the claude.ai and ChatGPT blocks. Missing: the first 10 words of the list |
| `sense_notes.brief` | Hook brief: where words must not be used ("pour never after ask or wait, ...") |
| `sense_notes.export` | The same for the claude.ai block, fuller wording |
| `sense_notes.export_short` | The same for ChatGPT, under about 100 characters |
| `drift_words` | Grammar words of the language that are on no word list (pronouns, articles, common verb forms); four or more in a reply mean it slid into full sentences, and the next brief says so |
| `exposure.same_as_english` | Words spelled like an English word, never counted as seen in chat (the lexicon's `scan` column does the same per word) |
| `exposure.not_followed_by` | `{word: regex}`: a use followed by this doesn't count (`"sans": "\\s+serif"`) |
| `articles.definite` | Definite articles before a listed noun (`el`, `la`); the bare noun also counts and is accepted |
| `articles.indefinite` | Indefinite articles; the extension also accepts the bare noun after these |
| `articles.elided` | Articles written joined to the noun (`l'`) |
| `articles.determiners` | Words that may stand before a listed noun when chat exposure is counted (articles, possessives, demonstratives) |
| `articles.hint_prefixes` | The articles' sounds at the start of a hint, removed for the bare noun (`luh`, `lah`) |
| `extension.synonym_examples` | `[[English, ...], word]`: English synonyms the extension prompt names for a word; each must pass the gloss check (a test checks against the word list) |
| `extension.filler_example` | A common filler pair that must not crowd out learning words: `["and", "et"]` |
| `extension.sense_note` | The extension prompt's sense note ("so" as an intensifier is NOT donc; ...) |
| `extension.adjective_example` | `["a big win", "a grand win"]`: an adjective swap that keeps English word order |
| `extension.level_examples` | `{"1": pairs, "2": pairs}`: typical swaps for the extension's built-in level lists (French only today) |
| `extension.synonyms` | Extra English synonyms for the extension's gloss check, `{"gloss": ["variant", ...]}` |
