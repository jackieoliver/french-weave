"""Language profiles (data/profiles/): every profile is well formed and the extension's copy is current; a non-French
profile fills the brief, calibration and exports with its own examples, sense notes and drift words and leaves no
French behind; a language with no profile, or a profile missing fields, falls back to the generic values."""
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
os.environ['FRENCH_WEAVE_NO_REFRESH'] = '1'

import export  # noqa: E402
import fwlib  # noqa: E402
import make_profiles  # noqa: E402
import weave  # noqa: E402

# A minimal fixture, not the real Spanish profile (that one comes with its word list).
SPANISH = {
    'language': 'Spanish',
    'variety': 'Latin American Spanish',
    'examples': {'swap_sentence': 'The build passes ahora, pero the cache is stale, entonces I cleared it.',
                 'full_sentences': ['La prueba pasa ahora.', 'Es el enfoque correcto.'],
                 'gloss': {'word': 'sin', 'en': 'without', 'hint': 'seen'},
                 'default_swaps': [['and', 'y'], ['but', 'pero'], ['now', 'ahora']]},
    'sense_notes': {'brief': 'por and para are not interchangeable',
                    'export': 'por and para are not interchangeable; ya means already',
                    'export_short': 'por/para differ'},
    'drift_words': ['yo', 'nosotros', 'está', 'estoy', 'tengo', 'hay'],
    'articles': {'definite': ['el', 'la', 'los', 'las'], 'indefinite': ['un', 'una'], 'elided': [],
                 'determiners': ['el', 'la', 'los', 'las', 'un', 'una', 'mi', 'tu']},
}
WORDS = [('y', 'and', 'ee'), ('pero', 'but', 'PEH-roh'), ('ahora', 'now', 'ah-OH-rah'), ('sin', 'without', 'seen'),
         ('el problema', 'the problem', 'el pro-BLEH-mah'), ('la casa', 'the house', 'lah KAH-sah')]
WORDS += [(f'palabra{i}', f'word {i}', 'pah-LAH-brah') for i in range(60)]
# French that must never show up in another language's text.
FRENCH = re.compile(r"French(?! [Ww]eave)|maintenant|\bdonc\b|\bmais\b|\bpour\b|\bsans\b|C'est|Le test|\bavant\b|"
                    r"\bpendant\b|\bça\b|grand win|\bseul\b|\bautre\b")


class Profiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / 'profiles'
        self.dir.mkdir()
        shutil.copy(fwlib.PROFILE_DIR / '_generic.json', self.dir)
        shutil.copy(fwlib.PROFILE_DIR / 'french.json', self.dir)
        self.patches = [mock.patch.object(fwlib, 'PROFILE_DIR', self.dir),
                        mock.patch.dict(os.environ, {'FRENCH_WEAVE_HOME': str(Path(self.tmp.name) / 'fw')})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def write(self, name, data):
        (self.dir / f'{name}.json').write_text(json.dumps(data, ensure_ascii=False))

    def state(self, language='Spanish', stage=1, known=20):
        lexicon = [{'fr': w, 'en': e, 'hint': h} for w, e, h in WORDS]
        state = fwlib.new_state('2026-10-01', lexicon, known_top=known)
        state.update(language=language, stage=stage, stage_pinned=True)
        return state

    def test_bundled_profiles_are_well_formed_and_the_extension_copy_is_current(self):
        self.assertEqual(make_profiles.check(fwlib.PLUGIN_ROOT / 'data' / 'profiles'), [])
        generic = make_profiles.load(fwlib.PLUGIN_ROOT / 'data' / 'profiles')['_generic']
        bad = {'language': 'Spanish', 'tone': 'warm', 'drift_words': 'yo', 'script': {'direction': 'up'},
               'examples': {'default_swaps': [['and']]}}
        found = '\n'.join(make_profiles.problems(bad, generic))
        for expected in ('tone: unknown field', 'drift_words: must be list', 'script.direction: must be one of',
                         "not an [English, word] pair: ['and']"):
            self.assertIn(expected, found)
        with tempfile.TemporaryDirectory() as out:  # a stale copy is reported
            stale = Path(out) / 'profile-data.js'
            stale.write_text('// old\n')
            self.assertIn('out of date', '\n'.join(make_profiles.check(fwlib.PLUGIN_ROOT / 'data' / 'profiles', stale)))

    def test_reading_schema_defaults_off(self):
        reading = fwlib.profile('French')['script']['reading']
        self.assertEqual(reading, {'early': 'none', 'late': 'none', 'late_from_stage': 0, 'late_only_with': '',
                                   'known_drop': False})
        japanese = {'language': 'Japanese', 'script': {'spaces': False, 'hint': 'romanization', 'hint_name': 'romaji',
                    'reading': {'early': 'romaji', 'late': 'kana', 'late_from_stage': 3, 'late_only_with': 'kanji',
                                'known_drop': True}}}
        generic = make_profiles.load(fwlib.PLUGIN_ROOT / 'data' / 'profiles')['_generic']
        self.assertEqual(make_profiles.problems(japanese, generic), [])
        self.write('japanese', japanese)
        self.assertEqual(fwlib.profile('Japanese')['script']['reading']['late'], 'kana')
        self.assertEqual(fwlib.profile('Japanese')['script']['marks'], 'accents')  # missing fields stay generic
        # A lexicon reading column reaches the extension's words; lists without one are unchanged.
        path = Path(self.tmp.name) / 'ja.csv'
        path.write_text('word,en,hint,reading\n猫,cat,neko,ねこ\nでも,but,demo,\n', encoding='utf-8')
        words = fwlib.load_lexicon(path)
        self.assertEqual((words[0]['reading'], 'reading' in words[1]), ('ねこ', False))
        state = fwlib.new_state('2026-10-01', words)
        self.assertEqual(fwlib.public_state(state)['words'][0]['reading'], 'ねこ')
        self.assertNotIn('reading', fwlib.public_state(fwlib.new_state('2026-10-01'))['words'][0])

    def test_a_non_french_profile_fills_the_brief_with_its_own_text(self):
        self.write('spanish', SPANISH)
        one, three = weave.brief(self.state(stage=1), {}), weave.brief(self.state(stage=3), {})
        self.assertIn('like "The build passes ahora, pero the cache is stale, entonces I cleared it." Never a Spanish', one)
        self.assertIn('instead (por and para are not interchangeable). If a reply runs long on Spanish', one)
        self.assertIn('like: (sin = without, "seen"); nothing to gloss', one)
        self.assertIn('learning Spanish passively. Use Latin American Spanish words and spellings. Write', one)
        self.assertIn('around it, like "La prueba pasa ahora." or "Es el enfoque correcto." Steps', three)
        recall = weave.brief(self.state(), {}, {'fr': 'ahora', 'en': 'now', 'hint': 'ah-OH-rah'})
        for text in (one, three, recall):
            self.assertNotRegex(text, FRENCH)

    def test_drift_words_come_from_the_profile(self):
        self.write('spanish', SPANISH)
        state = self.state(stage=2)
        spanish = 'Yo estoy aquí y hay un problema, pero tengo una idea y nosotros está bien, ahora vamos. ' * 3
        french = "J'ai ajouté une section, et je n'ai rien exécuté. Les autres problèmes sont dans sync.py, nous avons fini. " * 3
        self.assertIn('slipped into Spanish sentences', weave.calibration(spanish, state))
        self.assertNotIn('slipped', weave.calibration(french, state))
        self.assertNotRegex(weave.calibration(spanish, state), FRENCH)

    def test_exports_use_the_profile(self):
        self.write('spanish', SPANISH)
        for stage, known in ((1, 20), (3, 20)):
            state = self.state(stage=stage, known=known)
            claude, (about, respond) = export.claude_ai(state), export.chatgpt(state)
            self.assertIn('(and = y, but = pero, now = ahora, and the like', claude)
            self.assertIn('would there: por and para are not interchangeable; ya means already. Obvious', claude)
            self.assertIn('with the sound hint: (sin = without, "seen")', claude)
            self.assertIn('learning Spanish from zero, passively. Use Latin American Spanish words and spellings.', claude)
            self.assertIn('Default swaps every time the meaning fits: y, pero, ahora.', respond)
            self.assertIn('Exact sense only: por/para differ.', respond)
            self.assertIn('Use Latin American Spanish.', respond)
            for text in (claude, about, respond):
                self.assertNotRegex(text, FRENCH)
            self.assertLessEqual(max(len(about), len(respond)), export.CHATGPT_LIMIT)

    def test_articles_and_exposure_follow_the_profile(self):
        self.write('spanish', SPANISH)
        state, prof = self.state(), fwlib.profile('Spanish')
        self.assertEqual(fwlib.find(state, 'problema')['fr'], 'el problema')
        hits = lambda fr, text, p=prof: bool(fwlib.pattern(fr, p).search(fwlib.norm(text)))
        # An ASCII noun (also a possible English word) counts after any of the profile's determiners, not bare.
        self.assertTrue(hits('el problema', 'el problema here'))
        self.assertTrue(hits('la casa', 'mi casa is nice'))
        self.assertFalse(hits('la casa', 'une casa'))  # French determiners mean nothing here
        self.assertFalse(hits('la casa', 'casa'))
        generic = fwlib.profile('Klingon')
        self.assertFalse(hits('la casa', 'casa', generic))  # no profile: no article handling at all
        self.assertTrue(hits('la casa', 'la casa', generic))
        self.assertIsNone(fwlib.find(dict(state, language='Klingon'), 'problema'))

    def test_no_profile_or_missing_fields_degrade_to_the_generic_text(self):
        state = self.state(language='Klingon', stage=1)
        text = weave.brief(state, {}) + export.claude_ai(state) + ''.join(export.chatgpt(state))
        self.assertNotRegex(text, FRENCH)
        self.assertIn('swapped in. Never a Klingon sentence', text)
        self.assertIn('use another from the lists instead. If a reply', text)
        self.assertIn('(y = and, "ee")', text)  # gloss example: the first word of the list
        self.assertIn('(and = y, but = pero, now = ahora, without = sin, the problem = el problema', text)
        self.write('klingon', {'language': 'Klingon', 'examples': {'swap_sentence': 'The build passes, ghaH.'}})
        partial = weave.brief(state, {})
        self.assertIn('like "The build passes, ghaH." Never a Klingon', partial)
        self.assertIn('use another from the lists instead. If a reply', partial)  # no sense notes: slot left out
        self.assertNotRegex(partial, FRENCH)
        (self.dir / 'klingon.json').write_text('{not json')
        self.assertEqual(weave.brief(state, {}), weave.brief(dict(state, language='Klingon'), {}))
        self.assertNotRegex(weave.brief(state, {}), FRENCH)


class BundledLanguages(unittest.TestCase):
    """The bundled German, Italian, Portuguese and Japanese profiles with their own word lists."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = mock.patch.dict(os.environ, {'FRENCH_WEAVE_HOME': self.tmp.name})
        self.home.start()

    def tearDown(self):
        self.home.stop()
        self.tmp.cleanup()

    def state(self, language, stage=1, known=60):
        words = fwlib.load_lexicon(fwlib.PLUGIN_ROOT / 'data' / 'lexicons' / f'{language.lower()}.csv')
        state = fwlib.new_state('2026-10-01', words, known_top=known)
        state.update(language=language, stage=stage, stage_pinned=True)
        return state

    def test_every_new_language_fills_the_rules_with_its_own_text(self):
        for language in ('German', 'Italian', 'Portuguese', 'Japanese'):
            prof = fwlib.profile(language)
            self.assertEqual(prof['language'], language)
            for stage, known in ((1, 60), (3, 200)):
                state = self.state(language, stage, known)
                brief = weave.brief(state, {})
                claude, (about, respond) = export.claude_ai(state), export.chatgpt(state)
                self.assertIn(prof['examples']['swap_sentence' if stage < 3 else 'full_sentences'][0], brief)
                self.assertIn(prof['sense_notes']['export'], claude)
                self.assertIn(prof['sense_notes']['export_short'], respond)
                for text in (brief, claude, about, respond):
                    # mais is also Portuguese (more)
                    self.assertNotRegex(text.replace('mais', '') if language == 'Portuguese' else text, FRENCH)
                self.assertLessEqual(max(len(about), len(respond)), export.CHATGPT_LIMIT)
        self.assertIn('Use Brazilian Portuguese words and spellings.', weave.brief(self.state('Portuguese'), {}))
        self.assertIn('with the romaji: (今 = now, "ima")', export.claude_ai(self.state('Japanese')))

    def test_german_folds_umlauts_instead_of_stripping_them(self):
        state, prof = self.state('German'), fwlib.profile('German')
        hits = lambda fr, text: bool(fwlib.pattern(fr, prof).search(fwlib.fold(fwlib.norm(text), prof)))
        self.assertTrue(hits('schön', 'that looks schoen'))
        self.assertTrue(hits('schön', 'that looks Schön'))
        self.assertFalse(hits('schön', 'it is schon done'))  # schon (already) is another word
        self.assertFalse(hits('schon', 'that looks schön'))
        self.assertTrue(hits('Länge', 'the Laenge of it'))
        self.assertFalse(hits('Länge', 'it took lange'))
        self.assertTrue(hits('groß', 'a gross change'))  # ß typed as ss
        self.assertEqual(fwlib.find(state, 'fuer')['fr'], 'für')
        self.assertEqual(fwlib.find(state, 'schon')['fr'], 'schon')
        # Words spelled like English never count toward the measured share.
        known = [dict(w, status='known') for w in fwlib.load_lexicon(fwlib.PLUGIN_ROOT / 'data' / 'lexicons' / 'german.csv')]
        english = 'So the Hand of the Team had a Problem with the Name, so we fixed it fast. ' * 3
        self.assertEqual(weave.share(english, known, prof)[0], 0)
        german = 'The build passes jetzt, aber the cache is stale, deshalb I cleared it, and it was schoen. ' * 3
        self.assertEqual(weave.share(german, known, prof)[0], 12)

    def test_fixed_phrases_keep_their_article(self):
        state, prof = self.state('Portuguese'), fwlib.profile('Portuguese')
        hits = lambda fr, text, p=prof: bool(fwlib.pattern(fr, p).search(fwlib.norm(text)))
        self.assertTrue(hits('o que', 'o que is that'))
        self.assertFalse(hits('o que', 'a que'))  # not a noun: no determiner swap
        self.assertTrue(hits('a partir de', 'a partir de today'))
        self.assertFalse(hits('a partir de', 'o partir de today'))
        self.assertTrue(hits('o problema', 'o problema is here'))
        self.assertTrue(hits('o problema', 'meu problema is here'))
        self.assertIsNone(fwlib.find(state, 'que'))
        self.assertEqual(fwlib.find(state, 'problema')['fr'], 'o problema')
        italian = fwlib.profile('Italian')
        self.assertFalse(hits('lo so', 'I so wanted that', italian))  # "lo so" is I know, not the noun "so"
        self.assertTrue(hits("l'idea", "un'idea", italian))

    def test_elided_nouns_hints_start_with_the_elided_sound(self):
        # The extension takes articles.elided_hint_prefixes off the hint of a bare noun ("l'idée", "lee-day" ->
        # "ee-day"), so every elided noun's hint must start with one of them or the bare hint keeps the article.
        for name, path in (('French', 'lexicon.csv'), ('Italian', 'lexicons/italian.csv')):
            articles = fwlib.profile(name)['articles']
            self.assertTrue(articles['elided_hint_prefixes'], name)
            lead = re.compile('^(?:%s)' % '|'.join(map(re.escape, articles['elided'])), re.I)
            sound = re.compile(r'^(?:%s)(?=[^\W\d_])' % '|'.join(map(re.escape, articles['elided_hint_prefixes'])), re.I)
            rows = [w for w in fwlib.load_lexicon(fwlib.PLUGIN_ROOT / 'data' / path) if lead.match(fwlib.norm(w['fr']))]
            self.assertGreater(len(rows), 10, name)
            self.assertEqual([(w['fr'], w['hint']) for w in rows if not sound.match(w['hint'])], [], name)
        self.assertEqual(fwlib.profile('Spanish')['articles']['elided_hint_prefixes'], [])

    def test_japanese_drift_counts_grammar_inside_runs(self):
        state = self.state('Japanese', stage=2, known=100)
        swaps = 'The build passes 今, でも the cache is stale, だから I cleared it, and it is 本当に 簡単 now. ' * 3
        sentences = 'これは本当に簡単です。問題はキャッシュだったので、ファイルを消しました。私はそれを確認したいです。' * 2
        self.assertNotIn('slipped', weave.calibration(swaps, state))
        self.assertIn('slipped into Japanese sentences', weave.calibration(swaps + sentences, state))
        prof = fwlib.profile('Japanese')
        self.assertFalse(prof['plural_nouns'])  # the extension may show 問題 for "problems"
        self.assertTrue(fwlib.profile('French')['plural_nouns'])
        self.assertEqual(prof['script']['reading'], {'early': 'romaji', 'late': 'kana', 'late_from_stage': 3,
                                                     'late_only_with': 'kanji', 'known_drop': True})
        readings = {w['fr']: w.get('reading') for w in fwlib.public_state(state)['words']}
        self.assertEqual((readings['今'], readings['でも']), ('いま', 'でも'))


if __name__ == '__main__':
    unittest.main()
