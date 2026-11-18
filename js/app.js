import { PHRASES, TOPICS, LANG, LANGS, LEVELS, setLanguage } from './phrases.js';
import * as store from './store.js';
import { Session, plan, levelMatch, inScope } from './session.js';
import { voicesFor, startKeepAlive, stopKeepAlive, setMediaHandlers, azureEnabled, bundledEnabled, lastAudioError } from './audio.js';
import { scoringMethod } from './pron.js';

const $ = (s) => document.querySelector(s);
setLanguage(store.settings().lang);
const screens = ['home', 'player', 'summary', 'settings'];
function show(name) { for (const s of screens) $('#' + s).hidden = s !== name; window.scrollTo(0, 0); }

const ui = {
  topic: localStorage.getItem('tutor.topic') || TOPICS[0].id,
  minutes: Number(localStorage.getItem('tutor.minutes') || 10),
  mode: localStorage.getItem('tutor.mode') || 'listen',
};
function remember() {
  try { localStorage.setItem('tutor.topic', ui.topic); localStorage.setItem('tutor.minutes', ui.minutes); localStorage.setItem('tutor.mode', ui.mode); } catch {}
}

// ---------- home ----------
function statTiles(el, tiles) {
  el.innerHTML = tiles.map(([v, label]) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`).join('');
}

function renderLang() {
  $('#lang-short').textContent = LANG.short;
  $('#lang-name').textContent = `${LANG.name} zo slovenčiny`;
  document.title = `Frázy ${LANG.short}`;
  $('#langs').innerHTML = LANGS.map((l) => `<button role="radio" data-lang="${l.id}" aria-checked="${l.id === LANG.id}" title="${l.name}" aria-label="${l.name}">${l.short}</button>`).join('');
  const level = store.settings().level;
  $('#levels').innerHTML = LEVELS.map((l) => `<button role="radio" data-level="${l.id}" aria-checked="${l.id === level}" title="${l.sk}">${l.id}</button>`).join('');
  $('#level-note').textContent = LEVELS.find((l) => l.id === level)?.sk || '';
}

function renderHome() {
  renderLang();
  const s = store.stats();
  statTiles($('#stats'), [
    [s.known, 'fráz vieš'],
    [s.due, 'na opakovanie'],
    [`${s.introduced}/${s.total}`, 'počutých'],
    [s.streak, s.streak === 1 ? 'deň v rade' : 'dní v rade'],
  ]);

  const level = store.settings().level;
  // A topic with nothing at this level (the word list stops at B2) is shown but disabled.
  const counts = Object.fromEntries(TOPICS.map((t) => [t.id, PHRASES.filter((p) => p.topic === t.id && levelMatch(p, level))]));
  if (!counts[ui.topic]?.length) ui.topic = TOPICS.find((t) => counts[t.id].length)?.id || TOPICS[0].id;
  $('#topics').innerHTML = TOPICS.map((t) => {
    const all = counts[t.id];
    const seen = all.filter((p) => store.item(p.id).introduced).length;
    const off = all.length === 0;
    const label = off && t.id === 'words' ? 'len A1–B2' : `${seen}/${all.length}`;
    return `<button role="radio" data-topic="${t.id}" aria-checked="${t.id === ui.topic}"${off ? ' disabled' : ''}><span>${t.sk}<br><small lang="${LANG.id}" dir="auto">${LANG.topics[t.id]}</small></span><small>${label}</small></button>`;
  }).join('');
  for (const b of document.querySelectorAll('#lengths button')) b.setAttribute('aria-checked', String(Number(b.dataset.min) === ui.minutes));
  for (const b of document.querySelectorAll('#modes button')) b.setAttribute('aria-checked', String(b.dataset.mode === ui.mode));

  const p = plan({ ...ui, level: store.settings().level });
  const parts = [];
  if (p.dueCount) parts.push(`${p.dueCount} na opakovanie`);
  if (p.unratedCount) parts.push(`${p.unratedCount} počutých bez hodnotenia`);
  const nw = ui.topic === 'words' ? ['nové slovo', 'nové slová', 'nových slov', 'žiadne nové slová'] : ['nová fráza', 'nové frázy', 'nových fráz', 'žiadne nové frázy'];
  parts.push(p.newCount === 1 ? `1 ${nw[0]}` : p.newCount >= 2 && p.newCount <= 4 ? `${p.newCount} ${nw[1]}` : p.newCount ? `${p.newCount} ${nw[2]}` : nw[3]);
  const scopeName = ui.topic === 'quotes' ? 'len filmové vety' : `len úroveň ${store.settings().level}`;
  let note = `Plán (${scopeName}): ${parts.join(', ')}.`;
  if (p.capReached) note += ' Denný limit nových fráz je vyčerpaný (Nastavenia).';
  if (ui.mode === 'speak') {
    const m = scoringMethod();
    note += m === 'azure' ? ' Výslovnosť hodnotí Azure.' : m === 'browser' ? ' Výslovnosť: približné skóre z prehliadača.' : ' Tento prehliadač nevie rozpoznať reč, skóre nebude.';
  }
  $('#plan-note').textContent = note;
}

$('#langs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang]');
  if (!b || b.dataset.lang === LANG.id) return;
  store.updateSettings({ lang: b.dataset.lang });
  setLanguage(b.dataset.lang);
  renderHome();
});
$('#levels').addEventListener('click', (e) => {
  const b = e.target.closest('[data-level]');
  if (!b) return;
  store.updateSettings({ level: b.dataset.level });
  renderHome();
});
$('#topics').addEventListener('click', (e) => { const b = e.target.closest('[data-topic]'); if (b) { ui.topic = b.dataset.topic; remember(); renderHome(); } });
$('#lengths').addEventListener('click', (e) => { const b = e.target.closest('[data-min]'); if (b) { ui.minutes = Number(b.dataset.min); remember(); renderHome(); } });
$('#modes').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) { ui.mode = b.dataset.mode; remember(); renderHome(); } });

// ---------- player ----------
let session = null;
let wakeLock = null;
let progressTimer = null;

const phaseText = () => ({
  listen: {
    prompt: 'Počúvaj…',
    pause: 'Povedz význam nahlas',
    answer: 'Odpoveď',
    repeat: `Ešte raz ${LANG.po}`,
    shadow: `Zopakuj ${LANG.po}`,
    window: 'Vedel si to?',
  },
  speak: {
    prompt: 'Počúvaj…',
    pause: `Povedz to ${LANG.po}`,
    think: 'Čo to znamená? Stačí v duchu.',
    answer: 'Význam',
    'mic-repeat': `🎙 Zopakuj ${LANG.adjF} frázu`,
    'mic-produce': `🎙 Povedz to ${LANG.po}`,
    rate: 'Vedel si to? Ohodnoť sa.',
  },
});

function setCountdown(ms) {
  const cd = $('#countdown');
  const bar = cd.firstElementChild;
  if (!ms) { cd.classList.remove('on'); bar.style.transition = 'none'; bar.style.transform = 'scaleX(1)'; return; }
  cd.classList.add('on');
  bar.style.transition = 'none';
  bar.style.transform = 'scaleX(1)';
  void bar.offsetWidth;
  bar.style.transition = `transform ${ms}ms linear`;
  bar.style.transform = 'scaleX(0)';
}

let cur = null;
// Slovak line as shown on screen: the spoken text plus any usage note.
const skText = (p) => (p.note ? `${p.sk} (${p.note})` : p.sk);
// Target-language line as shown: the text (right-to-left where needed) plus any transliteration.
const tlHtml = (p) => `<span lang="${p.lang}" dir="auto">${escapeHtml(p.tl)}</span>${p.tr ? `<small class="tr">${escapeHtml(p.tr)}</small>` : ''}`;
const skHtml = (p) => escapeHtml(skText(p));
const sessionUi = {
  item({ phrase, dir, isNew, progress }) {
    cur = { phrase, dir };
    const show = store.settings().showText;
    $('#p-badge').hidden = !isNew;
    $('#prompt-text').innerHTML = show ? (dir === 'recv' ? tlHtml(phrase) : skHtml(phrase)) : '';
    $('#answer-text').innerHTML = '';
    $('#score').hidden = true;
    $('#progress').style.width = `${Math.round(progress * 100)}%`;
    for (const b of document.querySelectorAll('.rate button')) b.classList.remove('flash');
    $('#rate-speak').classList.remove('waiting');
  },
  phase(name, ms) {
    const mode = session.opts.mode;
    const el = $('#phase');
    el.textContent = phaseText()[mode][name] || '';
    el.classList.toggle('mic', name.startsWith('mic'));
    setCountdown(name === 'pause' || name === 'shadow' || name === 'think' ? ms : 0);
    if ((name === 'answer' || name === 'rate') && cur && store.settings().showText) {
      $('#answer-text').innerHTML = cur.dir === 'recv' ? skHtml(cur.phrase) : tlHtml(cur.phrase);
    }
    if (name === 'rate') $('#rate-speak').classList.add('waiting');
  },
  rated(grade) {
    const b = document.querySelector(`.rate:not([hidden]) button[data-grade="${grade}"]`);
    if (b) b.classList.add('flash');
    if (session.opts.mode === 'listen') $('#phase').textContent = grade === 1 ? 'Znova o chvíľu' : 'Výborne';
  },
  score(res, phrase) {
    const el = $('#score');
    el.hidden = false;
    if (!res) { el.innerHTML = '<small>Nič som nepočul. Skús nabudúce hovoriť hneď po signáli.</small>'; return; }
    const words = (res.words || []).map((w) => `<span class="w ${w.score < 60 || w.error !== 'None' ? 'bad' : w.score < 80 ? 'mid' : ''}">${escapeHtml(w.word)} ${w.score}</span>`).join('');
    const d = res.detail ? `<small>Presnosť ${res.detail.accuracy} · Plynulosť ${res.detail.fluency} · Úplnosť ${res.detail.completeness}</small>` : '<small>Približné skóre z rozpoznávania reči prehliadača</small>';
    el.innerHTML = `<div><span class="num">${res.score}</span><small> / 100 výslovnosť</small></div>${d}<div><small>Počul som: „${escapeHtml(res.heard || '')}“</small></div>${words ? `<div class="words">${words}</div>` : ''}`;
    if (!store.settings().showText) $('#answer-text').innerHTML = tlHtml(phrase);
  },
  paused(p) { $('#pause-btn').textContent = p ? 'Pokračovať' : 'Pauza'; if (p) $('#phase').textContent = 'Pozastavené'; setCountdown(0); },
  error(msg) { const e = $('#error'); e.hidden = false; e.textContent = msg; setTimeout(() => { e.hidden = true; }, 6000); },
};

function escapeHtml(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function startSession() {
  if (!PHRASES.some(() => true)) return;
  const level = store.settings().level;
  const p = plan({ ...ui, level });
  const heard = PHRASES.some((x) => inScope(x, { ...ui, level }) && store.item(x.id).introduced);
  if (!p.fresh.length && !heard && p.capReached) {
    $('#plan-note').textContent = `Na úrovni ${level} zatiaľ nemáš čo opakovať a denný limit nových fráz je vyčerpaný. Zvýš limit v nastaveniach alebo príď zajtra.`;
    return;
  }
  session = new Session({ ...ui, level: store.settings().level }, sessionUi);
  $('#p-topic').textContent = `${LANG.short} ${store.settings().level} · ${TOPICS.find((t) => t.id === ui.topic).sk} · ${ui.minutes} min · ${ui.mode === 'listen' ? 'počúvanie' : 'hovorenie'}`;
  $('#rate-listen').hidden = ui.mode !== 'listen';
  $('#rate-speak').hidden = ui.mode !== 'speak';
  $('#rate-hint').hidden = ui.mode !== 'speak';
  $('#pause-btn').textContent = 'Pauza';
  show('player');

  startKeepAlive();
  setMediaHandlers({
    knew: () => session && session.rate(store.Rating.Good, 'media'),
    again: () => session && session.rate(store.Rating.Again, 'media'),
    pause: () => session && session.pause(),
    play: () => session && session.resume(),
  });
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  progressTimer = setInterval(() => { if (session) $('#progress').style.width = `${Math.round(session.progress() * 100)}%`; }, 1000);

  const result = await session.run();
  clearInterval(progressTimer);
  stopKeepAlive();
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
  session = null;
  showSummary(result);
}

function showSummary(r) {
  const avg = r.pron.length ? Math.round(r.pron.reduce((a, b) => a + b, 0) / r.pron.length) : '–';
  statTiles($('#sum-stats'), [
    [r.plays, 'prehratí'],
    [r.newIntroduced, 'nových fráz'],
    [r.rated ? `${r.rated - r.again}/${r.rated}` : '–', 'vedel som'],
    [avg, 'výslovnosť ⌀'],
  ]);
  const notes = [`Trvanie ${Math.max(1, Math.round(r.minutes))} min.`];
  if (!r.rated) notes.push('Žiadne hodnotenie: frázy sa zaznamenali len ako vypočuté, plánovač sa nepohol. Stlač „Vedel som“ alebo tlačidlo ďalšej skladby na slúchadlách.');
  else if (r.again) notes.push(`${r.again}× znova. Tieto frázy prídu skôr.`);
  if (r.endedEarly) notes.push('Skončili sme skôr: na tejto úrovni by sa všetko ostatné opakovalo skôr ako o 5 minút a nové frázy už nie sú (alebo je vyčerpaný denný limit v nastaveniach).');
  notes.push('Krátke opakovanie ráno po večernom učení pomáha najviac.');
  $('#sum-note').textContent = notes.join(' ');
  show('summary');
}

$('#start').addEventListener('click', startSession);
$('#rate-listen').addEventListener('click', (e) => { const b = e.target.closest('[data-grade]'); if (b && session) session.rate(Number(b.dataset.grade), 'button'); });
$('#rate-speak').addEventListener('click', (e) => { const b = e.target.closest('[data-grade]'); if (b && session) session.rate(Number(b.dataset.grade), 'self'); });
$('#pause-btn').addEventListener('click', () => { if (!session) return; session.paused ? session.resume() : session.pause(); });
$('#stop-btn').addEventListener('click', () => session && session.stop());
$('#sum-home').addEventListener('click', () => { renderHome(); show('home'); });

document.addEventListener('keydown', (e) => {
  if (!session || e.target.closest('input, select, textarea')) return;
  const k = e.key;
  if (session.opts.mode === 'listen') {
    if (k === 'ArrowRight' || k === 'k') session.rate(3, 'key');
    else if (k === 'ArrowLeft' || k === 'j') session.rate(1, 'key');
  } else if (['1', '2', '3', '4'].includes(k)) session.rate(Number(k), 'self');
  if (k === ' ') { e.preventDefault(); session.paused ? session.resume() : session.pause(); }
});

// ---------- settings ----------
function fillVoices() {
  const s = store.settings();
  const tlWanted = s.voicePrefs?.[LANG.code] ?? (LANG.code === 'es-ES' ? s.esVoice : '');
  $('#tl-voice-label').textContent = `${LANG.name}: hlas prehliadača`;
  for (const [id, lang, wanted] of [['#s-tlVoice', LANG.code, tlWanted], ['#s-skVoice', 'sk-SK', s.skVoice]]) {
    const list = voicesFor(lang);
    const sel = $(id);
    sel.innerHTML = '<option value="">Automaticky</option>' + list.map((v) => `<option ${v.name === wanted ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('');
  }
  const missing = [LANG.code, 'sk-SK'].filter((l) => !voicesFor(l).length);
  const fallback = missing.includes('sk-SK') && voicesFor('cs-CZ').length ? ' Pre slovenčinu sa zatiaľ použije český hlas.' : '';
  $('#voice-note').textContent = bundledEnabled()
    ? 'Frázy hrajú nahraté prirodzené hlasy (slovenčina: Viktória; pre každý jazyk 2–3 rodení hovoriaci). Hlasy prehliadača sú len záloha pre text bez nahrávky.'
    : missing.length
      ? `Prehliadač nemá hlas pre: ${missing.join(', ')}.${fallback} Zapni nahraté hlasy alebo doinštaluj hlas v systéme (Nastavenia > Jazyk/Reč).`
      : (azureEnabled() ? 'Používajú sa Azure neurónové hlasy; hlasy prehliadača sú záloha.' : '');
}

function renderSettings() {
  const s = store.settings();
  fillVoices();
  for (const k of ['rate', 'pauseFactor']) { $('#s-' + k).value = s[k]; $('#o-' + k).textContent = k === 'rate' ? `${s[k]}×` : `${s[k]}×`; }
  for (const k of ['repeatTarget', 'showText', 'azureTts']) $('#s-' + k).checked = !!s[k];
  $('#s-bundledVoices').checked = s.bundledVoices !== false;
  for (const k of ['dailyNewCap', 'productionAfter', 'azureKey', 'azureRegion']) $('#s-' + k).value = s[k];
  $('#azure-status').textContent = lastAudioError ? `Posledná chyba: ${lastAudioError}` : '';
}

$('#settings').addEventListener('input', (e) => {
  const el = e.target;
  if (!el.id?.startsWith('s-') || el.id === 's-tlVoice' || el.id === 's-skVoice') return;
  const k = el.id.slice(2);
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (['rate', 'pauseFactor'].includes(k)) { v = Number(v); $('#o-' + k).textContent = `${v}×`; }
  if (['dailyNewCap', 'productionAfter'].includes(k)) v = Math.max(0, Number(v) || 0);
  if (k === 'azureKey' || k === 'azureRegion') v = String(v).trim();
  store.updateSettings({ [k]: v });
  if (k === 'bundledVoices') fillVoices();
});
$('#s-tlVoice').addEventListener('change', (e) => store.updateSettings({ voicePrefs: { ...(store.settings().voicePrefs || {}), [LANG.code]: e.target.value } }));
$('#s-skVoice').addEventListener('change', (e) => store.updateSettings({ skVoice: e.target.value }));
$('#open-settings').addEventListener('click', () => { renderSettings(); show('settings'); });
$('#close-settings').addEventListener('click', () => { renderHome(); show('home'); });
if ('speechSynthesis' in window) speechSynthesis.addEventListener?.('voiceschanged', () => { if (!$('#settings').hidden) fillVoices(); });

$('#test-azure').addEventListener('click', async () => {
  const s = store.settings();
  const out = $('#azure-status');
  if (!s.azureKey) { out.textContent = 'Najprv zadaj kľúč.'; return; }
  out.textContent = 'Testujem…';
  try {
    const r = await fetch(`https://${s.azureRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': s.azureKey } });
    out.textContent = r.ok ? 'Kľúč funguje.' : `Kľúč nefunguje (HTTP ${r.status}). Skontroluj kľúč a región.`;
  } catch (e) { out.textContent = `Spojenie zlyhalo: ${e.message}`; }
});

$('#export').addEventListener('click', () => {
  const blob = new Blob([store.exportData()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `frazy-${store.today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('#import').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { store.importData(await f.text()); $('#azure-status').textContent = 'Pokrok importovaný.'; renderSettings(); }
  catch (err) { $('#azure-status').textContent = `Import zlyhal: ${err.message}`; }
  e.target.value = '';
});
$('#reset').addEventListener('click', () => {
  const btn = $('#reset');
  if (btn.dataset.armed) { store.resetProgress(); btn.textContent = 'Vymazané'; delete btn.dataset.armed; return; }
  btn.dataset.armed = '1';
  btn.textContent = 'Naozaj? Klikni znova';
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Vymazať pokrok'; }, 4000);
});

// ---------- boot ----------
renderHome();
show('home');
try { navigator.storage?.persist?.(); } catch {}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
