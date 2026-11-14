// Pronunciation scoring (0-100) for speak-aloud mode.
// 1. Azure pronunciation assessment (scripted, HundredMark) when a key is set.
// 2. Otherwise the browser's SpeechRecognition (Chrome/Edge/Android): compares the
//    transcript with the reference. Only a rough estimate, labelled as such.
// The score is feedback only. It never decides the scheduling grade.
import { settings } from './store.js';

let sdkPromise = null;
function loadSdk() {
  if (window.SpeechSDK) return Promise.resolve(window.SpeechSDK);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/speech-sdk.min.js';
      s.onload = () => resolve(window.SpeechSDK);
      s.onerror = () => reject(new Error('Could not load the Azure Speech SDK'));
      document.head.appendChild(s);
    });
  }
  return sdkPromise;
}

export function scoringMethod() {
  const s = settings();
  if (s.azureKey && s.azureRegion) return 'azure';
  if (window.SpeechRecognition || window.webkitSpeechRecognition) return 'browser';
  return 'none';
}

// Listens once and resolves { score, method, heard, words?, detail? } or null if nothing was heard.
export async function assess(reference, { timeoutMs = 7000, lang = 'es-ES' } = {}) {
  const method = scoringMethod();
  if (method === 'azure') {
    try { return await assessAzure(reference, timeoutMs, lang); }
    catch (e) { console.warn('Azure pronunciation assessment failed', e); }
    if (window.SpeechRecognition || window.webkitSpeechRecognition) return assessBrowser(reference, timeoutMs, lang);
    return null;
  }
  if (method === 'browser') return assessBrowser(reference, timeoutMs, lang);
  return null;
}

async function assessAzure(reference, timeoutMs, lang) {
  const SDK = await loadSdk();
  const s = settings();
  const speechConfig = SDK.SpeechConfig.fromSubscription(s.azureKey, s.azureRegion);
  speechConfig.speechRecognitionLanguage = lang;
  speechConfig.setProperty(SDK.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, String(timeoutMs));
  speechConfig.setProperty(SDK.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, '900');
  const audioConfig = SDK.AudioConfig.fromDefaultMicrophoneInput();
  const pa = new SDK.PronunciationAssessmentConfig(
    reference,
    SDK.PronunciationAssessmentGradingSystem.HundredMark,
    SDK.PronunciationAssessmentGranularity.Word,
    true,
  );
  const recognizer = new SDK.SpeechRecognizer(speechConfig, audioConfig);
  pa.applyTo(recognizer);
  try {
    const result = await new Promise((resolve, reject) => recognizer.recognizeOnceAsync(resolve, reject));
    if (result.reason !== SDK.ResultReason.RecognizedSpeech) return null;
    const r = SDK.PronunciationAssessmentResult.fromResult(result);
    const words = (r.detailResult?.Words || []).map((w) => ({
      word: w.Word,
      score: Math.round(w.PronunciationAssessment?.AccuracyScore ?? 0),
      error: w.PronunciationAssessment?.ErrorType || 'None',
    }));
    return {
      method: 'azure',
      score: Math.round(r.pronunciationScore),
      heard: result.text,
      detail: {
        accuracy: Math.round(r.accuracyScore),
        fluency: Math.round(r.fluencyScore),
        completeness: Math.round(r.completenessScore),
      },
      words,
    };
  } finally {
    recognizer.close();
  }
}

// Lower-case, drop accents (Latin and Cyrillic) and Arabic vowel marks, keep letters of
// any script.
function norm(t) {
  return t.toLowerCase().replace(/ß/g, 'ss').normalize('NFD')
    .replace(/[\u0300-\u036f\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter(Boolean);
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function similarity(reference, heard) {
  const r = norm(reference).join(' ');
  const h = norm(heard).join(' ');
  if (!r.length) return 0;
  const d = editDistance([...r], [...h]);
  return Math.max(0, Math.round(100 * (1 - d / Math.max(r.length, h.length))));
}

function assessBrowser(reference, timeoutMs, lang) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  return new Promise((resolve) => {
    const rec = new SR();
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 5;
    let best = null;
    const timer = setTimeout(() => { try { rec.stop(); } catch {} }, timeoutMs);
    rec.onresult = (ev) => {
      const alts = [...ev.results[0]].map((a) => a.transcript);
      for (const heard of alts) {
        const score = similarity(reference, heard);
        if (!best || score > best.score) best = { method: 'browser', score, heard };
      }
    };
    rec.onerror = () => {};
    rec.onend = () => { clearTimeout(timer); resolve(best); };
    try { rec.start(); } catch { clearTimeout(timer); resolve(null); }
  });
}
