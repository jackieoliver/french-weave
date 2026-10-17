"""Local usage log for the dev build of the Chrome extension (Python 3.9+, standard library only).

The extension (extension/src/usage.js) records what it does: page views by site, each batch of passages and the model
call behind it, queue retries and drops, words seen and peeked, popup opens, setting changes, worker starts. It sends
them in batches to the native host (fw_host.py), which appends them here, one JSON object per line, in
<state dir>/usage/YYYY-MM-DD.jsonl (the event's local day). Only when the installed copy is the dev build
(app/CHANNEL says "dev"); nothing ever leaves this computer. Files older than KEEP_DAYS are deleted on each append.
`fw.py usage` reads them back as a summary.

Never stored: page text, URLs (only the site's hostname), keys, anything typed. clean_event drops anything that
looks like one, as a second check after the extension's own.
"""
import datetime as dt
import json
from pathlib import Path
import re
import statistics

import fwlib

KEEP_DAYS = 60
MAX_EVENTS = 1000  # per message from the extension
FILE = re.compile(r'^(\d{4}-\d{2}-\d{2})\.jsonl$')
KINDS = {'worker_start', 'installed', 'reload', 'page', 'batch', 'queue', 'word', 'popup', 'setting', 'host_error',
         'cap_hit', 'overflow'}
FIELD = re.compile(r'^[A-Za-z][A-Za-z0-9_]{0,23}$')
HOSTNAME = re.compile(r'^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$')
# Strings that may not be stored: a URL or path with a query, or something shaped like a key.
UNSAFE = re.compile(r'://|[?#&=]|\bAIza|\bsk-|[A-Za-z0-9_\-]{32,}')
MAX_TEXT = 80


def usage_dir():
    return fwlib.home() / 'usage'


def _value(value, depth=0):
    """A JSON value safe to store, or None to drop it."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return value if value == value and abs(value) < 1e15 else None  # no NaN or huge numbers
    if isinstance(value, str):
        return value if len(value) <= MAX_TEXT and not UNSAFE.search(value) else None
    if depth >= 2:
        return None
    if isinstance(value, list):
        items = [_value(v, depth + 1) for v in value[:20]]
        return [v for v in items if v is not None]
    if isinstance(value, dict):
        out = {}
        for k, v in list(value.items())[:30]:
            v = _value(v, depth + 1)
            if isinstance(k, str) and FIELD.match(k) and v is not None:
                out[k] = v
        return out
    return None


def clean_event(event):
    """The event as stored, or None. Needs a known kind ("k") and a time in ms ("at")."""
    if not isinstance(event, dict) or event.get('k') not in KINDS:
        return None
    at = event.get('at')
    if isinstance(at, bool) or not isinstance(at, (int, float)) or at <= 0:
        return None
    out = {'at': int(at), 'k': event['k']}
    for key, value in event.items():
        if key in ('at', 'k') or not FIELD.match(str(key)):
            continue
        if key == 'domain':
            value = value if isinstance(value, str) and HOSTNAME.match(value) else None
        value = _value(value)
        if value is not None:
            out[key] = value
    return out


def day_of(at_ms):
    return dt.datetime.fromtimestamp(at_ms / 1000).date().isoformat()


def append(events, today=None):
    """Append the extension's events to their day's file; returns how many were kept. Prunes old files."""
    kept = [e for e in (clean_event(e) for e in (events or [])[:MAX_EVENTS]) if e]
    directory = usage_dir()
    if kept:
        directory.mkdir(parents=True, exist_ok=True)
        by_day = {}
        for event in kept:
            by_day.setdefault(day_of(event['at']), []).append(event)
        with fwlib.locked('usage.lock'):
            for day, rows in sorted(by_day.items()):
                with open(directory / f'{day}.jsonl', 'a', encoding='utf-8') as file:
                    for row in rows:
                        file.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
    prune(today=today)
    return len(kept)


def prune(keep_days=KEEP_DAYS, today=None):
    """Delete day files older than keep_days (today counts as one). Returns the names removed."""
    directory = usage_dir()
    if not directory.is_dir():
        return []
    first = (dt.date.fromisoformat(today or fwlib.today()) - dt.timedelta(days=keep_days - 1)).isoformat()
    removed = []
    for path in directory.iterdir():
        m = FILE.match(path.name)
        if m and m.group(1) < first:
            path.unlink(missing_ok=True)
            removed.append(path.name)
    return sorted(removed)


def load(days=7, today=None):
    """Events from the last `days` days (today included), oldest first. Broken lines are skipped."""
    directory = usage_dir()
    if not directory.is_dir():
        return []
    end = dt.date.fromisoformat(today or fwlib.today())
    first = (end - dt.timedelta(days=max(1, days) - 1)).isoformat()
    events = []
    for path in sorted(directory.iterdir()):
        m = FILE.match(path.name)
        if not m or not (first <= m.group(1) <= end.isoformat()):
            continue
        with open(path, encoding='utf-8') as file:
            for line in file:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict) and isinstance(event.get('at'), (int, float)):
                    events.append(event)
    events.sort(key=lambda e: e['at'])
    return events


def percentile(values, p):
    """Nearest-rank percentile; None for no values."""
    values = sorted(values)
    if not values:
        return None
    rank = max(1, -(-len(values) * p // 100))  # ceil(n * p / 100)
    return values[int(rank) - 1]


def _count(rows, key):
    out = {}
    for row in rows:
        value = row.get(key)
        if value is not None:
            out[value] = out.get(value, 0) + 1
    return out


def _top(counts, n=10):
    return sorted(counts.items(), key=lambda kv: (-kv[1], str(kv[0])))[:n]


MODEL_CALL = ('ok', 'no_candidates')  # outcomes where a model answered


def summarize(events, days=7, today=None):
    """Everything `fw.py usage` prints, as plain data (also its --json output)."""
    today = today or fwlib.today()
    for e in events:
        e.setdefault('_day', day_of(e['at']))
        e.setdefault('_hour', dt.datetime.fromtimestamp(e['at'] / 1000).hour)
    of = lambda kind: [e for e in events if e.get('k') == kind]  # noqa: E731
    batches, pages, queue, words = of('batch'), of('page'), of('queue'), of('word')

    hours = _count(events, '_hour')
    slots = {(e['_day'], e['_hour']) for e in events}
    domains = {}
    for e in pages + batches:
        d = e.get('domain')
        if d:
            row = domains.setdefault(d, {'pages': 0, 'batches': 0})
            row['pages' if e['k'] == 'page' else 'batches'] += 1

    per_day = {}
    for e in batches:
        row = per_day.setdefault(e['_day'], {'batches': 0, 'passages': 0, 'cached': 0, 'swaps': 0, 'modelCalls': 0})
        row['batches'] += 1
        row['passages'] += e.get('passages') or 0
        row['cached'] += e.get('cached') or 0
        row['swaps'] += e.get('swaps') or 0
        row['modelCalls'] += 1 if e.get('model') else 0

    latency = {}
    for e in batches:
        if e.get('outcome') in MODEL_CALL and e.get('model') and isinstance(e.get('ms'), (int, float)):
            key = f"{e.get('provider') or '?'}/{e['model']}"
            latency.setdefault(key, []).append(e['ms'])
    latency = {k: {'n': len(v), 'medianMs': round(statistics.median(v)), 'p90Ms': percentile(v, 90)}
               for k, v in sorted(latency.items())}

    outcomes = _count(batches, 'outcome')
    attempts = [f for e in batches for f in (e.get('fallbacks') or []) if isinstance(f, dict)]
    fallback_kinds = _count(attempts, 'kind')
    fallback_models = _count([{'m': f"{f.get('provider') or '?'}/{f.get('model') or '?'}"} for f in attempts], 'm')
    called = sum(1 for e in batches if e.get('model') or e.get('fallbacks'))

    passages = sum(e.get('passages') or 0 for e in batches)
    cached = sum(e.get('cached') or 0 for e in batches)

    # Spend: the worker's own day total per provider (spent, as counted for the caps, failed paid requests
    # included) where a batch carries it, else the sum of each batch's cost.
    spend = {}
    for e in batches:
        day = spend.setdefault(e['_day'], {})
        snap = e.get('spent') if isinstance(e.get('spent'), dict) else {}
        for provider, usd in snap.items():
            if isinstance(usd, (int, float)):
                day[provider] = max(day.get(provider, 0), usd)
        provider = e.get('provider')
        if provider and isinstance(e.get('usd'), (int, float)) and provider not in snap:
            day[f'{provider}*'] = day.get(f'{provider}*', 0) + e['usd']
    spend = {d: {p: round(v, 6) for p, v in sorted(row.items()) if v} for d, row in sorted(spend.items())}

    by_status = {}
    for e in batches:
        for status, n in (e.get('byStatus') or {}).items():
            if isinstance(n, (int, float)):
                by_status[status] = by_status.get(status, 0) + n

    queue_counts = {}
    for e in queue:
        what = e.get('what') or '?'
        queue_counts[what] = queue_counts.get(what, 0) + (e.get('n') or 1)
        if what == 'cancelled' and e.get('pending'):
            queue_counts['cancelledQueued'] = queue_counts.get('cancelledQueued', 0) + e['pending']
    retry_reasons = _count([e for e in queue if e.get('what') == 'retry'], 'reason')

    def word_counts(what):
        return _top(_count([e for e in words if e.get('what') == what], 'word'), 15)

    starts = of('worker_start')
    idle = [e['idleMs'] for e in starts if isinstance(e.get('idleMs'), (int, float))]
    return {
        'days': days, 'today': today, 'events': len(events),
        'activeDays': sorted({e['_day'] for e in events}),
        'activeHours': len(slots),
        'busiestHours': _top(hours, 6),
        'topDomains': sorted(domains.items(), key=lambda kv: (-kv[1]['pages'] - kv[1]['batches'], kv[0]))[:10],
        'pageViews': len(pages), 'pagesOff': _count([e for e in pages if e.get('on') is False], 'why'),
        'perDay': dict(sorted(per_day.items())),
        'batches': len(batches), 'passages': passages, 'cached': cached,
        'cacheHitRate': round(cached / passages, 3) if passages else None,
        'latency': latency,
        'outcomes': dict(_top(outcomes, 30)),
        'modelBatches': called,
        'fallbacks': {'attempts': len(attempts), 'byKind': dict(_top(fallback_kinds, 20)),
                      'byModel': dict(_top(fallback_models, 20))},
        'queue': queue_counts, 'retryReasons': retry_reasons,
        'spend': spend,
        'swapsByStatus': by_status,
        'wordsSeen': len({e.get('word') for e in words if e.get('what') == 'seen'}),
        'topPeeks': word_counts('peek'), 'topFlips': word_counts('flip'),
        'workerStarts': len(starts), 'workerIdleMedianMs': round(statistics.median(idle)) if idle else None,
        'installs': [{k: e.get(k) for k in ('reason', 'from', 'to')} for e in of('installed')],
        'reloads': [{k: e.get(k) for k in ('from', 'to')} for e in of('reload')],
        'popupOpens': len(of('popup')),
        'settings': [{k: e.get(k) for k in ('_day', 'name', 'from', 'to', 'domain') if e.get(k) is not None}
                     for e in of('setting')][-15:],
        'hostErrors': _count(of('host_error'), 'where'),
        'capHits': [{k: e.get(k) for k in ('_day', 'provider', 'reason', 'usd', 'cap') if e.get(k) is not None}
                    for e in of('cap_hit')],
        'overflow': sum(e.get('n') or 0 for e in of('overflow')),
    }


def today_numbers(today=None):
    """The popup's line: today's batches, the share of passages served from the cache, p90 batch time of the
    batches a model answered, and spend."""
    today = today or fwlib.today()
    s = summarize(load(1, today), 1, today)
    times = [e['ms'] for e in load(1, today) if e.get('k') == 'batch' and e.get('outcome') in MODEL_CALL
             and e.get('model') and isinstance(e.get('ms'), (int, float))]
    usd = sum(s['spend'].get(today, {}).values())
    return {'batches': s['batches'], 'passages': s['passages'], 'cached': s['cached'],
            'p90Ms': percentile(times, 90), 'usd': round(usd, 6)}


def _ms(ms):
    return '-' if ms is None else f'{ms / 1000:.1f} s'


def render(s):
    """Plain-text report of summarize()'s result."""
    if not s['events']:
        return (f'No usage recorded in the last {s["days"]} days. The log is kept only by the dev build '
                f'(app/CHANNEL "dev") with "Usage log" on in the popup.')
    lines = [f'French Weave usage, last {s["days"]} days (to {s["today"]}): {s["events"]} events']
    lines.append(f'Active: {len(s["activeDays"])} days, {s["activeHours"]} distinct hours. Busiest hours: '
                 + ', '.join(f'{h:02d}h ({n})' for h, n in s['busiestHours']))
    if s['topDomains']:
        lines.append('Top sites: ' + ', '.join(f'{d} ({r["pages"]} views, {r["batches"]} batches)'
                                               for d, r in s['topDomains']))
    if s['pagesOff']:
        lines.append('Page views while off: ' + ', '.join(f'{k} {v}' for k, v in _top(s['pagesOff'], 10)))
    lines.append('')
    rate = '-' if s['cacheHitRate'] is None else f"{s['cacheHitRate'] * 100:.0f}%"
    lines.append(f'Batches: {s["batches"]} ({s["passages"]} passages, cache hit rate {rate})')
    for day, row in s['perDay'].items():
        spent = s['spend'].get(day, {})
        money = ', '.join(f'{p} ${v:.4f}' for p, v in spent.items()) or '$0'
        lines.append(f'  {day}: {row["batches"]} batches, {row["modelCalls"]} with a model, {row["passages"]} passages, '
                     f'{row["cached"]} cached, {row["swaps"]} swaps shown; spend {money}')
    if s['latency']:
        lines.append('Latency per provider/model (whole batch, answered by that model):')
        for key, row in s['latency'].items():
            lines.append(f'  {key}: n={row["n"]}, median {_ms(row["medianMs"])}, p90 {_ms(row["p90Ms"])}')
    total = s['batches'] or 1
    lines.append('Outcomes: ' + ', '.join(f'{k} {v} ({v / total * 100:.0f}%)' for k, v in s['outcomes'].items()))
    fb = s['fallbacks']
    if fb['attempts']:
        lines.append(f'Fallbacks to the next step: {fb["attempts"]} in {s["modelBatches"]} model batches; by kind: '
                     + ', '.join(f'{k} {v}' for k, v in fb['byKind'].items()) + '; by model: '
                     + ', '.join(f'{k} {v}' for k, v in fb['byModel'].items()))
    q = s['queue']
    lines.append(f'Queue: {q.get("retry", 0)} retries'
                 + (f' ({", ".join(f"{k} {v}" for k, v in _top(s["retryReasons"]))})' if s['retryReasons'] else '')
                 + f', {q.get("gave_up", 0)} given up, {q.get("unmounted", 0)} left the page while queued, '
                 f'{q.get("cancelled", 0)} in flight and {q.get("cancelledQueued", 0)} queued cancelled by a page change, '
                 f'{q.get("tab_closed", 0)} in flight when the tab closed')
    if s['swapsByStatus']:
        lines.append('Swaps shown by word status: ' + ', '.join(f'{k} {v}' for k, v in _top(s['swapsByStatus'])))
    lines.append(f'Words seen: {s["wordsSeen"]} different')
    if s['topPeeks']:
        lines.append('Most hovered (gloss peeks): ' + ', '.join(f'{w} {n}' for w, n in s['topPeeks']))
    if s['topFlips']:
        lines.append('Most "Show English" flips: ' + ', '.join(f'{w} {n}' for w, n in s['topFlips']))
    lines.append('')
    lines.append(f'Worker starts: {s["workerStarts"]}'
                 + (f' (median idle before a start {_ms(s["workerIdleMedianMs"])})' if s['workerIdleMedianMs'] else '')
                 + f'; popup opens: {s["popupOpens"]}')
    for e in s['installs']:
        lines.append(f'Installed/updated: {e.get("reason")} {e.get("from") or "-"} -> {e.get("to")}')
    for e in s['reloads']:
        lines.append(f'Reloaded for an update: {e.get("from")} -> {e.get("to")}')
    for e in s['settings']:
        lines.append(f'Setting {e.get("_day")}: {e.get("name")}{" " + e["domain"] if e.get("domain") else ""} '
                     f'{e.get("from")} -> {e.get("to")}')
    for e in s['capHits']:
        lines.append(f'Daily cap hit {e.get("_day")}: {e.get("provider")} ({e.get("reason")})')
    if s['hostErrors']:
        lines.append('Host errors: ' + ', '.join(f'{k} {v}' for k, v in s['hostErrors'].items()))
    if s['overflow']:
        lines.append(f'Events lost to a full buffer: {s["overflow"]}')
    return '\n'.join(lines)
