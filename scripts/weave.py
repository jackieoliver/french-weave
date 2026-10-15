#!/usr/bin/env python3
"""UserPromptSubmit hook: prints a short French Weave brief as additional context for the next reply, in the
language the user is learning (French by default; other languages through data/profiles/).

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
# Most known words listed per tier, so the brief stays small at Stages 3-4 (hundreds of known words).
LIMITS = {'rare': 24, 'some': 60, 'lot': 80}
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
    """The hook brief: shared rules in the state's language, with that language's profile filling the slots
    (example sentences, sense notes, gloss example; data/profiles/). Slots a profile leaves empty are left out."""
    stage = fwlib.stage_for(state)
    target, cap, per_sentence = STAGES[min(stage, 4)]
    lang, prof = fwlib.language(state), fwlib.profile(state)
    examples = prof['examples']
    entry = lambda w: w['fr'] if w['status'] == 'known' else f'{w["fr"]} = {w["en"]}' + (f', "{w["hint"]}"' if stage <= 2 else '')
    words = sorted(fwlib.introduced(state), key=lambda w: (w['status'] != 'shaky', -seen.get(w['fr'], {}).get('n', 0)))
    swap = lambda w: f'{w["en"]} → {w["fr"]}'
    def group(name, show=entry):
        picked = [w for w in words if tier(w, seen) == name]
        if name == 'rare':  # least exposure first, so fading words get pushed back in
            picked.sort(key=lambda w: seen.get(w['fr'], {}).get('n', 0))
        return '; '.join(show(w) for w in picked[:LIMITS.get(name)]) or 'none'
    banded = sum(w['status'] == 'known' for w in state['words']) >= fwlib.COLLAPSE_AT
    swap_example = f', like "{examples["swap_sentence"]}"' if examples['swap_sentence'] else '.'
    full_examples = (', like ' + ' or '.join(f'"{s}"' for s in examples['full_sentences'])
                     if examples['full_sentences'] else '.')
    notes = f' ({prof["sense_notes"]["brief"]})' if prof['sense_notes']['brief'] else ''
    grammar = (f'Every sentence stays an English sentence with {lang} words swapped in{swap_example} Never a {lang} '
               f'sentence or clause, and no {lang} outside these lists (no {lang} articles, verbs or numbers); if a '
               f'sentence starts turning {lang}, rewrite it in English. '
               if stage < 3 else
               f'About {"one sentence in five" if stage == 3 else "two sentences in five"} should be fully {lang} '
               f'({"2" if stage == 3 else "4"} in a ten-sentence reply): short, simple and guessable from the English '
               f'around it{full_examples} Steps stay English, so put the {lang} sentences in the explanation, summary '
               f'and advice around them. The other sentences stay English with {lang} words swapped in. At this stage '
               f'use any common {lang} word the user would follow, not only the lists. ')
    text = (f'French Weave (Stage {stage}): the user is a native English speaker learning {lang} passively.'
            f'{fwlib.variety_note(prof)} Write your chat reply in English and swap in {lang} words from the lists '
            f'below: about {target}% of the words in a reply (about {round(target * 1.5)} in a 150-word reply'
            f'{", so most sentences carry one or two" if stage <= 2 else ""}), never over {cap}%, at most '
            f'{per_sentence} in one sentence. Under target is the usual miss, so count as you write. '
            f'{grammar}Use a word only where it means exactly what the English word would mean there; where one doesn\'t '
            f'fit, use another from the lists instead{notes}. If a reply runs long on {lang}, cut '
            f'{"known" if banded else "seen-a-lot"} words first. Plain English for code, commands, paths, numbers, '
            f'names, IDs, option letters and steps the user will follow, and no {lang} right before a path; zero '
            f'{lang}, and no recall cue, for health, medication, legal, money, safety, emergency, driving or urgent '
            f'topics. {lang} goes only in your chat reply: never in files, code, configs, commit or PR text, messages '
            f'to other agents, subagent prompts, or drafts and documents meant to be shared. No bold on {lang} words '
            f'and no inline glosses. End the reply with one footer line glossing the learning words you used that are '
            f'not glossed earlier in this chat, at most 8, like: {fwlib.gloss_example(state, prof)}; nothing to gloss, '
            f'no footer.\n'
            f'Learning now (use 2 to 4 per reply): {group("learn")}\n'
            f'Rarely seen (pepper in a couple per reply where the sentence makes the meaning obvious): {group("rare")}\n'
            + (band_line(state) if banded else
               f'Seen sometimes (about 2 in 3 places one fits): {group("some")}\n'
               f'Seen a lot, as default swaps (write the {lang} every time the English word has that meaning): '
               f'{group("lot", swap)}'))
    if recall:
        text += (f'\nIf this reply is longer than a few sentences, open it with "Recall: {recall["fr"]}?" on its own line '
                 f'and end it, after the footer, with: Recall: {recall["fr"]} = {recall["en"]}, "{recall["hint"]}"')
    else:  # without this, models repeat the last recall cue on every turn
        text += '\nNo recall cue in this reply: no "Recall:" lines, even if an earlier reply had one.'
    return text


DEFAULT_SWAPS = 12  # in band mode: the top-ranked known words (connectors and adverbs) written in the language every time


def band_line(state):
    n, missing, extra = fwlib.known_band(state)
    swaps = [w for w in state['words'] if w['status'] == 'known'][:DEFAULT_SWAPS]
    defaults = (f'Default swaps (write the {fwlib.language(state)} every time the English word has that meaning): '
                + '; '.join(f'{w["en"]} → {w["fr"]}' for w in swaps) + '\n') if swaps else ''
    cut = lambda xs: ', '.join(xs[:fwlib.EXCEPTIONS_MAX]) + (f' and {len(xs) - fwlib.EXCEPTIONS_MAX} more' if len(xs) > fwlib.EXCEPTIONS_MAX else '')
    return defaults + (f'Known (use freely, never gloss): roughly the {n} most common {fwlib.language(state)} words and phrases'
            + (f', except these not learned yet: {cut(missing)}' if missing else '')
            + (f'; also known: {cut(extra)}' if extra else '') + '.')


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


def share(text, words, prof=None):
    """(target-language words, prose words, learning words used, drift words off the lists) in a reply.

    Drift words are the profile's grammar words (French: je, nous, était, ...): several in one reply mean it slid
    into full sentences in the language. Code, links, glosses and the recall cue are skipped. prof: the language
    profile (default French). In a language written without spaces (Japanese) a run of script is one word, and its
    grammar words (particles, endings) are found inside the runs, longest first, after the listed words are removed."""
    prof = prof or fwlib.profile(fwlib.DEFAULT_LANGUAGE)
    prose = fwlib.fold(fwlib.norm(fwlib.CODE.sub(' ', text)), prof)
    prose = '\n'.join(line for line in prose.split('\n') if not EXTRA.match(line))
    total = len(re.findall(r"[^\W\d_]+(?:['-][^\W\d_]+)*", prose))
    french = learning = 0
    rest = prose
    # Longest first, each match removed before the next search: "faire attention" is not also "faire".
    for word in sorted(words, key=lambda w: -len(w['fr'])):
        if fwlib.measurable(word, prof):
            regex = fwlib.pattern(word['fr'], prof)
            uses = len(regex.findall(rest))
            french += uses * len(word['fr'].split())
            learning += uses if word['status'] != 'known' else 0
            rest = regex.sub(' ', rest)
    drift = {fwlib.fold(fwlib.norm(word), prof) for word in prof['drift_words']}
    if prof['script']['spaces']:
        grammar = sum(token in drift for token in re.findall(r"[^\W\d_]+(?:'[^\W\d_]+)?", rest))
    else:
        for word in sorted(words, key=lambda w: -len(w['fr'])):  # unmeasured list words (でも) hold particle kana too
            rest = rest.replace(fwlib.fold(fwlib.norm(word['fr']), prof), ' ')
        grammar = 0
        for word in sorted(drift, key=len, reverse=True):
            grammar += rest.count(word)
            rest = rest.replace(word, ' ')
    return french, total, learning, grammar


def calibration(text, state):
    """One line on how much of the language the last reply in this chat had, so the next one corrects toward the target."""
    french, total, learning, grammar = share(text, fwlib.introduced(state), fwlib.profile(state))
    if total < SHORT:
        return ''
    target, cap, _ = STAGES[min(fwlib.stage_for(state), 4)]
    percent = 100 * french / total
    lang = fwlib.language(state)
    verdict = (f'it slipped into {lang} sentences, so this time write English sentences with only list words in {lang}'
               if grammar >= 4 else f'over the {cap}% cap, so use less {lang} this time' if percent > cap else
               f'under the {target}% target, so use more this time unless the topic needs zero {lang}'
               if percent < 0.7 * target else 'on target')
    return (f'\nYour last reply in this chat was {percent:.0f}% {lang} ({french} of {total} words, {learning} '
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


def process_args(pid):
    """Command line of a process as a list (Linux /proc, else ps), and its parent pid."""
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as file:
            args = [a.decode('utf-8', 'replace') for a in file.read().split(b'\0') if a]
        with open(f'/proc/{pid}/stat') as file:
            parent = int(file.read().rsplit(')', 1)[1].split()[1])
        return args, parent
    except (OSError, ValueError, IndexError):
        pass
    try:
        out = subprocess.run(['ps', '-o', 'ppid=', '-o', 'args=', '-p', str(pid)], capture_output=True, text=True,
                             timeout=5).stdout.strip()
        parent, _, args = out.partition(' ')
        return args.split(), int(parent)
    except (OSError, ValueError, subprocess.SubprocessError):
        return [], 0


def codex_exec(pid=None):
    """True when a `codex exec` process starts this hook (directly or through a shell)."""
    pid = pid or os.getppid()
    for _ in range(3):
        args, parent = process_args(pid)
        if args and os.path.basename(args[0]).startswith('codex'):
            return 'exec' in args[1:] or 'e' in args[1:2]
        if parent <= 1:
            break
        pid = parent
    return False


def is_claude(args):
    """Claude Code's own process: `claude`, the native build under .../claude/versions/<version>, or node cli.js."""
    return bool(args) and (os.path.basename(args[0]) == 'claude' or '/claude/versions/' in args[0]
                           or any(os.path.basename(a) == 'cli.js' for a in args[:2]))


def claude_args(pid=None):
    """Command line of the Claude Code process that started this hook (directly or through a shell), or []."""
    pid = pid or os.getppid()
    for _ in range(3):
        args, parent = process_args(pid)
        if is_claude(args):
            return args
        if parent <= 1:
            break
        pid = parent
    return []


def one_shot(args):
    """True for a one-shot scripted `claude -p` run. Chat hosts also use --print (Remote Control, claude.ai/code,
    desktop and IDE hosts run `claude --print --sdk-url ... --input-format stream-json`), so those weave."""
    printing = any(a in ('-p', '--print') for a in args)
    streaming = any(a == '--sdk-url' or a.startswith('--sdk-url=') or a == '--input-format=stream-json' or
                    (a == '--input-format' and i + 1 < len(args) and args[i + 1] == 'stream-json')
                    for i, a in enumerate(args))
    return printing and not streaming


def interactive(env=None, data=None, exec_check=codex_exec, args_check=claude_args):
    """Weave by default; stay silent only in clear one-shot scripted runs, whose output must never get French.

    Claude Code: skip `claude -p` without --sdk-url / --input-format stream-json (see one_shot), and Agent SDK
    library scripts (CLAUDE_CODE_ENTRYPOINT sdk-ts or sdk-py). Codex (its hook input has a turn_id): skip under
    `codex exec`; the Codex TUI runs hooks from its app-server instead. FRENCH_WEAVE_FORCE=1 weaves anyway;
    FRENCH_WEAVE_OFF=1 never weaves."""
    env = os.environ if env is None else env
    if env.get('FRENCH_WEAVE_OFF') == '1':
        return False
    if env.get('FRENCH_WEAVE_FORCE') == '1':
        return True
    if 'turn_id' in (data or {}):
        return not exec_check()
    if env.get('CLAUDE_CODE_ENTRYPOINT') in ('sdk-ts', 'sdk-py'):
        return False
    return not one_shot(args_check())


STALE_EXPORT_DAYS = 7


def export_notice(state, now=None):
    """Once per export: a nudge when a pasted claude.ai / ChatGPT block is over a week behind the word state."""
    exported = state.get('exported') or {}
    if not exported.get('at') or exported.get('noticed') or exported.get('version') == fwlib.version(state):
        return None
    now = now or time.time()
    if now - exported['at'] < STALE_EXPORT_DAYS * 86400:
        return None
    with fwlib.editing() as fresh:
        fresh.setdefault('exported', {})['noticed'] = True
    return ('French Weave: the block you pasted into claude.ai or ChatGPT is over a week behind your word list. '
            'Run /french-weave:export to refresh it.')


def main(argv):
    hook = '--hook' in argv
    data = {}
    if hook:
        try:
            data = json.load(sys.stdin)
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        if not interactive(data=data):
            return 0  # scripted run: no brief at all
    updated = ''
    if hook:
        try:
            updated = fwlib.refresh_copies()
        except Exception:
            pass  # setup can always redo the copies
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
        out = {'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': text}}
        try:
            notice = export_notice(state)
        except Exception:
            notice = None
        if updated:
            update = (f'French Weave updated to {updated}. The Chrome extension reloads itself within about 30 minutes, '
                      'or right away when you open its toolbar popup.')
            if fwlib.marketplace_source() and fwlib.auto_update() is None:
                update += (' Later updates can install themselves: type /plugin, open Marketplaces, pick french-weave '
                           'and turn on auto-update.')
            notice = f'{update}\n{notice}' if notice else update
        if notice:
            out['systemMessage'] = notice  # shown to the user, outside the brief
        print(json.dumps(out, ensure_ascii=False))
    else:
        print(text)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
