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
  fw.py setup --backup-key-file FILE --anthropic-key-file FILE --openrouter-key-file FILE
                                                     also store a backup Gemini key and paid Anthropic and
                                                     OpenRouter keys for the extension (a key pasted in its
                                                     popup wins)
  fw.py setup --language NAME [--lexicon FILE]       learn another language from a word list (columns word,en,hint;
                                                     default data/lexicons/<name>.csv); the old language's state and
                                                     word list are kept and come back when you switch back
  fw.py status                                       stage, word counts, learning words
  fw.py known WORD...                                mark words as known
  fw.py learn WORD...                                put words back in the learning set (shaky)
  fw.py stage N|auto                                 pin the stage (1-4) or let it follow known words
  fw.py pause | resume                               stop or restart French in chat and on websites
  fw.py refresh                                      rescan chat transcripts and apply the promotion rules
  fw.py setup --codex [--dry-run]                    also add the chat hook to Codex CLI (~/.codex or $CODEX_HOME)
  fw.py export [--claude-ai | --chatgpt] [--log-day] paste-ready block for claude.ai preferences or ChatGPT
  fw.py log-chat-day                                 opt-in: count today as exposure for your learning words
  fw.py check                                        verify the state, extension folder and native host
  fw.py uninstall [--codex] [--dry-run]              remove the native host manifests (and the Codex hook)
"""
import argparse
import csv
import datetime as dt
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fwlib  # noqa: E402
import export  # noqa: E402

try:
    import tomllib
except ImportError:  # Python 3.9 and 3.10: no TOML parser in the standard library
    tomllib = None

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


TABLE = re.compile(r'\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(#.*)?$')
HOOKS_KEY = re.compile(r'\s*(hooks|"hooks"|\'hooks\')\s*=')
CODEX_LINE = 'hooks = true'


def hooks_on(text):
    """Whether config.toml text parses with hooks = true in [features]; None without tomllib (Python 3.9, 3.10)."""
    if tomllib is None:
        return None
    try:
        return tomllib.loads(text).get('features', {}).get('hooks') is True
    except (tomllib.TOMLDecodeError, AttributeError):
        return False


def enable_codex_hooks(text):
    """config.toml text with `hooks = true` in its [features] table (added if missing), or None when the file
    can't be edited safely (features as an inline table or dotted keys, or a result that doesn't parse)."""
    lines = text.splitlines()
    tables = [(i, m.group(1).strip('"\'')) for i, m in ((i, TABLE.match(line)) for i, line in enumerate(lines)) if m]
    top = lines[:tables[0][0]] if tables else lines
    if any(re.match(r'\s*["\']?features["\']?\s*[.=]', line) for line in top):
        return None
    start = next((i for i, name in tables if name == 'features' and not lines[i].lstrip().startswith('[[')), None)
    if start is None:
        out = text.rstrip('\n') + ('\n\n' if text.strip() else '') + f'[features]\n{CODEX_LINE}\n'
    else:
        end = next((i for i, _ in tables if i > start), len(lines))
        for i in range(start + 1, end):
            if HOOKS_KEY.match(lines[i]):
                lines[i] = CODEX_LINE
                break
        else:
            lines.insert(start + 1, CODEX_LINE)
        out = '\n'.join(lines) + '\n'
    return None if hooks_on(out) is False else out


def claude_settings():
    """Claude Code's user settings file and its contents ({} when missing, None when it isn't a JSON object)."""
    path = fwlib.claude_home() / 'settings.json'
    data = fwlib.read_json(path) if path.exists() else {}
    return path, data if isinstance(data, dict) else None


def write_claude_settings(path, data):
    backup = path.with_name(path.name + '.before-french-weave')
    if path.exists() and not backup.exists():
        shutil.copy2(path, backup)
    temporary = path.with_name(f'{path.name}.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, path)


def enable_auto_update(dry_run):
    """Turns on Claude Code's auto-update for this marketplace (off by default outside Anthropic's marketplaces)
    with the documented extraKnownMarketplaces setting, unless the person already chose either way. Returns the
    line for the setup summary, or None when French Weave isn't installed as a Claude Code plugin."""
    source = fwlib.marketplace_source()
    if not source:
        return None
    choice = fwlib.auto_update()
    if choice is not None:
        return 'on' if choice else 'off (your choice; /plugin, Marketplaces, french-weave turns it on)'
    if source.get('source') not in ('github', 'git', 'url'):
        return 'off (installed from a folder on this computer; update that folder, then run claude plugin update)'
    path, settings = claude_settings()
    extra = settings.get('extraKnownMarketplaces', {}) if settings is not None else None
    if not isinstance(extra, dict):
        return f'off ({path} is not valid JSON, so setup left it alone)'
    if not dry_run:
        extra[fwlib.MARKETPLACE] = {**(extra.get(fwlib.MARKETPLACE) or {'source': source}), 'autoUpdate': True}
        settings['extraKnownMarketplaces'] = extra
        write_claude_settings(path, settings)
    return 'on (Claude Code checks after you start a session; turn off in /plugin, Marketplaces, french-weave)'


def turn_off_narration(dry_run):
    """Turns off Claude Code's mid-turn narration (its server rewrites some progress notes into short updates of its
    own) with the CLAUDE_CODE_THINKING_DISPLAY_UPDATES env setting, unless the person already set it. Those rewrites
    ignore the weave: in one person's chats they dropped every French word in 399 of 408 notes and wrote 6 entirely in
    French. Returns the line for the setup summary, or None when Claude Code isn't set up on this computer."""
    if not fwlib.claude_home().is_dir():
        return None
    path, settings = claude_settings()
    if settings is None:
        return f'left alone ({path} is not valid JSON)'
    env = settings.get('env', {})
    if not isinstance(env, dict):
        return f'left alone ("env" in {path} is not an object)'
    if fwlib.NARRATION_ENV in env:
        return 'off' if fwlib.narration_off() else 'on (your choice)'
    if not dry_run:
        settings['env'] = {**env, fwlib.NARRATION_ENV: '0'}
        write_claude_settings(path, settings)
    return (f'off (its rewrites of mid-turn notes drop the French; to undo, delete {fwlib.NARRATION_ENV} from "env" '
            f'in {path})')


def setup_codex(dry_run):
    codex = fwlib.codex_home()
    hooks_path, config_path = codex / 'hooks.json', codex / 'config.toml'
    data = merge_codex_hooks(fwlib.read_json(hooks_path, {}) if hooks_path.exists() else {}, codex_command())
    original = config_path.read_text() if config_path.exists() else ''
    config = original if hooks_on(original) else enable_codex_hooks(original)
    manual = (f'  Could not edit {config_path} safely; add the line `{CODEX_LINE}` to its [features] table yourself '
              '(inside the braces if it is written as features = { ... }).')
    if dry_run:
        print(json.dumps({'codex_hooks': str(hooks_path), 'codex_config': str(config_path), 'command': codex_command(),
                          'codex_config_edit': 'manual' if config is None else 'automatic'}, indent=1))
        return
    if hooks_path.exists() and fwlib.read_json(hooks_path) is None:
        sys.exit(f'{hooks_path} is not valid JSON; fix it, then rerun setup --codex.')
    codex.mkdir(parents=True, exist_ok=True)
    for path in (hooks_path, config_path):
        backup = path.with_name(path.name + '.before-french-weave')
        if path.exists() and not backup.exists():
            shutil.copy2(path, backup)
    fwlib.write_json(hooks_path, data)
    if config is None:
        print(f'Codex: chat hook in {hooks_path}.')
        print(manual)
    else:
        if config != original:
            config_path.write_text(config)
        print(f'Codex: chat hook in {hooks_path}, hooks enabled in {config_path}.')
    print('  Human step: start `codex` once; at "Hooks need review" pick "Trust all and continue" (or review first).')
    print('  Codex never runs a new hook before that. `codex exec` runs stay French-free either way.')


KEY_SHAPE = re.compile(r'^(?:[A-Za-z0-9]{1,8}\.)?[A-Za-z0-9_-]{30,64}$')  # AIza… keys, and newer ones like AQ.…
OPENROUTER_SHAPE = re.compile(r'^sk-or-[A-Za-z0-9_-]{20,120}$')
ANTHROPIC_SHAPE = re.compile(r'^sk-ant-[A-Za-z0-9_-]{20,200}$')
# Setup option -> (file in the state folder, what it is, its shape, what it starts with). The native host hands each
# stored key to the extension's background worker; a key pasted in the popup still wins over the stored one.
KEY_FILES = {
    'gemini_key_file': ('gemini_key', 'Gemini key', KEY_SHAPE, 'AIza… or AQ.…'),
    'backup_key_file': ('gemini_backup_key', 'backup Gemini key', KEY_SHAPE, 'AIza… or AQ.…'),
    'openrouter_key_file': ('openrouter_key', 'OpenRouter key', OPENROUTER_SHAPE, 'sk-or-…'),
    'anthropic_key_file': ('anthropic_key', 'Anthropic key', ANTHROPIC_SHAPE, 'sk-ant-…'),
}


def read_key_file(arg, what='Gemini key', shape=KEY_SHAPE, starts='AIza… or AQ.…'):
    """The key from a file. Never echoes the argument, the path or the contents, since any of them may be the key."""
    path = Path(arg).expanduser()
    if not path.is_file() and (arg.startswith(('AIza', 'sk-or-', 'sk-ant-')) or KEY_SHAPE.match(arg) or OPENROUTER_SHAPE.match(arg)
                               or ANTHROPIC_SHAPE.match(arg)):
        sys.exit('That looks like a key, not a file path; paste the key into the extension popup instead.')
    try:
        key = path.read_text().strip()
    except (OSError, UnicodeDecodeError):
        sys.exit(f'Could not read the {what} file.')
    if not shape.match(key):
        sys.exit(f'The {what} file should hold only the key ({starts}).')
    return key


def named(state):
    """'Spanish, ' before the stage in setup and status output; nothing for French."""
    language = fwlib.language(state)
    return '' if language == fwlib.DEFAULT_LANGUAGE else f'{language}, '


def set_language(name, lexicon, home):
    """Installs the word list for a language as <home>/lexicon.csv (French: the bundled list) and, when the language
    changes, sets the current state and word list aside as state-<language>.json and lexicon-<language>.csv and
    brings back ones saved for the new language. Word list: --lexicon, else the saved one, else the bundled one."""
    name = ' '.join(name.split())
    bundled = fwlib.PLUGIN_ROOT / 'data' / 'lexicons' / f'{name.lower()}.csv'
    saved_list = home / f'lexicon-{name.lower()}.csv'
    source = (Path(lexicon).expanduser() if lexicon else saved_list if saved_list.exists()
              else bundled if bundled.exists() else None)
    if source is None and name.lower() != fwlib.DEFAULT_LANGUAGE.lower():
        sys.exit(f'No word list for {name}: pass --lexicon FILE, a CSV with columns word,en,hint (README "Other languages").')
    try:
        words = fwlib.load_lexicon(source) if source else []
    except (OSError, UnicodeDecodeError, csv.Error) as error:
        sys.exit(f'Could not read the word list: {error.__class__.__name__}.')
    if source and (not words or not all(w['en'] for w in words)):
        sys.exit('The word list needs a header row word,en,hint and an English gloss on every row.')
    name = fwlib.DEFAULT_LANGUAGE if not source else name
    state = fwlib.load_state(create=False, lock=False)
    old = fwlib.language(state)
    if state and old.lower() != name.lower():
        os.replace(home / 'state.json', home / f'state-{old.lower()}.json')
        if (home / 'lexicon.csv').exists():
            os.replace(home / 'lexicon.csv', home / f'lexicon-{old.lower()}.csv')
        saved = home / f'state-{name.lower()}.json'
        if saved.exists():
            os.replace(saved, home / 'state.json')
    if source:
        shutil.copyfile(source, home / 'lexicon.csv')
    elif (home / 'lexicon.csv').exists():
        (home / 'lexicon.csv').unlink()
    if saved_list.exists():
        saved_list.unlink()  # back in use as lexicon.csv, or replaced by --lexicon
    return name, len(words)


def setup(args):
    if sys.platform == 'win32':
        sys.exit('French Weave setup supports macOS and Linux only for now. On Windows, run Claude Code or Codex '
                 'inside WSL, or paste a block from blocks/ into claude.ai or ChatGPT.')
    info = plan(args.user_data_dir)
    if sys.version_info < (3, 9):
        sys.exit(f'French Weave needs Python 3.9 or newer; this is {info["python_version"]}.')
    root, home = fwlib.PLUGIN_ROOT, fwlib.home()
    installed = root.resolve() == (home / 'app').resolve()  # run from the copy setup made: nothing to copy
    if not installed and not (root / 'extension' / 'manifest.json').exists():
        sys.exit(f'No extension/ folder next to {root / "scripts"}; run setup from a full copy of the repo.')
    keys = {opt: read_key_file(getattr(args, opt), *KEY_FILES[opt][1:]) for opt in KEY_FILES if getattr(args, opt)}
    key = keys.get('gemini_key_file')
    if args.lexicon and not args.language:
        sys.exit('--lexicon needs --language NAME too, like --language Spanish --lexicon spanish.csv.')
    if args.dry_run:
        print(json.dumps(dict(info, dry_run=True, **{name: 'would be stored' if opt in keys else 'not given'
                                                     for opt, (name, *_) in KEY_FILES.items()},
                              known_top=args.known_top, sites=args.sites, language=args.language), indent=1))
        if args.codex:
            setup_codex(True)
        updates = None if args.no_auto_update else enable_auto_update(True)
        if updates:
            print(f'updates: {updates}')
        narration = None if args.keep_narration else turn_off_narration(True)
        if narration:
            print(f'narration: {narration}')
        return
    home.mkdir(parents=True, exist_ok=True)
    os.chmod(home, 0o700)
    if not installed:
        with fwlib.locked('copies.lock'):
            fwlib.install_copies(root, home)
    launcher = home / 'app' / 'fw-host'
    launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{home / "app" / "scripts" / "fw_host.py"}" "$@"\n')
    launcher.chmod(0o755)
    manifest = {'name': HOST_NAME, 'description': 'French Weave word state', 'path': str(launcher), 'type': 'stdio',
                'allowed_origins': [f'chrome-extension://{EXTENSION_ID}/']}
    for directory in host_dirs(args.user_data_dir):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f'{HOST_NAME}.json').write_text(json.dumps(manifest, indent=1) + '\n')
    for opt, value in keys.items():
        path = home / KEY_FILES[opt][0]
        path.write_text(value + '\n')
        path.chmod(0o600)
    with fwlib.locked():
        language = set_language(args.language, args.lexicon, home)[0] if args.language else None
        if not (home / 'state.json').exists():  # first run: seed known words before the first learning words
            fwlib.save_state(fwlib.new_state(known_top=args.known_top))
    with fwlib.editing() as state:  # later runs: adds new lexicon words, seeds only words not yet introduced
        if language:
            state['language'] = language
        fwlib.seed_known(state, args.known_top)
        if args.sites:
            state.setdefault('prefs', {})['extension_sites'] = args.sites
    if args.codex:
        setup_codex(False)
    updates = None if args.no_auto_update else enable_auto_update(False)
    narration = None if args.keep_narration else turn_off_narration(False)
    print('French Weave is set up.')
    print(f'  word state:  {home / "state.json"} ({named(state)}Stage {fwlib.stage_for(state)}, '
          f'{sum(w["status"] == "known" for w in state["words"])} known, '
          f'{sum(w["status"] == "active" for w in state["words"])} learning words)')
    sites = (state.get('prefs') or {}).get('extension_sites', 'all')
    print(f'  extension:   {"every site; turn any off from the toolbar" if sites == "all" else "only sites you turn on"}')
    print(f'  native host: {", ".join(info["host_manifests"])}')
    print(f'  Gemini key:  {"stored for the extension" if key or (home / "gemini_key").exists() else "not stored; the extension swaps a few fixed words until you paste one in its popup"}')
    for name, label in (('gemini_backup_key', 'backup key: '), ('anthropic_key', 'Anthropic:  '), ('openrouter_key', 'OpenRouter: ')):
        if (home / name).exists():
            print(f'  {label} stored for the extension')
    if updates:
        print(f'  updates:     {updates}')
    if narration:
        print(f'  narration:   {narration}')
    print('Human steps left (Chrome blocks scripts from doing these):')
    print('  1. Open chrome://extensions and switch on Developer mode (top right).')
    print(f'  2. Click "Load unpacked" and pick: {home / "extension"}')
    print('  3. Pin the French Weave toolbar icon (puzzle piece menu) and click it:')
    if sites == 'all':
        print('     click "Allow all websites" (Chrome asks once; until then it runs only on x.com).')
    else:
        print("     on each site you want, tick the box next to the site's name (Chrome asks for that site).")
    if not key and not (home / 'gemini_key').exists():
        print('     Optional: paste a Gemini API key (https://aistudio.google.com/apikey). Without one, the extension swaps')
        print('     only a few fixed words and sends no page text anywhere.')
        print('     With a free key, Google may use the page text it is sent to improve its products; a paid key avoids that.')
    print('Chat weaving and the /french-weave:* commands start in new Claude Code sessions; in an open session, type '
          '/reload-plugins first.')


def ago(at, now=None):
    """'5m ago' for an ISO 8601 time, '' when it can't be read."""
    try:
        then = dt.datetime.fromisoformat(at)
        now = now or dt.datetime.now(then.tzinfo)
        minutes = max(0, round((now - then).total_seconds() / 60))
    except (TypeError, ValueError):
        return ''
    if minutes < 1:
        return 'just now'
    if minutes < 60:
        return f'{minutes}m ago'
    return f'{round(minutes / 60)}h ago' if minutes < 24 * 60 else f'{round(minutes / 1440)}d ago'


def extension_running(seen, disk, now=None):
    """check's line on the version Chrome runs: (prefix, text). seen: fwlib.extension_seen(); disk: the version in
    <state dir>/extension/manifest.json ('' when missing). A difference is a warning, not a failure: Chrome may simply
    not have run the extension since the update."""
    if not seen:
        return 'note', ('extension running version not reported yet (0.2.9 and later report it each time they sync with '
                        'the native host: open the toolbar popup, or wait up to 30 minutes with Chrome open)')
    when = seen['at'] + (f' ({ago(seen["at"], now)})' if ago(seen['at'], now) else '')
    if disk and seen['version'] != disk:
        return 'warn', (f'extension running {seen["version"]} (seen {when}), but the copy on disk is {disk}: Chrome has not '
                        'reloaded it yet. It reloads itself within about 5 minutes while Chrome is open, or right away '
                        'when you open its toolbar popup; else click the reload arrow on French Weave in chrome://extensions')
    return 'ok  ', f'extension running {seen["version"]}, seen {when}' + ('' if disk else ' (no copy on disk to compare)')


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
    disk = str((fwlib.read_json(home / 'extension' / 'manifest.json', {}) or {}).get('version') or '')
    print('{} {}'.format(*extension_running(fwlib.extension_seen(), disk)))
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
        text = config.read_text() if config.exists() else ''
        enabled = hooks_on(text)
        enabled = enable_codex_hooks(text) == text.rstrip('\n') + '\n' if enabled is None else enabled
        report(enabled, f'Codex hook in {fwlib.codex_home() / "hooks.json"} with [features] hooks = true '
                        '(Codex asks you to trust it on first start)')
    has_key = (home / 'gemini_key').exists()
    print(f'{"ok  " if has_key else "note"} Gemini key {"stored by setup" if has_key else "not stored; the extension swaps a few fixed words until you paste one in its popup"}')
    for name, what in (('gemini_backup_key', 'backup Gemini key'), ('anthropic_key', 'Anthropic key'), ('openrouter_key', 'OpenRouter key')):
        if (home / name).exists():
            print(f'ok   {what} stored by setup')
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
        if not args.dry_run:  # setup made these folders even with no Chrome installed; drop them if now empty
            for folder in (directory, directory.parent):
                try:
                    folder.rmdir()
                except OSError:
                    break
    print(f'Your word state stays in {fwlib.home()}; delete that folder to start over.')


def status(_args):
    with fwlib.editing() as state:
        pass
    by = {}
    for w in state['words']:
        by.setdefault(w['status'], []).append(w)
    stage = fwlib.stage_for(state)
    print(f'French Weave: {named(state)}Stage {stage}{" (pinned)" if state.get("stage_pinned") else ""}'
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
        if not any(arg.strip(' ,') for arg in args.words):
            print(f'No word given. Name one, for example: {"known" if kind == "known" else "learn"} mais')
            return
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
        print('French Weave paused: no French in chat or on websites until you resume (pasted claude.ai or ChatGPT blocks '
              'stay as they are). Chat stops now; the Chrome extension stops within about 2 minutes, before it sends any '
              'more page text (the On switch in its toolbar popup turns it off at once).' if value else
              'French Weave resumed. The Chrome extension picks this up on the next page you open after about 2 minutes, or '
              'right away from Sync words in its popup.')
    return run


def copy_to_clipboard(text):
    """Best effort: pbcopy (macOS), wl-copy or xclip (Linux). True when one of them took the text."""
    for cmd in (['pbcopy'], ['wl-copy'], ['xclip', '-selection', 'clipboard']):
        if shutil.which(cmd[0]):
            try:
                subprocess.run(cmd, input=text, text=True, check=True, timeout=5,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return True
            except (OSError, subprocess.SubprocessError):
                continue
    return False


def save_export(name, text):
    """Blocks copied out of a terminal pick up line breaks and indentation, so each one is also saved as a file."""
    path = fwlib.home() / 'export' / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + '\n', encoding='utf-8')
    return path


def export_cmd(args):
    with fwlib.editing() as state:
        logged = export.log_chat_day(state) if args.log_day else 0
        export.mark_exported(state, 'chatgpt' if args.chatgpt else 'claude-ai')
    if args.chatgpt:
        try:
            about, respond = export.chatgpt(state)
        except ValueError as error:
            sys.exit(f'No ChatGPT block: {error}. Use the claude.ai block (fw.py export) instead.')
        parsed = export.parse_state_line(about)
        left_out = (sum(w['status'] in ('active', 'shaky') for w in state['words'])
                    - len(parsed.get('active', [])) - len(parsed.get('shaky', [])))
        paths = [save_export('chatgpt-about.txt', about), save_export('chatgpt-respond.txt', respond)]
        print(f'ChatGPT > Settings > Personalization > Custom instructions. Each field holds {export.CHATGPT_LIMIT} '
              'characters on every plan.\n')
        print(f'--- "What would you like ChatGPT to know about you?" ({len(about)} characters) ---\n{about}\n')
        print(f'--- "How would you like ChatGPT to respond?" ({len(respond)} characters) ---\n{respond}')
        print(f'\nAlso saved as {paths[0]} and {paths[1]}.')
        if left_out:
            print(f'{left_out} learning words were left out to fit the {export.CHATGPT_LIMIT}-character field.')
    else:
        block = export.claude_ai(state)
        path = save_export('claude-ai.txt', block)
        print(f'claude.ai > Settings > Profile > personal preferences. Replace the old French Weave block '
              f'({len(block)} characters):\n\n{block}')
        copied = args.copy and copy_to_clipboard(block)
        print(f'\n{"Copied to your clipboard, and a" if copied else "A"}lso saved as {path}.')
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
    p.add_argument('--backup-key-file', help='a second Gemini key, tried when the main one is out for the day')
    p.add_argument('--anthropic-key-file', help='paid: Claude Haiku 5.5 first at Levels 1-2, direct to Anthropic')
    p.add_argument('--openrouter-key-file', help='paid: Claude Haiku 5.5 first at Levels 1-2 without an Anthropic key, '
                   'else only when every Gemini step fails')
    p.add_argument('--user-data-dir', action='append', default=[])
    p.add_argument('--codex', action='store_true')
    p.add_argument('--known-top', type=int, default=0, metavar='N')
    p.add_argument('--sites', choices=['all', 'ask'])
    p.add_argument('--language', metavar='NAME')
    p.add_argument('--lexicon', metavar='FILE')
    p.add_argument('--no-auto-update', action='store_true', help="leave Claude Code's plugin auto-update setting alone")
    p.add_argument('--keep-narration', action='store_true', help="leave Claude Code's mid-turn narration setting alone")
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
    p.add_argument('--copy', action='store_true', help='also copy the claude.ai block to the clipboard')
    p.set_defaults(run=export_cmd)
    sub.add_parser('log-chat-day').set_defaults(run=log_chat_day)
    args = parser.parse_args(argv)
    args.run(args)


if __name__ == '__main__':
    main()
