// Phrase sets: Slovak (native) -> one target language at a time. Each language lives in
// js/lang/<id>.js with the same five topics. Every line still needs a check by a
// native speaker before the sets grow.
//
// A phrase: { id, topic, level, lang, code, tl, tr, sk, note }
//   tl   target-language text, exactly as spoken
//   tr   transliteration for non-Latin scripts (shown on screen, never spoken)
//   sk   Slovak text, exactly as spoken (no slashes, brackets or alternatives)
//   note optional usage hint for the Slovak side, shown on screen only (for the
//        film lines: the film or series and year)
//   code language code for voices and recognition; a pack can override it per topic
//        (topicCodes), e.g. Egyptian Arabic for the Arabic film lines
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
  { id: 'quotes', sk: 'Slávne vety z filmov a seriálov' },
];

export const LANGS = [es, de, fr, ar, ru];

export const LEVELS = [
  { id: 'A1', sk: 'A1 – začiatočník: pozdravy a najjednoduchšie vety' },
  { id: 'A2', sk: 'A2 – mierne pokročilý: bežné situácie' },
  { id: 'B1', sk: 'B1 – stredne pokročilý: vysvetliť, poprosiť, posťažovať sa' },
  { id: 'B2', sk: 'B2 – pokročilý: názory, podmienky, vyjednávanie' },
  { id: 'C1', sk: 'C1 – veľmi pokročilý: nuansy, idiómy, diplomacia' },
];

// The starter sets (A1/A2): short lines (up to 3 Slovak words) count as A1, longer as
// A2. B1–C1 come from each pack's `levels` block. Film lines have no level.
const baseLevel = (sk) => (sk.split(/\s+/).length <= 3 ? 'A1' : 'A2');

function rows(L, topic, list, level, idPrefix) {
  return list.map((row, i) => {
    const [tl, tr, sk, note] = L.translit ? row : [row[0], '', row[1], row[2]];
    const n = String(i + 1).padStart(2, '0');
    return {
      id: `${idPrefix}${topic}-${n}`,
      topic, lang: L.id, code: L.topicCodes?.[topic] || L.code, tl, tr: tr || '', sk, note: note || '',
      level: topic === 'quotes' ? '' : level || baseLevel(sk),
    };
  });
}

function build(L) {
  const pre = L.id === 'es' ? '' : `${L.id}-`;
  const base = Object.entries(L.phrases).flatMap(([topic, list]) => rows(L, topic, list, null, pre));
  const higher = Object.entries(L.levels || {}).flatMap(([level, topics]) =>
    Object.entries(topics).flatMap(([topic, list]) => rows(L, topic, list, level, `${pre}${level.toLowerCase()}-`)));
  return [...base, ...higher];
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
