"""French output must not change when the rules are refactored: the hook brief, the calibration line and the
claude.ai / ChatGPT export blocks are compared byte for byte with files captured before the language-profile
refactor (tests/snapshots/french/). The extension's system prompt has its own snapshots (extension/test/).

Rewrite the files only for a deliberate wording change: python3 tests/test_french_snapshots.py --write
"""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOTS = ROOT / 'tests' / 'snapshots' / 'french'
sys.path.insert(0, str(ROOT / 'scripts'))
os.environ['FRENCH_WEAVE_NO_REFRESH'] = '1'

import export  # noqa: E402
import fwlib  # noqa: E402
import weave  # noqa: E402

DAY = '2026-10-01'
NOW = 1791000000  # a fixed sync time for the export state line


def french_state(known, stage):
    """The French list with the top `known` words known, a shaky word, and (banded) exceptions on both sides."""
    state = fwlib.new_state(DAY, fwlib.load_lexicon(fwlib.LEXICON), known_top=known)
    words = state['words']
    fwlib.apply_event(state, words[3]['fr'], 'flip', DAY)  # avec: shaky
    if known >= fwlib.COLLAPSE_AT:
        words[20]['status'] = 'queue'  # not learned yet, inside the band
        fwlib.apply_event(state, words[400]['fr'], 'known', DAY)  # known, outside the band
    state.update(stage=stage, stage_pinned=True)
    return state


def seen(state):
    """Chat exposure that puts known words in every tier: a lot, sometimes, rarely."""
    known = [w['fr'] for w in state['words'] if w['status'] == 'known']
    lot = {'n': 50, 'days': [f'2026-10-0{i}' for i in range(1, 8)]}
    some = {'n': 12, 'days': ['2026-10-01', '2026-10-02', '2026-10-03']}
    rare = {'n': 1, 'days': ['2026-10-02']}
    return {**{fr: lot for fr in known[0:6]}, **{fr: some for fr in known[6:12]}, **{fr: rare for fr in known[12:18]}}


REPLIES = {
    'english': 'The build passes and the cache is warm, so nothing else needs doing before the release goes out today. ' * 3,
    'woven': 'The build passes, et the cache is warm, donc nothing else needs doing, mais avec care it ships sans delay. ' * 3,
    'drift': ("J'ai ajouté une section à README.md. Elle dit qu'un export vide supprime les lignes, mais la table reste, "
              "et je n'ai rien exécuté. Les autres problèmes sont dans sync.py, donc dis-moi si je dois les corriger. ") * 2,
}


def cases():
    """{snapshot name: text} for today's French output."""
    out = {}
    for banded, known in (('flat', 60), ('banded', 200)):
        for stage in (1, 2, 3, 4):
            state = french_state(known, stage)
            recall = next(w for w in fwlib.introduced(state) if w['status'] == 'shaky')
            out[f'brief-stage{stage}-{banded}'] = weave.brief(state, seen(state))
            out[f'brief-stage{stage}-{banded}-recall'] = weave.brief(state, seen(state), recall)
    for name, reply in REPLIES.items():
        out[f'calibration-{name}'] = weave.calibration(reply, french_state(60, 2))
    for label, known, stage in (('stage1', 60, 1), ('stage3', 160, 3), ('stage4-banded', 450, 4)):
        state = french_state(known, stage)
        out[f'export-claude-ai-{label}'] = export.claude_ai(state, now=NOW)
        about, respond = export.chatgpt(state, now=NOW)
        out[f'export-chatgpt-about-{label}'] = about
        out[f'export-chatgpt-respond-{label}'] = respond
    return out


def generate():
    with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {'FRENCH_WEAVE_HOME': home}):
        return cases()


class FrenchSnapshots(unittest.TestCase):
    def test_french_output_is_unchanged(self):
        texts = generate()
        self.assertEqual(sorted(p.stem for p in SNAPSHOTS.glob('*.txt')), sorted(texts))
        for name, text in texts.items():
            with self.subTest(name):
                self.assertEqual(text, (SNAPSHOTS / f'{name}.txt').read_text(encoding='utf-8'))


if __name__ == '__main__':
    if '--write' in sys.argv:
        SNAPSHOTS.mkdir(parents=True, exist_ok=True)
        for old in SNAPSHOTS.glob('*.txt'):
            old.unlink()
        for name, text in generate().items():
            (SNAPSHOTS / f'{name}.txt').write_text(text, encoding='utf-8')
        print(f'wrote {len(list(SNAPSHOTS.glob("*.txt")))} snapshots to {SNAPSHOTS}')
    else:
        unittest.main()
