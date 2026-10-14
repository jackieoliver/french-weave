"""French Weave shared state: word statuses, stage, chat exposure, extension events.

Python 3.9+ standard library only. One state directory per user (FRENCH_WEAVE_HOME, default ~/.french-weave)
holds everything; the Claude Code hook, the slash commands and the Chrome native messaging host all read and
write it through this module.

Statuses: queue -> active -> known, with shaky as the penalty box (see README "How words advance").
"""
import contextlib
import csv
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import unicodedata

try:
    import fcntl
except ImportError:  # Windows: no locking (untested platform)
    fcntl = None

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
LEXICON = PLUGIN_ROOT / 'data' / 'lexicon.csv'

# ---- promotion rules (documented in README "How words advance") ----
WINDOW = 20             # target number of active (learning) words
NEW_PER_DAY = 5         # new words per day, including the first day
SHAKY_BLOCK = 5         # no new words while this many or more are shaky
GRADUATE_DAYS = 3       # active -> known: exposure days needed, and length of the clean streak
SHAKY_DAYS = 7          # shaky -> known: days with no new flip, asked or peek
PEEK_WINDOW = 7         # a known word peeked on 2 different days within this many days becomes shaky
ASSUMED_WEIGHT = 1      # a day with only opt-in "assumed" exposure (fw.py log-chat-day) counts this much
STAGES = [(400, 4), (150, 3), (40, 2)]  # (known words, stage): first match wins; otherwise Stage 1


# Same spelling as an English word, so French use can't be told apart in English prose: never counted.
UNMEASURABLE = {'important', 'possible', 'plus', 'comment', 'grand', 'simple', 'long', 'normal', 'excellent',
                'terrible', 'impossible', 'mars', 'bravo', 'pardon', 'rouge', 'mince', 'sec', 'dire', 'porter',
                'planter', 'charger', 'lever', 'lancer', 'quitter', 'payer', 'signer', 'proposer', 'copier', 'derrière'}
DETERMINER = r"(?:le|la|les|l'|un|une|du|de la|ce|cette|mon|ma|ton|ta)\s*"
CODE = re.compile(r"```.*?```|`[^`\n]*`|https?://\S+", re.S)
DEDUPE_DAYS = 45


def home():
    """The state dir: FRENCH_WEAVE_HOME, else the dir this copy was installed into by setup (<home>/app/scripts),
    else ~/.french-weave."""
    if os.environ.get('FRENCH_WEAVE_HOME'):
        return Path(os.environ['FRENCH_WEAVE_HOME']).expanduser()
    if PLUGIN_ROOT.name == 'app' and (PLUGIN_ROOT.parent / 'state.json').exists():
        return PLUGIN_ROOT.parent
    return Path.home() / '.french-weave'


def today():
    return dt.date.today().isoformat()


def days_between(a, b):
    return (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days


def norm(text):
    return unicodedata.normalize('NFC', str(text)).replace('’', "'").replace('‘', "'").lower().strip()


def key(fr):
    return re.sub(r'\s+', ' ', norm(fr))


def load_lexicon(path=LEXICON):
    with open(path, encoding='utf-8', newline='') as file:
        rows = [r for r in csv.DictReader(file) if (r.get('fr') or '').strip()]
    seen, out = set(), []
    for r in rows:
        k = key(r['fr'])
        if k not in seen:
            seen.add(k)
            out.append({'fr': r['fr'].strip(), 'en': r['en'].strip(), 'hint': r['hint'].strip()})
    return out


# ---- files ----

def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False, encoding='utf-8') as file:
            temporary = Path(file.name)
            json.dump(data, file, ensure_ascii=False, indent=1)
            file.write('\n')
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            with contextlib.suppress(OSError):
                temporary.unlink()


def read_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as file:
            return json.load(file)
    except (OSError, ValueError):
        return default


@contextlib.contextmanager
def locked(name='state.lock', blocking=True):
    """Exclusive lock in the state dir; yields False when non-blocking and someone else holds it."""
    directory = home()
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / name, 'w') as handle:
        if fcntl is None:
            yield True
            return
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


# ---- state ----

def new_state(day=None, lexicon=None):
    day = day or today()
    words = [blank(w) for w in (lexicon or load_lexicon())]
    state = {'schema': 1, 'created': day, 'stage': 1, 'stage_pinned': False, 'paused': False, 'words': words}
    refill(state, day)
    return state


def blank(word):
    """A lexicon entry as a queued word: days = extension seen days, assumed = opt-in unscanned chat days."""
    return dict(word, status='queue', added='', changed='', days=[], assumed=[], peeks=[], last_bad='')


def merge_lexicon(state, lexicon=None):
    """Adds lexicon words the state doesn't have yet (a plugin update can grow the list); never drops any."""
    have = {key(w['fr']) for w in state['words']}
    for w in lexicon or load_lexicon():
        if key(w['fr']) not in have:
            state['words'].append(blank(w))
    return state


def load_state(create=True, lock=True):
    """The saved state; creates it on first use. lock=False when the caller already holds state.lock."""
    path = home() / 'state.json'
    state = read_json(path)
    if isinstance(state, dict) and isinstance(state.get('words'), list):
        return state
    if not create:
        return None
    with locked() if lock else contextlib.nullcontext():
        if not path.exists():
            write_json(path, new_state())
    return read_json(path)


def save_state(state):
    write_json(home() / 'state.json', state)


@contextlib.contextmanager
def editing():
    """Load, let the caller change, promote and save the state under the lock."""
    with locked():
        state = load_state(lock=False)
        merge_lexicon(state)
        yield state
        promote(state)
        save_state(state)


def find(state, fr):
    k = key(fr)
    for w in state['words']:
        if key(w['fr']) == k:
            return w
    # Accept the bare noun for "le problème" style entries.
    for w in state['words']:
        if re.sub(r"^(le |la |les |l')", '', key(w['fr'])) == k:
            return w
    return None


def set_status(word, status, day):
    word['status'] = status
    word['changed'] = day
    if not word['added']:
        word['added'] = day


def stage_for(state):
    if state.get('stage_pinned'):
        return state['stage']
    known = sum(w['status'] == 'known' for w in state['words'])
    return next((s for n, s in STAGES if known >= n), 1)


def exposure_days(word, chat=None):
    """{day: 'seen' | 'assumed'} since the word joined the learning set.

    'seen' (counts 1): extension seen events and the word in a Claude Code or Codex reply (scanned transcripts are
    genuine exposure). 'assumed' (counts ASSUMED_WEIGHT): opt-in log-chat-day marks for chats that can't be scanned."""
    since = word.get('added') or '0000'
    days = {d: 'assumed' for d in word.get('assumed') or [] if d >= since}
    for d in list(word.get('days') or []) + list((chat or {}).get(word['fr'], {}).get('days', [])):
        if d >= since:
            days[d] = 'seen'
    return dict(sorted(days.items()))


def refill(state, day, cap=NEW_PER_DAY):
    """Fill the learning set up to WINDOW from lexicon order, at most cap new words per day, none while
    SHAKY_BLOCK or more words are shaky."""
    words = state['words']
    if sum(w['status'] == 'shaky' for w in words) >= SHAKY_BLOCK:
        return 0
    last_day, count = state.get('refilled') or ['', 0]
    count = count if last_day == day else 0
    room = min(WINDOW - sum(w['status'] == 'active' for w in words), cap - count)
    added = 0
    for w in words:
        if added >= room:
            break
        if w['status'] == 'queue':
            set_status(w, 'active', day)
            added += 1
    state['refilled'] = [day, count + added]
    return added


def graduates(word, chat=None):
    """active -> known: GRADUATE_DAYS of exposure, no flip/asked/peek on the last GRADUATE_DAYS exposure days,
    and at least one genuinely seen day (assumed days alone never graduate a word)."""
    days = exposure_days(word, chat)
    total = sum(1 if kind == 'seen' else ASSUMED_WEIGHT for kind in days.values())
    if total < GRADUATE_DAYS or len(days) < GRADUATE_DAYS:
        return False
    streak = list(days)[-GRADUATE_DAYS]
    peeks = word.get('peeks') or []
    clean = (not word['last_bad'] or word['last_bad'] < streak) and not (peeks and peeks[-1] >= streak)
    return clean and 'seen' in days.values()


def promote(state, day=None, chat=None):
    """Applies the promotion rules for today. Idempotent: safe to call as often as you like."""
    day = day or today()
    if chat is None:
        chat = (read_json(home() / 'exposure.json', {}) or {}).get('words', {})
    for w in state['words']:
        if w['status'] == 'active' and graduates(w, chat):
            set_status(w, 'known', day)
        elif w['status'] == 'shaky' and days_between(w['last_bad'] or w['changed'], day) >= SHAKY_DAYS:
            set_status(w, 'known', day)
    refill(state, day)
    state['stage'] = stage_for(state)
    return state


EVENTS = ('seen', 'assumed', 'flip', 'asked', 'peek', 'known', 'active')


def apply_event(state, fr, kind, day=None):
    """Extension and command events. Returns False for unknown words or kinds.

    seen / assumed: exposure. flip (clicked back to English) / asked: shaky. peek (hovered for the meaning):
    blocks graduation of an active word, restarts a shaky word's clock, and a known word peeked on 2 different
    days within PEEK_WINDOW days becomes shaky. known / active: set directly (commands)."""
    day = day or today()
    w = find(state, fr)
    if w is None or kind not in EVENTS:
        return False
    if kind in ('seen', 'assumed'):
        field = 'days' if kind == 'seen' else 'assumed'
        if w['status'] != 'queue' and day not in (w.get(field) or []):
            w[field] = sorted((w.get(field) or []) + [day])[-60:]
    elif kind in ('flip', 'asked'):
        w['last_bad'] = day
        set_status(w, 'shaky', day)
    elif kind == 'peek':
        peeks = w.setdefault('peeks', [])
        if not peeks or peeks[-1] != day:
            peeks.append(day)
            del peeks[:-10]
        if w['status'] == 'shaky':
            w['last_bad'] = day
        elif w['status'] == 'known' and len(peeks) >= 2 and days_between(peeks[-2], day) < PEEK_WINDOW:
            w['last_bad'] = day
            set_status(w, 'shaky', day)
    elif kind == 'known':
        set_status(w, 'known', day)
    elif kind == 'active':
        w['last_bad'] = day  # restart its graduation count
        set_status(w, 'active', day)
    return True


def introduced(state):
    """Words in use (active, shaky, known), learning words first."""
    order = {'shaky': 0, 'active': 1, 'known': 2}
    words = [w for w in state['words'] if w['status'] in order]
    return sorted(words, key=lambda w: (order[w['status']], w['added']))


COLLAPSE_AT = 150      # from this many known words, the brief and exports name a rank band instead of listing them
EXCEPTIONS_MAX = 15    # most exceptions named on each side of the band


def known_band(state):
    """Compact description of the known set by lexicon rank (the lexicon is in frequency/usefulness order).

    Returns (n, missing, extra): known = words ranked 1..n, except `missing` (ranked <= n but not yet introduced;
    learning words are listed separately anyway), plus `extra` (known words ranked > n). n minimizes the number
    of exceptions; ties go to the larger band."""
    words = state['words']
    known_after = sum(w['status'] == 'known' for w in words)
    queue_before = 0
    best = (known_after, 0)
    for rank, w in enumerate(words, 1):
        known_after -= w['status'] == 'known'
        queue_before += w['status'] == 'queue'
        if queue_before + known_after <= best[0]:
            best = (queue_before + known_after, rank)
    n = best[1]
    missing = [w['fr'] for w in words[:n] if w['status'] == 'queue']
    extra = [w['fr'] for w in words[n:] if w['status'] == 'known']
    return n, missing, extra


def version(state):
    blob = json.dumps([stage_for(state), state.get('paused'), [(w['fr'], w['status']) for w in introduced(state)]])
    return hashlib.sha1(blob.encode()).hexdigest()[:10]


def public_state(state):
    """What the extension gets: stage, pause flag, and the words in use."""
    return {'version': version(state), 'stage': stage_for(state), 'paused': bool(state.get('paused')),
            'words': [{k: w[k] for k in ('fr', 'en', 'hint', 'status')} for w in introduced(state)]}


# ---- chat exposure from Claude Code transcripts ----

def pattern(fr):
    word = norm(fr)
    noun = re.match(r"(?:le |la |les |l')(.+)", word)
    if noun:
        noun = noun.group(1)
        lead = r"(?<!\w)" + (DETERMINER if noun.isascii() else '')
        return re.compile(lead + re.escape(noun) + r"s?(?![\w])")
    tail = {'sans': r"(?![\w-])(?!\s+serif)", 'et': r"(?![\w-])(?!\s+al\b)"}.get(word, r"(?![\w-])")
    return re.compile(r"(?<![\w'-])" + re.escape(word) + tail)


def codex_home():
    return Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex').expanduser()


def transcript_roots():
    """Chat transcripts to scan: FRENCH_WEAVE_TRANSCRIPTS, else Claude Code's projects and Codex's sessions."""
    if os.environ.get('FRENCH_WEAVE_TRANSCRIPTS'):
        return [Path(os.environ['FRENCH_WEAVE_TRANSCRIPTS']).expanduser()]
    claude = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude').expanduser() / 'projects'
    return [claude, codex_home() / 'sessions']


class Lines:
    """Complete lines of a log after a byte offset; .offset ends just past the last complete line read."""

    def __init__(self, path, offset):
        self.path, self.offset = path, offset

    def __iter__(self):
        with open(self.path, 'rb') as file:
            file.seek(self.offset)
            for raw in file:
                if not raw.endswith(b'\n'):
                    return  # half-written; read it next time
                self.offset += len(raw)
                yield raw.decode('utf-8', 'replace')


def replies(lines):
    """Yield (day, text) for main-thread assistant replies in Claude Code or Codex transcript lines."""
    for line in lines:
        if len(line) > 1_000_000 or '"assistant"' not in line:
            continue
        try:
            item = json.loads(line)
        except ValueError:
            continue
        day = local_day(item.get('timestamp'))
        if item.get('type') == 'assistant' and not item.get('isSidechain'):  # Claude Code
            for block in item.get('message', {}).get('content') or []:
                if isinstance(block, dict) and block.get('type') == 'text':
                    yield day, block.get('text', '')
        elif item.get('type') == 'response_item':  # Codex
            payload = item.get('payload') or {}
            if payload.get('type') == 'message' and payload.get('role') == 'assistant':
                yield day, ' '.join(b.get('text', '') for b in payload.get('content') or [] if isinstance(b, dict))


def local_day(stamp):
    try:
        return dt.datetime.fromisoformat(str(stamp).replace('Z', '+00:00')).astimezone().date().isoformat()
    except ValueError:
        return str(stamp)[:10]


def scan(words, index, roots=None, start='0000-00-00'):
    """Fold new transcript lines into the exposure index (mutated and returned)."""
    roots = [Path(r) for r in ([roots] if isinstance(roots, (str, Path)) else roots)] if roots else transcript_roots()
    patterns = {fr: pattern(fr) for fr in words if norm(fr) not in UNMEASURABLE}
    counts, offsets, recent = index.setdefault('words', {}), index.setdefault('offsets', {}), index.setdefault('recent', {})
    for fr in patterns:
        counts.setdefault(fr, {'n': 0, 'days': []})
    since = time.mktime(time.strptime(start, '%Y-%m-%d')) if start > '0000' else 0
    for path in (p for root in roots if root.exists() for p in root.rglob('*.jsonl')):
        name = str(path)
        try:
            if 'subagents' in path.parts or path.stat().st_mtime < since:
                continue
            offset = offsets.get(name, 0)
            if path.stat().st_size < offset:
                offset = 0
        except OSError:
            continue
        lines = Lines(path, offset)
        for day, text in replies(lines):
            if day < start or 'French Weave' in text:
                continue
            digest = hashlib.sha1(text.encode()).hexdigest()[:16]
            if digest in recent:
                continue  # forked and resumed chats copy old replies
            recent[digest] = day
            prose = norm(CODE.sub(' ', text))
            for fr, regex in patterns.items():
                if regex.search(prose):
                    entry = counts[fr]
                    entry['n'] += 1
                    if day not in entry['days']:
                        entry['days'] = sorted(entry['days'] + [day])[-60:]
        offsets[name] = lines.offset
    cutoff = (dt.date.today() - dt.timedelta(days=DEDUPE_DAYS)).isoformat()
    index['recent'] = {k: v for k, v in recent.items() if v >= cutoff}
    index['offsets'] = {k: v for k, v in offsets.items() if os.path.exists(k)}
    index['updated'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    return index


def refresh_exposure():
    """Scan new transcript lines, then re-apply promotion. Skips if another refresh is running."""
    with locked('exposure.lock', blocking=False) as got:
        if not got:
            return False
        state = load_state()
        path = home() / 'exposure.json'
        index = scan([w['fr'] for w in state['words']], read_json(path, {}) or {}, start=state.get('created', '0000-00-00'))
        write_json(path, index)
    with editing():
        pass  # promotion runs on save
    return True
