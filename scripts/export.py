"""Paste-ready French Weave blocks for chats without hooks: claude.ai personal preferences and ChatGPT custom
instructions. One rules source (RULES) feeds both, so the long and short versions can't drift apart.

The state line keeps the format of the original word-state line: Stage | Active | Shaky | Known | Synced.
"""
import datetime as dt
import re
import time

import fwlib

CHATGPT_LIMIT = 1500   # characters per ChatGPT custom-instructions field (Free and Go; paid plans allow 5,000)
KNOWN_LIST_MAX = fwlib.COLLAPSE_AT  # above this many known words, the state line names a rank band instead
STAGE_SHAPES = {1: '', 2: '', 3: ' plus about one short, fully {lang} sentence in five (2 in a ten-sentence reply, '
                'in the explanation around any steps)',
                4: ' plus about two in five (4 in ten), English for complex or technical ideas'}

# (full text for claude.ai, short text for ChatGPT). Order matters: it is the order of the pasted block. Written once
# for every language: {lang} is the language name, and the other slots come from its profile (data/profiles/), each
# left out when the profile has nothing for it (see rules()).
RULES = [
    ("I'm a native English speaker learning {lang} from zero, passively.{variety} Weave {lang} into your normal "
     "answers. Answer my real question as usual. Never make {lang} the topic.",
     "I'm learning {lang} passively: weave {lang} words into normal answers; never make {lang} the topic.{variety_short}"),
    ("Apply only in chat replies to me. Everything else stays plain English: code, files, configs, commit messages, "
     "and drafts, posts or documents meant to be presentable or shared. If I'm not reading it, or unlikely to, no {lang}.",
     "Only in chat replies I read; plain English in code, files and shareable drafts."),
    ("My stage and words are in the French Weave state line below (I update it from time to time). Active and Shaky are "
     "the words I'm learning; Known words I've seen a lot. Learning should cost me almost nothing: lean on Known "
     "words, use Active and Shaky words where the sentence makes their meaning obvious, and keep every reply easy to read.",
     "Words are in my French Weave state line: lean on Known, use Active/Shaky where meaning is obvious."),
    ("How much, by stage: {stages}. Aim for the target, not the minimum, in technical replies as much as casual "
     "ones; most sentences carry one or two {lang} words. When a word doesn't fit a spot, use another from the lists "
     "rather than leaving the sentence all English. Keep track of how much {lang} you've used in this chat and "
     "correct toward the target. Stage 5: all {lang}, only when I ask.",
     "Share of words in {lang}: {stages_short}. Aim for the target; most sentences carry one or two."),
    ("Connectors and adverbs on my lists are default swaps: write the {lang} every time the English word has that "
     "meaning in your chat prose ({swaps}, and the like once they're on my lists). Under target "
     "is the usual miss, so count as you write.",
     "Default swaps every time the meaning fits: {swaps_short}."),
    ("Below Stage 3, {lang} words drop into English sentences and English grammar stays: no fully {lang} sentences "
     "or clauses, and no {lang} articles, verbs or other words that aren't on my lists{swap_example} At Stage 3+, "
     "{lang} sentences are short and guessable from the surrounding English.",
     "Below Stage 3 every sentence stays English grammar with list words swapped in; no {lang} outside my lists."),
    ("Use a word only where it means exactly what the English would there{sense}. Obvious cognates are free.",
     "Exact sense only{sense_short}."),
    ("Comprehension beats the stage. If a reply would be hard to follow, use simpler {lang}, then less {lang}.",
     "Comprehension beats the stage."),
    ("Never gloss inline, and no bold on {lang} words. End with one footer line glossing the Active and Shaky words "
     "you used that haven't been glossed earlier in this chat, max 8, with the {hint_name}: {gloss}. "
     "At Stage 3+, also gloss up to 3 uncommon words from {lang} sentences. Nothing to gloss, no footer.",
     "No inline glosses or bold. Footer line glossing new Active/Shaky words, max 8: {gloss}."),
    ("Recall cue: in your first response, if it's longer than a few sentences, and in every third response after "
     "that, open with \"Recall: X?\" and end with the answer and its {hint_name}. Pick X from Shaky first, then "
     "Active, not yet used in this chat.",
     "First reply and every third: open \"Recall: X?\" (Shaky, then Active word); answer at the end."),
    ("I'll sometimes type {lang} words myself. Accept missing {marks}, and keep answering in English with {lang} "
     "woven in.",
     ""),
    ("Zero {lang}, and no recall cue, in health, medication, legal, money, safety, emergency, or driving answers, or "
     "anything urgent. No {lang} in code, commands, paths, numbers, names, IDs, option letters, or steps I'll follow, "
     "and none right before a path.",
     "Zero {lang} for health, legal, money, safety, emergency, driving, urgent. None in code, commands, steps."),
    ("\"word?\" = translate in one line. \"quiz\" = ask me what 3 recent words meant. \"story\" = retell your last "
     "answer as a short story at my stage. \"easier\" / \"harder\" shifts one stage for this chat. Apart from the "
     "recall cue, never quiz me or comment on the method.",
     "\"word?\" = translate. \"quiz\" = ask me 3 recent words. \"easier\"/\"harder\" = one stage. Never comment on the method."),
]


def stage_text(short=False, lang=fwlib.DEFAULT_LANGUAGE):
    from weave import STAGES
    if short:
        return '; '.join(f'S{n} ~{t}%, ~{round(t * 1.5)} per 150 words (max {c}%, {p}/sentence)'
                         for n, (t, c, p) in STAGES.items())
    return '; '.join(f'Stage {n} about {t}% of words, about {round(t * 1.5)} {lang} words in a 150-word reply '
                     f'(cap {c}%, at most {p} in a sentence){STAGE_SHAPES[n].format(lang=lang)}'
                     for n, (t, c, p) in STAGES.items())


def slots(state=None):
    """The values RULES are filled with, for the state's language (no state: French)."""
    state = state or {}
    lang, prof = fwlib.language(state), fwlib.profile(state)
    swaps = fwlib.default_swaps(state, prof)
    example, notes = prof['examples']['swap_sentence'], prof['sense_notes']
    return {'lang': lang, 'stages': stage_text(lang=lang), 'stages_short': stage_text(short=True, lang=lang),
            'variety': fwlib.variety_note(prof), 'variety_short': fwlib.variety_note(prof, short=True),
            'swaps': ', '.join(f'{en} = {word}' for en, word in swaps), 'swaps_short': ', '.join(w for _, w in swaps),
            'swap_example': f', like "{example}"' if example else '.',
            'sense': f': {notes["export"]}' if notes['export'] else '',
            'sense_short': f': {notes["export_short"]}' if notes['export_short'] else '',
            'gloss': fwlib.gloss_example(state, prof), 'hint_name': prof['script']['hint_name'],
            'marks': prof['script']['marks']}


def rules(short=False, state=None):
    fill = slots(state)
    parts = [(s if short else f).format(**fill) for f, s in RULES]
    return ('FRENCH WEAVE. ' if short else 'FRENCH WEAVE\n\n') + ('\n' if short else '\n\n').join(
        p if short else f'- {p}' for p in parts if p)


def md(day):
    return f'{int(day[5:7])}/{int(day[8:10])}' if day else ''


def ordinal(n):
    return f'{n}{"th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")}'


def band_text(state, exceptions=fwlib.EXCEPTIONS_MAX):
    """Known words as a frequency band plus exceptions; claude.ai and ChatGPT can't see the list, so it reads as
    "common French words up to about the N-th most frequent"."""
    n, missing, extra = fwlib.known_band(state)
    cut = lambda xs: ', '.join(xs[:exceptions]) + (f' and {len(xs) - exceptions} more' if len(xs) > exceptions else '')
    return (f'common {fwlib.language(state)} words up to about the {ordinal(n)} most frequent'
            + (f', except (not learned yet): {cut(missing)}' if missing else '')
            + (f'; also: {cut(extra)}' if extra else ''))


def state_line(state, now=None, known_max=KNOWN_LIST_MAX, dates=True, exceptions=fwlib.EXCEPTIONS_MAX, tail=None,
               learning_max=None):
    """The word-state line: Stage | Active | Shaky | Known | Synced, in the original state-line format.
    learning_max: list at most this many Active and this many Shaky words, the earliest added (ChatGPT)."""
    words = state['words']
    by_added = lambda xs: sorted(xs, key=lambda w: w['added'])[:learning_max]
    active = by_added([w for w in words if w['status'] == 'active'])
    shaky = by_added([w for w in words if w['status'] == 'shaky'])
    known = [w for w in words if w['status'] == 'known']
    entry = lambda w, d: f'{w["fr"]} = {w["en"]}, "{w["hint"]}"' + (f' ({md(d)})' if dates else '')
    listing = lambda xs: '; '.join(xs) or 'none'
    known_text = (band_text(state, exceptions) if len(known) > known_max
                  else ', '.join(w['fr'] for w in known[:known_max]) or 'none')
    if 0 <= known_max < len(known) <= KNOWN_LIST_MAX:  # trimmed listing (ChatGPT)
        shown = ', '.join(w['fr'] for w in known[:known_max])
        known_text = (f'{shown} and {len(known) - known_max} more of the most common {fwlib.language(state)} words' if shown
                      else f'the {len(known)} most common {fwlib.language(state)} words')
    stamp = time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime(time.time() if now is None else now))
    return (f'French weave state{" (re-export about weekly)" if tail is None else ""} — Stage: {fwlib.stage_for(state)}'
            f' | Active (use most; gloss in footer): {listing([entry(w, w["added"]) for w in active])}'
            f' | Shaky (use often; gloss in footer): {listing([entry(w, w["changed"]) for w in shaky])}'
            f' | Known (use freely; never gloss): {known_text}'
            f' | {tail or "Synced: " + stamp}')


def parse_state_line(line):
    """Inverse of state_line, for checking round trips: {stage, active, shaky, known, synced}."""
    sections = line.split(' | ')
    out = {'stage': int(re.search(r'Stage: (\d)', sections[0]).group(1))}
    entry = re.compile(r'^(.+?) = (.+), "([^"]*)"(?: \((\d+/\d+)\))?$')
    for section in sections[1:]:
        name, _, body = section.partition(': ')
        name = name.split(' ')[0].lower()
        if name in ('active', 'shaky'):
            out[name] = [] if body == 'none' else [entry.match(e).groups()[:3] for e in body.split('; ')]
        elif name == 'known':
            out['known'] = [] if body == 'none' else body if body.startswith('common ') else body.split(', ')
        elif name == 'synced':
            out['synced'] = body
    return out


def claude_ai(state, now=None, tail=None, known_max=KNOWN_LIST_MAX, dates=True):
    """Personal preferences for claude.ai (Settings > Profile): the rules, then the state line."""
    return rules(state=state) + '\n\n' + state_line(state, now, tail=tail, known_max=known_max, dates=dates)


def chatgpt(state, now=None, limit=CHATGPT_LIMIT, tail=None):
    """Two ChatGPT custom-instructions fields: (about you: the state line without dates, known words trimmed to fit,
    then learning words; how to respond: the short rules). Raises ValueError when the state line can't fit limit."""
    known = sum(w['status'] == 'known' for w in state['words'])
    if known > KNOWN_LIST_MAX:
        tries = [dict(exceptions=e) for e in range(fwlib.EXCEPTIONS_MAX, -1, -5)]
    else:
        tries = [dict(known_max=k) for k in list(range(known, 0, -10)) + [0]]
    learning = max(sum(w['status'] == s for w in state['words']) for s in ('active', 'shaky'))
    tries += [dict(tries[-1], learning_max=n) for n in range(learning - 1, -1, -1)]
    respond = rules(short=True, state=state)
    if len(respond) > limit:
        raise ValueError(f'the rules need {len(respond)} characters, more than the {limit} a field holds')
    for kwargs in tries:
        line = state_line(state, now, dates=False, tail=tail, **kwargs)
        if len(line) <= limit:
            return line, respond
    raise ValueError(f'the word-state line needs {len(line)} characters, more than the {limit} a field holds')


def mark_exported(state, target):
    state['exported'] = {'at': time.time(), 'version': fwlib.version(state), 'target': target}


def log_chat_day(state, day=None):
    """Opt-in: count today as an "assumed" exposure day for every learning word (chats that can't be scanned)."""
    day = day or dt.date.today().isoformat()
    return sum(fwlib.apply_event(state, w['fr'], 'assumed', day) for w in state['words'] if w['status'] in ('active', 'shaky'))
