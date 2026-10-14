#!/usr/bin/env python3
"""Live model check: runs realistic prompts through `claude -p` with only this plugin loaded and measures the French.

Isolation: empty temp working dir, --setting-sources project, CLAUDE_CODE_DISABLE_CLAUDE_MDS=1,
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1, no tools, no session persistence, and a temp French Weave state dir with an
empty transcript root, so your own config, CLAUDE.md, memory and word state stay out of it.

Usage: python3 tests/model_eval.py --models opus,sonnet --stages 1,2 --out DIR
Costs one model call per prompt x stage x model (5 x 2 x 2 = 20 by default).
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
import fwlib  # noqa: E402
import weave  # noqa: E402

PROMPTS = {
    'status': ("Quick status check on the database migration you're helping me with. Here's where things stand: the "
               "migration script ran on staging, two rows failed validation because of null emails, the rollback plan "
               "is written but untested, and prod is scheduled for Thursday. Summarize where we are and what's next."),
    'debug': ("My Python script crashes with KeyError: 'id' when parsing a JSON API response, but only sometimes. The "
              "line is user_id = data['user']['id']. What's likely going on and how do I fix it?"),
    'casual': "What's a good name for a cat that loves sitting in boxes?",
    'code': ("Give me a bash one-liner that finds the 5 largest files under the current directory, and explain briefly "
             "how it works."),
    'health': "I've had a headache for three days and ibuprofen isn't helping. Should I be worried?",
}
CODE_BLOCK = re.compile(r"```.*?```|`[^`\n]*`", re.S)


def make_state(home, stage):
    """Stage 1: a brand-new user. Stage 2: 45 known words with varied chat exposure and 8 learning words."""
    os.environ['FRENCH_WEAVE_HOME'] = str(home)
    state = fwlib.new_state('2026-09-01')
    exposure = {'words': {}, 'offsets': {}, 'recent': {}}
    if stage == 2:
        for i, w in enumerate(state['words'][:45]):
            fwlib.apply_event(state, w['fr'], 'known', '2026-09-01')
            days, n = ((8, 40) if i < 15 else (4, 12) if i < 30 else (1, 2))
            exposure['words'][w['fr']] = {'n': n, 'days': [f'2026-09-{d + 10:02d}' for d in range(days)]}
        for day in range(2, 6):
            fwlib.promote(state, f'2026-09-{day:02d}', {})
    fwlib.write_json(home / 'state.json', state)
    fwlib.write_json(home / 'exposure.json', exposure)
    return state


def sentences(text):
    prose = CODE_BLOCK.sub(' ', text)
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+|\n+', prose) if len(s.split()) >= 4]


def french_sentence(sentence, words):
    """A sentence that reads as French: several French grammar words, or most of its words French."""
    _, total, _, grammar = weave.share(sentence, words)
    french = weave.share(sentence, words)[0]
    return grammar >= 2 or (total >= 4 and french / total > 0.5)


def measure(text, state):
    words = fwlib.introduced(state)
    french, total, learning, grammar = weave.share(text, words)
    code = ' '.join(CODE_BLOCK.findall(text))
    code_french = sorted({w['fr'] for w in words if fwlib.norm(w['fr']) not in fwlib.UNMEASURABLE
                          and len(w['fr']) > 2 and fwlib.pattern(w['fr']).search(fwlib.norm(code))})
    lines = [l.strip() for l in text.strip().split('\n') if l.strip()]
    return {
        'percent': round(100 * french / total, 1) if total else 0.0, 'french': french, 'words': total,
        'learning_uses': learning, 'grammar_slips': grammar,
        'french_sentences': [s for s in sentences(text) if french_sentence(s, words)],
        'french_in_code': code_french,
        'recall_open': bool(lines) and lines[0].lower().startswith('recall:'),
        'recall_answer': any(re.match(r'\**recall:.*=', l, re.I) for l in lines[1:]),
        'footer': any(re.search(r'\(\s*[^()]+ = [^()]+"[^"]+"', l) for l in lines[-3:]),
    }


def run(model, stage, name, prompt, out):
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / 'work').mkdir()
        (tmp / 'transcripts').mkdir()
        state = make_state(tmp / 'fw', stage)
        env = dict(os.environ, FRENCH_WEAVE_HOME=str(tmp / 'fw'), FRENCH_WEAVE_TRANSCRIPTS=str(tmp / 'transcripts'),
                   CLAUDE_CODE_DISABLE_CLAUDE_MDS='1', CLAUDE_CODE_DISABLE_AUTO_MEMORY='1')
        result = subprocess.run(
            ['claude', '-p', '--model', model, '--setting-sources', 'project', '--plugin-dir', str(ROOT),
             '--no-session-persistence', '--tools', '', '--output-format', 'json', prompt],
            cwd=tmp / 'work', env=env, capture_output=True, text=True, timeout=600)
        brief = weave.brief(state, json.loads((tmp / 'fw' / 'exposure.json').read_text())['words'])
    try:
        data = json.loads(result.stdout)
    except ValueError:
        data = {'result': '', 'error': result.stdout[-500:] + result.stderr[-500:]}
    text = data.get('result') or ''
    row = {'model': model, 'served': sorted((data.get('modelUsage') or {}).keys()), 'stage': stage, 'prompt': name,
           'target': weave.STAGES[stage][0], 'cap': weave.STAGES[stage][1], **measure(text, state)}
    (out / f'{model}-s{stage}-{name}.md').write_text(f'<!-- {json.dumps(row, ensure_ascii=False)} -->\n{text}\n')
    if stage == 2 and name == 'status':
        (out / 'brief-stage2.txt').write_text(brief)
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', default='opus,sonnet')
    parser.add_argument('--stages', default='1,2')
    parser.add_argument('--prompts', default=','.join(PROMPTS))
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for model in args.models.split(','):
        for stage in map(int, args.stages.split(',')):
            for name in args.prompts.split(','):
                row = run(model, stage, name, PROMPTS[name], out)
                rows.append(row)
                print(json.dumps(row, ensure_ascii=False), flush=True)
    (out / 'results.json').write_text(json.dumps(rows, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
