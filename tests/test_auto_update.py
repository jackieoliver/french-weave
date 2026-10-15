"""Setup turns on Claude Code's auto-update for this marketplace, so people get fixes without asking for them.

Run: python3 -m unittest discover -s tests
"""
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
os.environ.pop('CLAUDE_CONFIG_DIR', None)

import fw  # noqa: E402

GITHUB = {'source': 'github', 'repo': 'jackieoliver/french-weave'}


class AutoUpdate(unittest.TestCase):
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

    def known(self, **entry):
        path = self.claude / 'plugins' / 'known_marketplaces.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'french-weave': {'source': GITHUB, **entry}}))

    def fw(self, *argv):
        with mock.patch.object(Path, 'home', return_value=self.home), \
                mock.patch('sys.stdout', new=io.StringIO()) as out:
            fw.main(list(argv))
        return out.getvalue()

    def test_setup_turns_it_on_and_keeps_other_settings(self):
        self.known()
        self.settings.write_text(json.dumps({'model': 'opus', 'enabledPlugins': {'french-weave@french-weave': True}}))
        out = self.fw('setup')
        self.assertIn('updates:     on', out)
        data = json.loads(self.settings.read_text())
        self.assertEqual(data['extraKnownMarketplaces']['french-weave'], {'source': GITHUB, 'autoUpdate': True})
        self.assertEqual(data['model'], 'opus')
        self.assertTrue((self.claude / 'settings.json.before-french-weave').exists())

    def test_creates_settings_when_missing(self):
        self.known()
        self.fw('setup')
        self.assertTrue(json.loads(self.settings.read_text())['extraKnownMarketplaces']['french-weave']['autoUpdate'])

    def test_respects_the_plugin_toggle_turned_off(self):
        self.known(autoUpdate=False)
        out = self.fw('setup')
        self.assertIn('updates:     off (your choice', out)
        self.assertFalse(self.settings.exists())

    def test_respects_a_setting_turned_off(self):
        self.known()
        before = json.dumps({'extraKnownMarketplaces': {'french-weave': {'source': GITHUB, 'autoUpdate': False}}})
        self.settings.parent.mkdir(parents=True, exist_ok=True)
        self.settings.write_text(before)
        self.fw('setup')
        self.assertEqual(self.settings.read_text(), before)

    def test_opt_out_flag_and_dry_run_write_nothing(self):
        self.known()
        self.fw('setup', '--no-auto-update')
        self.assertFalse(self.settings.exists())
        self.assertIn('updates: on', self.fw('setup', '--dry-run'))
        self.assertFalse(self.settings.exists())

    def test_local_folder_install_is_left_alone(self):
        path = self.claude / 'plugins' / 'known_marketplaces.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'french-weave': {'source': {'source': 'directory', 'path': '/src/fw'}}}))
        self.assertIn('installed from a folder', self.fw('setup'))
        self.assertFalse(self.settings.exists())

    def test_not_a_claude_code_plugin_says_nothing(self):
        self.assertNotIn('updates:', self.fw('setup'))
        self.assertFalse(self.settings.exists())

    def test_invalid_settings_file_is_never_overwritten(self):
        self.known()
        self.settings.parent.mkdir(parents=True, exist_ok=True)
        self.settings.write_text('{"model": "opus",}')
        self.assertIn('not valid JSON', self.fw('setup'))
        self.assertEqual(self.settings.read_text(), '{"model": "opus",}')

    def test_uninstall_leaves_claude_settings_alone(self):
        # Claude Code writes this entry on `marketplace add` and drops it on `marketplace remove` (checked live with
        # 2.1.300); removing it from uninstall would unregister a plugin the person kept.
        self.known()
        self.fw('setup')
        before = self.settings.read_text()
        self.fw('uninstall')
        self.assertEqual(self.settings.read_text(), before)


if __name__ == '__main__':
    unittest.main()
