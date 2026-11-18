// Builds and runs one topic session.
// Scope: a session uses only phrases of the chosen level (or only the film lines when
// that topic is chosen). Phrases of other levels never play; their reviews wait until
// that level is chosen again. Within the level the chosen topic goes first: its due
// reviews and its new phrases. Only when the topic has nothing left that can play
// without repeating too soon does the session borrow from the level's other topics,
// reviews before new phrases. A phrase never comes back sooner than MIN_GAP
// (5 minutes of session time).
import { PHRASES, LANG, spoken } from './phrases.js';
import * as store from './store.js';
import { say, wait, cancelAll, isAbort, syllables, prefetch, setNowPlaying } from './audio.js';
import { assess, scoringMethod } from './pron.js';

const NEW_BY_LENGTH = { 5: 2, 10: 5, 20: 9, 30: 12 };
const MIN = 60000;
const MIN_GAP = 5 * MIN;                 // shortest time before the same phrase returns
const NEW_LADDER = [5 * MIN, 12 * MIN];  // a new phrase returns after 5, then 12 minutes
const AGAIN_GAP = 5 * MIN;               // "again" brings it back after 5 minutes
const UNRATED_GAP = 8 * MIN;             // an unrated review is heard once more after 8

// For the topic counts on the home screen: the film lines show at every level.
export const levelMatch = (p, level) => p.topic === 'quotes' || p.level === level;
// What a session may play.
export const inScope = (p, { topic, level }) => (topic === 'quotes' ? p.topic === 'quotes' : p.topic !== 'quotes' && p.level === level);

let idMap = null, idMapFor = null;
function byId(id) {
  if (idMapFor !== PHRASES) { idMap = Object.fromEntries(PHRASES.map((p) => [p.id, p])); idMapFor = PHRASES; }
  return idMap[id];
}

export function plan({ topic, minutes, mode, level = 'A1' }) {
  const s = store.settings();
  const now = new Date();
  const perMin = mode === 'speak' ? 3 : 5;
  const capacity = Math.round(minutes * perMin);

  const scope = PHRASES.filter((p) => inScope(p, { topic, level }));
  const isDue = (p) => { const c = store.cardOf(p.id); return c && c.due <= now; };
  const isUnrated = (p) => { const it = store.item(p.id); return it.introduced && !it.card; };
  const byDue = (a, b) => store.cardOf(a.id).due - store.cardOf(b.id).due;
  const byHeard = (a, b) => store.item(a.id).lastSeen - store.item(b.id).lastSeen;
  const reviewsOf = (list) => [...list.filter(isDue).sort(byDue), ...list.filter(isUnrated).sort(byHeard)];
  const mine = scope.filter((p) => p.topic === topic);
  const topicReviews = reviewsOf(mine);
  const otherReviews = reviewsOf(scope.filter((p) => p.topic !== topic));

  const capLeft = Math.max(0, s.dailyNewCap - store.newToday());
  let newCount = NEW_BY_LENGTH[minutes] ?? Math.round(minutes / 2.5);
  if (mode === 'speak') newCount = Math.ceil(newCount / 2);
  newCount = Math.min(newCount, capLeft);
  if (topicReviews.length + otherReviews.length >= 0.8 * capacity) newCount = 0; // backlog: reviews only
  const news = mine.filter((p) => !store.item(p.id).introduced).slice(0, newCount);

  // The chosen topic first (two reviews, then a new phrase), then the level's other reviews.
  const reviewSlots = Math.max(0, capacity - news.length * 3);
  const r = topicReviews.slice(0, reviewSlots), n = [...news];
  const fresh = [];
  while (r.length || n.length) {
    for (let k = 0; k < 2 && r.length; k++) fresh.push(r.shift());
    if (n.length) fresh.push(n.shift());
  }
  fresh.push(...otherReviews.slice(0, Math.max(0, reviewSlots - topicReviews.length)));
  return {
    fresh, newIds: new Set(news.map((p) => p.id)), capacity,
    dueCount: scope.filter(isDue).length, unratedCount: scope.filter(isUnrated).length, newCount: news.length,
    capReached: capLeft === 0, scopeSize: scope.length,
  };
}

export class Session {
  constructor({ topic, minutes, mode, level = 'A1' }, ui) {
    this.opts = { topic, minutes, mode, level };
    this.ui = ui;
    this.plan = plan(this.opts);
    this.scope = PHRASES.filter((p) => inScope(p, this.opts));
    this.fresh = this.plan.fresh.map((p) => p.id);
    this.pending = [];        // { id, at }
    this.state = {};          // per-item state for this session
    this.pos = 0;
    this.current = null;
    this.paused = false;
    this.stopped = false;
    this.elapsed = 0;
    this.startedAt = 0;
    this.ratingWaiter = null;
    this.summary = { plays: 0, newIntroduced: 0, rated: 0, again: 0, pron: [] };
    this.voiceTurn = 0;
    this.endedEarly = false;
  }

  st(id) {
    return this.state[id] || (this.state[id] = { plays: 0, rated: false, again: 0, knewStreak: 0, ladder: 0, isNew: this.plan.newIds.has(id), extra: 0, ratedThisPlay: false, lastAt: -Infinity });
  }

  // Session clock in ms, paused time excluded.
  now() { return this.elapsed + (this.startedAt ? Date.now() - this.startedAt : 0); }
  timeUp() { return this.now() >= this.opts.minutes * 60000; }
  restedEnough(id) { return this.now() - this.st(id).lastAt >= MIN_GAP; }

  pickNext() {
    const now = this.now();
    const take = (x) => { this.pending.splice(this.pending.indexOf(x), 1); return x.id; };
    // 1. a spaced repeat whose time has come
    const ready = this.pending.filter((x) => x.at <= now).sort((a, b) => a.at - b.at);
    if (ready.length) return take(ready[0]);
    // 2. the planned reviews and new phrases
    while (this.fresh.length) {
      const id = this.fresh.shift();
      if (this.restedEnough(id)) return id;
    }
    // 3. the chosen topic: another new phrase, else one not heard for a while
    // 4. then the level's other topics the same way
    for (const sameTopic of [true, false]) {
      const id = this.topUpNew(sameTopic) || this.extraReview(sameTopic);
      if (id) return id;
    }
    // 5. a spaced repeat that is nearly due (at most a minute early)
    const soon = [...this.pending].sort((a, b) => a.at - b.at)[0];
    if (soon && soon.at - now <= MIN) return take(soon);
    // Nothing left in this level that would not repeat too soon: end here rather than drill.
    this.endedEarly = true;
    return null;
  }

  inTopic(p, sameTopic) { return (p.topic === this.opts.topic) === sameTopic; }

  topUpNew(sameTopic) {
    if (store.newToday() >= store.settings().dailyNewCap) return null;
    const p = this.scope.find((x) => this.inTopic(x, sameTopic) && !store.item(x.id).introduced && !this.state[x.id]);
    if (!p) return null;
    this.plan.newIds.add(p.id);
    return p.id;
  }

  extraReview(sameTopic) {
    const seen = this.scope.filter((p) => this.inTopic(p, sameTopic) && store.item(p.id).introduced
      && this.restedEnough(p.id) && !this.pending.some((x) => x.id === p.id));
    if (!seen.length) return null;
    // least recently heard first, so the whole set gets refreshed over time
    seen.sort((a, b) => store.item(a.id).lastSeen - store.item(b.id).lastSeen);
    return seen[0].id;
  }

  pauseFor(id, dir) {
    const s = store.settings();
    const p = byId(id);
    let ms;
    if (dir === 'prod') ms = Math.min(6000, Math.max(3000, syllables(p.tr || p.tl) * 500 + 1500));
    else ms = store.item(id).successes > 0 ? 2000 : 3000;
    return ms * s.pauseFactor;
  }

  // ----- controls from UI / media keys -----
  rate(grade, source) {
    const id = this.current;
    if (!id) return;
    const st = this.st(id);
    if (st.ratedThisPlay) return; // one rating per play
    st.ratedThisPlay = true;
    const dir = this.currentDir;
    const first = !st.rated;
    store.rate(id, grade, { source, dir, updateScheduler: first, pron: this.lastPron || undefined });
    st.rated = true;
    this.summary.rated++;
    if (grade === store.Rating.Again) {
      st.again++; st.knewStreak = 0; this.summary.again++;
      this.pending = this.pending.filter((x) => x.id !== id);
      this.pending.push({ id, at: this.now() + AGAIN_GAP });
      st.ladder = 1;
    } else {
      st.knewStreak++;
    }
    this.ui.rated?.(grade, source);
    if (this.ratingWaiter) { const w = this.ratingWaiter; this.ratingWaiter = null; w(grade); }
  }

  pause() {
    if (this.paused || this.stopped) return;
    this.paused = true;
    this.elapsed += Date.now() - this.startedAt;
    this.startedAt = 0;
    cancelAll();
    this.ui.paused?.(true);
  }

  resume() {
    if (!this.paused || this.stopped) return;
    this.paused = false;
    this.startedAt = Date.now();
    this.ui.paused?.(false);
    this._resume?.();
  }

  stop() {
    this.stopped = true;
    cancelAll();
    if (this.ratingWaiter) { const w = this.ratingWaiter; this.ratingWaiter = null; w(null); }
    this._resume?.();
  }

  // ----- main loop -----
  async run() {
    this.startedAt = Date.now();
    prefetch(this.fresh.slice(0, 6).map((id) => byId(id)));
    let id = this.pickNext();
    while (id && !this.stopped) {
      try {
        await this.playItem(id);
        this.afterPlay(id);
        this.pos++;
        if (this.timeUp()) break;
        id = this.pickNext();
        const look = [...this.pending.map((x) => x.id), ...this.fresh].slice(0, 4).map((x) => byId(x));
        prefetch(look);
      } catch (e) {
        if (!isAbort(e)) { console.error(e); this.ui.error?.(String(e.message || e)); await wait(1000).catch(() => {}); }
        if (this.stopped) break;
        if (this.paused) await new Promise((r) => { this._resume = r; });
        this._resume = null;
        // replay the same item after a pause
      }
    }
    this.stopped = true;
    if (this.startedAt) this.elapsed += Date.now() - this.startedAt;
    this.startedAt = 0;
    cancelAll();
    return { ...this.summary, minutes: this.elapsed / 60000, plan: this.plan, endedEarly: this.endedEarly };
  }

  afterPlay(id) {
    const st = this.st(id);
    if (!st.ratedThisPlay) store.logExposure(id, this.currentDir);
    if (st.isNew) {
      const done = st.knewStreak >= 2 || st.ladder >= NEW_LADDER.length;
      const alreadyQueued = this.pending.some((x) => x.id === id);
      if (!done && !alreadyQueued) { this.pending.push({ id, at: this.now() + NEW_LADDER[st.ladder] }); st.ladder++; }
    } else if (!st.rated && st.plays === 1 && !this.pending.some((x) => x.id === id)) {
      // Unrated review: hear it once more later in the session.
      this.pending.push({ id, at: this.now() + UNRATED_GAP });
    }
  }

  async playItem(id) {
    const p = byId(id);
    const st = this.st(id);
    st.ratedThisPlay = false;
    this.lastPron = null;
    this.current = id;
    // New phrases always start receptive (target language first).
    const dir = st.isNew && st.plays === 0 ? 'recv' : store.direction(id);
    this.currentDir = dir;
    if (st.plays === 0 && st.isNew) this.summary.newIntroduced++;
    st.plays++;
    st.lastAt = this.now();
    this.summary.plays++;
    store.noteExposure(id);

    // Phrases rotate the language's voices; the word list is recorded in one voice only.
    const single = p.topic === 'words';
    const voiceIndex = single ? 0 : this.voiceTurn++;
    const nextVoice = single ? 0 : voiceIndex + 1;
    const ui = this.ui;
    ui.item?.({ phrase: p, dir, isNew: st.isNew && st.plays === 1, mode: this.opts.mode, pos: this.pos, progress: this.progress() });
    setNowPlaying(dir === 'recv' ? p.tl : p.sk, dir === 'recv' ? 'Čo to znamená?' : `Povedz ${LANG.po}`);

    const pauseMs = this.pauseFor(id, dir);
    if (this.opts.mode === 'listen') {
      if (dir === 'recv') {
        ui.phase?.('prompt'); await say(p.tl, p.code, { voiceIndex });
        ui.phase?.('pause', pauseMs); await wait(pauseMs);
        ui.phase?.('answer'); await say(p.sk, 'sk-SK');
        if (store.settings().repeatTarget) { await wait(600); ui.phase?.('repeat'); await say(p.tl, p.code, { voiceIndex: nextVoice }); }
      } else {
        ui.phase?.('prompt'); await say(p.sk, 'sk-SK');
        ui.phase?.('pause', pauseMs); await wait(pauseMs);
        ui.phase?.('answer'); await say(p.tl, p.code, { voiceIndex });
        if (store.settings().repeatTarget) { ui.phase?.('shadow', 1800); await wait(1800); ui.phase?.('repeat'); await say(p.tl, p.code, { voiceIndex: nextVoice }); }
      }
      ui.phase?.('window', 1400);
      await wait(1400); // time to press "knew it" / "again"
      return;
    }

    // Speak-aloud mode (foreground). Correctness rating and pronunciation score stay separate.
    const scoring = scoringMethod();
    if (dir === 'recv') {
      // Hear it, recall the meaning silently, hear the meaning, then repeat the phrase aloud.
      ui.phase?.('prompt'); await say(p.tl, p.code, { voiceIndex });
      ui.phase?.('think', pauseMs); await wait(pauseMs);
      ui.phase?.('answer'); await say(p.sk, 'sk-SK');
      await wait(300);
      await this.listenAndScore(p, scoring, 'repeat');
    } else {
      ui.phase?.('prompt'); await say(p.sk, 'sk-SK');
      await this.listenAndScore(p, scoring, 'produce', pauseMs);
      ui.phase?.('answer'); await say(p.tl, p.code, { voiceIndex });
    }
    if (this.stopped) return;
    ui.phase?.('rate');
    if (!st.ratedThisPlay) {
      await new Promise((resolve) => { this.ratingWaiter = resolve; });
    }
  }

  async listenAndScore(p, scoring, kind, pauseMs = 3000) {
    if (scoring === 'none') { this.ui.phase?.('pause', pauseMs); await wait(pauseMs); return; }
    this.ui.phase?.(kind === 'repeat' ? 'mic-repeat' : 'mic-produce');
    let res = null;
    try { res = await assess(spoken(p.tl), { lang: p.code, timeoutMs: kind === 'repeat' ? 6000 : 8000 }); }
    catch (e) { this.ui.error?.(`Scoring failed: ${e.message || e}`); }
    if (this.stopped || this.paused) { const err = new Error('aborted'); err.name = 'Aborted'; throw err; }
    this.lastPron = res ? { score: res.score, method: res.method, heard: res.heard } : null;
    if (res) { this.summary.pron.push(res.score); store.logPron(p.id, this.lastPron); }
    this.ui.score?.(res, p);
  }

  progress() {
    const total = this.opts.minutes * 60000;
    const used = this.elapsed + (this.startedAt ? Date.now() - this.startedAt : 0);
    return Math.min(1, used / total);
  }
}
