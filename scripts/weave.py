#!/usr/bin/env python3
"""UserPromptSubmit hook: prints a short French Weave brief as additional context for the next reply.

Usage: weave.py --hook   (reads the hook JSON on stdin, prints hook JSON)
       weave.py          (prints the plain brief, for checking)
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fwlib  # noqa: E402

STALE = 30 * 60  # refresh chat exposure in the background when the index is older than this
# Stage: (target % of words in French, cap %, max French words in one sentence).
STAGES = {1: (6, 10, 2), 2: (12, 20, 4), 3: (25, 35, 4), 4: (40, 55, 4)}
LOT, SOME = (6, 30), (3, 10)  # chat exposure (distinct days, replies) for the "seen a lot" and "sometimes" tiers
TAIL = 2_000_000  # bytes at the end of a transcript searched for the last reply
SHORT = 40  # replies with fewer prose words are too short to measure
RECALL_EVERY = 3
# French grammar words on no list: several in one reply mean it slipped into French sentences.
GRAMMAR = set("je tu il elle nous vous ils elles les une des du sont était été suis avez avons ont cette ces notre votre "
              "leur j'ai c'était n'est qu'il".split())
EXTRA = re.compile(r'\s*(?:\**recall:|.*\s=\s.*")', re.I)  # recall cue and footer gloss lines


def exposure():
    """Per-word chat exposure; starts a background refresh when the index is stale or missing."""
    path = fwlib.home() / 'exposure.json'
    data = fwlib.read_json(path, {}) or {}
    try:
        fresh = time.time() - path.stat().st_mtime < STALE
    except OSError:
        fresh = False
    if not fresh and not os.environ.get('FRENCH_WEAVE_NO_REFRESH'):
        subprocess.Popen([sys.executable, str(Path(__file__).resolve().with_name('fw.py')), 'refresh'],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    return data.get('words', {})


def tier(word, seen):
    """'learn' for active and shaky words; known words by chat exposure: 'lot', 'some' or 'rare' (uncountable: 'some')."""
    if word['status'] != 'known':
        return 'learn'
    count = seen.get(word['fr'])
    if count is None:
        return 'some'
    days, replies = len(count['days']), count['n']
    if days >= LOT[0] and replies >= LOT[1]:
        return 'lot'
    return 'some' if days >= SOME[0] and replies >= SOME[1] else 'rare'


def brief(state, seen, recall=None):
    stage = fwlib.stage_for(state)
    target, cap, per_sentence = STAGES[min(stage, 4)]
    entry = lambda w: w['fr'] if w['status'] == 'known' else f'{w["fr"]} = {w["en"]}' + (f', "{w["hint"]}"' if stage <= 2 else '')
    words = sorted(fwlib.introduced(state), key=lambda w: (w['status'] != 'shaky', -seen.get(w['fr'], {}).get('n', 0)))
    swap = lambda w: f'{w["en"]} → {w["fr"]}'
    group = lambda name, show=entry: '; '.join(show(w) for w in words if tier(w, seen) == name) or 'none'
    grammar = ('Every sentence stays an English sentence with French words swapped in, like "The build passes maintenant, '
               'mais the cache is stale, donc I cleared it." Never a French sentence or clause, and no French outside these '
               'lists (no French articles, verbs or numbers); if a sentence starts turning French, rewrite it in English. '
               if stage < 3 else 'English sentences keep English grammar; about one short, fully French sentence in '
               f'{5 if stage == 3 else 2.5:g}, guessable from the English around it. ')
    text = (f'French Weave (Stage {stage}): the user is a native English speaker learning French passively. Write your chat '
            f'reply in English and swap in French words from the lists below: about {target}% of the words in a reply (about '
            f'{round(target * 1.5)} in a 150-word reply), never over {cap}%, at most {per_sentence} in one sentence. '
            f'{grammar}Use a word only where it means exactly what the English word would mean there; where one doesn\'t '
            'fit, use another from the lists instead (pour never after ask or wait, or for a duration; avant, pendant and '
            'après only before a noun; plus means more, never and; dans only for in a place or time; ça only as a pronoun; '
            'non only as an answer). If a reply runs long on French, cut seen-a-lot words first. Plain English for code, '
            'commands, paths, numbers, names, IDs, option letters and steps the user will follow, and no French right before '
            'a path; zero French, and no recall cue, for health, medication, legal, money, safety, emergency, driving or '
            'urgent topics. French goes only in your chat reply: never in files, code, configs, commit or PR text, messages '
            'to other agents, subagent prompts, or drafts and documents meant to be shared. No bold on French words and no '
            'inline glosses. End the reply with one footer line glossing the learning words you used that are not glossed '
            'earlier in this chat, at most 8, like: (sans = without, "sahn"); nothing to gloss, no footer.\n'
            f'Learning now (use 2 to 4 per reply): {group("learn")}\n'
            f'Rarely seen (pepper in a couple per reply where the sentence makes the meaning obvious): {group("rare")}\n'
            f'Seen sometimes (about 2 in 3 places one fits): {group("some")}\n'
            f'Seen a lot, as default swaps (write the French every time the English word has that meaning): {group("lot", swap)}')
    if recall:
        text += (f'\nIf this reply is longer than a few sentences, open it with "Recall: {recall["fr"]}?" on its own line '
                 f'and end it, after the footer, with: Recall: {recall["fr"]} = {recall["en"]}, "{recall["hint"]}"')
    return text


def last_reply(path):
    """Text of the latest main-thread assistant reply in a Claude Code transcript, or None."""
    with open(path, 'rb') as file:
        size = file.seek(0, 2)
        file.seek(max(0, size - TAIL))
        if size > TAIL:
            file.readline()  # skip the cut line
        lines = [raw.decode('utf-8', 'replace') for raw in file]
    texts = [text for _, text in fwlib.replies(lines) if text.strip()]
    return texts[-1] if texts else None


def share(text, words):
    """(French words, prose words, learning words used, French grammar words off the lists) in a reply.

    Code, links, glosses and the recall cue are skipped."""
    prose = fwlib.norm(fwlib.CODE.sub(' ', text))
    prose = '\n'.join(line for line in prose.split('\n') if not EXTRA.match(line))
    total = len(re.findall(r"[^\W\d_]+(?:['-][^\W\d_]+)*", prose))
    french = learning = 0
    rest = prose
    for word in words:
        if fwlib.norm(word['fr']) not in fwlib.UNMEASURABLE:
            regex = fwlib.pattern(word['fr'])
            uses = len(regex.findall(prose))
            french += uses * len(word['fr'].split())
            learning += uses if word['status'] != 'known' else 0
            rest = regex.sub(' ', rest)
    grammar = sum(token in GRAMMAR for token in re.findall(r"[^\W\d_]+(?:'[^\W\d_]+)?", rest))
    return french, total, learning, grammar


def calibration(text, state):
    """One line on how much French the last reply in this chat had, so the next one corrects toward the target."""
    french, total, learning, grammar = share(text, fwlib.introduced(state))
    if total < SHORT:
        return ''
    target, cap, _ = STAGES[min(fwlib.stage_for(state), 4)]
    percent = 100 * french / total
    verdict = ('it slipped into French sentences, so this time write English sentences with only list words in French'
               if grammar >= 4 else f'over the {cap}% cap, so use less French this time' if percent > cap else
               f'under the {target}% target, so use more this time unless the topic needs zero French'
               if percent < 0.7 * target else 'on target')
    return (f'\nYour last reply in this chat was {percent:.0f}% French ({french} of {total} words, {learning} '
            f'learning word{"" if learning == 1 else "s"}): {verdict}.')


def next_recall(state, session):
    """Every third turn in a chat (1st, 4th, ...): the recall word, shaky first, then active, not yet used here."""
    if not session:
        return None
    path = fwlib.home() / 'sessions.json'
    with fwlib.locked('sessions.lock'):
        sessions = fwlib.read_json(path, {}) or {}
        entry = sessions.setdefault(session, {'n': 0, 'recalled': []})
        entry['n'] += 1
        entry['t'] = int(time.time())
        pick = None
        if (entry['n'] - 1) % RECALL_EVERY == 0:
            pool = [w for w in fwlib.introduced(state) if w['status'] in ('shaky', 'active')]
            pick = next((w for w in pool if w['fr'] not in entry['recalled']), None)
            if pick:
                entry['recalled'].append(pick['fr'])
        if len(sessions) > 200:  # keep the newest chats only
            sessions = dict(sorted(sessions.items(), key=lambda kv: kv[1].get('t', 0))[-200:])
        fwlib.write_json(path, sessions)
    return pick


def main(argv):
    hook = '--hook' in argv
    data = {}
    if hook:
        try:
            data = json.load(sys.stdin)
        except ValueError:
            data = {}
    try:
        state = fwlib.load_state()
    except Exception as error:  # never block a prompt because of French
        print(f'French Weave: state unreadable ({error.__class__.__name__}); run /french-weave:status', file=sys.stderr)
        return 0
    if state.get('paused'):
        return 0
    text = brief(state, exposure(), next_recall(state, data.get('session_id')) if hook else None)
    if hook:
        try:
            reply = last_reply(data['transcript_path'])
            text += calibration(reply, state) if reply else ''
        except Exception:
            pass  # no transcript yet or unreadable: the brief alone still helps
        print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': text}},
                         ensure_ascii=False))
    else:
        print(text)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
