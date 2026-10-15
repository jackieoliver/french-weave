"""Regression tests: one per bug found so far that tests/test_weave.py doesn't already pin down.

Each test names the bug it guards. Run: python3 -m unittest discover -s tests
"""
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
os.environ['FRENCH_WEAVE_NO_REFRESH'] = '1'
for name in ('CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'FRENCH_WEAVE_FORCE', 'FRENCH_WEAVE_OFF'):
    os.environ.pop(name, None)  # tests set these explicitly

import fwlib  # noqa: E402
import weave  # noqa: E402
import fw  # noqa: E402
import export  # noqa: E402
import make_blocks  # noqa: E402

HOOK = ROOT / 'scripts' / 'weave.py'


class Home(unittest.TestCase):
    """Each test gets its own state dir and home folder."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {'FRENCH_WEAVE_HOME': str(self.home / 'fw')})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def hook(self, payload=None, **env):
        result = subprocess.run([sys.executable, str(HOOK), '--hook'], input=json.dumps(payload or {}),
                                capture_output=True, text=True, timeout=60, env=dict(os.environ, **env))
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def fw(self, *argv, **env):
        """fw.py in-process with the home folder and Chrome config redirected into the temp dir; returns stdout."""
        with mock.patch.object(Path, 'home', return_value=self.home), \
                mock.patch.dict(os.environ, dict({'XDG_CONFIG_HOME': '', 'CODEX_HOME': str(self.home / 'codex')}, **env)), \
                mock.patch('sys.stdout', new=io.StringIO()) as out:
            fw.main(list(argv))
        return out.getvalue()


class ScriptedRuns(Home):
    """French must never reach scripted output, and must reach every chat surface. These run the real hook under a
    parent process whose command line is `claude ...`, the way Claude Code starts it, so the process detection is
    tested end to end rather than through weave.interactive's arguments."""

    def under_claude(self, args, **env):
        code = ('import json, os, subprocess\n'
                'ps = subprocess.run(["ps", "-o", "args=", "-p", str(os.getpid())], capture_output=True, text=True)\n'
                f'out = subprocess.run([{sys.executable!r}, {str(HOOK)!r}, "--hook"], input="{{}}", capture_output=True, text=True)\n'
                'print(json.dumps([(ps.stdout.split() or [""])[0], out.stdout, out.returncode]))')
        result = subprocess.run(['claude', '-c', code, *args], executable=sys.executable, capture_output=True, text=True,
                                timeout=60, env=dict(os.environ, **env))
        self.assertEqual(result.returncode, 0, result.stderr)
        name, out, code = json.loads(result.stdout)
        if os.path.basename(name) != 'claude':  # macOS framework Python re-execs itself and loses argv[0]
            self.skipTest(f'this Python does not keep argv[0] ({name})')
        self.assertEqual(code, 0)
        return out

    # 712348b: `claude -p` must stay French-free, while Remote Control and claude.ai/code (also --print, but with
    # --sdk-url and stream-json input, entrypoint sdk-cli) and the terminal UI must weave. c9cc0dc keyed on the
    # sdk-cli entrypoint alone and so silenced Remote Control.
    def test_claude_print_is_silent_remote_control_and_tui_weave(self):
        printing = dict(CLAUDE_CODE_ENTRYPOINT='sdk-cli', CLAUDE_CODE_SESSION_ATTENDED='0')
        self.assertEqual(self.under_claude(['-p', '--model', 'haiku', 'Reply OK'], **printing), '')
        self.assertEqual(self.under_claude(['--print', '--output-format', 'json', 'x'], **printing), '')
        remote = ['--print', '--sdk-url', 'https://example.invalid/v1/code/sessions/x', '--session-id', 'x',
                  '--input-format', 'stream-json', '--output-format', 'stream-json']
        self.assertIn('French Weave (Stage', self.under_claude(remote, **printing))
        self.assertIn('French Weave (Stage', self.under_claude(['--print', '--input-format=stream-json'], **printing))
        self.assertIn('French Weave (Stage', self.under_claude(['--model', 'opus'], CLAUDE_CODE_ENTRYPOINT='cli'))

    # FRENCH_WEAVE_FORCE=1 weaves even in `claude -p` (model checks); FRENCH_WEAVE_OFF=1 silences even the TUI.
    def test_force_and_off_overrides(self):
        self.assertIn('French Weave (Stage', self.under_claude(['-p', 'x'], CLAUDE_CODE_ENTRYPOINT='sdk-cli',
                                                                FRENCH_WEAVE_FORCE='1'))
        self.assertEqual(self.under_claude([], CLAUDE_CODE_ENTRYPOINT='cli', FRENCH_WEAVE_OFF='1'), '')
        self.assertEqual(self.under_claude([], CLAUDE_CODE_ENTRYPOINT='cli', FRENCH_WEAVE_OFF='1', FRENCH_WEAVE_FORCE='1'), '')

    # Agent SDK library scripts (TypeScript and Python) are scripted runs whatever their command line.
    def test_agent_sdk_entrypoints_are_silent(self):
        for entrypoint in ('sdk-ts', 'sdk-py'):
            self.assertEqual(self.hook(CLAUDE_CODE_ENTRYPOINT=entrypoint), '', entrypoint)


class Brief(Home):
    def state(self, stage):
        state = fwlib.new_state('2026-10-01')
        state.update(stage=stage, stage_pinned=True)
        return state

    # f5556d1: with no recall word this turn, models repeated the last "Recall:" cue on every reply.
    def test_turns_without_recall_say_no_recall_cue(self):
        state = self.state(1)
        plain = weave.brief(state, {})
        self.assertIn('No recall cue in this reply', plain)
        self.assertNotIn('Recall: ', plain.replace('no "Recall:" lines', ''))
        word = {'fr': 'et', 'en': 'and', 'hint': 'ay'}
        cued = weave.brief(state, {}, word)
        self.assertIn('"Recall: et?"', cued)
        self.assertNotIn('No recall cue', cued)
        # Through the hook: turn 1 has the cue, turns 2 and 3 say no cue.
        turns = [json.loads(self.hook({'session_id': 's'}))['hookSpecificOutput']['additionalContext'] for _ in range(3)]
        self.assertIn('Recall: et?', turns[0])
        self.assertTrue(all('No recall cue' in t and 'Recall: et?' not in t for t in turns[1:]))

    # Safety and placement rules the brief must carry at every stage: zero French for sensitive topics, no French in
    # code, files or commits, and no fully French sentences below Stage 3.
    def test_brief_rules_at_every_stage(self):
        for stage in (1, 2, 3, 4):
            text = ' '.join(weave.brief(self.state(stage), {}).split())
            zero = re.search(r'zero French, and no recall cue, for ([^.]*)\.', text)
            self.assertTrue(zero, stage)
            for topic in ('health', 'medication', 'legal', 'money', 'safety', 'emergency', 'driving', 'urgent'):
                self.assertIn(topic, zero.group(1), (stage, topic))
            self.assertIn('Plain English for code, commands, paths', text)
            self.assertIn('never in files, code, configs, commit or PR text', text)
            if stage < 3:
                self.assertIn('Never a French sentence or clause', text)
                self.assertNotIn('fully French', text)
            else:
                self.assertNotIn('Never a French sentence', text)
                self.assertIn('should be fully French', text)

    # The same rules in the pasted claude.ai and ChatGPT blocks.
    def test_export_rules(self):
        state = self.state(1)
        claude = ' '.join(export.claude_ai(state).split())
        for topic in ('health', 'medication', 'legal', 'money', 'safety', 'emergency', 'driving'):
            self.assertRegex(claude, r'Zero French, and no recall cue, in [^.]*' + topic)
        self.assertIn('no fully French sentences or clauses', claude)
        self.assertIn('code, files, configs, commit messages', claude)
        respond = export.chatgpt(state)[1]
        for topic in ('health', 'legal', 'money', 'safety', 'emergency', 'driving'):
            self.assertRegex(respond, r'Zero French for [^.]*' + topic)
        self.assertIn('Below Stage 3 every sentence stays English grammar', respond)
        self.assertIn('plain English in code, files', respond)


class HookResilience(Home):
    # e6afc89: a corrupt state.json made every prompt fail to get a brief; now it is set aside and a fresh state used.
    def test_corrupt_state_never_breaks_the_hook(self):
        (self.home / 'fw').mkdir()
        (self.home / 'fw' / 'state.json').write_text('{"words": [')
        out = json.loads(self.hook({'session_id': 's'}))
        self.assertIn('French Weave (Stage 1)', out['hookSpecificOutput']['additionalContext'])
        self.assertTrue(any(p.name.startswith('state.json.bad-') for p in (self.home / 'fw').iterdir()))
        self.assertIsInstance(fwlib.load_state(create=False)['words'], list)

    # e6afc89: after `claude plugin update`, the copies setup made in ~/.french-weave (extension, native host
    # scripts) stayed on the old version. The hook now refreshes them and tells the user once.
    def test_plugin_update_refreshes_copies_and_says_so_once(self):
        app = self.home / 'fw' / 'app'
        app.mkdir(parents=True)
        (app / 'VERSION').write_text('0.0.1\n')  # copies from an older plugin version
        version = json.loads((ROOT / '.claude-plugin' / 'plugin.json').read_text())['version']
        first = json.loads(self.hook({'session_id': 's'}))
        self.assertIn(f'French Weave updated to {version}', first.get('systemMessage', ''))
        self.assertIn('chrome://extensions', first['systemMessage'])
        self.assertEqual((app / 'VERSION').read_text().strip(), version)
        manifest = json.loads((self.home / 'fw' / 'extension' / 'manifest.json').read_text())
        self.assertEqual(manifest['version'], json.loads((ROOT / 'extension' / 'manifest.json').read_text())['version'])
        self.assertTrue((app / 'scripts' / 'fw_host.py').exists())
        second = json.loads(self.hook({'session_id': 's'}))
        self.assertNotIn('systemMessage', second)


class Cli(Home):
    # b06822b: setup on Windows half-installed (no native host support); it must stop with a clear message first.
    def test_windows_setup_exits_clearly_and_writes_nothing(self):
        with mock.patch.object(sys, 'platform', 'win32'), mock.patch.object(fw.shutil, 'which', return_value=None), \
                self.assertRaises(SystemExit) as caught:
            self.fw('setup', '--known-top', '40')
        message = str(caught.exception.code)
        self.assertIn('macOS and Linux only', message)
        self.assertIn('WSL', message)
        self.assertFalse((self.home / 'fw').exists())
        self.assertEqual(sorted(p.name for p in self.home.iterdir()), [])

    # f5556d1: uninstall left empty NativeMessagingHosts folders (and empty browser folders setup had created).
    def test_uninstall_removes_empty_host_folders_only(self):
        self.fw('setup')
        with mock.patch.object(Path, 'home', return_value=self.home), mock.patch.dict(os.environ, {'XDG_CONFIG_HOME': ''}):
            dirs = fw.host_dirs()
        self.assertTrue(all((d / f'{fw.HOST_NAME}.json').exists() for d in dirs))
        (dirs[0].parent / 'Default').mkdir()  # this browser is really installed: its folder must stay
        out = self.fw('uninstall')
        self.assertIn('removed', out)
        self.assertFalse(any(d.exists() for d in dirs))
        self.assertTrue((dirs[0].parent / 'Default').is_dir())
        self.assertFalse(dirs[1].parent.exists())  # created only by setup, now empty
        self.assertTrue((self.home / 'fw' / 'state.json').exists())  # word progress stays

    # f5556d1: `known` or `learn` with no word printed "Not in the word list: " with nothing after it.
    def test_known_and_learn_without_a_word_print_usage(self):
        self.fw('status')
        before = (self.home / 'fw' / 'state.json').read_text()
        for argv in (['known', ''], ['learn', ' , '], ['known', ',']):
            out = self.fw(*argv)
            self.assertIn('No word given', out, argv)
            self.assertNotIn('Not in the word list', out, argv)
        self.assertEqual((self.home / 'fw' / 'state.json').read_text(), before)
        self.assertIn('Known: mais', self.fw('known', 'mais'))

    # a1f64e0: a browser started with --user-data-dir only looks for native hosts inside that folder.
    def test_user_data_dir_gets_a_host_manifest(self):
        profile = self.home / 'profile'
        self.fw('setup', '--user-data-dir', str(profile))
        manifest = json.loads((profile / 'NativeMessagingHosts' / f'{fw.HOST_NAME}.json').read_text())
        self.assertEqual(manifest['allowed_origins'], [f'chrome-extension://{fw.EXTENSION_ID}/'])

    # 2442714: setup's human steps said the extension runs "only on X" before Allow all websites; it is x.com.
    def test_setup_steps_name_x_com(self):
        out = self.fw('setup', '--sites', 'all')
        self.assertIn('runs only on x.com', out)
        self.assertIn('/reload-plugins', out)  # f5556d1: an open session needs /reload-plugins to see the plugin


class SetupCommand(unittest.TestCase):
    """The /french-weave:setup instructions (commands/setup.md) the model follows."""

    def setUp(self):
        self.text = ' '.join((ROOT / 'commands' / 'setup.md').read_text().split())

    # f5556d1: a rerun where the person skipped the sites question passed a default --sites and reset an earlier
    # "only sites I turn on" choice.
    def test_skipped_sites_question_leaves_sites_flag_out(self):
        self.assertIn('leave `--sites` out if they skipped question 3', self.text)

    # f5556d1: with no key file named, the agent searched the disk for one.
    def test_never_searches_for_a_key_file(self):
        self.assertIn('never search their disk for one', self.text)


class Blocks(unittest.TestCase):
    DATE = re.compile(r'" \(\d{1,2}/\d{1,2}\)')

    # b06822b: ready-made blocks showed a fixed "(1/1)" date after every learning word, which reads as a score.
    def test_ready_made_blocks_carry_no_dates(self):
        lexicon = fwlib.load_lexicon(fwlib.LEXICON)
        levels = -(-len(lexicon) // make_blocks.PER_LEVEL)
        for level in (1, 2, levels):
            text, _ = make_blocks.block(level, levels, lexicon)
            self.assertNotRegex(text, self.DATE, level)
        for path in sorted((ROOT / 'blocks').glob('level-*.md')):
            self.assertNotRegex(path.read_text(), self.DATE, path.name)
        # The pattern is right: a real export still dates the words it lists.
        state = make_blocks.level_state(1, lexicon)
        self.assertRegex(export.state_line(state), self.DATE)


if __name__ == '__main__':
    unittest.main()
