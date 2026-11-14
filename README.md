# Frázy ES: Slovak → Spanish audio phrase tutor (v1)

A standalone web app (no build step, no account, no server code). Everything runs in the browser and progress is stored in that browser only.

## Run it

ES modules don't load from `file://`, so serve the folder:

```
cd tutor-app
python3 -m http.server 8000      # or: npx serve .
```

Open http://localhost:8000 in Chrome or Edge. The microphone and "install as app" need HTTPS (or localhost), so to use it on a phone, host the folder on any static host (GitHub Pages, Netlify, Cloudflare Pages).

## What's in v1

- **145 starter phrases** in 5 topics (greetings, café/restaurant, getting around, shopping, small talk), European Spanish with Slovak. Hand-written; still needs a native check before the set grows.
- **Audio loop**: Spanish → pause (say the meaning) → Slovak → Spanish again. Pauses: ~3 s for new items, ~2 s for known ones, longer for production; adjustable in settings.
- **Direction switch**: after 3 "knew it" ratings, a phrase flips to Slovak → pause → Spanish (you produce the Spanish).
- **Spacing within a session**: new phrases come back after 3, 7, 15 and 30 other items, never back-to-back; "again" brings an item back after 4.
- **Spacing across sessions**: FSRS (ts-fsrs, 90% target retention). Only explicit ratings move the scheduler, and only the first rating of a phrase in a session. Plain listening is logged as an exposure. Reviews come from all topics by due date; the topic picks the new phrases. No new phrases when reviews fill 80% of the session. Daily cap of 15 new.
- **Sessions** of 5/10/20/30 min, starting with reviews.
- **Listen mode**: hands-free. Earbud/lock-screen *next track* = knew it, *previous track* = again (also on-screen buttons and ← / → keys).
- **Speak mode**: you say the answer or repeat the Spanish aloud, get a 0–100 pronunciation score, then rate your recall yourself (Again/Hard/Good/Easy, keys 1–4). The score never changes the schedule.
- **Voices**: browser speech by default (free). An optional Azure Speech key (Settings) switches to neural voices (rotating 3 Spanish voices, clips cached after first use) and enables Azure pronunciation assessment. Without a key, speak mode uses the browser's speech recognition (Chrome/Edge/Android) for a rough similarity score.
- Offline cache (service worker), export/import of progress, day streak.

## Known limits

- With browser voices, iOS stops speech when the screen locks. Lock-screen listening needs the Azure voices (real audio files) and still has to be tested on a real iPhone.
- Browser voice quality depends on the device. Slovak voices may be missing on some systems (Settings shows a warning).
- The Azure key sits in the browser's localStorage. Fine for personal use; don't share a hosted copy that contains your key.

## Files

- `js/phrases.js`: phrase data
- `js/session.js`: session planning and the audio loop
- `js/store.js`: progress, FSRS, review log
- `js/audio.js`: TTS (Azure / browser), media keys
- `js/pron.js`: pronunciation scoring
- `vendor/`: ts-fsrs 5.2.3 (MIT), Azure Speech SDK 1.44.0 (MIT)
