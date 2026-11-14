// Builds and runs one topic session.
// Reviews come from every topic by due date; the chosen topic only decides which
// NEW phrases appear. New phrases come back after other items have played
// (expanding gaps), never back-to-back.
import { PHRASES } from './phrases.js';
import * as store from './store.js';
import { say, wait, cancelAll, isAbort, syllables, prefetch, setNowPlaying } from './audio.js';
import { assess, scoringMethod } from './pron.js';

const NEW_BY_LENGTH = { 5: 2, 10: 5, 20: 9, 30: 12 };
const NEW_LADDER = [3, 7, 15, 30];   // positions after the previous play
const AGAIN_GAP = 4;

const byId = Object.fromEntries(PHRASES.map((p) => [p.id, p]));

export function plan({ topic, minutes, mode }) {
  const s = store.settings();
  const now = new Date();
  const perMin = mode === 'speak' ? 3 : 5;
  const capacity = Math.round(minutes * perMin);

  const due = PHRASES.filter((p) => { const c = store.cardOf(p.id); return c && c.due <= now; })
    .sort((a, b) => store.cardOf(a.id).due - store.cardOf(b.id).due);
  const unrated = PHRASES.filter((p) => { const it = store.item(p.id); return it.introduced && !it.card; })
    .sort((a, b) => store.item(a.id).lastSeen - store.item(b.id).lastSeen);
  let reviews = [...due, ...unrated];

  let newCount = NEW_BY_LENGTH[minutes] ?? Math.round(minutes / 2.5);
  if (mode === 'speak') newCount = Math.ceil(newCount / 2);
  newCount = Math.max(0, Math.min(newCount, s.dailyNewCap - store.newToday()));
  if (reviews.length >= 0.8 * capacity) newCount = 0; // backlog: reviews only
  const news = PHRASES.filter((p) => p.topic === topic && !store.item(p.id).introduced).slice(0, newCount);

  const reviewSlots = Math.max(0, capacity - news.length * 4);
  // Warm-up: a couple of reviews from the chosen topic first.
  const topicReviews = reviews.filter((p) => p.topic === topic);
  const warm = topicReviews.slice(0, 2);
  reviews = reviews.filter((p) => !warm.includes(p)).slice(0, Math.max(0, reviewSlots - warm.length));

  const fresh = [...warm];
  const r = [...reviews], n = [...news];
  while (r.length || n.length) {
    for (let k = 0; k < 2 && r.length; k++) fresh.push(r.shift());
    if (n.length) fresh.push(n.shift());
  }
  return { fresh, newIds: new Set(news.map((p) => p.id)), capacity, dueCount: due.length, unratedCount: unrated.length, newCount: news.length };
}

export class Session {
  constructor({ topic, minutes, mode }, ui) {
    this.opts = { topic, minutes, mode };
    this.ui = ui;
    this.plan = plan(this.opts);
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
  }

  st(id) {
    return this.state[id] || (this.state[id] = { plays: 0, rated: false, again: 0, knewStreak: 0, ladder: 0, isNew: this.plan.newIds.has(id), extra: 0, ratedThisPlay: false });
  }

  timeUp() { return this.elapsed + (this.startedAt ? Date.now() - this.startedAt : 0) >= this.opts.minutes * 60000; }

  pickNext() {
    const ready = this.pending.filter((x) => x.at <= this.pos).sort((a, b) => a.at - b.at);
    const take = (x) => { this.pending.splice(this.pending.indexOf(x), 1); return x.id; };
    if (ready.length) return take(ready[0]);
    if (this.fresh.length) return this.fresh.shift();
    // Nothing due and time left (e.g. the first sessions): bring in another new
    // phrase rather than replaying the same few back-to-back.
    const extra = this.topUpNew();
    if (extra) return extra;
    if (this.pending.length) return take([...this.pending].sort((a, b) => a.at - b.at)[0]);
    // Consolidation: replay what was hardest this session.
    const cands = Object.entries(this.state)
      .filter(([id, s]) => s.extra < 2 && id !== this.current)
      .sort((a, b) => (b[1].again - a[1].again) || (a[1].plays - b[1].plays));
    if (cands.length && Object.keys(this.state).length > 2) { cands[0][1].extra++; return cands[0][0]; }
    return null;
  }

  topUpNew() {
    const s = store.settings();
    if (store.newToday() >= s.dailyNewCap) return null;
    // Keep in-flight new phrases to a handful so each still gets spaced repeats.
    const inFlight = this.pending.filter((x) => this.st(x.id).isNew).length;
    if (inFlight >= 4) return null;
    const p = PHRASES.find((x) => x.topic === this.opts.topic && !store.item(x.id).introduced && !this.state[x.id]);
    if (!p) return null;
    this.plan.newIds.add(p.id);
    return p.id;
  }

  pauseFor(id, dir) {
    const s = store.settings();
    const p = byId[id];
    let ms;
    if (dir === 'prod') ms = Math.min(6000, Math.max(3000, syllables(p.es) * 500 + 1500));
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
      this.pending.push({ id, at: this.pos + AGAIN_GAP });
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
    prefetch(this.fresh.slice(0, 6).map((id) => byId[id]));
    let id = this.pickNext();
    while (id && !this.stopped) {
      try {
        await this.playItem(id);
        this.afterPlay(id);
        this.pos++;
        if (this.timeUp()) break;
        id = this.pickNext();
        const look = [...this.pending.map((x) => x.id), ...this.fresh].slice(0, 4).map((x) => byId[x]);
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
    return { ...this.summary, minutes: this.elapsed / 60000, plan: this.plan };
  }

  afterPlay(id) {
    const st = this.st(id);
    if (!st.ratedThisPlay) store.logExposure(id, this.currentDir);
    if (st.isNew) {
      const done = st.knewStreak >= 2 || st.ladder >= NEW_LADDER.length;
      const alreadyQueued = this.pending.some((x) => x.id === id);
      if (!done && !alreadyQueued) { this.pending.push({ id, at: this.pos + NEW_LADDER[st.ladder] }); st.ladder++; }
    } else if (!st.rated && st.plays === 1 && !this.pending.some((x) => x.id === id)) {
      // Unrated review: hear it once more later in the session.
      this.pending.push({ id, at: this.pos + 12 });
    }
  }

  async playItem(id) {
    const p = byId[id];
    const st = this.st(id);
    st.ratedThisPlay = false;
    this.lastPron = null;
    this.current = id;
    // New phrases always start receptive (Spanish first).
    const dir = st.isNew && st.plays === 0 ? 'recv' : store.direction(id);
    this.currentDir = dir;
    if (st.plays === 0 && st.isNew) this.summary.newIntroduced++;
    st.plays++;
    this.summary.plays++;
    store.noteExposure(id);

    const voiceIndex = this.voiceTurn++;
    const ui = this.ui;
    ui.item?.({ phrase: p, dir, isNew: st.isNew && st.plays === 1, mode: this.opts.mode, pos: this.pos, progress: this.progress() });
    setNowPlaying(dir === 'recv' ? p.es : p.sk, dir === 'recv' ? '¿Qué significa?' : 'Povedz po španielsky');

    const pauseMs = this.pauseFor(id, dir);
    if (this.opts.mode === 'listen') {
      if (dir === 'recv') {
        ui.phase?.('prompt'); await say(p.es, 'es-ES', { voiceIndex });
        ui.phase?.('pause', pauseMs); await wait(pauseMs);
        ui.phase?.('answer'); await say(p.sk, 'sk-SK');
        if (store.settings().repeatTarget) { await wait(600); ui.phase?.('repeat'); await say(p.es, 'es-ES', { voiceIndex: voiceIndex + 1 }); }
      } else {
        ui.phase?.('prompt'); await say(p.sk, 'sk-SK');
        ui.phase?.('pause', pauseMs); await wait(pauseMs);
        ui.phase?.('answer'); await say(p.es, 'es-ES', { voiceIndex });
        if (store.settings().repeatTarget) { ui.phase?.('shadow', 1800); await wait(1800); ui.phase?.('repeat'); await say(p.es, 'es-ES', { voiceIndex: voiceIndex + 1 }); }
      }
      ui.phase?.('window', 1400);
      await wait(1400); // time to press "knew it" / "again"
      return;
    }

    // Speak-aloud mode (foreground). Correctness rating and pronunciation score stay separate.
    const scoring = scoringMethod();
    if (dir === 'recv') {
      ui.phase?.('prompt'); await say(p.es, 'es-ES', { voiceIndex });
      ui.phase?.('pause', pauseMs); await wait(pauseMs);
      ui.phase?.('answer'); await say(p.sk, 'sk-SK');
      await wait(300);
      await this.listenAndScore(p, scoring, 'repeat');
    } else {
      ui.phase?.('prompt'); await say(p.sk, 'sk-SK');
      await this.listenAndScore(p, scoring, 'produce', pauseMs);
      ui.phase?.('answer'); await say(p.es, 'es-ES', { voiceIndex });
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
    try { res = await assess(p.es, { timeoutMs: kind === 'repeat' ? 6000 : 8000 }); }
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
