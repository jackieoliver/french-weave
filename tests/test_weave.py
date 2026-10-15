"""Offline tests for the hook, word state, native host and setup. Run: python3 -m unittest discover -s tests"""
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
os.environ['FRENCH_WEAVE_NO_REFRESH'] = '1'
for name in ('CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'FRENCH_WEAVE_FORCE', 'FRENCH_WEAVE_OFF'):
    os.environ.pop(name, None)  # tests set these explicitly

import fwlib  # noqa: E402
import weave  # noqa: E402
import fw_host  # noqa: E402
import fw  # noqa: E402
import export  # noqa: E402


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


class Copies(Home):
    def test_refresh_only_after_setup_and_only_when_stale(self):
        self.assertEqual(fwlib.refresh_copies(), '')  # setup never ran: nothing to refresh
        fwlib.install_copies()
        app = fwlib.home() / 'app'
        version = fwlib.plugin_version()
        self.assertTrue(version)
        self.assertEqual((app / 'VERSION').read_text().strip(), version)
        self.assertTrue((fwlib.home() / 'extension' / 'manifest.json').exists())
        self.assertEqual(fwlib.refresh_copies(), '')  # current
        (app / 'VERSION').unlink()  # copies made before versions were recorded
        (fwlib.home() / 'extension' / 'stale.js').write_text('old')
        self.assertEqual(fwlib.refresh_copies(), version)
        self.assertFalse((fwlib.home() / 'extension' / 'stale.js').exists())
        self.assertEqual((app / 'VERSION').read_text().strip(), version)
        self.assertEqual(sorted(p.name for p in fwlib.home().iterdir() if p.name.endswith(('.new', '.old'))), [])


class Corrupt(Home):
    def test_unreadable_state_is_kept_aside_and_replaced(self):
        fwlib.home().mkdir(parents=True, exist_ok=True)
        for bad in ('{"words": [', '[]'):
            (fwlib.home() / 'state.json').write_text(bad)
            state = fwlib.load_state()
            self.assertIsInstance(state.get('words'), list)
            self.assertTrue(any(p.name.startswith('state.json.bad-') for p in fwlib.home().iterdir()))
            time.sleep(1.1)  # distinct backup names


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
    def test_lexicon_is_well_formed(self):
        words = fwlib.load_lexicon()
        self.assertEqual(len({fwlib.key(w['fr']) for w in words}), len(words))
        for w in words:
            self.assertTrue(w['en'] and w['hint'] and w['hint'] == w['hint'].lower(), w)

    def test_new_state_starts_small(self):
        state = fwlib.new_state('2026-10-01')
        active = [w['fr'] for w in state['words'] if w['status'] == 'active']
        self.assertEqual(active, ['et', 'mais', 'donc', 'avec', 'sans'])  # 5 new a day
        self.assertEqual(fwlib.stage_for(state), 1)
        for day in ('2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'):
            fwlib.promote(state, day, {})
        self.assertEqual(sum(w['status'] == 'active' for w in state['words']), fwlib.WINDOW)  # full at 20

    def test_graduation_needs_three_clean_days(self):
        state = fwlib.new_state('2026-10-01')
        chat = {'et': {'n': 5, 'days': ['2026-10-01', '2026-10-02']}}
        fwlib.promote(state, '2026-10-02', chat)
        self.assertEqual(fwlib.find(state, 'et')['status'], 'active')  # 2 days
        fwlib.apply_event(state, 'et', 'seen', '2026-10-03')  # extension day + chat days
        fwlib.promote(state, '2026-10-03', chat)
        self.assertEqual(fwlib.find(state, 'et')['status'], 'known')

    def test_peek_blocks_graduation_and_assumed_alone_never_graduates(self):
        state = fwlib.new_state('2026-10-01')
        chat = {'mais': {'n': 3, 'days': ['2026-10-01', '2026-10-02', '2026-10-03']}}
        fwlib.apply_event(state, 'mais', 'peek', '2026-10-02')
        fwlib.promote(state, '2026-10-03', chat)
        self.assertEqual(fwlib.find(state, 'mais')['status'], 'active')  # peek inside the last 3 days
        chat['mais']['days'] += ['2026-10-04', '2026-10-05']
        fwlib.promote(state, '2026-10-05', chat)
        self.assertEqual(fwlib.find(state, 'mais')['status'], 'known')  # last 3 days (03-05) are peek-free
        for day in ('2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'):
            fwlib.apply_event(state, 'donc', 'assumed', day)
        fwlib.promote(state, '2026-10-04', {})
        self.assertEqual(fwlib.find(state, 'donc')['status'], 'active')  # 4 assumed days, never seen
        fwlib.apply_event(state, 'donc', 'seen', '2026-10-05')
        fwlib.promote(state, '2026-10-05', {})
        self.assertEqual(fwlib.find(state, 'donc')['status'], 'known')

    def test_flip_makes_shaky_and_recovers_after_7_clean_days(self):
        state = fwlib.new_state('2026-10-01')
        fwlib.apply_event(state, 'avec', 'flip', '2026-10-04')
        fwlib.promote(state, '2026-10-10', {})
        self.assertEqual(fwlib.find(state, 'avec')['status'], 'shaky')
        fwlib.apply_event(state, 'avec', 'peek', '2026-10-09')  # restarts the clock
        fwlib.promote(state, '2026-10-15', {})
        self.assertEqual(fwlib.find(state, 'avec')['status'], 'shaky')
        fwlib.promote(state, '2026-10-16', {})
        self.assertEqual(fwlib.find(state, 'avec')['status'], 'known')

    def test_known_word_peeked_twice_in_a_week_becomes_shaky(self):
        state = fwlib.new_state('2026-10-01')
        fwlib.apply_event(state, 'sans', 'known', '2026-10-01')
        fwlib.apply_event(state, 'sans', 'peek', '2026-10-02')
        self.assertEqual(fwlib.find(state, 'sans')['status'], 'known')
        fwlib.apply_event(state, 'sans', 'peek', '2026-10-02')  # same day: once
        self.assertEqual(fwlib.find(state, 'sans')['status'], 'known')
        fwlib.apply_event(state, 'sans', 'peek', '2026-10-08')
        self.assertEqual(fwlib.find(state, 'sans')['status'], 'shaky')

    def test_refill_cap_and_shaky_block(self):
        state = fwlib.new_state('2026-10-01')
        for day in ('2026-10-02', '2026-10-03', '2026-10-04'):
            fwlib.promote(state, day, {})
        for fr in ('et', 'mais', 'donc', 'avec', 'sans', 'très'):
            fwlib.apply_event(state, fr, 'known', '2026-10-05')
        fwlib.promote(state, '2026-10-05', {})
        self.assertEqual(sum(w['status'] == 'active' for w in state['words']), fwlib.WINDOW - 1)  # 20-6+5
        for fr in ('aussi', 'maintenant', 'pour', 'parce que', 'toujours'):
            fwlib.apply_event(state, fr, 'flip', '2026-10-06')
        before = sum(w['status'] != 'queue' for w in state['words'])
        fwlib.promote(state, '2026-10-06', {})
        self.assertEqual(sum(w['status'] != 'queue' for w in state['words']), before)  # 5 shaky: no new words

    def test_stage_auto_and_pinned(self):
        state = fwlib.new_state('2026-10-01')
        stages = []
        for i, w in enumerate(state['words'][:400], 1):
            fwlib.apply_event(state, w['fr'], 'known', '2026-10-01')
            if i in (39, 40, 149, 150, 399, 400):
                stages.append(fwlib.stage_for(state))
        self.assertEqual(stages, [1, 2, 2, 3, 3, 4])
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
        overlap = [word('faire'), word('faire attention'), word('tout'), word('tout le monde')]
        self.assertEqual(weave.share('Please faire attention, tout le monde, then faire it. ' * 6, overlap)[0], 36)  # 2 + 3 + 1 per sentence, not 8

    def test_last_reply(self):
        log = self.home / 'chat.jsonl'
        log.write_text('\n'.join([line('old reply, et more'), line('sub', sidechain=True),
                                  json.dumps({'type': 'user', 'message': {'content': 'next'}}),
                                  line('latest reply, donc done'), line('sub2', sidechain=True)]) + '\n')
        self.assertEqual(weave.last_reply(log), 'latest reply, donc done')
        with mock.patch.object(weave, 'TAIL', len(log.read_bytes()) // 2):
            self.assertEqual(weave.last_reply(log), 'latest reply, donc done')

    def run_hook(self, payload, **env):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'weave.py'), '--hook'], input=json.dumps(payload),
                                capture_output=True, text=True, timeout=30, env=dict(os.environ, **env))
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

    def test_no_french_in_scripted_runs(self):
        self.assertIn('French Weave', self.run_hook({}))  # no claude parent here: weave by default
        self.assertEqual(self.run_hook({}, FRENCH_WEAVE_OFF='1'), '')
        self.assertEqual(self.run_hook({}, CLAUDE_CODE_ENTRYPOINT='sdk-py'), '')
        self.assertIn('French Weave', self.run_hook({}, CLAUDE_CODE_ENTRYPOINT='sdk-cli', CLAUDE_CODE_SESSION_ATTENDED='0'))
        one_shot = ['claude', '-p', '--model', 'haiku', 'Reply OK']
        remote = ['claude', '--print', '--sdk-url', 'https://example.invalid/v1/code/sessions/x', '--session-id', 'x',
                  '--input-format', 'stream-json', '--output-format', 'stream-json']
        self.assertTrue(weave.one_shot(one_shot))
        self.assertTrue(weave.is_claude(['/home/u/.local/share/claude/versions/2.1.296', '--print']))
        self.assertTrue(weave.is_claude(['claude', '-p']) and not weave.is_claude(['/bin/sh', '-c', 'x']))
        self.assertTrue(weave.one_shot(['claude', '--print', '--output-format', 'json', 'x']))
        self.assertFalse(weave.one_shot(remote))
        self.assertFalse(weave.one_shot(['claude', '--print', '--input-format=stream-json']))
        self.assertFalse(weave.one_shot(['claude', '--model', 'opus']))
        self.assertFalse(weave.interactive({}, args_check=lambda: one_shot))
        self.assertTrue(weave.interactive({}, args_check=lambda: remote))
        self.assertTrue(weave.interactive({'CLAUDE_CODE_ENTRYPOINT': 'sdk-cli'}, args_check=lambda: remote))
        self.assertTrue(weave.interactive({'FRENCH_WEAVE_FORCE': '1'}, args_check=lambda: one_shot))
        self.assertFalse(weave.interactive({'CLAUDE_CODE_ENTRYPOINT': 'sdk-ts'}, args_check=lambda: []))


def grown(known, seed=1):
    """A state with about `known` known words, mostly in rank order, a few gaps and a few beyond."""
    import random
    rng = random.Random(seed)
    state = fwlib.new_state('2026-01-01')
    words = state['words']
    chosen = set(range(known))
    for i in rng.sample(sorted(chosen), known // 20):
        chosen.discard(i)
    chosen.update(range(known, min(len(words), known + known // 20)))
    for i in chosen:
        fwlib.apply_event(state, words[i]['fr'], 'known', '2026-01-01')
    for day in range(2, 7):
        fwlib.promote(state, f'2026-01-0{day}', {})
    return state


class Scale(Home):
    def test_known_band(self):
        state = grown(400)
        n, missing, extra = fwlib.known_band(state)
        known = {w['fr'] for w in state['words'] if w['status'] == 'known'}
        band = {w['fr'] for w in state['words'][:n]}
        self.assertEqual(known, (band - set(missing) - {w['fr'] for w in state['words'][:n] if w['status'] in ('active', 'shaky')}) | set(extra))

    def test_brief_and_exports_stay_small(self):
        for known in (50, 400, 1000):
            state = grown(known)
            brief = weave.brief(state, {}, {'fr': 'et', 'en': 'and', 'hint': 'ay'})
            about, respond = export.chatgpt(state)
            self.assertLessEqual(len(about), export.CHATGPT_LIMIT)
            self.assertLessEqual(len(respond), export.CHATGPT_LIMIT)
            self.assertLess(len(export.claude_ai(state)), 6000)
            if known >= 400:
                self.assertIn('most common French words', brief)
                self.assertLess(len(brief.encode()), 3100, known)

    def test_state_line_round_trips(self):
        for known in (30, 400):
            state = grown(known)
            line = export.state_line(state, now=0)
            parsed = export.parse_state_line(line)
            self.assertEqual(parsed['stage'], fwlib.stage_for(state))
            self.assertEqual(parsed['synced'], '1970-01-01T00:00Z')
            active = sorted((w for w in state['words'] if w['status'] == 'active'), key=lambda w: w['added'])
            self.assertEqual(parsed['active'], [(w['fr'], w['en'], w['hint']) for w in active])
            shaky = [w for w in state['words'] if w['status'] == 'shaky']
            self.assertEqual(len(parsed['shaky']), len(shaky))
            if known < export.KNOWN_LIST_MAX:
                self.assertEqual(parsed['known'], [w['fr'] for w in state['words'] if w['status'] == 'known'])
            else:
                n = fwlib.known_band(state)[0]
                self.assertIn(f'up to about the {export.ordinal(n)} most frequent', parsed['known'])

    def test_export_notice_once_after_a_week(self):
        state = fwlib.load_state()
        with fwlib.editing() as state:
            export.mark_exported(state, 'claude-ai')
        self.assertIsNone(weave.export_notice(state))  # same version
        with fwlib.editing() as state:
            fwlib.apply_event(state, 'et', 'known')
        self.assertIsNone(weave.export_notice(state, now=time.time() + 86400))  # changed, but fresh
        self.assertIn('/french-weave:export', weave.export_notice(state, now=time.time() + 8 * 86400))
        self.assertIsNone(weave.export_notice(fwlib.load_state(), now=time.time() + 9 * 86400))  # only once

    def test_log_chat_day_counts_but_never_graduates_alone(self):
        state = fwlib.new_state('2026-10-01')
        for day in ('2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'):
            self.assertGreater(export.log_chat_day(state, day), 0)
            fwlib.promote(state, day, {})
        self.assertEqual(fwlib.find(state, 'et')['status'], 'active')


class Blocks(unittest.TestCase):
    def test_blocks_are_current_and_fit(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'make_blocks.py'), '--check'],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class Codex(Home):
    def test_merge_keeps_other_hooks_and_is_idempotent(self):
        theirs = {'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': 'x.sh'}]}],
                            'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': 'other.py'}]}]}}
        once = fw.merge_codex_hooks(json.loads(json.dumps(theirs)), fw.codex_command())
        twice = fw.merge_codex_hooks(json.loads(json.dumps(once)), fw.codex_command())
        self.assertEqual(once, twice)
        self.assertEqual(once['hooks']['Stop'], theirs['hooks']['Stop'])
        self.assertEqual(len(once['hooks']['UserPromptSubmit']), 2)
        self.assertEqual(once['hooks']['UserPromptSubmit'][0], theirs['hooks']['UserPromptSubmit'][0])

    def test_feature_flag(self):
        self.assertEqual(fw.enable_codex_hooks(''), '[features]\nhooks = true\n')
        self.assertEqual(fw.enable_codex_hooks('model = "x"\n[features]\nhooks = false\nother = 1\n[tui]\n'),
                         'model = "x"\n[features]\nhooks = true\nother = 1\n[tui]\n')
        self.assertEqual(fw.enable_codex_hooks('[features]\nmemories = true\n'), '[features]\nhooks = true\nmemories = true\n')
        self.assertIn('[features]\nhooks = true', fw.enable_codex_hooks('model = "x"\n[tui]\na = 1\n'))

    def test_codex_exec_is_scripted_tui_is_not(self):
        data = {'turn_id': 't', 'session_id': 's'}
        self.assertFalse(weave.interactive({}, data, exec_check=lambda: True))
        self.assertTrue(weave.interactive({}, data, exec_check=lambda: False))
        self.assertTrue(weave.interactive({'FRENCH_WEAVE_FORCE': '1'}, data, exec_check=lambda: True))
        code = f'import sys, os; sys.path.insert(0, {str(ROOT / "scripts")!r}); import weave; print(weave.codex_exec(os.getpid()))'
        sh = subprocess.run(['codex', '-c', code, 'exec'], executable=sys.executable, capture_output=True, text=True)
        self.assertEqual(sh.stdout.strip(), 'True', sh.stderr)

    def test_codex_transcript_replies(self):
        lines = [json.dumps({'type': 'response_item', 'timestamp': '2026-10-09T10:00:00Z',
                             'payload': {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Fixed, donc it ships.'}]}}),
                 json.dumps({'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'et'}]}})]
        self.assertEqual([t for _, t in fwlib.replies(lines)], ['Fixed, donc it ships.'])


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
        self.assertEqual(len(state['words']), fwlib.NEW_PER_DAY)
        self.assertNotIn('geminiKey', state)
        self.assertEqual(state['prefs'], {})
        self.assertEqual(events, {'ok': True, 'applied': 2})
        self.assertEqual(after['words'][0], {'fr': 'mais', 'en': 'but', 'hint': 'meh', 'status': 'shaky'})
        self.assertNotEqual(after['version'], state['version'])
        self.assertFalse(bad['ok'])

    def test_state_reply_carries_prefs(self):
        with fwlib.editing() as state:
            state['prefs'] = {'extension_sites': 'ask'}
        reply, = self.converse({'type': 'state'})
        self.assertEqual(reply['prefs'], {'extension_sites': 'ask'})

    def test_message_framing(self):
        stream = io.BytesIO()
        fw_host.write_message(stream, {'a': 'é'})
        stream.seek(0)
        self.assertEqual(fw_host.read_message(stream), {'a': 'é'})
        self.assertIsNone(fw_host.read_message(io.BytesIO(b'')))


FAKE_KEY = 'AIzaTEST_placeholder_not_a_real_key_0000'


class Setup(Home):
    def test_setup_installs_extension_host_and_key(self):
        key = self.home / 'key.txt'
        key.write_text(f'  {FAKE_KEY} \n')
        with mock.patch.object(Path, 'home', return_value=self.home), \
                mock.patch.dict(os.environ, {'XDG_CONFIG_HOME': ''}), mock.patch('sys.stdout', new=io.StringIO()) as out:
            fw.main(['setup', '--dry-run', '--gemini-key-file', str(key)])
            self.assertFalse((self.home / 'fw').exists())
            fw.main(['setup', '--gemini-key-file', str(key)])
        home = self.home / 'fw'
        self.assertIn('Load unpacked', out.getvalue())
        self.assertTrue((home / 'extension' / 'manifest.json').exists())
        self.assertFalse((home / 'extension' / 'test').exists())
        self.assertEqual((home / 'gemini_key').read_text().strip(), FAKE_KEY)
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
        self.assertEqual(reply['geminiKey'], FAKE_KEY)

    def test_key_file_problems_never_echo_the_key_or_path(self):
        def fails(arg):
            with mock.patch.object(Path, 'home', return_value=self.home), mock.patch('sys.stdout', new=io.StringIO()) as out, \
                    self.assertRaises(SystemExit) as caught:
                fw.main(['setup', '--dry-run', '--gemini-key-file', arg])
            return str(caught.exception.code) + out.getvalue()
        self.assertIn('looks like a key', fails(FAKE_KEY))  # the key itself, given as the path
        self.assertNotIn(FAKE_KEY, fails(FAKE_KEY))
        self.assertIn('looks like a key', fails('x' * 40))
        missing = str(self.home / 'secret-dir' / 'no-such-file')
        self.assertNotIn('secret-dir', fails(missing))
        bad = self.home / 'notes.txt'
        bad.write_text(f'my key is {FAKE_KEY}\n')
        message = fails(str(bad))
        self.assertIn('only the key', message)
        self.assertNotIn(FAKE_KEY, message)
        self.assertFalse((self.home / 'fw').exists())

    def run_setup(self, *flags):
        with mock.patch.object(Path, 'home', return_value=self.home), mock.patch.dict(os.environ, {
                'XDG_CONFIG_HOME': '', 'CODEX_HOME': str(self.home / 'codex')}), mock.patch('sys.stdout', new=io.StringIO()):
            fw.main(['setup', *flags])
        return fwlib.load_state(create=False)

    def test_known_top_seeds_before_first_learning_words(self):
        state = self.run_setup('--known-top', '40')
        statuses = [w['status'] for w in state['words']]
        self.assertEqual(statuses[:40], ['known'] * 40)
        self.assertEqual(statuses[40:40 + fwlib.NEW_PER_DAY], ['active'] * fwlib.NEW_PER_DAY)
        self.assertEqual(fwlib.stage_for(state), 2)
        self.assertFalse(state['stage_pinned'])
        self.assertNotIn('prefs', state)

    def test_rerun_never_resets_or_downgrades(self):
        self.run_setup()  # top 5 become learning words
        with fwlib.editing() as state:
            fwlib.apply_event(state, 'et', 'flip')  # shaky
            fwlib.apply_event(state, 'mais', 'seen')
        state = self.run_setup('--known-top', '150', '--sites', 'ask')
        by = {w['fr']: w for w in state['words']}
        self.assertEqual(by['et']['status'], 'shaky')
        self.assertEqual(by['mais']['status'], 'active')
        self.assertEqual(by['mais']['days'], [fwlib.today()])
        # et (shaky) and mais (seen) keep their progress; today's untouched picks donc, avec, sans become known.
        self.assertEqual(sum(w['status'] == 'known' for w in state['words'][:150]), 148)
        self.assertEqual(fwlib.stage_for(state), 2)  # 148 known: stage 3 comes once the learning words graduate
        self.assertEqual(state['prefs'], {'extension_sites': 'ask'})
        before = json.dumps(state)
        state = self.run_setup('--known-top', '40')  # a lower answer later changes nothing
        self.assertEqual(json.dumps(state), before)
        self.assertEqual(state['prefs'], {'extension_sites': 'ask'})  # --sites left out keeps the choice
        self.assertEqual(self.run_setup('--sites', 'all')['prefs'], {'extension_sites': 'all'})

    def test_known_top_after_a_prompt_already_created_the_state(self):
        # Typing /french-weave:setup runs the chat hook first, which creates the state with the top words learning.
        with mock.patch.dict(os.environ, {'FRENCH_WEAVE_NO_REFRESH': '1'}), mock.patch('sys.stdout', new=io.StringIO()):
            weave.main([])
        self.assertEqual([w['status'] for w in fwlib.load_state()['words'][:5]], ['active'] * 5)
        state = self.run_setup('--known-top', '40')
        statuses = [w['status'] for w in state['words']]
        self.assertEqual(statuses[:40], ['known'] * 40)
        self.assertEqual(statuses[40:40 + fwlib.NEW_PER_DAY], ['active'] * fwlib.NEW_PER_DAY)
        self.assertEqual(fwlib.stage_for(state), 2)

    def test_dry_run_reports_answers_and_writes_nothing(self):
        with mock.patch.object(Path, 'home', return_value=self.home), \
                mock.patch.dict(os.environ, {'XDG_CONFIG_HOME': ''}), mock.patch('sys.stdout', new=io.StringIO()) as out:
            fw.main(['setup', '--dry-run', '--known-top', '40', '--sites', 'ask'])
        info = json.loads(out.getvalue())
        self.assertEqual((info['known_top'], info['sites']), (40, 'ask'))
        self.assertIn('codex_cli', info)
        self.assertFalse((self.home / 'fw').exists())
        with self.assertRaises(SystemExit), mock.patch('sys.stderr', new=io.StringIO()):
            fw.main(['setup', '--dry-run', '--sites', 'some'])

    def test_extension_id_matches_manifest_key(self):
        import base64
        import hashlib
        key = json.loads((ROOT / 'extension' / 'manifest.json').read_text())['key']
        digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
        self.assertEqual(''.join(chr(ord('a') + int(c, 16)) for c in digest), fw.EXTENSION_ID)


SPANISH = 'word,en,hint,scan\ny,and,ee,\npero,but,PEH-roh,\nentonces,so,en-TON-ses,\nahora,now,ah-OH-rah,\nsolo,only,SOH-loh,no\n'
SPANISH += ''.join(f'palabra{i},word {i},pah-LAH-brah,\n' for i in range(200))


class Languages(Home):
    run_setup = Setup.run_setup

    def lexicon(self, text=SPANISH):
        path = self.home / 'spanish.csv'
        path.write_text('\ufeff' + text)  # a BOM, as spreadsheet apps save it
        return path

    def state(self, stage=1, known=0):
        state = fwlib.new_state('2026-10-01', fwlib.load_lexicon(self.lexicon()), known_top=known)
        state.update(language='Spanish', stage=stage, stage_pinned=True)
        return state

    def test_lexicon_format(self):
        words = fwlib.load_lexicon(self.lexicon())
        self.assertEqual(words[0], {'fr': 'y', 'en': 'and', 'hint': 'ee'})
        self.assertEqual(words[4], {'fr': 'solo', 'en': 'only', 'hint': 'SOH-loh', 'scan': False})
        self.assertFalse(fwlib.measurable(words[4]))

    def test_words_written_without_spaces(self):
        hits = lambda fr, text: bool(fwlib.pattern(fr).search(fwlib.norm(text)))
        self.assertTrue(hits('今日', '今日はいい日です。'))
        self.assertTrue(hits('猫', 'a 猫 who loves boxes'))
        self.assertTrue(hits('kucing', 'a kucing who'))
        self.assertFalse(hits('dan', 'dance'))

    def test_brief_and_exports_name_the_language(self):
        french = weave.brief(dict(self.state(), language=None, words=fwlib.new_state('2026-10-01')['words']), {})
        for old, _ in weave.CUTS[::2]:  # stage 1-2 cuts; the stage 3+ example is checked below
            self.assertIn(old, french)
        self.assertIn(weave.CUTS[1][0], weave.brief(dict(self.state(3), language=None), {}))
        rules = export.rules() + export.rules(short=True)
        for old, _ in export.CUTS:
            self.assertIn(old, rules)
        for stage, known in ((1, 0), (3, 5), (4, 180)):
            state = self.state(stage, known)
            texts = [weave.brief(state, {}), export.claude_ai(state), *export.chatgpt(state)]
            for text in texts:
                self.assertNotRegex(text, r'French(?! [Ww]eave)|maintenant|pour never|\bsans\b')
            self.assertTrue(all('Spanish' in text for text in texts[:2] + [texts[3]]))
            self.assertIn('(y = and, "ee")', texts[0] + texts[1])
            self.assertLessEqual(max(map(len, texts[2:])), export.CHATGPT_LIMIT)
        self.assertIn('most common Spanish words', weave.brief(self.state(4, 180), {}))

    def test_calibration_and_host_carry_the_language(self):
        state = self.state()
        reply = 'The build passes ahora, pero the cache is stale, entonces I cleared it, je tu il elle nous. ' * 4
        self.assertIn('% Spanish', weave.calibration(reply, state))
        self.assertNotIn('slipped', weave.calibration(reply, state))  # French grammar words mean nothing here
        self.assertEqual(fwlib.public_state(state)['language'], 'Spanish')
        self.assertEqual(fwlib.public_state(fwlib.new_state())['language'], 'French')

    def test_setup_switches_language_and_back(self):
        state = self.run_setup('--language', 'Spanish', '--lexicon', str(self.lexicon()))
        self.assertEqual((state['language'], state['words'][0]['fr']), ('Spanish', 'y'))
        with fwlib.editing() as state:
            fwlib.apply_event(state, 'pero', 'known')
        self.assertEqual(self.run_setup()['language'], 'Spanish')  # a plain rerun keeps it
        state = self.run_setup('--language', 'French')
        self.assertEqual((fwlib.language(state), state['words'][0]['fr']), ('French', 'et'))
        self.assertFalse((self.home / 'fw' / 'lexicon.csv').exists())
        state = self.run_setup('--language', 'Spanish', '--lexicon', str(self.lexicon()))
        self.assertEqual(fwlib.find(state, 'pero')['status'], 'known')  # progress came back
        self.assertTrue((self.home / 'fw' / 'state-french.json').exists())
        for flags in (['--language', 'Klingon'], ['--lexicon', str(self.lexicon())]):
            with self.assertRaises(SystemExit):
                self.run_setup(*flags)


if __name__ == '__main__':
    unittest.main()
