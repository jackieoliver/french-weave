"""The dev build's local usage log: the native host's append and prune, what may be stored, and `fw.py usage`.

Run: python3 -m pytest -q tests/test_usage.py
"""
import contextlib
import datetime as dt
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
os.environ['FRENCH_WEAVE_NO_REFRESH'] = '1'

import fw  # noqa: E402
import fw_host  # noqa: E402
import fwusage  # noqa: E402

# Key-shaped values built at run time, so no literal key sits in this file.
FAKE_KEY = ''.join(['AIza', 'SyD', '-not-a-real-key-', 'x' * 12])


def ms(day, hour=12, minute=0):
    return int(dt.datetime.fromisoformat(f'{day}T{hour:02d}:{minute:02d}:00').timestamp() * 1000)


def fixture(today):
    """Two days of a reader's usage: page views, batches through Haiku and Gemini with a fallback, failures,
    queue events, words, popup opens, a setting change and worker starts."""
    yday = (dt.date.fromisoformat(today) - dt.timedelta(days=1)).isoformat()
    events = [
        {'k': 'worker_start', 'at': ms(yday, 9), 'v': '0.2.11'},
        {'k': 'worker_start', 'at': ms(today, 9), 'idleMs': 3600000, 'prevAliveAt': ms(today, 8)},
        {'k': 'page', 'at': ms(yday, 9, 1), 'domain': 'x.com', 'on': True, 'level': 2, 'tier': 'gemini'},
        {'k': 'page', 'at': ms(today, 9, 1), 'domain': 'x.com', 'on': True, 'level': 2, 'tier': 'gemini'},
        {'k': 'page', 'at': ms(today, 21, 5), 'domain': 'mail.google.com', 'on': False, 'why': 'site_off'},
        {'k': 'batch', 'at': ms(yday, 9, 2), 'domain': 'x.com', 'passages': 4, 'cached': 0, 'outcome': 'ok', 'provider': 'anthropic',
         'model': 'claude-haiku-5-5', 'ms': 6000, 'modelMs': 5600, 'usd': 0.0017, 'tokensIn': 1200, 'tokensOut': 90, 'swaps': 5,
         'byStatus': {'active': 3, 'known': 2}, 'spent': {'anthropic': 0.0017}},
        {'k': 'batch', 'at': ms(today, 9, 2), 'domain': 'x.com', 'passages': 8, 'cached': 2, 'outcome': 'ok', 'provider': 'anthropic',
         'model': 'claude-haiku-5-5', 'ms': 12000, 'usd': 0.002, 'swaps': 6, 'byStatus': {'active': 4, 'shaky': 2},
         'spent': {'anthropic': 0.002}},
        {'k': 'batch', 'at': ms(today, 9, 3), 'domain': 'x.com', 'passages': 4, 'cached': 0, 'outcome': 'ok', 'provider': 'gemini',
         'model': 'gemini-3.1-flash-lite', 'ms': 21000, 'swaps': 2,
         'fallbacks': [{'provider': 'anthropic', 'model': 'claude-haiku-5-5', 'kind': 'timeout'}], 'spent': {'anthropic': 0.003}},
        {'k': 'batch', 'at': ms(today, 9, 4), 'domain': 'x.com', 'passages': 6, 'cached': 6, 'outcome': 'cached', 'swaps': 4},
        {'k': 'batch', 'at': ms(today, 9, 5), 'domain': 'x.com', 'passages': 2, 'cached': 0, 'outcome': '429', 'retryAfterMs': 60000,
         'fallbacks': [{'provider': 'gemini', 'model': 'gemini-3.1-flash-lite', 'kind': '429'}]},
        {'k': 'batch', 'at': ms(today, 9, 6), 'domain': 'x.com', 'passages': 1, 'outcome': 'stale'},
        {'k': 'queue', 'at': ms(today, 9, 6), 'domain': 'x.com', 'what': 'retry', 'n': 1, 'attempt': 1, 'reason': 'rate_limit'},
        {'k': 'queue', 'at': ms(today, 9, 7), 'domain': 'x.com', 'what': 'gave_up', 'n': 1, 'reason': 'busy'},
        {'k': 'queue', 'at': ms(today, 9, 7), 'domain': 'x.com', 'what': 'unmounted', 'n': 3},
        {'k': 'queue', 'at': ms(today, 9, 8), 'domain': 'x.com', 'what': 'cancelled', 'n': 2, 'pending': 5, 'reason': 'page_changed'},
        {'k': 'queue', 'at': ms(today, 9, 9), 'domain': 'x.com', 'what': 'tab_closed', 'n': 4},
        {'k': 'word', 'at': ms(today, 9, 10), 'what': 'seen', 'word': 'et', 'status': 'active'},
        {'k': 'word', 'at': ms(today, 9, 10), 'what': 'seen', 'word': 'très', 'status': 'shaky'},
        {'k': 'word', 'at': ms(today, 9, 11), 'what': 'peek', 'word': 'très', 'status': 'shaky'},
        {'k': 'word', 'at': ms(yday, 9, 11), 'what': 'peek', 'word': 'très', 'status': 'shaky'},
        {'k': 'word', 'at': ms(today, 9, 12), 'what': 'flip', 'word': 'mais', 'status': 'active'},
        {'k': 'popup', 'at': ms(today, 9, 13)},
        {'k': 'setting', 'at': ms(today, 9, 14), 'name': 'levelOverride', 'from': 0, 'to': 2},
        {'k': 'cap_hit', 'at': ms(today, 9, 15), 'provider': 'gemini', 'reason': 'local'},
        {'k': 'installed', 'at': ms(yday, 8), 'reason': 'update', 'from': '0.2.9', 'to': '0.2.11'},
        {'k': 'host_error', 'at': ms(today, 9, 16), 'where': 'state', 'error': 'disk full'},
    ]
    return events


class UsageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / 'fw'
        self.env = mock.patch.dict(os.environ, {'FRENCH_WEAVE_HOME': str(self.home)})
        self.env.start()
        self.today = dt.date.today().isoformat()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def dev(self, on=True):
        (self.home / 'app').mkdir(parents=True, exist_ok=True)
        channel = self.home / 'app' / 'CHANNEL'
        if on:
            channel.write_text('dev\n')
        else:
            channel.unlink(missing_ok=True)

    def lines(self, day=None):
        path = self.home / 'usage' / f'{day or self.today}.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_host_appends_only_for_the_dev_build(self):
        event = {'k': 'popup', 'at': ms(self.today, 10)}
        self.dev(False)
        self.assertEqual(fw_host.handle({'type': 'usage', 'events': [event]}), {'ok': True, 'appended': 0, 'off': True})
        self.assertFalse((self.home / 'usage').exists())
        self.dev()
        reply = fw_host.handle({'type': 'usage', 'events': [event, {'k': 'nonsense', 'at': 1}, 'junk'], 'today': True})
        self.assertEqual(reply['appended'], 1)
        self.assertEqual(reply['today'], {'batches': 0, 'passages': 0, 'cached': 0, 'p90Ms': None, 'usd': 0})
        self.assertEqual(self.lines(), [event])
        self.assertEqual(fw_host.handle({'type': 'usage', 'events': 'x'})['ok'], False)

    def test_events_go_to_their_own_day_and_old_files_are_pruned(self):
        self.dev()
        directory = self.home / 'usage'
        directory.mkdir(parents=True)
        today = dt.date.fromisoformat(self.today)
        old = (today - dt.timedelta(days=60)).isoformat()   # day 61 back counting today: deleted
        kept = (today - dt.timedelta(days=59)).isoformat()  # day 60: kept
        for day in (old, kept):
            (directory / f'{day}.jsonl').write_text('{"at": 1, "k": "popup"}\n')
        (directory / 'notes.txt').write_text('not a day file')
        yday = (today - dt.timedelta(days=1)).isoformat()
        fw_host.handle({'type': 'usage', 'events': [{'k': 'popup', 'at': ms(yday, 23, 59)}, {'k': 'popup', 'at': ms(self.today, 0, 1)}]})
        self.assertFalse((directory / f'{old}.jsonl').exists())
        self.assertTrue((directory / f'{kept}.jsonl').exists())
        self.assertTrue((directory / 'notes.txt').exists())
        self.assertEqual(len(self.lines(yday)), 1)
        self.assertEqual(len(self.lines()), 1)

    def test_no_url_path_page_text_or_key_is_stored(self):
        """A second check after the extension's own: paths, queries, long text and key-shaped values are dropped."""
        self.dev()
        url = 'https://www.example.com/account/inbox?q=my+private+search#frag'
        event = {'k': 'page', 'at': ms(self.today, 10), 'domain': url, 'on': True, 'url': url, 'text': 'x' * 200,
                 'title': 'Inbox?private', 'key': FAKE_KEY, 'error': f'failed with {FAKE_KEY}',
                 'nested': {'deep': {'deeper': {'deepest': 1}}}, 'level': 2}
        fw_host.handle({'type': 'usage', 'events': [event, dict(event, domain='www.example.com')]})
        stored = self.lines()
        raw = json.dumps(stored)
        for leak in ('account', 'inbox', 'private', 'frag', 'AIza', 'xxxxxxxxxx', '://'):
            self.assertNotIn(leak, raw)
        self.assertNotIn('domain', stored[0])
        self.assertEqual(stored[1]['domain'], 'www.example.com')
        self.assertEqual(stored[1]['level'], 2)

    def write_fixture(self):
        self.dev()
        events = fixture(self.today)
        self.assertEqual(fwusage.append(events), len(events))

    def test_summary_on_a_fixture(self):
        self.write_fixture()
        s = fwusage.summarize(fwusage.load(7), 7)
        self.assertEqual(len(s['activeDays']), 2)
        self.assertEqual(s['batches'], 6)
        self.assertEqual(s['passages'], 25)
        self.assertEqual(s['cached'], 8)
        self.assertEqual(s['cacheHitRate'], 0.32)
        self.assertEqual(s['latency']['anthropic/claude-haiku-5-5'], {'n': 2, 'medianMs': 9000, 'p90Ms': 12000})
        self.assertEqual(s['latency']['gemini/gemini-3.1-flash-lite']['p90Ms'], 21000)
        self.assertEqual(s['outcomes'], {'ok': 3, '429': 1, 'cached': 1, 'stale': 1})
        self.assertEqual(s['fallbacks']['byKind'], {'429': 1, 'timeout': 1})
        self.assertEqual(s['queue'], {'retry': 1, 'gave_up': 1, 'unmounted': 3, 'cancelled': 2, 'cancelledQueued': 5, 'tab_closed': 4})
        self.assertEqual(s['spend'][self.today], {'anthropic': 0.003})
        self.assertEqual(s['topPeeks'], [('très', 2)])
        self.assertEqual(s['topFlips'], [('mais', 1)])
        self.assertEqual(s['wordsSeen'], 2)
        self.assertEqual(s['workerStarts'], 2)
        self.assertEqual(s['topDomains'][0][0], 'x.com')
        self.assertEqual(s['pagesOff'], {'site_off': 1})
        self.assertEqual(s['swapsByStatus'], {'active': 7, 'known': 2, 'shaky': 2})
        self.assertEqual(s['capHits'][0]['provider'], 'gemini')
        # One day back only: yesterday's batch is left out.
        self.assertEqual(fwusage.summarize(fwusage.load(1), 1)['batches'], 5)
        self.assertEqual(fwusage.today_numbers(), {'batches': 5, 'passages': 21, 'cached': 8, 'p90Ms': 21000, 'usd': 0.003})

    def test_fw_usage_command(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fw.main(['usage'])
        self.assertIn('No usage recorded', out.getvalue())
        self.write_fixture()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fw.main(['usage', '--days', '7'])
        text = out.getvalue()
        for part in ('Batches: 6 (25 passages, cache hit rate 32%)', 'anthropic/claude-haiku-5-5: n=2, median 9.0 s, p90 12.0 s',
                     'Most hovered (gloss peeks): très 2', 'Worker starts: 2', 'x.com', '3 left the page while queued'):
            self.assertIn(part, text)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fw.main(['usage', '--json'])
        self.assertEqual(json.loads(out.getvalue())['batches'], 6)


if __name__ == '__main__':
    unittest.main()
