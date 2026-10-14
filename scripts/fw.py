#!/usr/bin/env python3
"""French Weave command line: setup, status, word and stage changes. Python 3.9+, standard library only.

  fw.py setup [--gemini-key-file FILE] [--user-data-dir DIR]... [--dry-run]
                                                     install the state dir, extension copy and native host;
                                                     --user-data-dir also registers the host for a browser run
                                                     with that --user-data-dir (Chromium looks there)
  fw.py status                                       stage, word counts, learning words
  fw.py known WORD...                                mark words as known
  fw.py learn WORD...                                put words back in the learning set (shaky)
  fw.py stage N|auto                                 pin the stage (1-4) or let it follow known words
  fw.py pause | resume                               stop or restart French in chat and on X
  fw.py refresh                                      rescan chat transcripts and apply the promotion rules
  fw.py check                                        verify the state, extension folder and native host
  fw.py uninstall [--dry-run]                        remove the native host manifests (keeps your word state)
"""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fwlib  # noqa: E402

HOST_NAME = 'com.frenchweave.host'
EXTENSION_ID = 'ckihjnkijacemibkblmjfjgpffflbced'  # fixed by the "key" in extension/manifest.json


def host_dirs(extra=()):
    """User-level NativeMessagingHosts folders for Google Chrome and Chromium on this OS, plus any extra
    browser user-data dirs (a browser started with --user-data-dir looks only inside that dir)."""
    home = Path.home()
    extra = [Path(d).expanduser().resolve() / 'NativeMessagingHosts' for d in extra]
    if sys.platform == 'darwin':
        base = home / 'Library' / 'Application Support'
        return [base / 'Google' / 'Chrome' / 'NativeMessagingHosts', base / 'Chromium' / 'NativeMessagingHosts'] + extra
    config = Path(os.environ.get('XDG_CONFIG_HOME') or home / '.config')
    return [config / 'google-chrome' / 'NativeMessagingHosts', config / 'chromium' / 'NativeMessagingHosts'] + extra


def plan(extra=()):
    root, home = fwlib.PLUGIN_ROOT, fwlib.home()
    return {
        'python': sys.executable,
        'python_version': platform.python_version(),
        'platform': sys.platform,
        'source': str(root),
        'state_dir': str(home),
        'extension_dir': str(home / 'extension'),
        'host_launcher': str(home / 'app' / 'fw-host'),
        'host_manifests': [str(d / f'{HOST_NAME}.json') for d in host_dirs(extra)],
        'extension_id': EXTENSION_ID,
    }


def setup(args):
    info = plan(args.user_data_dir)
    if sys.version_info < (3, 9):
        sys.exit(f'French Weave needs Python 3.9 or newer; this is {info["python_version"]}.')
    root, home = fwlib.PLUGIN_ROOT, fwlib.home()
    if not (root / 'extension' / 'manifest.json').exists():
        sys.exit(f'No extension/ folder next to {root / "scripts"}; run setup from a full copy of the repo.')
    key = None
    if args.gemini_key_file:
        key = Path(args.gemini_key_file).expanduser().read_text().strip()
        if not key:
            sys.exit('The Gemini key file is empty.')
    if args.dry_run:
        print(json.dumps(dict(info, dry_run=True, gemini_key='would be stored' if key else 'not given'), indent=1))
        return
    home.mkdir(parents=True, exist_ok=True)
    os.chmod(home, 0o700)
    # Stable copies: the plugin cache path changes on every update, Chrome needs fixed paths.
    for name, ignore in (('extension', shutil.ignore_patterns('test', 'node_modules', 'package.json', 'bun.lock')),
                         ('app/scripts', shutil.ignore_patterns('__pycache__')), ('app/data', None)):
        source = root / ('extension' if name == 'extension' else name.split('/')[1])
        target = home / name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source, target, ignore=ignore)
    launcher = home / 'app' / 'fw-host'
    launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{home / "app" / "scripts" / "fw_host.py"}" "$@"\n')
    launcher.chmod(0o755)
    manifest = {'name': HOST_NAME, 'description': 'French Weave word state', 'path': str(launcher), 'type': 'stdio',
                'allowed_origins': [f'chrome-extension://{EXTENSION_ID}/']}
    for directory in host_dirs(args.user_data_dir):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f'{HOST_NAME}.json').write_text(json.dumps(manifest, indent=1) + '\n')
    if key:
        path = home / 'gemini_key'
        path.write_text(key + '\n')
        path.chmod(0o600)
    with fwlib.editing() as state:
        pass  # creates the state on first run, adds new lexicon words on later runs
    print('French Weave is set up.')
    print(f'  word state:  {home / "state.json"} (Stage {fwlib.stage_for(state)}, '
          f'{sum(w["status"] == "active" for w in state["words"])} learning words)')
    print(f'  native host: {", ".join(info["host_manifests"])}')
    print(f'  Gemini key:  {"stored for the extension" if key or (home / "gemini_key").exists() else "not stored; paste it in the extension popup"}')
    print('Human steps left (Chrome blocks scripts from doing these):')
    print('  1. Open chrome://extensions and switch on Developer mode (top right).')
    print(f'  2. Click "Load unpacked" and pick: {home / "extension"}')
    if not key and not (home / 'gemini_key').exists():
        print('  3. Click the French Weave toolbar icon and paste a Gemini API key (https://aistudio.google.com/apikey).')
    print('Chat weaving runs wherever the plugin is enabled; sessions opened from now on pick it up.')


def check(_args):
    """Prints one line per check; exits 1 if any failed."""
    import struct
    import subprocess
    home, ok = fwlib.home(), True

    def report(passed, what):
        nonlocal ok
        ok = ok and passed
        print(f'{"ok  " if passed else "FAIL"} {what}')

    state = fwlib.load_state(create=False)
    report(state is not None, f'word state at {home / "state.json"}' + (f' (Stage {fwlib.stage_for(state)})' if state else ''))
    report((home / 'extension' / 'manifest.json').exists(), f'extension folder for Load unpacked: {home / "extension"}')
    for directory in host_dirs():
        path = directory / f'{HOST_NAME}.json'
        manifest = fwlib.read_json(path)
        report(bool(manifest) and manifest.get('allowed_origins') == [f'chrome-extension://{EXTENSION_ID}/'],
               f'native host manifest {path}')
    launcher = home / 'app' / 'fw-host'
    try:
        message = json.dumps({'type': 'ping'}).encode()
        out = subprocess.run([str(launcher)], input=struct.pack('=I', len(message)) + message, capture_output=True,
                             timeout=20).stdout
        report(json.loads(out[4:]).get('ok') is True, f'native host answers: {launcher}')
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        report(False, f'native host answers: {launcher} ({error.__class__.__name__})')
    has_key = (home / 'gemini_key').exists()
    print(f'{"ok  " if has_key else "note"} Gemini key {"stored by setup" if has_key else "not stored; paste it in the extension popup"}')
    if not ok:
        sys.exit(1)


def uninstall(args):
    for directory in host_dirs():
        path = directory / f'{HOST_NAME}.json'
        if path.exists():
            print(('would remove ' if args.dry_run else 'removed ') + str(path))
            if not args.dry_run:
                path.unlink()
    print(f'Your word state stays in {fwlib.home()}; delete that folder to start over.')


def status(_args):
    with fwlib.editing() as state:
        pass
    by = {}
    for w in state['words']:
        by.setdefault(w['status'], []).append(w)
    stage = fwlib.stage_for(state)
    print(f'French Weave: Stage {stage}{" (pinned)" if state.get("stage_pinned") else ""}'
          f'{", PAUSED" if state.get("paused") else ""}')
    print(f'  known {len(by.get("known", []))}, learning {len(by.get("active", []))}, '
          f'shaky {len(by.get("shaky", []))}, not yet introduced {len(by.get("queue", []))}')
    chat = (fwlib.read_json(fwlib.home() / 'exposure.json', {}) or {}).get('words', {})
    for name in ('shaky', 'active'):
        for w in by.get(name, []):
            days = len(fwlib.exposure_days(w, chat))
            print(f'  {name:6} {w["fr"]} = {w["en"]}, "{w["hint"]}"  (seen on {days} day{"s" if days != 1 else ""})')
    nxt = next((n for n, s in sorted(fwlib.STAGES) if fwlib.stage_for(state) < s), None)
    if nxt and not state.get('stage_pinned'):
        print(f'  next stage at {nxt} known words')


def mark(kind):
    def run(args):
        missing, done = [], []
        with fwlib.editing() as state:
            for chunk in (c for arg in args.words for c in arg.split(',')):
                chunk = chunk.strip()
                # "parce que" is one word; "et mais" is two.
                for word in [chunk] if fwlib.find(state, chunk) or ' ' not in chunk else chunk.split():
                    (done if fwlib.apply_event(state, word, kind) else missing).append(word)
        if done:
            print(f'{"Known" if kind == "known" else "Back to learning"}: {", ".join(done)}')
        if missing:
            print(f'Not in the word list: {", ".join(missing)}')
    return run


def stage(args):
    with fwlib.editing() as state:
        if args.value == 'auto':
            state['stage_pinned'] = False
        else:
            state['stage'], state['stage_pinned'] = int(args.value), True
    print(f'Stage {fwlib.stage_for(state)}{" (pinned)" if state["stage_pinned"] else " (automatic)"}')


def pause(value):
    def run(_args):
        with fwlib.editing() as state:
            state['paused'] = value
        print('French Weave paused: no French in chat or on X until you resume.' if value else 'French Weave resumed.')
    return run


def refresh(_args):
    fwlib.refresh_exposure()


def main(argv=None):
    parser = argparse.ArgumentParser(description='French Weave', formatter_class=argparse.RawDescriptionHelpFormatter,
                                     epilog=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('setup')
    p.add_argument('--gemini-key-file')
    p.add_argument('--user-data-dir', action='append', default=[])
    p.add_argument('--dry-run', action='store_true')
    p.set_defaults(run=setup)
    p = sub.add_parser('uninstall')
    p.add_argument('--dry-run', action='store_true')
    p.set_defaults(run=uninstall)
    sub.add_parser('status').set_defaults(run=status)
    sub.add_parser('check').set_defaults(run=check)
    for name, kind in (('known', 'known'), ('learn', 'asked')):
        p = sub.add_parser(name)
        p.add_argument('words', nargs='+')
        p.set_defaults(run=mark(kind))
    p = sub.add_parser('stage')
    p.add_argument('value', choices=['1', '2', '3', '4', 'auto'])
    p.set_defaults(run=stage)
    sub.add_parser('pause').set_defaults(run=pause(True))
    sub.add_parser('resume').set_defaults(run=pause(False))
    sub.add_parser('refresh').set_defaults(run=refresh)
    args = parser.parse_args(argv)
    args.run(args)


if __name__ == '__main__':
    main()
