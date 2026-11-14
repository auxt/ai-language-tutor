# Frázy: audio phrase tutor from Slovak (Spanish, German, French, Arabic, Russian)

A standalone web app (no build step, no account, no server code). Everything runs in the browser and progress is stored in that browser only.

## Run it

ES modules don't load from `file://`, so serve the folder:

```
cd ai-language-tutor
python3 -m http.server 8000      # or: npx serve .
```

Live copy: https://auxt.github.io/ai-language-tutor/ (GitHub Pages, served from the `gh-pages` branch).

Open http://localhost:8000 in Chrome or Edge. The microphone and "install as app" need HTTPS (or localhost), so to use it on a phone, host the folder on any static host (GitHub Pages, Netlify, Cloudflare Pages).

## Languages

Pick the language and your level on the home screen. Each language has the same 235 everyday phrases in five topics and five levels, plus a sixth topic of famous film and TV lines from that culture, with its own progress, daily new-phrase limit and recorded voices:

| | Variety | Recorded voices | Notes |
|---|---|---|---|
| ES | Spain | Elvira, Álvaro, Ximena | |
| DE | Germany | Tanja, Christoph | du with friends, Sie with staff and strangers |
| FR | France | Denise, Henri, Vivienne | tu/vous the same way |
| AR | Modern Standard Arabic | Fatima, Hamdan (UAE), Zariyah (Saudi) | right-to-left, Slovak-friendly transliteration, a few items adapted to the Gulf |
| RU | Russian | Svetlana, Dmitry | Slovak-friendly transliteration |

### Levels A1–C1

The home screen has a level switch (A1, A2, B1, B2, C1). The level decides which new phrases a session brings in; reviews of anything you already learned still come back by their due date whatever level is set. The film lines belong to every level.

| Level | Per language | What it covers |
|---|---|---|
| A1 | about 90 | greetings, one-to-three-word basics |
| A2 | about 55 | everyday situations in full sentences |
| B1 | 30 | asking for help, explaining, complaining politely, plans and past habits |
| B2 | 30 | opinions, conditions ("if I had known…"), refunds and complaints, negotiating |
| C1 | 30 | nuance, idioms, diplomatic disagreement, firm but polite pressure |

A1 and A2 are split automatically by the length of the Slovak line (up to three words is A1). B1–C1 are written as their own sets in each language pack under `levels`, from one shared Slovak list, so every language teaches the same situations.

### Famous film and TV lines

The sixth topic, "Slávne vety z filmov a seriálov", holds lines a typical person from each culture knows: the country's own classics plus world hits as they are known there in the local dub (Spain's dub of *Terminator 2* says "Sayonara, baby"). Each line shows its film or series and year. Counts: ES 25, DE 20, FR 25, RU 31, AR 12. The Arabic lines are Egyptian, because Egyptian cinema is what the whole Arab world quotes, so they use Egyptian voices (Salma, Shakir).

Rules for adding lines: one short line (under 15 words) per film or series, checked against a source for exact wording, and no song lyrics, poems or passages from novels.

Slovak lines are adapted per language where needed (for example "Učím sa nemčinu"). Every set still needs a check by a native speaker. To add a language, copy `js/lang/de.js`, add it to `LANGS` in `js/phrases.js` and its voices in `tools/make_audio.py` and `AZURE_VOICES` in `js/audio.js`, then run the audio script.

## What's in v1

- **235 phrases per language** in 5 topics (greetings, café/restaurant, getting around, shopping, small talk) across levels A1–C1, plus film lines. Hand-written; still needs a native check.
- **Audio loop**: Spanish → pause (say the meaning) → Slovak → Spanish again. Pauses: ~3 s for new items, ~2 s for known ones, longer for production; adjustable in settings.
- **Direction switch**: after 3 "knew it" ratings, a phrase flips to Slovak → pause → Spanish (you produce the Spanish).
- **Spacing within a session** is by time, not by count: a phrase never comes back sooner than about 5 minutes. A new phrase returns after 5 and then 12 minutes, "again" brings it back after 5. The time in between is filled with other new phrases of your level and older phrases you have not heard for a while. If there is nothing left that would not repeat too soon (for example the daily new limit is used up), the session ends early and says so instead of drilling the same lines.
- **Spacing across sessions**: FSRS (ts-fsrs, 90% target retention). Only explicit ratings move the scheduler, and only the first rating of a phrase in a session. Plain listening is logged as an exposure. Reviews come from all topics by due date; the topic picks the new phrases. No new phrases when reviews fill 80% of the session. Daily cap of 50 new (Settings).
- **Sessions** of 5/10/20/30 min, starting with reviews.
- **Listen mode**: hands-free. Earbud/lock-screen *next track* = knew it, *previous track* = again (also on-screen buttons and ← / → keys).
- **Speak mode**: you say the answer or repeat the Spanish aloud, get a 0–100 pronunciation score, then rate your recall yourself (Again/Hard/Good/Easy, keys 1–4). The score never changes the schedule.
- **Voices**: every phrase ships with recorded natural neural voices in `audio/`: Slovak by Viktória, each target language rotating between 2–3 native voices (table above). They sound the same on every device, need no key, work offline once played, and keep playing with the screen locked. Text without a recording falls back to Azure (if a key is set) and then to the browser voice. When the browser has no Slovak voice, the app uses a Czech one, never an English one. An optional Azure Speech key (Settings) also enables Azure pronunciation assessment. Without a key, speak mode uses the browser's speech recognition (Chrome/Edge/Android) for a rough similarity score.
- **Spoken vs. shown Slovak**: `sk` holds exactly what is said aloud. Alternatives and usage hints go in an optional third field (`note`), which is shown on screen but never spoken.
- Offline cache (service worker), export/import of progress, day streak.

## Known limits

- With browser voices, iOS stops speech when the screen locks. The recorded clips are real audio files, so lock-screen listening should work, but it still has to be tested on a real iPhone.
- Browser voice quality depends on the device. Slovak voices may be missing on some systems (Settings shows a warning).
- The Azure key sits in the browser's localStorage. Fine for personal use; don't share a hosted copy that contains your key.

## Files

- `js/phrases.js`: language registry and phrase model
- `js/lang/<id>.js`: phrase data per language
- `audio/`: recorded clips (`<voice>/<phrase-id>.mp3`) and `manifest.json`, which maps phrase text to clip
- `tools/make_audio.py`: regenerates the clips after you add or edit phrases (`pip install edge-tts`, then `python3 tools/make_audio.py`; only changed phrases are redone)
- `js/session.js`: session planning and the audio loop
- `js/store.js`: progress, FSRS, review log
- `js/audio.js`: TTS (Azure / browser), media keys
- `js/pron.js`: pronunciation scoring
- `vendor/`: ts-fsrs 5.2.3 (MIT), Azure Speech SDK 1.44.0 (MIT)

## Updating the live site

GitHub Pages serves the `gh-pages` branch. After committing to `main` in GitHub Desktop: switch to `gh-pages`, choose Branch → Update from main, push, and switch back to `main`. Bump `VERSION` in `sw.js` whenever files change, so installed copies pick up the update.

The recorded clips use Microsoft neural voices through the free Edge read-aloud service. They are fine for a personal, non-commercial app like this one. For anything commercial, regenerate them with your own Azure Speech key (same voices).
