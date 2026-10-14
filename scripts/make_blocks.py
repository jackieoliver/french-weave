#!/usr/bin/env python3
"""Writes blocks/level-NN.md: ready-made French Weave blocks for claude.ai and ChatGPT, no install needed.

Level k knows the lexicon's first (k-1)*PER_LEVEL words (it is in frequency/usefulness order) and learns the next
PER_LEVEL. Same rules source and state-line format as `fw.py export`, so the blocks can't drift from it.
Usage: python3 scripts/make_blocks.py [--check]   (--check: fail if blocks/ is out of date or a block is too long)
"""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export  # noqa: E402
import fwlib  # noqa: E402

PER_LEVEL = 30
KNOWN_NAMED = 40      # known words named one by one; above this a level block names the rank band
CLAUDE_AI_MAX = 6000  # claude.ai doesn't document a limit for personal preferences; stay well inside a few pages
OUT = fwlib.PLUGIN_ROOT / 'blocks'


def level_state(level, lexicon):
    known_until, learn_until = (level - 1) * PER_LEVEL, level * PER_LEVEL
    words = []
    for rank, w in enumerate(lexicon):
        status = 'known' if rank < known_until else 'active' if rank < learn_until else 'queue'
        words.append(dict(fwlib.blank(w), status=status, added='2026-01-01' if status != 'queue' else ''))
    return {'stage': 1, 'stage_pinned': False, 'paused': False, 'words': words}


def block(level, levels, lexicon):
    state = level_state(level, lexicon)
    stage = fwlib.stage_for(state)
    nxt = f'level-{level + 1:02d}.md' if level < levels else None
    tail = f'Level {level} of {levels}' + (f' (next: {nxt})' if nxt else '')
    claude = export.claude_ai(state, tail=tail, known_max=KNOWN_NAMED)
    about, respond = export.chatgpt(state, tail=tail)
    first, last = (level - 1) * PER_LEVEL + 1, min(level * PER_LEVEL, len(lexicon))
    known = f'words ranked 1-{first - 1}' if first > 1 else 'none yet'
    text = (f'# French Weave level {level} of {levels} (Stage {stage})\n\n'
            f'Learning: words ranked {first}-{last} of the [French Weave list](../data/lexicon.csv). Known: {known}. '
            + (f'When these feel easy, paste [level {level + 1}]({nxt}) instead.\n\n' if nxt else 'This is the last level.\n\n')
            + '## claude.ai\n\nSettings > Profile > "What personal preferences should Claude consider in responses?" '
              'Paste the whole block, replacing any older French Weave block.\n\n'
            + f'```text\n{claude}\n```\n\n'
            + '## ChatGPT\n\nSettings > Personalization > Custom instructions. Each box fits the 1,500-character limit.\n\n'
            + f'"What would you like ChatGPT to know about you?"\n\n```text\n{about}\n```\n\n'
            + f'"How would you like ChatGPT to respond?"\n\n```text\n{respond}\n```\n')
    sizes = (len(claude), len(about), len(respond))
    return text, sizes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    lexicon = fwlib.load_lexicon()
    levels = -(-len(lexicon) // PER_LEVEL)
    stale, worst = [], [0, 0, 0]
    for level in range(1, levels + 1):
        text, sizes = block(level, levels, lexicon)
        worst = [max(a, b) for a, b in zip(worst, sizes)]
        if sizes[0] > CLAUDE_AI_MAX or max(sizes[1:]) > export.CHATGPT_LIMIT:
            sys.exit(f'level {level} too long: {sizes}')
        path = OUT / f'level-{level:02d}.md'
        if args.check:
            if not path.exists() or path.read_text() != text:
                stale.append(path.name)
        else:
            OUT.mkdir(exist_ok=True)
            path.write_text(text)
    if stale:
        sys.exit(f'blocks out of date: {", ".join(stale)}; run python3 scripts/make_blocks.py')
    print(f'{levels} levels; longest claude.ai block {worst[0]} chars, ChatGPT fields {worst[1]} / {worst[2]} '
          f'(limit {export.CHATGPT_LIMIT})')


if __name__ == '__main__':
    main()
