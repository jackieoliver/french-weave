// A private-use tag keeps this catalog separate from generated gn and gn-PY packs.
export const GUARANI_STARTER = 'gn-PY-x-weave';
export const bundledLanguage = (code) => code === 'es' || code === GUARANI_STARTER;

const CODE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2})?$/;

export function languageCode(input) {
  if (typeof input !== 'string' || input.length > 20) return null;
  try {
    const code = Intl.getCanonicalLocales(input.trim())[0];
    return code && CODE.test(code) && !['en', 'es'].includes(code.split('-')[0]) ? code : null;
  } catch { return null; }
}

export function languageName(code) {
  if (code === 'es') return 'Spanish';
  if (code === GUARANI_STARTER) return 'Paraguayan Guaraní';
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; }
  catch { return code; }
}
