"""Tests for tests/check_version_bump.py, the CI version check. Run: python3 -m unittest discover -s tests"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_version_bump as cvb  # noqa: E402

GIT = ['git', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
       '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main']


class VersionBump(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.git('init', '-q')
        self.write_versions('0.2.0')
        self.write('scripts/weave.py', 'print(1)\n')
        self.write('README.md', 'docs\n')
        self.base = self.commit('0.2.0')

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(GIT + ['-C', str(self.repo), *args], capture_output=True, text=True, check=True).stdout.strip()

    def write(self, path, text):
        file = self.repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def write_versions(self, version, extension=None, marketplace=None):
        self.write('.claude-plugin/plugin.json', json.dumps({'name': 'french-weave', 'version': version}))
        plugin = {'name': 'french-weave', 'source': './'}
        if marketplace:
            plugin['version'] = marketplace
        self.write('.claude-plugin/marketplace.json', json.dumps({'name': 'french-weave', 'plugins': [plugin]}))
        self.write('extension/manifest.json', json.dumps({'manifest_version': 3, 'version': extension or version}))
        self.write('extension/package.json', json.dumps({'name': 'french-weave', 'version': extension or version}))

    def commit(self, message):
        self.git('add', '-A')
        self.git('commit', '-q', '-m', message)
        return self.git('rev-parse', 'HEAD')

    def problems(self, base=None, head=None):
        return cvb.check(self.repo, base, head)[0]

    def test_this_repo_versions_agree(self):
        problems, _ = cvb.check(ROOT)
        self.assertEqual(problems, [])
        self.assertEqual(len(set(cvb.versions(ROOT).values())), 1, cvb.versions(ROOT))

    def test_versions_must_agree(self):
        self.assertEqual(self.problems(), [])
        self.write_versions('0.2.1', extension='0.2.0')
        self.assertIn('Versions disagree', self.problems()[0])
        self.write_versions('0.2.1', marketplace='0.2.0')
        self.assertIn('marketplace.json', self.problems()[0])
        self.write_versions('0.2.1', marketplace='0.2.1')
        self.assertEqual(self.problems(), [])

    # 0.2.0 -> 0.2.1: shipped fixes (issue #1 among them) sat on main under an unchanged version, so `claude plugin
    # update` never delivered them to anyone who had already installed.
    def test_shipped_change_without_bump_fails(self):
        self.write('extension/src/levels.js', 'fixed\n')
        head = self.commit('fix without bump')
        problems = self.problems(self.base, head)
        self.assertEqual(len(problems), 1)
        self.assertIn('extension/src/levels.js', problems[0])
        self.assertIn('Bump the version', problems[0])
        self.assertIn('claude plugin update', problems[0])
        # The working tree is checked when no head is given (local use before a commit).
        self.write_versions('0.2.1')
        self.assertEqual(self.problems(self.base), [])
        self.assertEqual(len(self.problems(self.base, head)), 1)  # the committed head is still unbumped

    def test_shipped_change_with_bump_passes(self):
        for path in ('scripts/weave.py', 'commands/setup.md', 'hooks/hooks.json', 'data/lexicon.csv'):
            self.write(path, 'changed\n')
        self.write_versions('0.2.1')
        self.assertEqual(self.problems(self.base, self.commit('bumped')), [])

    def test_unshipped_changes_need_no_bump(self):
        for path in ('README.md', 'tests/test_x.py', '.github/workflows/test.yml', 'extension/test/a.test.js',
                     'extension/src/BUILD.bazel', 'extension/scripts/BUILD',
                     'extension/e2e/smoke.mjs', 'extension/e2e/gradual.mjs', 'extension/e2e/again.mjs',
                     'extension/e2e/adaptive.mjs',
                     'extension/e2e/highlights.mjs', 'extension/e2e/welcome.mjs',
                     'extension/bun.lock',
                     'blocks/level-01.md'):
            self.write(path, 'changed\n')
        self.assertEqual(self.problems(self.base, self.commit('docs and tests')), [])

    def test_runtime_reference_scan_handles_build_metadata_and_binary_assets(self):
        self.write('extension/BUILD.bazel', 'exports_files(["e2e/welcome.mjs"])\n')
        self.write('extension/icons/binary.png', '')
        (self.repo / 'extension/icons/binary.png').write_bytes(b'\x89PNG\r\n\x1a\n')
        head = self.commit('Bazel harness metadata and binary icon')
        self.assertEqual(self.problems(), [])
        self.assertEqual(self.problems(head=head), [])
        self.write('extension/src/runtime.js', "import '../e2e/welcome.mjs';\n")
        head = self.commit('runtime import of welcome harness')
        self.assertIn('extension/src/runtime.js', self.problems()[0])
        self.assertIn('extension/src/runtime.js', self.problems(head=head)[0])

    def test_build_metadata_exemption_does_not_hide_packager_change(self):
        self.write('extension/src/BUILD.bazel', 'filegroup(name = "source")\n')
        self.write('extension/scripts/package.mjs', 'changed\n')
        problems = self.problems(self.base, self.commit('packager and build metadata'))
        self.assertEqual(len(problems), 1)
        self.assertIn('extension/scripts/package.mjs', problems[0])
        self.assertNotIn('extension/src/BUILD.bazel', problems[0])

    def test_e2e_exclusion_does_not_hide_runtime_change(self):
        self.write('extension/e2e/smoke.mjs', 'changed\n')
        self.write('extension/src/content.js', 'changed\n')
        problems = self.problems(self.base, self.commit('harness and runtime'))
        self.assertEqual(len(problems), 1)
        self.assertIn('extension/src/content.js', problems[0])

    def test_e2e_prefix_boundary_still_needs_bump(self):
        self.write('extension/e2e-helpers/helper.js', 'changed\n')
        problems = self.problems(self.base, self.commit('runtime beside harness'))
        self.assertEqual(len(problems), 1)
        self.assertIn('extension/e2e-helpers/helper.js', problems[0])

    def test_new_e2e_file_fails_closed(self):
        self.write('extension/e2e/helper.js', 'changed\n')
        problems = self.problems(self.base, self.commit('new harness helper'))
        self.assertEqual(len(problems), 1)
        self.assertIn('extension/e2e/helper.js', problems[0])

    def test_moving_runtime_into_e2e_still_needs_bump(self):
        self.write('extension/src/old.js', 'export const old = true;\n')
        base = self.commit('runtime file')
        (self.repo / 'extension/e2e').mkdir(parents=True)
        self.git('mv', 'extension/src/old.js', 'extension/e2e/old.js')
        problems = self.problems(base, self.commit('move runtime into harness'))
        self.assertEqual(len(problems), 1)
        self.assertIn('extension/src/old.js', problems[0])

    def test_e2e_runtime_dependency_invalidates_exclusion(self):
        self.write('extension/e2e/smoke.mjs', 'changed\n')
        self.write('extension/src/content.js', "import '../e2e/smoke.mjs';\n")
        head = self.commit('runtime imports developer harness')
        self.assertTrue(any('Runtime files reference developer-only extension/e2e/' in problem
                            and 'extension/src/content.js' in problem for problem in self.problems(self.base, head)))
        self.write('extension/e2e/smoke.mjs', 'changed again\n')
        e2e_only = self.commit('edit referenced harness file only')
        problems = self.problems(head, e2e_only)
        self.assertEqual(len(problems), 1)
        self.assertIn('extension/src/content.js', problems[0])
        self.write('extension/src/content.js', 'fixed\n')
        self.write('extension/manifest.json', json.dumps({'version': '0.2.0',
            'web_accessible_resources': [{'resources': ['e2e/smoke.mjs'], 'matches': ['https://*/*']}]}))
        self.assertTrue(any('Runtime files reference developer-only extension/e2e/' in problem
                            and 'extension/manifest.json' in problem for problem in self.problems(self.base)))
        manifest_head = self.commit('manifest exposes developer harness')
        self.assertTrue(any('Runtime files reference developer-only extension/e2e/' in problem
                            and 'extension/manifest.json' in problem for problem in self.problems(self.base, manifest_head)))

    def test_runtime_outside_src_cannot_reference_e2e(self):
        self.write('extension/background.js', "import './e2e/smoke.mjs';\n")
        self.assertIn('extension/background.js', self.problems()[0])

    def test_version_never_goes_down(self):
        self.write('scripts/weave.py', 'print(2)\n')
        self.write_versions('0.1.9')
        self.assertIn('down', self.problems(self.base, self.commit('downgrade'))[0])
        self.assertEqual(cvb.key('0.10.0') > cvb.key('0.9.9'), True)

    def test_missing_or_new_branch_base_skips_the_bump_check(self):
        self.write('scripts/weave.py', 'print(3)\n')
        head = self.commit('no bump')
        problems, notes = cvb.check(self.repo, '0' * 40, head)  # GitHub's "before" for a new branch
        self.assertEqual(problems, [])
        self.assertIn('skipped', notes[0])
        problems, notes = cvb.check(self.repo, 'f' * 40, head)  # not fetched
        self.assertEqual(problems, [])
        self.assertIn('not in this clone', notes[0])

    def test_pull_request_compares_with_the_merge_base(self):
        self.git('checkout', '-q', '-b', 'feature')
        self.write('README.md', 'docs only\n')
        feature = self.commit('docs')
        self.git('checkout', '-q', 'main')
        self.write('scripts/weave.py', 'main moved on\n')
        self.write_versions('0.2.1')
        main = self.commit('main release')
        # main's own shipped change and bump are not the feature branch's: docs only, no bump needed.
        self.assertEqual(self.problems(main, feature), [])

    def test_command_line_exit_codes(self):
        script = Path(cvb.__file__)
        run = lambda *a: subprocess.run([sys.executable, str(script), '--repo', str(self.repo), *a], capture_output=True,
                                        text=True, env=dict(os.environ, GITHUB_ACTIONS='true'))
        self.assertEqual(run().returncode, 0)
        self.write('scripts/fw.py', 'x\n')
        head = self.commit('no bump')
        result = run('--base', self.base, '--head', head)
        self.assertEqual(result.returncode, 1)
        self.assertIn('FAIL: Files the plugin ships changed (scripts/fw.py)', result.stdout)
        self.assertIn('::error title=Version check::', result.stdout)
        self.assertEqual(run('--base', 'HEAD', '--head', head).returncode, 0)


if __name__ == '__main__':
    unittest.main()
