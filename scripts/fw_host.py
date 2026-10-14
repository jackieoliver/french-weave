#!/usr/bin/env python3
"""Chrome native messaging host for the French Weave extension (Python 3.9+, standard library only).

Messages (JSON, 4-byte native-endian length prefix, one per line of conversation):
  {"type": "ping"}                      -> {"ok": true, "host": 1}
  {"type": "state"}                     -> {"ok": true, "version", "stage", "paused", "words": [{fr, en, hint, status}],
                                            "geminiKey"?: stored key if setup saved one}
  {"type": "events", "events": [{"word", "kind": "seen"|"flip", "day"?}]} -> {"ok": true, "applied": n}
"""
import json
from pathlib import Path
import re
import struct
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fwlib  # noqa: E402

MAX_EVENTS = 500
DAY = re.compile(r'^\d{4}-\d{2}-\d{2}$')


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
        with fwlib.editing() as state:
            pass  # applies today's promotion before answering
        reply = dict(fwlib.public_state(state), ok=True)
        key = fwlib.home() / 'gemini_key'
        if key.exists():
            reply['geminiKey'] = key.read_text().strip()
        return reply
    if kind == 'events':
        events = message.get('events')
        if not isinstance(events, list):
            return {'ok': False, 'error': 'events must be a list'}
        applied = 0
        today = fwlib.today()
        with fwlib.editing() as state:
            for event in events[:MAX_EVENTS]:
                if not isinstance(event, dict) or event.get('kind') not in ('seen', 'flip'):
                    continue
                day = event.get('day') if isinstance(event.get('day'), str) and DAY.match(event['day']) else today
                if day > today:
                    day = today
                if isinstance(event.get('word'), str) and fwlib.apply_event(state, event['word'], event['kind'], day):
                    applied += 1
        return {'ok': True, 'applied': applied}
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
