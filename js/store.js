// Local persistence: settings, per-phrase learning state, append-only review log.
// Everything lives in localStorage so the app works offline with no account.
import { createEmptyCard, fsrs, generatorParameters, Rating, State } from '../vendor/ts-fsrs.mjs';
import { PHRASES } from './phrases.js';

const KEY = 'tutor.v1';
const LOG_CAP = 20000;

export const DEFAULT_SETTINGS = {
  pauseFactor: 1,          // multiplies every answer pause
  rate: 0.95,              // speech rate for browser voices
  repeatTarget: true,      // replay the Spanish phrase after the answer
  showText: true,          // show the transcript on screen
  dailyNewCap: 15,
  esVoice: '',             // browser voice name ('' = best guess)
  skVoice: '',
  azureKey: '',
  azureRegion: 'westeurope',
  azureTts: true,          // use Azure neural voices when a key is set
  productionAfter: 3,      // successful recalls before L1 -> L2 trials start
};

function blank() {
  return { settings: { ...DEFAULT_SETTINGS }, items: {}, log: [], days: {} };
}

let db = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const parsed = JSON.parse(raw);
    return { ...blank(), ...parsed, settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) } };
  } catch {
    return blank();
  }
}

export function save() {
  try {
    if (db.log.length > LOG_CAP) db.log = db.log.slice(-LOG_CAP);
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch (e) {
    console.warn('save failed', e);
  }
}

export const settings = () => db.settings;
export function updateSettings(patch) { Object.assign(db.settings, patch); save(); }

let scheduler = fsrs(generatorParameters({ request_retention: 0.9, enable_fuzz: true }));

function reviveCard(c) {
  if (!c) return null;
  return { ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined };
}

// Learning state for one phrase.
// card: FSRS card once the learner has given at least one explicit rating
// introduced: heard at least once; exposures: plays; successes: explicit "knew it" count
export function item(id) {
  let it = db.items[id];
  if (!it) it = db.items[id] = { card: null, introduced: false, exposures: 0, successes: 0, lastSeen: 0 };
  return it;
}

export function cardOf(id) { return reviveCard(item(id).card); }

export function direction(id) {
  return item(id).successes >= db.settings.productionAfter ? 'prod' : 'recv';
}

export function noteExposure(id) {
  const it = item(id);
  if (!it.introduced) {
    it.introduced = true;
    const d = today();
    db.days[d] = db.days[d] || { newCount: 0, plays: 0 };
    db.days[d].newCount++;
  }
  it.exposures++;
  it.lastSeen = Date.now();
  const d = today();
  db.days[d] = db.days[d] || { newCount: 0, plays: 0 };
  db.days[d].plays++;
}

// grade: 1 Again, 2 Hard, 3 Good, 4 Easy. Feeds FSRS only when updateScheduler is true
// (the first explicit rating for the item in a session).
export function rate(id, grade, { source, dir, updateScheduler, pron }) {
  const it = item(id);
  const now = new Date();
  if (updateScheduler) {
    const card = reviveCard(it.card) || createEmptyCard(now);
    const { card: next } = scheduler.next(card, now, grade);
    it.card = next;
  }
  if (grade >= Rating.Good) it.successes++;
  if (grade === Rating.Again && it.successes > 0 && dir === 'prod') it.successes = Math.max(0, it.successes - 1);
  db.log.push({ t: now.toISOString(), id, dir, grade, source, scheduler: !!updateScheduler, exposureOnly: false, ...(pron ? { pron } : {}) });
  save();
}

export function logExposure(id, dir) {
  db.log.push({ t: new Date().toISOString(), id, dir, grade: null, source: 'listen', scheduler: false, exposureOnly: true });
  save();
}

export function logPron(id, pron) {
  db.log.push({ t: new Date().toISOString(), id, dir: 'repeat', grade: null, source: 'pronunciation', scheduler: false, exposureOnly: true, pron });
  save();
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const newToday = () => (db.days[today()] || {}).newCount || 0;

export function retrievability(id, now = new Date()) {
  const c = reviveCard(item(id).card);
  if (!c || c.state === State.New) return 0;
  return scheduler.get_retrievability(c, now, false);
}

export function stats() {
  const now = new Date();
  let known = 0, due = 0, introduced = 0, rated = 0, production = 0;
  for (const p of PHRASES) {
    const it = db.items[p.id];
    if (!it) continue;
    if (it.introduced) introduced++;
    if (it.card) {
      rated++;
      known += retrievability(p.id, now);
      if (new Date(it.card.due) <= now) due++;
    }
    if (it.successes >= db.settings.productionAfter) production++;
  }
  const unrated = introduced - rated;
  return { known: Math.round(known), due, introduced, rated, unrated, production, streak: streak(), total: PHRASES.length };
}

function streak() {
  let n = 0;
  const d = new Date();
  // today counts if practised; otherwise start from yesterday
  if (!db.days[today()]) d.setDate(d.getDate() - 1);
  for (;;) {
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!db.days[k] || !db.days[k].plays) break;
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function exportData() { return JSON.stringify(db, null, 1); }
export function importData(json) {
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || !parsed.items) throw new Error('Not a tutor backup file');
  db = { ...blank(), ...parsed, settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) } };
  save();
}
export function resetProgress() {
  const keep = db.settings;
  db = blank();
  db.settings = keep;
  save();
}

export { Rating };
