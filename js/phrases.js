// Phrase sets: Slovak (native) -> one target language at a time. Each language lives in
// js/lang/<id>.js with the same five topics. Every line still needs a check by a
// native speaker before the sets grow.
//
// A phrase: { id, topic, lang, code, tl, tr, sk, note }
//   tl   target-language text, exactly as spoken
//   tr   transliteration for non-Latin scripts (shown on screen, never spoken)
//   sk   Slovak text, exactly as spoken (no slashes, brackets or alternatives)
//   note optional usage hint for the Slovak side, shown on screen only
// Ids: Spanish keeps `<topic>-NN` so earlier progress still matches; other languages
// use `<lang>-<topic>-NN`.
import es from './lang/es.js';
import de from './lang/de.js';
import fr from './lang/fr.js';
import ar from './lang/ar.js';
import ru from './lang/ru.js';

export const TOPICS = [
  { id: 'basics', sk: 'Pozdravy a základy' },
  { id: 'cafe', sk: 'Kaviareň a reštaurácia' },
  { id: 'travel', sk: 'Cestovanie a orientácia' },
  { id: 'shopping', sk: 'Nakupovanie' },
  { id: 'smalltalk', sk: 'Rozhovor o sebe' },
];

export const LANGS = [es, de, fr, ar, ru];

function build(L) {
  return Object.entries(L.phrases).flatMap(([topic, list]) => list.map((row, i) => {
    const [tl, tr, sk, note] = L.translit ? row : [row[0], '', row[1], row[2]];
    const n = String(i + 1).padStart(2, '0');
    return {
      id: L.id === 'es' ? `${topic}-${n}` : `${L.id}-${topic}-${n}`,
      topic, lang: L.id, code: L.code, tl, tr: tr || '', sk, note: note || '',
    };
  }));
}

// The current target language. Live bindings: importers always see the current set.
export let LANG = es;
export let PHRASES = build(es);

export function setLanguage(id) {
  const next = LANGS.find((l) => l.id === id) || es;
  if (next !== LANG) { LANG = next; PHRASES = build(next); }
  return LANG;
}

// Every phrase of every language (used by tools/make_audio.py).
export const allPhrases = () => LANGS.flatMap(build);
