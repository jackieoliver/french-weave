"""Setup turns off Claude Code's mid-turn narration, whose server-side rewrites of progress notes drop the French and
sometimes come out entirely in French; a choice already in the settings is kept.

Run: python3 -m unittest discover -s tests
"""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
HOOK = ROOT / 'scripts' / 'weave.py'
sys.path.insert(0, str(ROOT / 'scripts'))
os.environ['FRENCH_WEAVE_NO_REFRESH'] = '1'
os.environ.pop('CLAUDE_CONFIG_DIR', None)

import fw  # noqa: E402
import fwlib  # noqa: E402

KEY = 'CLAUDE_CODE_THINKING_DISPLAY_UPDATES'


class Narration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.claude = self.home / 'claude'
        self.settings = self.claude / 'settings.json'
        env = {'FRENCH_WEAVE_HOME': str(self.home / 'fw'), 'CLAUDE_CONFIG_DIR': str(self.claude),
               'CODEX_HOME': str(self.home / 'codex'), 'XDG_CONFIG_HOME': ''}
        self.env = mock.patch.dict(os.environ, env)
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def write(self, data):
        self.settings.parent.mkdir(parents=True, exist_ok=True)
        self.settings.write_text(data if isinstance(data, str) else json.dumps(data))

    def fw(self, *argv):
        with mock.patch.object(Path, 'home', return_value=self.home), \
                mock.patch('sys.stdout', new=io.StringIO()) as out:
            fw.main(list(argv))
        return out.getvalue()

    def test_setup_turns_it_off_and_keeps_other_settings(self):
        self.write({'model': 'opus', 'env': {'OTHER': '1'}})
        out = self.fw('setup')
        self.assertIn('narration:   off (', out)
        data = json.loads(self.settings.read_text())
        self.assertEqual(data['env'], {'OTHER': '1', KEY: '0'})
        self.assertEqual(data['model'], 'opus')
        self.assertTrue((self.claude / 'settings.json.before-french-weave').exists())
        self.assertIs(fwlib.narration_off(), True)

    def test_creates_settings_when_claude_code_has_none(self):
        self.claude.mkdir()
        self.fw('setup')
        self.assertEqual(json.loads(self.settings.read_text())['env'], {KEY: '0'})

    def test_a_choice_already_made_is_kept(self):
        for value, line in (('1', 'narration:   on (your choice)'), ('false', 'narration:   off')):
            with self.subTest(value=value):
                before = json.dumps({'env': {KEY: value}})
                self.write(before)
                self.assertIn(line, self.fw('setup'))
                self.assertEqual(self.settings.read_text(), before)

    def test_opt_out_flag_and_dry_run_write_nothing(self):
        self.claude.mkdir()
        self.assertNotIn('narration', self.fw('setup', '--keep-narration'))
        self.assertFalse(self.settings.exists())
        self.assertIn('narration: off', self.fw('setup', '--dry-run'))
        self.assertFalse(self.settings.exists())

    def test_no_claude_code_says_nothing(self):
        self.assertNotIn('narration', self.fw('setup'))
        self.assertFalse(self.settings.exists())

    def test_invalid_settings_file_is_never_overwritten(self):
        for text, line in (('{"model": "opus",}', 'not valid JSON'), ('{"env": "nope"}', 'is not an object')):
            with self.subTest(text=text):
                self.write(text)
                self.assertIn(line, self.fw('setup'))
                self.assertEqual(self.settings.read_text(), text)

    def test_update_notice_points_existing_installs_to_setup(self):
        # Setup runs once, so people who installed before this setting get it from the post-update notice.
        app = self.home / 'fw' / 'app'
        self.claude.mkdir()
        for settings, told in (({}, True), ({'env': {KEY: '1'}}, False)):
            with self.subTest(settings=settings):
                app.mkdir(parents=True, exist_ok=True)
                (app / 'VERSION').write_text('0.0.1\n')  # copies from an older plugin version
                self.write(settings)
                result = subprocess.run([sys.executable, str(HOOK), '--hook'], input=json.dumps({'session_id': 's'}),
                                        capture_output=True, text=True, timeout=60, env=dict(os.environ))
                self.assertEqual(result.returncode, 0, result.stderr)
                notice = json.loads(result.stdout).get('systemMessage', '')
                self.assertIn('French Weave updated to', notice)
                self.assertEqual('/french-weave:setup again' in notice, told)


if __name__ == '__main__':
    unittest.main()
