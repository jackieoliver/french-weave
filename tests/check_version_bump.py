#!/usr/bin/env python3
"""Version checks: run by CI, and locally before a push or a release.

  python3 tests/check_version_bump.py                  versions agree (plugin.json, marketplace.json if it has one,
                                                       extension/manifest.json, extension/package.json)
  python3 tests/check_version_bump.py --base REF       also: if a file the plugin ships changed since REF (merge base
                                                       with HEAD), warn unless .claude-plugin/plugin.json's version
                                                       changed too
  ... --release                                        a missing bump fails instead of warning (a release)
  ... --head REF                                       check REF instead of the working tree (CI, tests)
  ... --repo DIR                                       the repository (default: the one this file is in)

`claude plugin update` only delivers a new copy when plugin.json's version changes, so a shipped change without a
bump reaches anyone who already installed only once a release bumps the version. Feature branches and main may carry
shipped changes under the old version until then; the release bumps it once for all of them. Versions that disagree
or go down always fail. Python 3.9+, standard library only. Exit 1 on a failed check.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

PLUGIN = '.claude-plugin/plugin.json'
VERSIONED = (PLUGIN, '.claude-plugin/marketplace.json', 'extension/manifest.json', 'extension/package.json')
# What installed users run: the plugin copies these (the extension and scripts also land in ~/.french-weave).
SHIPPED = ('.claude-plugin/', 'scripts/', 'hooks/', 'commands/', 'skills/', 'agents/', 'data/', 'extension/')
# Inside those, files only developers use (setup never copies them).
NOT_SHIPPED = ('extension/test/', 'extension/node_modules/', 'extension/package.json', 'extension/bun.lock',
               'extension/bun.lockb')
ZERO = re.compile(r'^0+$')  # GitHub's "before" SHA for a new branch


def git(repo, *args, check=True):
    result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True)
    if check and result.returncode:
        raise RuntimeError(f'git {" ".join(args)}: {result.stderr.strip()}')
    return result


def read(repo, path, ref=None):
    """Parsed JSON of path at ref (None: the working tree), or None when it doesn't exist."""
    if ref is None:
        file = Path(repo) / path
        return json.loads(file.read_text()) if file.exists() else None
    result = git(repo, 'show', f'{ref}:{path}', check=False)
    return json.loads(result.stdout) if result.returncode == 0 else None


def versions(repo, ref=None):
    """{file: version} for every versioned file that exists and carries a version."""
    found = {}
    for path in VERSIONED:
        data = read(repo, path, ref)
        if data is None:
            continue
        if path.endswith('marketplace.json'):
            entries = [p for p in data.get('plugins', []) if isinstance(p, dict) and 'version' in p]
            if 'version' in (data.get('metadata') or {}):
                found[f'{path} (metadata)'] = str(data['metadata']['version'])
            for entry in entries:
                found[f'{path} ({entry.get("name", "plugin")})'] = str(entry['version'])
        elif 'version' in data:
            found[path] = str(data['version'])
    return found


def shipped(path):
    return path.startswith(SHIPPED) and not path.startswith(NOT_SHIPPED)


def key(version):
    return tuple(int(part) if part.isdigit() else 0 for part in re.split(r'[.+-]', version))


def check(repo, base=None, head=None, release=False):
    """Lists of problems (empty: all good), warnings and notes. A missing bump is a warning, or a problem for a release."""
    problems, warnings, notes = [], [], []
    found = versions(repo, head)
    if PLUGIN not in found:
        return [f'{PLUGIN} has no version.'], warnings, notes
    if len(set(found.values())) > 1:
        problems.append('Versions disagree; set them all to the same value:\n' +
                        '\n'.join(f'  {path}: {version}' for path, version in found.items()))
    if not base or ZERO.match(base):
        notes.append('No base to compare with: skipped the version-bump check.')
        return problems, warnings, notes
    if git(repo, 'rev-parse', '--verify', '--quiet', f'{base}^{{commit}}', check=False).returncode:
        notes.append(f'Base {base} is not in this clone (fetch more history): skipped the version-bump check.')
        return problems, warnings, notes
    merge_base = git(repo, 'merge-base', base, head or 'HEAD').stdout.strip()
    diff = ['diff', '--name-only', merge_base] + ([head] if head else [])
    changed = [p for p in git(repo, *diff).stdout.splitlines() if shipped(p)]
    if not changed:
        notes.append('No shipped files changed: no version bump needed.')
        return problems, warnings, notes
    old = (read(repo, PLUGIN, merge_base) or {}).get('version')
    new = found[PLUGIN]
    if old is not None and str(old) == new:
        shown = ', '.join(changed[:8]) + (f' and {len(changed) - 8} more' if len(changed) > 8 else '')
        (problems if release else warnings).append(
            f'Files the plugin ships changed ({shown}), but {PLUGIN} is still version {new}. The release that ships '
            'them must bump the version (and extension/manifest.json and extension/package.json to match): `claude '
            'plugin update` only delivers a change to installed users when that version changes.')
    elif old is not None and key(new) < key(str(old)):
        problems.append(f'{PLUGIN} went from {old} down to {new}; versions only go up.')
    else:
        notes.append(f'Version {old} -> {new} for {len(changed)} shipped file(s).')
    return problems, warnings, notes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--base', help='compare with this ref (merge base with HEAD)')
    parser.add_argument('--head', help='check this ref instead of the working tree')
    parser.add_argument('--release', action='store_true', help='a missing version bump fails instead of warning')
    parser.add_argument('--repo', default=str(Path(__file__).resolve().parent.parent))
    args = parser.parse_args(argv)
    try:
        problems, warnings, notes = check(args.repo, args.base, args.head, args.release)
    except (RuntimeError, ValueError) as error:
        print(f'version check failed to run: {error}', file=sys.stderr)
        return 1
    for note in notes:
        print(note)
    for level, label, messages in (('warning', 'WARNING', warnings), ('error', 'FAIL', problems)):
        for message in messages:
            print(f'{label}: {message}')
            if os.environ.get('GITHUB_ACTIONS') == 'true':  # also as an annotation on the run's summary page
                print(f'::{level} title=Version check::' + message.replace('%', '%25').replace('\r', '')
                      .replace('\n', '%0A'))
    if not problems:
        print('Version check passed' + (' with a warning' if warnings else '') + ': '
              + ', '.join(sorted(set(versions(args.repo, args.head).values()))))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
