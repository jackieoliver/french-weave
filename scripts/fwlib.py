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
import shutil
import tempfile
import time
import unicodedata

try:
    import fcntl
except ImportError:  # Windows: no locking (untested platform)
    fcntl = None

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
LEXICON = PLUGIN_ROOT / 'data' / 'lexicon.csv'
DEFAULT_LANGUAGE = 'French'  # another language: setup --language NAME --lexicon FILE (README "Other languages")

# ---- promotion rules (documented in README "How words advance") ----
WINDOW = 20             # target number of active (learning) words
NEW_PER_DAY = 5         # new words per day, including the first day
SHAKY_BLOCK = 5         # no new words while this many or more are shaky
GRADUATE_DAYS = 3       # active -> known: exposure days needed, and length of the clean streak
SHAKY_DAYS = 7          # shaky -> known: days with no new flip, asked or peek
PEEK_WINDOW = 7         # a known word peeked on 2 different days within this many days becomes shaky
ASSUMED_WEIGHT = 1      # a day with only opt-in "assumed" exposure (fw.py log-chat-day) counts this much
STAGES = [(400, 4), (150, 3), (40, 2)]  # (known words, stage): first match wins; otherwise Stage 1


PROFILE_DIR = PLUGIN_ROOT / 'data' / 'profiles'  # one JSON profile per language (data/profiles/README.md)
NO_SPACES = re.compile('[\u0e00-\u0e7f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]')  # Thai, kana, CJK
CODE = re.compile(r"```.*?```|`[^`\n]*`|https?://\S+", re.S)
DEDUPE_DAYS = 45


def home():
    """The state dir: FRENCH_WEAVE_HOME, else the dir this copy was installed into by setup (<home>/app/scripts),
    else ~/.french-weave."""
    if os.environ.get('FRENCH_WEAVE_HOME'):
        return Path(os.environ['FRENCH_WEAVE_HOME']).expanduser()
    if PLUGIN_ROOT.name == 'app' and ((PLUGIN_ROOT / 'fw-host').exists() or (PLUGIN_ROOT.parent / 'state.json').exists()):
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


def lexicon_path():
    """The word list: <state dir>/lexicon.csv when setup installed one for another language, else the French list."""
    custom = home() / 'lexicon.csv'
    return custom if custom.exists() else LEXICON


def language(state=None):
    return (state or {}).get('language') or DEFAULT_LANGUAGE


def load_lexicon(path=None):
    """Rows of fr (or word), en, hint; an optional scan column set to no keeps a word out of exposure counting
    (it is also an English word, like "solo")."""
    with open(path or lexicon_path(), encoding='utf-8-sig', newline='') as file:
        rows = [r for r in csv.DictReader(file) if (r.get('fr') or r.get('word') or '').strip()]
    seen, out = set(), []
    for r in rows:
        word = (r.get('fr') or r.get('word')).strip()
        if key(word) not in seen:
            seen.add(key(word))
            out.append({'fr': word, 'en': (r.get('en') or '').strip(), 'hint': (r.get('hint') or '').strip(),
                        **({'scan': False} if (r.get('scan') or '').strip().lower() == 'no' else {})})
    return out


# ---- language profiles ----

def _merged(base, own):
    """base with own's values on top; nested objects merge, anything else (lists included) replaces."""
    out = dict(base)
    for k, v in (own or {}).items():
        out[k] = _merged(base[k], v) if isinstance(base.get(k), dict) and isinstance(v, dict) else v
    return out


_profiles = {}


def _read_profile(path):
    """Parsed profile file ({} when missing or unreadable), cached by path and modification time."""
    try:
        stamp = path.stat().st_mtime_ns
    except OSError:
        return {}
    if _profiles.get(path, (None,))[0] != stamp:
        data = read_json(path, {})
        _profiles[path] = (stamp, data if isinstance(data, dict) else {})
    return _profiles[path][1]


def profile(state_or_name=None):
    """The language profile for a state (or a language name): data/profiles/<name>.json over _generic.json. A
    language with no profile, or a profile missing fields, gets the generic values: no examples, sense notes,
    articles or drift words, so nothing French ever leaks into another language."""
    name = state_or_name if isinstance(state_or_name, str) else language(state_or_name)
    merged = _merged(_read_profile(PROFILE_DIR / '_generic.json'), _read_profile(PROFILE_DIR / f'{name.strip().lower()}.json'))
    merged['language'] = merged.get('language') or name
    return merged


def gloss_example(state, prof=None):
    """The footer example: the profile's, else the first word of the list: (sans = without, "sahn")."""
    w = (prof or profile(state))['examples'].get('gloss') or (state.get('words') or [{}])[0]
    return f'({w.get("word") or w.get("fr", "")} = {w.get("en", "")}, "{w.get("hint", "")}")'


def default_swaps(state, prof=None, n=10):
    """[(English, word)] named as default swaps in exports: the profile's, else the first n words of the list."""
    pairs = (prof or profile(state))['examples'].get('default_swaps')
    return [tuple(p) for p in pairs] if pairs else [(w['en'], w['fr']) for w in (state.get('words') or [])[:n]]


def variety_note(prof, short=False):
    """' Use Latin American Spanish words and spellings.' when the profile names a variety, else ''."""
    variety = prof.get('variety')
    return '' if not variety else f' Use {variety}.' if short else f' Use {variety} words and spellings.'


def measurable(word, prof=None):
    same = (prof or profile(DEFAULT_LANGUAGE))['exposure']['same_as_english']
    return norm(word['fr']) not in same and word.get('scan', True)


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


# ---- installed copies ----

# Setup copies these into the state dir: the plugin cache path changes on every update, Chrome needs fixed paths.
COPIES = (('extension', ('test', 'node_modules', 'package.json', 'bun.lock')),
          ('app/scripts', ('__pycache__',)), ('app/data', ()))


def plugin_version(root=None):
    data = read_json((root or PLUGIN_ROOT) / '.claude-plugin' / 'plugin.json', {}) or {}
    return str(data.get('version') or '')


def install_copies(root=None, directory=None):
    """Copy the extension, scripts and data into the state dir. Each folder is built next to its target and
    swapped in, so the native host and Chrome never see a half-copied folder. Records the version in app/VERSION.
    Callers hold copies.lock, so pid-named staging folders found here are leftovers from a run that died."""
    root, directory = Path(root or PLUGIN_ROOT), Path(directory or home())
    for name, skip in COPIES:
        source = root / ('extension' if name == 'extension' else name.split('/')[1])
        target = directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        for leftover in target.parent.glob(target.name + '.*-*'):
            if re.fullmatch(re.escape(target.name) + r'\.(new|old)-\d+', leftover.name):
                shutil.rmtree(leftover, ignore_errors=True)
        fresh, old = (target.with_name(f'{target.name}.{kind}-{os.getpid()}') for kind in ('new', 'old'))
        shutil.copytree(source, fresh, ignore=shutil.ignore_patterns(*skip) if skip else None)
        if target.exists():
            target.rename(old)
        fresh.rename(target)
        if old.exists():
            shutil.rmtree(old)
    version = plugin_version(root)
    if version:
        (directory / 'app' / 'VERSION').write_text(version + '\n')


def refresh_copies():
    """After a plugin update, bring the copies setup made up to this plugin's version. Does nothing before setup
    has run, when running from the copies themselves (Codex, the native host), or when they're current.
    Returns the new version when it copied, else ''."""
    app = home() / 'app'
    version = plugin_version()
    if not version or not app.is_dir() or PLUGIN_ROOT.resolve() == app.resolve():
        return ''
    try:
        if (app / 'VERSION').read_text().strip() == version:
            return ''
    except OSError:
        pass  # copies from before 0.2.1 have no VERSION
    with locked('copies.lock', blocking=False) as got:
        if not got:
            return ''  # another session is copying right now
        install_copies()
    return version


# ---- state ----

def new_state(day=None, lexicon=None, known_top=0):
    """A fresh state; known_top marks the top lexicon words known before the first learning words are picked."""
    day = day or today()
    words = [blank(w) for w in (lexicon or load_lexicon())]
    state = {'schema': 1, 'created': day, 'stage': 1, 'stage_pinned': False, 'paused': False, 'words': words}
    seed_known(state, known_top, day)
    refill(state, day)
    return state


def seed_known(state, n, day=None):
    """Marks the top n lexicon words known if they aren't introduced yet: still queued, or picked as learning words
    today with nothing recorded (the first chat prompt, `/french-weave:setup` included, creates the state just
    before setup runs). Words with any progress keep their status, so seeding never resets progress. Today's
    new-word allowance is handed back for the picks it undoes. Returns how many words changed."""
    day = day or today()
    fresh = lambda w: (w['status'] == 'active' and w.get('added') == day and
                       not (w.get('days') or w.get('assumed') or w.get('peeks') or w.get('last_bad')))
    seeded = [w for w in state['words'][:max(n, 0)] if w['status'] == 'queue' or fresh(w)]
    undone = sum(map(fresh, seeded))
    for w in seeded:
        set_status(w, 'known', day)
    last_day, count = state.get('refilled') or ['', 0]
    if undone and last_day == day:
        state['refilled'] = [day, max(0, count - undone)]
    return len(seeded)


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
        current = read_json(path)
        if not (isinstance(current, dict) and isinstance(current.get('words'), list)):
            if path.exists():  # unreadable or not a word state: keep it for the user and start over
                path.rename(path.with_name('state.json.bad-' + time.strftime('%Y%m%d-%H%M%S')))
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
    # Accept the bare noun for "le problème" style entries (the profile's definite articles).
    lead = definite_lead(profile(state))
    for w in state['words'] if lead else ():
        if re.sub(f'^({lead})', '', key(w['fr'])) == k:
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
            'language': language(state), 'words': [{k: w[k] for k in ('fr', 'en', 'hint', 'status')} for w in introduced(state)]}


# ---- chat exposure from Claude Code transcripts ----

def definite_lead(prof):
    """Regex alternation for a definite article at the start of a listed noun ("le |la |les |l'"), or ''."""
    articles = prof['articles']
    return '|'.join([re.escape(a) + ' ' for a in articles['definite']] + [re.escape(a) for a in articles['elided']])


def pattern(fr, prof=None):
    """Regex for a word in normalized prose. Nouns listed with a definite article (le problème) also count bare, and
    with any of the profile's determiners when the bare noun is ASCII (le chat, not the English "chat")."""
    prof = prof or profile(DEFAULT_LANGUAGE)
    word = norm(fr)
    if NO_SPACES.search(word) or not prof['script']['spaces']:  # no spaces between words: no boundaries to look for
        return re.compile(re.escape(word))
    lead = definite_lead(prof)
    noun = re.match(f'(?:{lead})(.+)', word) if lead else None
    if noun:
        noun = noun.group(1)
        determiners = '|'.join(re.escape(d) for d in prof['articles']['determiners'])
        lead = r"(?<!\w)" + (f'(?:{determiners})' + r'\s*' if determiners and noun.isascii() else '')
        return re.compile(lead + re.escape(noun) + r"s?(?![\w])")
    after = prof['exposure']['not_followed_by'].get(word)
    tail = r"(?![\w-])" + (f'(?!{after})' if after else '')
    return re.compile(r"(?<![\w'-])" + re.escape(word) + tail)


def codex_home():
    return Path(os.environ.get('CODEX_HOME') or Path.home() / '.codex').expanduser()


def claude_home():
    return Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude').expanduser()


MARKETPLACE = 'french-weave'


def marketplace_source():
    """Where Claude Code installed this marketplace from ({'source': 'github', 'repo': ...}), or None."""
    known = read_json(claude_home() / 'plugins' / 'known_marketplaces.json', {}) or {}
    entry = known.get(MARKETPLACE) if isinstance(known, dict) else None
    return entry.get('source') if isinstance(entry, dict) and isinstance(entry.get('source'), dict) else None


def auto_update():
    """True or False when Claude Code auto-updates this marketplace by a setting or the /plugin toggle, else None
    (off: Claude Code's default for marketplaces outside Anthropic's)."""
    settings = read_json(claude_home() / 'settings.json', {}) or {}
    entry = (settings.get('extraKnownMarketplaces') or {}).get(MARKETPLACE) if isinstance(settings, dict) else None
    if isinstance(entry, dict) and 'autoUpdate' in entry:
        return bool(entry['autoUpdate'])
    known = read_json(claude_home() / 'plugins' / 'known_marketplaces.json', {}) or {}
    entry = known.get(MARKETPLACE) if isinstance(known, dict) else None
    return bool(entry['autoUpdate']) if isinstance(entry, dict) and 'autoUpdate' in entry else None


def transcript_roots():
    """Chat transcripts to scan: FRENCH_WEAVE_TRANSCRIPTS, else Claude Code's projects and Codex's sessions."""
    if os.environ.get('FRENCH_WEAVE_TRANSCRIPTS'):
        return [Path(os.environ['FRENCH_WEAVE_TRANSCRIPTS']).expanduser()]
    return [claude_home() / 'projects', codex_home() / 'sessions']


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


def replies(lines, ids=False):
    """Yield (day, text) for main-thread assistant replies in Claude Code or Codex transcript lines; with ids,
    (day, text, record id): Claude Code's uuid or Codex's message id, which copies in forked chats keep."""
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
                    yield (day, block.get('text', ''), item.get('uuid') or '')[:3 if ids else 2]
        elif item.get('type') == 'response_item':  # Codex
            payload = item.get('payload') or {}
            if payload.get('type') == 'message' and payload.get('role') == 'assistant':
                text = ' '.join(b.get('text', '') for b in payload.get('content') or [] if isinstance(b, dict))
                yield (day, text, payload.get('id') or '')[:3 if ids else 2]


def local_day(stamp):
    try:
        return dt.datetime.fromisoformat(str(stamp).replace('Z', '+00:00')).astimezone().date().isoformat()
    except ValueError:
        return str(stamp)[:10]


def scan(words, index, roots=None, start='0000-00-00', prof=None):
    """Fold new transcript lines into the exposure index (mutated and returned). prof: the language profile
    (default French)."""
    prof = prof or profile(DEFAULT_LANGUAGE)
    roots = [Path(r) for r in ([roots] if isinstance(roots, (str, Path)) else roots)] if roots else transcript_roots()
    same = set(prof['exposure']['same_as_english'])
    patterns = {fr: pattern(fr, prof) for fr in words if norm(fr) not in same}
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
        for day, text, record in replies(lines, ids=True):
            if day < start or 'French Weave' in text:
                continue
            # Forked and resumed chats copy old replies with their ids (Codex gives the copies new timestamps), so
            # the id tells a copy from the same words said again; records without one fall back to the text alone.
            digest = hashlib.sha1(f'{record}\0{text}'.encode() if record else text.encode()).hexdigest()[:16]
            if digest in recent:
                continue
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
        index = scan([w['fr'] for w in state['words'] if w.get('scan', True)], read_json(path, {}) or {}, start=state.get('created', '0000-00-00'), prof=profile(state))
        write_json(path, index)
    with editing():
        pass  # promotion runs on save
    return True
