#!/usr/bin/env python3
"""French Weave command line: setup, status, word and stage changes. Python 3.9+, standard library only.

  fw.py setup [--gemini-key-file FILE] [--user-data-dir DIR]... [--known-top N] [--sites all|ask] [--dry-run]
                                                     install the state dir, extension copy and native host;
                                                     --user-data-dir also registers the host for a browser run
                                                     with that --user-data-dir (Chromium looks there);
                                                     --known-top marks the top N lexicon words known unless
                                                     already introduced (40: some basics, 150: simple French);
                                                     --sites: extension on every site (all) or only ones you
                                                     turn on (ask)
  fw.py status                                       stage, word counts, learning words
  fw.py known WORD...                                mark words as known
  fw.py learn WORD...                                put words back in the learning set (shaky)
  fw.py stage N|auto                                 pin the stage (1-4) or let it follow known words
  fw.py pause | resume                               stop or restart French in chat and on X
  fw.py refresh                                      rescan chat transcripts and apply the promotion rules
  fw.py setup --codex [--dry-run]                    also add the chat hook to Codex CLI (~/.codex or $CODEX_HOME)
  fw.py export [--claude-ai | --chatgpt] [--log-day] paste-ready block for claude.ai preferences or ChatGPT
  fw.py log-chat-day                                 opt-in: count today as exposure for your learning words
  fw.py check                                        verify the state, extension folder and native host
  fw.py uninstall [--codex] [--dry-run]              remove the native host manifests (and the Codex hook)
"""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fwlib  # noqa: E402
import export  # noqa: E402

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
        'codex_cli': shutil.which('codex'),
    }


CODEX_MARK = 'french-weave'  # our Codex hook command always contains this (the state dir path)


def codex_command():
    return f'"{sys.executable}" "{fwlib.home() / "app" / "scripts" / "weave.py"}" --hook'


def is_ours(handler):
    command = handler.get('command', '') if isinstance(handler, dict) else ''
    return 'weave.py' in command and '--hook' in command and str(fwlib.home()) in command


def merge_codex_hooks(data, command):
    """hooks.json with our UserPromptSubmit handler added or updated in place; other hooks untouched."""
    data = data if isinstance(data, dict) else {}
    groups = data.setdefault('hooks', {}).setdefault('UserPromptSubmit', [])
    for group in groups:
        for handler in group.get('hooks', []):
            if is_ours(handler):
                handler['command'] = command  # same place, so Codex keeps the trust if nothing changed
                return data
    groups.append({'hooks': [{'type': 'command', 'command': command}]})
    return data


def enable_codex_hooks(text):
    """config.toml text with `hooks = true` in its [features] table (added if missing)."""
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if line.strip() == '[features]'), None)
    if start is None:
        return text.rstrip('\n') + ('\n\n' if text.strip() else '') + '[features]\nhooks = true\n'
    end = next((i for i in range(start + 1, len(lines)) if lines[i].lstrip().startswith('[')), len(lines))
    for i in range(start + 1, end):
        if re.match(r'\s*hooks\s*=', lines[i]):
            lines[i] = 'hooks = true'
            break
    else:
        lines.insert(start + 1, 'hooks = true')
    return '\n'.join(lines) + '\n'


def setup_codex(dry_run):
    codex = fwlib.codex_home()
    hooks_path, config_path = codex / 'hooks.json', codex / 'config.toml'
    data = merge_codex_hooks(fwlib.read_json(hooks_path, {}) if hooks_path.exists() else {}, codex_command())
    config = enable_codex_hooks(config_path.read_text() if config_path.exists() else '')
    if dry_run:
        print(json.dumps({'codex_hooks': str(hooks_path), 'codex_config': str(config_path), 'command': codex_command()},
                         indent=1))
        return
    if hooks_path.exists() and fwlib.read_json(hooks_path) is None:
        sys.exit(f'{hooks_path} is not valid JSON; fix it, then rerun setup --codex.')
    codex.mkdir(parents=True, exist_ok=True)
    for path in (hooks_path, config_path):
        backup = path.with_name(path.name + '.before-french-weave')
        if path.exists() and not backup.exists():
            shutil.copy2(path, backup)
    fwlib.write_json(hooks_path, data)
    config_path.write_text(config)
    print(f'Codex: chat hook in {hooks_path}, hooks enabled in {config_path}.')
    print('  Human step: start `codex` once; at "Hooks need review" pick "Trust all and continue" (or review first).')
    print('  Codex never runs a new hook before that. `codex exec` runs stay French-free either way.')


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
        print(json.dumps(dict(info, dry_run=True, gemini_key='would be stored' if key else 'not given',
                              known_top=args.known_top, sites=args.sites), indent=1))
        if args.codex:
            setup_codex(True)
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
    with fwlib.locked():
        if not (home / 'state.json').exists():  # first run: seed known words before the first learning words
            fwlib.save_state(fwlib.new_state(known_top=args.known_top))
    with fwlib.editing() as state:  # later runs: adds new lexicon words, seeds only words not yet introduced
        fwlib.seed_known(state, args.known_top)
        if args.sites:
            state.setdefault('prefs', {})['extension_sites'] = args.sites
    if args.codex:
        setup_codex(False)
    print('French Weave is set up.')
    print(f'  word state:  {home / "state.json"} (Stage {fwlib.stage_for(state)}, '
          f'{sum(w["status"] == "known" for w in state["words"])} known, '
          f'{sum(w["status"] == "active" for w in state["words"])} learning words)')
    sites = (state.get('prefs') or {}).get('extension_sites', 'all')
    print(f'  extension:   {"every site; turn any off from the toolbar" if sites == "all" else "only sites you turn on"}')
    print(f'  native host: {", ".join(info["host_manifests"])}')
    print(f'  Gemini key:  {"stored for the extension" if key or (home / "gemini_key").exists() else "not stored; paste it in the extension popup"}')
    print('Human steps left (Chrome blocks scripts from doing these):')
    print('  1. Open chrome://extensions and switch on Developer mode (top right).')
    print(f'  2. Click "Load unpacked" and pick: {home / "extension"}')
    print('  3. Pin the French Weave toolbar icon (puzzle piece menu) and click it:')
    if sites == 'all':
        print('     click "Allow all websites" (Chrome asks once; until then it runs only on X).')
    else:
        print('     on each site you want, tick "This site" (Chrome asks for that site).')
    if not key and not (home / 'gemini_key').exists():
        print('     Paste a Gemini API key (https://aistudio.google.com/apikey).')
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
    hooks = fwlib.read_json(fwlib.codex_home() / 'hooks.json', {}) or {}
    groups = (hooks.get('hooks') or {}).get('UserPromptSubmit') or []
    if any(is_ours(h) for g in groups for h in g.get('hooks', [])):
        config = (fwlib.codex_home() / 'config.toml')
        enabled = config.exists() and enable_codex_hooks(config.read_text()) == config.read_text().rstrip('\n') + '\n'
        report(enabled, f'Codex hook in {fwlib.codex_home() / "hooks.json"} with [features] hooks = true '
                        '(Codex asks you to trust it on first start)')
    has_key = (home / 'gemini_key').exists()
    print(f'{"ok  " if has_key else "note"} Gemini key {"stored by setup" if has_key else "not stored; paste it in the extension popup"}')
    if not ok:
        sys.exit(1)


def uninstall(args):
    if args.codex:
        path = fwlib.codex_home() / 'hooks.json'
        data = fwlib.read_json(path, {}) or {}
        groups = (data.get('hooks') or {}).get('UserPromptSubmit') or []
        kept = [g for g in ({**g, 'hooks': [h for h in g.get('hooks', []) if not is_ours(h)]} for g in groups) if g['hooks']]
        if len(kept) != len(groups) or sum(len(g['hooks']) for g in kept) != sum(len(g.get('hooks', [])) for g in groups):
            print(('would remove' if args.dry_run else 'removed') + f' the French Weave hook from {path}')
            if not args.dry_run:
                data['hooks']['UserPromptSubmit'] = kept
                fwlib.write_json(path, data)
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


def export_cmd(args):
    with fwlib.editing() as state:
        logged = export.log_chat_day(state) if args.log_day else 0
        export.mark_exported(state, 'chatgpt' if args.chatgpt else 'claude-ai')
    if args.chatgpt:
        about, respond = export.chatgpt(state)
        print(f'ChatGPT > Settings > Personalization > Custom instructions. Each field holds {export.CHATGPT_LIMIT} '
              'characters on every plan.\n')
        print(f'--- "What would you like ChatGPT to know about you?" ({len(about)} characters) ---\n{about}\n')
        print(f'--- "How would you like ChatGPT to respond?" ({len(respond)} characters) ---\n{respond}')
    else:
        block = export.claude_ai(state)
        print(f'claude.ai > Settings > Profile > personal preferences. Replace the old French Weave block '
              f'({len(block)} characters):\n\n{block}')
    if logged:
        print(f'\n(Counted today as chat exposure for {logged} learning words.)')


def log_chat_day(_args):
    with fwlib.editing() as state:
        logged = export.log_chat_day(state)
    print(f'Counted today as chat exposure for {logged} learning words (never enough on its own to make a word known).')


def refresh(_args):
    fwlib.refresh_exposure()


def main(argv=None):
    parser = argparse.ArgumentParser(description='French Weave', formatter_class=argparse.RawDescriptionHelpFormatter,
                                     epilog=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('setup')
    p.add_argument('--gemini-key-file')
    p.add_argument('--user-data-dir', action='append', default=[])
    p.add_argument('--codex', action='store_true')
    p.add_argument('--known-top', type=int, default=0, metavar='N')
    p.add_argument('--sites', choices=['all', 'ask'])
    p.add_argument('--dry-run', action='store_true')
    p.set_defaults(run=setup)
    p = sub.add_parser('uninstall')
    p.add_argument('--codex', action='store_true')
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
    p = sub.add_parser('export')
    target = p.add_mutually_exclusive_group()
    target.add_argument('--claude-ai', action='store_true')
    target.add_argument('--chatgpt', action='store_true')
    p.add_argument('--log-day', action='store_true', help='also count today as exposure (see log-chat-day)')
    p.set_defaults(run=export_cmd)
    sub.add_parser('log-chat-day').set_defaults(run=log_chat_day)
    args = parser.parse_args(argv)
    args.run(args)


if __name__ == '__main__':
    main()
