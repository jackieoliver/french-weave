#!/usr/bin/env python3
"""Chrome native messaging host for the French Weave extension (Python 3.9+, standard library only).

Messages (JSON, 4-byte native-endian length prefix, one per line of conversation):
  {"type": "ping"}                      -> {"ok": true, "host": 1}
  {"type": "state", "extension"?: "0.2.9"}
                                        -> {"ok": true, "version", "stage", "paused", "language", "words": [{fr, en, hint, reading?, status}],
                                            "prefs": {"extension_sites"?: "all" | "ask"} (absent means "all"),
                                            "geminiKey"?, "geminiBackupKey"?, "openRouterKey"?, "anthropicKey"?: keys setup stored,
                                            "channel"?: "dev" when the plugin came from the french-weave-dev marketplace}
  {"type": "events", "events": [{"word", "kind": "seen"|"flip"|"peek", "day"?}]} -> {"ok": true, "applied": n}
  {"type": "usage", "events": [{"at", "k", ...}], "today"?: true}
                                        -> {"ok": true, "appended": n, "today"?: {batches, passages, cached, p90Ms, usd}}
                                           dev build only (app/CHANNEL "dev"); otherwise {"ok": true, "appended": 0,
                                           "off": true} and nothing is written (fwusage.py, extension/src/usage.js)

"extension" (0.2.9 on) is the version Chrome is running; it is recorded in <state dir>/extension-seen.json as
{"version", "at"} for `fw.py check`. Extensions before 0.2.9 leave it out, and hosts before 0.2.9 ignore it.
"""
import json
from pathlib import Path
import re
import struct
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fwlib  # noqa: E402
import fwusage  # noqa: E402

MAX_EVENTS = 500
DAY = re.compile(r'^\d{4}-\d{2}-\d{2}$')
VERSION = re.compile(r'^[0-9][0-9A-Za-z.+-]{0,39}$')


def read_message(stream):
    header = stream.read(4)
    if len(header) < 4:
        return None
    size = struct.unpack('=I', header)[0]
    if size > 1024 * 1024:
        raise ValueError('message too large')
    return json.loads(stream.read(size).decode('utf-8'))


def write_message(stream, message):
    data = json.dumps(message, ensure_ascii=False).encode('utf-8')
    stream.write(struct.pack('=I', len(data)))
    stream.write(data)
    stream.flush()


def handle(message):
    kind = message.get('type') if isinstance(message, dict) else None
    if kind == 'ping':
        return {'ok': True, 'host': 1}
    if kind == 'state':
        if isinstance(message.get('extension'), str) and VERSION.match(message['extension']):
            fwlib.record_extension_seen(message['extension'])
        with fwlib.editing() as state:
            pass  # applies today's promotion before answering
        reply = dict(fwlib.public_state(state), ok=True, prefs=state.get('prefs') or {})
        if fwlib.installed_channel():
            reply['channel'] = fwlib.installed_channel()
        for name, field in (('gemini_key', 'geminiKey'), ('gemini_backup_key', 'geminiBackupKey'),
                            ('openrouter_key', 'openRouterKey'), ('anthropic_key', 'anthropicKey')):
            key = fwlib.home() / name
            if key.exists():
                reply[field] = key.read_text().strip()
        return reply
    if kind == 'events':
        events = message.get('events')
        if not isinstance(events, list):
            return {'ok': False, 'error': 'events must be a list'}
        applied = 0
        today = fwlib.today()
        with fwlib.editing() as state:
            for event in events[:MAX_EVENTS]:
                if not isinstance(event, dict) or event.get('kind') not in ('seen', 'flip', 'peek'):
                    continue
                day = event.get('day') if isinstance(event.get('day'), str) and DAY.match(event['day']) else today
                if day > today:
                    day = today
                if isinstance(event.get('word'), str) and fwlib.apply_event(state, event['word'], event['kind'], day):
                    applied += 1
        return {'ok': True, 'applied': applied}
    if kind == 'usage':
        if fwlib.installed_channel() != 'dev':
            return {'ok': True, 'appended': 0, 'off': True}
        events = message.get('events')
        if not isinstance(events, list):
            return {'ok': False, 'error': 'events must be a list'}
        reply = {'ok': True, 'appended': fwusage.append(events)}
        if message.get('today') is True:
            reply['today'] = fwusage.today_numbers()
        return reply
    return {'ok': False, 'error': 'unknown message type'}


def main():
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    while True:
        try:
            message = read_message(stdin)
        except ValueError as error:
            write_message(stdout, {'ok': False, 'error': str(error)})
            return
        if message is None:
            return
        try:
            reply = handle(message)
        except Exception as error:  # report, don't crash Chrome's port
            reply = {'ok': False, 'error': f'{error.__class__.__name__}: {error}'}
        write_message(stdout, reply)


if __name__ == '__main__':
    main()
