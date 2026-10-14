"""Offline tests for the hook, word state, native host and setup. Run: python3 -m unittest discover -s tests"""
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
os.environ['FRENCH_WEAVE_NO_REFRESH'] = '1'

import fwlib  # noqa: E402
import weave  # noqa: E402
import fw_host  # noqa: E402
import fw  # noqa: E402


def line(text, day='2026-10-09', sidechain=False):
    return json.dumps({'type': 'assistant', 'isSidechain': sidechain, 'timestamp': day + 'T12:00:00',
                       'message': {'content': [{'type': 'text', 'text': text}]}})


def word(fr, status='known'):
    return {'fr': fr, 'en': 'meaning', 'hint': 'hint', 'status': status, 'added': '2026-10-01', 'changed': '',
            'days': [], 'last_bad': ''}


class Home(unittest.TestCase):
    """Each test gets its own state dir."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {'FRENCH_WEAVE_HOME': str(self.home / 'fw')})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()


class Matching(unittest.TestCase):
    def hits(self, fr, text):
        return bool(fwlib.pattern(fr).search(fwlib.norm(text)))

    def test_word_matching(self):
        self.assertTrue(self.hits('le moment', 'wait for le moment'))
        self.assertFalse(self.hits('le moment', 'wait a moment'))
        self.assertTrue(self.hits('le problème', 'the problème is'))
        self.assertTrue(self.hits("l'idée", 'l’idée works'))
        self.assertTrue(self.hits('sans', 'sans the cache'))
        self.assertFalse(self.hits('sans', 'a sans-serif font'))
        self.assertFalse(self.hits('sans', 'sans serif'))
        self.assertTrue(self.hits('non', 'non, it failed'))
        self.assertFalse(self.hits('non', 'a non-zero exit'))
        self.assertTrue(self.hits('où', 'où it runs'))
        self.assertFalse(self.hits('ou', 'où it runs'))
        self.assertFalse(self.hits('dans', 'dansk'))
        self.assertFalse(self.hits('et', 'Drake et al. found'))


class Scan(unittest.TestCase):
    def test_scan_dedupes_and_skips(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chat = root / 'proj' / 'a.jsonl'
            chat.parent.mkdir()
            chat.write_text('\n'.join([
                line('Done, et the build passes.'),
                line('Done, et the build passes.'),  # forked copy: counted once
                line('et inside a subagent', sidechain=True),
                line('Run `git add et` then check https://x.test/et'),
                line('French Weave notes: et, donc'),
                line('Old reply, et it predates install.', day='2026-09-01'),
            ]) + '\n' + line('partial donc'))  # no newline: half-written
            (root / 'proj' / 's' / 'subagents').mkdir(parents=True)
            (root / 'proj' / 's' / 'subagents' / 'b.jsonl').write_text(line('et donc') + '\n')
            index = fwlib.scan(['et', 'donc', 'plus'], {}, root, start='2026-09-19')
            self.assertEqual(index['words']['et'], {'n': 1, 'days': ['2026-10-09']})
            self.assertEqual(index['words']['donc'], {'n': 0, 'days': []})
            self.assertNotIn('plus', index['words'])
            with open(chat, 'a') as file:
                file.write('\n' + line('Et again, et donc.', day='2026-10-11') + '\n')
            index = fwlib.scan(['et', 'donc', 'plus'], index, root, start='2026-09-19')
            self.assertEqual(index['words']['et'], {'n': 2, 'days': ['2026-10-09', '2026-10-11']})
            self.assertEqual(index['words']['donc']['n'], 2)  # the finished partial line and the new one


class Rules(Home):
    def test_new_state_starts_small(self):
        state = fwlib.new_state('2026-10-01')
        active = [w['fr'] for w in state['words'] if w['status'] == 'active']
        self.assertEqual(len(active), fwlib.WINDOW)
        self.assertEqual(active[:3], ['et', 'mais', 'donc'])
        self.assertEqual(fwlib.stage_for(state), 1)
        self.assertGreaterEqual(len(state['words']), 140)

    def test_graduation_from_chat_and_extension_days(self):
        state = fwlib.new_state('2026-10-01')
        chat = {'et': {'n': 5, 'days': ['2026-10-01', '2026-10-02', '2026-10-03']}}
        fwlib.promote(state, '2026-10-03', chat)
        self.assertEqual(fwlib.find(state, 'et')['status'], 'active')  # 3 days
        fwlib.apply_event(state, 'et', 'seen', '2026-10-04')
        fwlib.promote(state, '2026-10-04', chat)
        self.assertEqual(fwlib.find(state, 'et')['status'], 'known')

    def test_flip_resets_and_shaky_recovers(self):
        state = fwlib.new_state('2026-10-01')
        chat = {'mais': {'n': 9, 'days': ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']}}
        fwlib.apply_event(state, 'mais', 'flip', '2026-10-04')
        fwlib.promote(state, '2026-10-05', chat)
        self.assertEqual(fwlib.find(state, 'mais')['status'], 'shaky')
        fwlib.promote(state, '2026-10-11', chat)
        self.assertEqual(fwlib.find(state, 'mais')['status'], 'known')

    def test_refill_cap_and_shaky_block(self):
        state = fwlib.new_state('2026-10-01')
        for fr in ('et', 'mais', 'donc', 'avec'):
            fwlib.apply_event(state, fr, 'known', '2026-10-01')
        fwlib.promote(state, '2026-10-01', {})
        self.assertEqual(sum(w['status'] == 'active' for w in state['words']), fwlib.WINDOW - 1)  # 3 new per day
        fwlib.promote(state, '2026-10-02', {})
        self.assertEqual(sum(w['status'] == 'active' for w in state['words']), fwlib.WINDOW)
        for fr in ('pour', 'sans', 'très', 'aussi', 'maintenant'):
            fwlib.apply_event(state, fr, 'flip', '2026-10-03')
        before = sum(w['status'] != 'queue' for w in state['words'])
        fwlib.promote(state, '2026-10-03', {})
        self.assertEqual(sum(w['status'] != 'queue' for w in state['words']), before)

    def test_stage_auto_and_pinned(self):
        state = fwlib.new_state('2026-10-01')
        for w in state['words'][:40]:
            fwlib.apply_event(state, w['fr'], 'known', '2026-10-01')
        self.assertEqual(fwlib.stage_for(state), 2)
        state['stage'], state['stage_pinned'] = 1, True
        self.assertEqual(fwlib.stage_for(state), 1)

    def test_find_accepts_bare_nouns_and_case(self):
        state = fwlib.new_state('2026-10-01')
        self.assertEqual(fwlib.find(state, 'Problème')['fr'], 'le problème')
        self.assertEqual(fwlib.find(state, 'L’idée')['fr'], "l'idée")
        self.assertIsNone(fwlib.find(state, 'nope'))


class Brief(Home):
    seen = {'et': {'n': 40, 'days': [f'2026-10-0{i}' for i in range(1, 8)]},
            'dans': {'n': 400, 'days': ['2026-10-08', '2026-10-09', '2026-10-10']},
            'pire': {'n': 0, 'days': []}}

    def state(self, stage=2):
        words = [word('et'), word('dans'), word('pire'), word('ensemble', 'active'), word('malgré', 'shaky'), word('quoi', 'queue')]
        return {'stage': stage, 'stage_pinned': True, 'paused': False, 'words': words}

    def test_tiers(self):
        self.assertEqual(weave.tier(word('et'), self.seen), 'lot')
        self.assertEqual(weave.tier(word('dans'), self.seen), 'some')
        self.assertEqual(weave.tier(word('pire'), self.seen), 'rare')
        self.assertEqual(weave.tier(word('plus'), self.seen), 'some')
        self.assertEqual(weave.tier(word('ensemble', 'active'), self.seen), 'learn')

    def test_brief_text(self):
        lines = weave.brief(self.state(), self.seen).split('\n')
        self.assertIn('about 12%', lines[0])
        self.assertIn('never over 20%', lines[0])
        self.assertIn('at most 4 in one sentence', lines[0])
        self.assertIn('Never a French sentence', lines[0])
        self.assertIn('never in files, code', lines[0])
        self.assertTrue(lines[1].endswith(': malgré = meaning, "hint"; ensemble = meaning, "hint"'))
        self.assertTrue(lines[2].endswith(': pire') and lines[3].endswith(': dans') and lines[4].endswith(': meaning → et'))
        self.assertNotIn('quoi', '\n'.join(lines))  # queued words are not in use yet
        three = weave.brief(self.state(3), self.seen)
        self.assertIn('about 25%', three)
        self.assertNotIn('"hint"', three)
        self.assertIn('about 40%', weave.brief(self.state(4), self.seen))

    def test_recall_every_third_turn_shaky_first(self):
        state = self.state()
        picks = [weave.next_recall(state, 's1') for _ in range(7)]
        self.assertEqual([p and p['fr'] for p in picks], ['malgré', None, None, 'ensemble', None, None, None])
        self.assertIsNone(weave.next_recall(state, None))
        self.assertIn('Recall: malgré?', weave.brief(state, {}, picks[0]))

    def test_calibration(self):
        words = [word('et'), word('donc'), word('mais'), word('simple', 'active'), word('le chien', 'active'), word('plus')]
        state = {'stage': 2, 'stage_pinned': True, 'words': words}
        english = 'The build passes and the cache is warm, so nothing else needs doing before the release goes out today. ' * 3
        self.assertEqual(weave.share(english, words), (0, 57, 0, 0))
        woven = 'The build passes, et the cache is warm, donc nothing else needs le chien, mais plus simple things wait. ' * 3
        self.assertEqual(weave.share(woven + '```et donc mais```\n(le chien = the dog, "luh shyan")\nRecall: et?', words), (15, 57, 3, 0))
        self.assertIn('under the 12% target', weave.calibration(english, state))
        self.assertIn('over the 20% cap', weave.calibration(woven, state))
        self.assertEqual(weave.calibration('Done, et pushed.', state), '')
        french = ("J'ai ajouté une section à README.md. Elle dit qu'un export vide supprime les lignes, mais la table reste, "
                  "et je n'ai rien exécuté. Les autres problèmes sont dans sync.py, donc dis-moi si je dois les corriger. ") * 2
        self.assertIn('slipped into French sentences', weave.calibration(french, state))

    def test_last_reply(self):
        log = self.home / 'chat.jsonl'
        log.write_text('\n'.join([line('old reply, et more'), line('sub', sidechain=True),
                                  json.dumps({'type': 'user', 'message': {'content': 'next'}}),
                                  line('latest reply, donc done'), line('sub2', sidechain=True)]) + '\n')
        self.assertEqual(weave.last_reply(log), 'latest reply, donc done')
        with mock.patch.object(weave, 'TAIL', len(log.read_bytes()) // 2):
            self.assertEqual(weave.last_reply(log), 'latest reply, donc done')

    def run_hook(self, payload):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'weave.py'), '--hook'], input=json.dumps(payload),
                                capture_output=True, text=True, timeout=30, env=dict(os.environ))
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_hook_output_and_pause(self):
        out = json.loads(self.run_hook({'session_id': 'x', 'transcript_path': str(self.home / 'missing.jsonl')}))
        context = out['hookSpecificOutput']['additionalContext']
        self.assertEqual(out['hookSpecificOutput']['hookEventName'], 'UserPromptSubmit')
        self.assertIn('French Weave (Stage 1)', context)
        self.assertIn('Recall: et?', context)
        self.assertLess(len(context), 3000)
        fw.main(['pause'])
        self.assertEqual(self.run_hook({'session_id': 'x'}), '')
        fw.main(['resume'])
        self.assertIn('French Weave', self.run_hook({}))


class Host(Home):
    def converse(self, *messages):
        raw = b''.join(struct.pack('=I', len(m)) + m for m in (json.dumps(x).encode() for x in messages))
        result = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'fw_host.py')], input=raw, capture_output=True,
                                timeout=30, env=dict(os.environ))
        out, replies = result.stdout, []
        while out:
            size = struct.unpack('=I', out[:4])[0]
            replies.append(json.loads(out[4:4 + size]))
            out = out[4 + size:]
        return replies

    def test_protocol(self):
        ping, state, events, after, bad = self.converse(
            {'type': 'ping'}, {'type': 'state'},
            {'type': 'events', 'events': [{'word': 'Mais', 'kind': 'flip'}, {'word': 'et', 'kind': 'seen'},
                                          {'word': 'zzz', 'kind': 'seen'}, {'word': 'et', 'kind': 'typed'}]},
            {'type': 'state'}, {'type': 'nope'})
        self.assertEqual(ping, {'ok': True, 'host': 1})
        self.assertEqual(state['stage'], 1)
        self.assertEqual(len(state['words']), fwlib.WINDOW)
        self.assertNotIn('geminiKey', state)
        self.assertEqual(events, {'ok': True, 'applied': 2})
        self.assertEqual(after['words'][0], {'fr': 'mais', 'en': 'but', 'hint': 'meh', 'status': 'shaky'})
        self.assertNotEqual(after['version'], state['version'])
        self.assertFalse(bad['ok'])

    def test_message_framing(self):
        stream = io.BytesIO()
        fw_host.write_message(stream, {'a': 'é'})
        stream.seek(0)
        self.assertEqual(fw_host.read_message(stream), {'a': 'é'})
        self.assertIsNone(fw_host.read_message(io.BytesIO(b'')))


class Setup(Home):
    def test_setup_installs_extension_host_and_key(self):
        key = self.home / 'key.txt'
        key.write_text('  AIzaTEST \n')
        with mock.patch.object(Path, 'home', return_value=self.home), \
                mock.patch.dict(os.environ, {'XDG_CONFIG_HOME': ''}), mock.patch('sys.stdout', new=io.StringIO()) as out:
            fw.main(['setup', '--dry-run', '--gemini-key-file', str(key)])
            self.assertFalse((self.home / 'fw').exists())
            fw.main(['setup', '--gemini-key-file', str(key)])
        home = self.home / 'fw'
        self.assertIn('Load unpacked', out.getvalue())
        self.assertTrue((home / 'extension' / 'manifest.json').exists())
        self.assertFalse((home / 'extension' / 'test').exists())
        self.assertEqual((home / 'gemini_key').read_text().strip(), 'AIzaTEST')
        self.assertEqual(oct((home / 'gemini_key').stat().st_mode & 0o777), '0o600')
        base = self.home / ('Library/Application Support/Google/Chrome' if sys.platform == 'darwin' else '.config/google-chrome')
        manifest = json.loads((base / 'NativeMessagingHosts' / f'{fw.HOST_NAME}.json').read_text())
        self.assertEqual(manifest['allowed_origins'], [f'chrome-extension://{fw.EXTENSION_ID}/'])
        launcher = Path(manifest['path'])
        self.assertTrue(os.access(launcher, os.X_OK))
        # The installed copy answers on its own, without the plugin folder.
        msg = json.dumps({'type': 'state'}).encode()
        result = subprocess.run([str(launcher)], input=struct.pack('=I', len(msg)) + msg, capture_output=True, timeout=30,
                                env=dict(os.environ))
        reply = json.loads(result.stdout[4:])
        self.assertTrue(reply['ok'])
        self.assertEqual(reply['geminiKey'], 'AIzaTEST')

    def test_extension_id_matches_manifest_key(self):
        import base64
        import hashlib
        key = json.loads((ROOT / 'extension' / 'manifest.json').read_text())['key']
        digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
        self.assertEqual(''.join(chr(ord('a') + int(c, 16)) for c in digest), fw.EXTENSION_ID)


if __name__ == '__main__':
    unittest.main()
