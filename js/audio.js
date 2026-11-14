// Audio output, in order of preference:
//   1. bundled clips (audio/<voice>/<id>.mp3, natural Microsoft neural voices, made by
//      tools/make_audio.py): same voice on every device, no key, offline once cached;
//   2. Azure neural TTS (if a key is set), for text that has no bundled clip;
//   3. the browser's speechSynthesis, preferring a real Slovak voice and falling back
//      to Czech rather than letting an English voice mangle Slovak text.
// All recorded audio goes through one HTMLAudioElement. Plus cancellable pauses and a
// silent keep-alive track so lock-screen / earbud buttons reach the page.
import { settings } from './store.js';

const AZURE_VOICES = {
  'es-ES': ['es-ES-ElviraNeural', 'es-ES-AlvaroNeural', 'es-ES-XimenaNeural'],
  'de-DE': ['de-DE-TanjaNeural', 'de-DE-ChristophNeural'],
  'fr-FR': ['fr-FR-DeniseNeural', 'fr-FR-HenriNeural', 'fr-FR-VivienneMultilingualNeural'],
  'ar-AE': ['ar-AE-FatimaNeural', 'ar-AE-HamdanNeural', 'ar-SA-ZariyahNeural'],
  'ru-RU': ['ru-RU-SvetlanaNeural', 'ru-RU-DmitryNeural'],
  'ar-EG': ['ar-EG-SalmaNeural', 'ar-EG-ShakirNeural'],
  'sk-SK': ['sk-SK-ViktoriaNeural'],
};

const player = new Audio();
player.preload = 'auto';
let keepAlive = null;
let abortCtl = new AbortController();
const ttsCache = new Map(); // in-memory object URLs for this page load

export function cancelAll() {
  abortCtl.abort();
  abortCtl = new AbortController();
  try { speechSynthesis.cancel(); } catch {}
  try { player.pause(); } catch {}
}

export const signal = () => abortCtl.signal;

class Aborted extends Error { constructor() { super('aborted'); this.name = 'Aborted'; } }
export const isAbort = (e) => e && e.name === 'Aborted';

export function wait(ms, sig = signal()) {
  return new Promise((resolve, reject) => {
    if (sig.aborted) return reject(new Aborted());
    const t = setTimeout(resolve, ms);
    sig.addEventListener('abort', () => { clearTimeout(t); reject(new Aborted()); }, { once: true });
  });
}

// ---------- browser voices ----------
let voices = [];
function refreshVoices() { try { voices = speechSynthesis.getVoices() || []; } catch { voices = []; } }
if ('speechSynthesis' in window) {
  refreshVoices();
  speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
}

export function voicesFor(lang) {
  refreshVoices();
  const base = lang.slice(0, 2);
  const exact = voices.filter((v) => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase());
  const loose = voices.filter((v) => v.lang.toLowerCase().startsWith(base) && !exact.includes(v));
  return [...exact, ...loose];
}

// Without a Slovak voice the browser would read Slovak with its default (often English)
// voice. Czech is close enough to be understood and sounds far more natural.
const FALLBACK_LANG = { 'sk-SK': 'cs-CZ' };
const bestOf = (list) => list.find((v) => /natural|neural|online|google|premium|enhanced/i.test(v.name)) || list[0] || null;

function pickVoice(lang) {
  const s = settings();
  const wanted = lang === 'sk-SK' ? s.skVoice : (s.voicePrefs?.[lang] ?? (lang === 'es-ES' ? s.esVoice : ''));
  const list = voicesFor(lang);
  if (list.length) return list.find((v) => v.name === wanted) || bestOf(list);
  return FALLBACK_LANG[lang] ? bestOf(voicesFor(FALLBACK_LANG[lang])) : null;
}

export function hasBrowserVoice(lang) { return voicesFor(lang).length > 0; }

function speakBrowser(text, lang, sig) {
  return new Promise((resolve, reject) => {
    if (sig.aborted) return reject(new Aborted());
    if (!('speechSynthesis' in window)) {
      // No speech at all: leave roughly the time it would take to say it.
      return wait(estimateMs(text), sig).then(resolve, reject);
    }
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(lang);
    u.lang = v ? v.lang : lang;
    if (v) u.voice = v;
    u.rate = settings().rate;
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(guard); resolve(); } };
    // Some engines never fire onend (headless, background tabs): cap the wait.
    const guard = setTimeout(finish, estimateMs(text) * 2 + 2500);
    u.onend = finish;
    u.onerror = finish;
    sig.addEventListener('abort', () => { clearTimeout(guard); speechSynthesis.cancel(); if (!done) { done = true; reject(new Aborted()); } }, { once: true });
    speechSynthesis.speak(u);
  });
}

function estimateMs(text) {
  return Math.max(700, syllables(text) * 190 / (settings().rate || 1));
}

export function syllables(text) {
  const t = text.toLowerCase();
  // Arabic script mostly omits short vowels: estimate from the letter count.
  const arabic = t.match(/[\u0621-\u064A]/g);
  if (arabic && arabic.length > t.replace(/\s/g, '').length / 2) return Math.max(1, Math.round(arabic.length / 2.2));
  const m = t.match(/[aeiouáéíóúüyäôľŕàâèêëîïœùûÿöß]+|[аеёиоуыэюя]+/g);
  return m ? m.length : 1;
}

// ---------- bundled clips ----------
let bundle = null; // { voices: { lang: [folder] }, clips: { lang: { text: id } } }
const bundleReady = fetch('audio/manifest.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => { bundle = j; })
  .catch(() => {});

export function bundledEnabled() { return settings().bundledVoices !== false; }

const missingClips = new Set();
let listedMissing = false;

// Fetch as a blob (not <audio src=url>): no range requests, so the service worker can
// cache the whole clip and playback works offline. Starts with the voice for this turn;
// if that voice has no file for the line, another voice of the same language is used.
async function bundledClip(text, lang, voiceIndex) {
  const id = bundle?.clips?.[lang]?.[text];
  const folders = bundle?.voices?.[lang];
  if (!id || !folders?.length) return null;
  if (!listedMissing) {
    listedMissing = true;
    for (const [folder, ids] of Object.entries(bundle.missing || {})) for (const m of ids) missingClips.add(`audio/${folder}/${m}.mp3`);
  }
  for (let k = 0; k < folders.length; k++) {
    const url = `audio/${folders[(voiceIndex + k) % folders.length]}/${id}.mp3`;
    if (ttsCache.has(url)) return ttsCache.get(url);
    if (missingClips.has(url)) continue;
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) { missingClips.add(url); continue; }
    const obj = URL.createObjectURL(await res.blob());
    ttsCache.set(url, obj);
    return obj;
  }
  throw new Error(`no recording for "${text}"`);
}

// ---------- Azure TTS ----------
export function azureEnabled() {
  const s = settings();
  return !!(s.azureKey && s.azureRegion && s.azureTts);
}

function escapeXml(t) {
  return t.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

async function azureClip(text, lang, voiceIndex) {
  const s = settings();
  const list = AZURE_VOICES[lang];
  if (!list) throw new Error(`no Azure voice for ${lang}`);
  const voice = list[voiceIndex % list.length];
  const pct = Math.round((s.rate - 1) * 100);
  const cacheKey = `${voice}|${pct}|${text}`;
  if (ttsCache.has(cacheKey)) return ttsCache.get(cacheKey);

  // Persistent cache so each clip is only generated (and billed) once.
  const cacheName = 'tutor-tts-v1';
  const reqUrl = `/__tts/${encodeURIComponent(cacheKey)}`;
  let blob = null;
  try {
    const c = await caches.open(cacheName);
    const hit = await c.match(reqUrl);
    if (hit) blob = await hit.blob();
  } catch {}

  if (!blob) {
    const ssml = `<speak version="1.0" xml:lang="${lang}"><voice name="${voice}"><prosody rate="${pct >= 0 ? '+' : ''}${pct}%">${escapeXml(text)}</prosody></voice></speak>`;
    const res = await fetch(`https://${s.azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': s.azureKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      },
      body: ssml,
    });
    if (!res.ok) throw new Error(`Azure TTS ${res.status}`);
    blob = await res.blob();
    try { const c = await caches.open(cacheName); await c.put(reqUrl, new Response(blob, { headers: { 'Content-Type': 'audio/mpeg' } })); } catch {}
  }
  const url = URL.createObjectURL(blob);
  ttsCache.set(cacheKey, url);
  return url;
}

function playUrl(url, sig, rate = 1) {
  return new Promise((resolve, reject) => {
    if (sig.aborted) return reject(new Aborted());
    const cleanup = () => { player.onended = null; player.onerror = null; };
    player.onended = () => { cleanup(); resolve(); };
    player.onerror = () => { cleanup(); reject(new Error('audio error')); };
    sig.addEventListener('abort', () => { cleanup(); player.pause(); reject(new Aborted()); }, { once: true });
    player.src = url;
    // Setting src resets the rate, so set it after. Pitch is preserved by default.
    player.defaultPlaybackRate = player.playbackRate = rate;
    player.play().catch((e) => { cleanup(); reject(e); });
  });
}

let azureFailures = 0;
export let lastAudioError = '';

// Speak one phrase. voiceIndex rotates Spanish voices (speaker variability helps learning).
export async function say(text, lang, { voiceIndex = 0 } = {}) {
  const sig = signal();
  if (bundledEnabled()) {
    await bundleReady;
    try {
      const url = await bundledClip(text, lang, voiceIndex);
      if (url) {
        if (sig.aborted) throw new Aborted();
        await playUrl(url, sig, settings().rate || 1);
        return;
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      lastAudioError = String(e.message || e);
      console.warn('Bundled clip failed, trying the next voice source', e);
    }
  }
  if (azureEnabled() && azureFailures < 3) {
    try {
      const url = await azureClip(text, lang, voiceIndex);
      if (sig.aborted) throw new Aborted();
      await playUrl(url, sig);
      azureFailures = 0;
      return;
    } catch (e) {
      if (isAbort(e)) throw e;
      azureFailures++;
      lastAudioError = String(e.message || e);
      console.warn('Azure TTS failed, using browser voice', e);
    }
  }
  await speakBrowser(text, lang, sig);
}

// Pre-generate the clips for upcoming phrases so playback has no gaps.
export function prefetch(phrases) {
  if (bundledEnabled()) {
    bundleReady.then(() => {
      for (const p of phrases) {
        const n = bundle?.voices?.[p.code]?.length || 1;
        for (let v = 0; v < n; v++) bundledClip(p.tl, p.code, v).catch(() => {});
        bundledClip(p.sk, 'sk-SK', 0).catch(() => {});
      }
    });
  }
  if (!azureEnabled()) return;
  for (const [i, p] of phrases.entries()) {
    azureClip(p.tl, p.code, i).catch(() => {});
    azureClip(p.sk, 'sk-SK', 0).catch(() => {});
  }
}

// ---------- keep-alive + media session ----------
function silentWavUrl(seconds = 2, rate = 8000) {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export function startKeepAlive() {
  if (!keepAlive) {
    keepAlive = new Audio(silentWavUrl());
    keepAlive.loop = true;
  }
  keepAlive.play().catch(() => {});
}
export function stopKeepAlive() { try { keepAlive && keepAlive.pause(); } catch {} }

export function setMediaHandlers({ knew, again, pause, play }) {
  if (!('mediaSession' in navigator)) return;
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch {} };
  // Only next/previous (+ play/pause): seek handlers make iOS show seek buttons instead.
  set('nexttrack', knew);
  set('previoustrack', again);
  set('pause', pause);
  set('play', play);
}

export function setNowPlaying(title, artist) {
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album: 'Frázy ES' }); } catch {}
}
