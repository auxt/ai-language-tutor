#!/usr/bin/env python3
"""Pre-generate natural neural voice clips for every phrase.

Writes audio/<voice>/<phrase-id>.mp3 and audio/manifest.json for every language in
js/lang/. The app plays these files first, so every device gets the same natural
voices with no API key, works offline once cached, and keeps playing with the screen
locked. Each Slovak line is recorded once and shared by all languages that use it.

Usage (from the repo root):
    pip install edge-tts
    python3 tools/make_audio.py            # only (re)makes clips whose text changed
    python3 tools/make_audio.py --force    # remakes everything

Voices are Microsoft neural voices (the same ones the Azure option in Settings uses).
Phrases are read from js/phrases.js through Node, so add or edit phrases there and
run this script again.
"""
import argparse, asyncio, json, os, ssl, subprocess, sys
from pathlib import Path

import edge_tts
import edge_tts.communicate as ec

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'audio'
# Folder name -> voice, per language code. Only voices the read-aloud service lists;
# unknown names fall back silently to a default voice.
VOICES = {
    'es-ES': {'elvira': 'es-ES-ElviraNeural', 'alvaro': 'es-ES-AlvaroNeural', 'ximena': 'es-ES-XimenaNeural'},
    'de-DE': {'tanja': 'de-DE-TanjaNeural', 'christoph': 'de-DE-ChristophNeural'},
    'fr-FR': {'denise': 'fr-FR-DeniseNeural', 'henri': 'fr-FR-HenriNeural', 'vivienne': 'fr-FR-VivienneMultilingualNeural'},
    'ar-AE': {'fatima': 'ar-AE-FatimaNeural', 'hamdan': 'ar-AE-HamdanNeural', 'zariyah': 'ar-SA-ZariyahNeural'},
    'ru-RU': {'svetlana': 'ru-RU-SvetlanaNeural', 'dmitry': 'ru-RU-DmitryNeural'},
    'sk-SK': {'viktoria': 'sk-SK-ViktoriaNeural'},
}

# Behind a TLS-inspecting proxy, point SSL_CERT_FILE at its CA bundle.
if os.environ.get('SSL_CERT_FILE'):
    ec._SSL_CTX = ssl.create_default_context(cafile=os.environ['SSL_CERT_FILE'])


def load_phrases():
    js = "import('./js/phrases.js').then(m => console.log(JSON.stringify(m.allPhrases())))"
    out = subprocess.run(['node', '--input-type=module', '-e', js], cwd=ROOT, check=True, capture_output=True, text=True)
    return json.loads(out.stdout)


def trim(path):
    """Cut the ~0.2 s lead-in and ~0.9 s tail of silence so the app's pauses stay
    as timed. Stream copy (no re-encode), so quality is untouched. Needs ffmpeg."""
    import re, shutil
    if not shutil.which('ffmpeg'):
        return
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)], capture_output=True, text=True)
    dur = float(probe.stdout)
    log = subprocess.run(['ffmpeg', '-i', str(path), '-af', 'silencedetect=noise=-45dB:d=0.05', '-f', 'null', '-'], capture_output=True, text=True).stderr
    starts = [float(x) for x in re.findall(r'silence_start: ([\d.]+)', log)]
    ends = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', log)]
    begin = max(0.0, ends[0] - 0.06) if starts and starts[0] < 0.01 and ends else 0.0
    stop = dur
    if starts and starts[-1] > begin and (len(starts) > len(ends) or ends[-1] > dur - 0.05):
        stop = min(dur, starts[-1] + 0.15)
    if begin < 0.02 and stop > dur - 0.05:
        return
    tmp = path.with_suffix('.trim.mp3')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{begin:.3f}', '-i', str(path), '-t', f'{stop - begin:.3f}', '-c', 'copy', str(tmp)], check=True)
    tmp.replace(path)


async def make(text, voice, path, sem):
    async with sem:
        for attempt in range(6):
            try:
                tmp = path.with_suffix('.part')
                await edge_tts.Communicate(text, voice).save(str(tmp))
                if tmp.stat().st_size < 1000:
                    raise RuntimeError('empty clip')
                tmp.replace(path)
                await asyncio.to_thread(trim, path)
                return
            except Exception as e:  # network hiccups: back off and retry
                if attempt == 5:
                    path.with_suffix('.part').unlink(missing_ok=True)
                    raise RuntimeError(f'{voice} {text!r}: {e}') from e
                await asyncio.sleep(2.0 * (attempt + 1))


async def main(force):
    phrases = load_phrases()
    old = {}
    mf = OUT / 'manifest.json'
    if mf.exists() and not force:
        old = json.loads(mf.read_text(encoding='utf-8')).get('clips', {})

    # (language code, text) -> clip id. Target lines use their phrase id; a Slovak line
    # uses the id of the first phrase that says it, so shared lines are recorded once.
    wanted = {}
    for p in phrases:
        if p['code'] not in VOICES:
            sys.exit(f"no voices configured for {p['code']}")
        wanted.setdefault(p['code'], {}).setdefault(p['tl'], p['id'])
        wanted.setdefault('sk-SK', {}).setdefault(p['sk'], p['id'])

    manifest = {'voices': {lang: list(v) for lang, v in VOICES.items() if lang in wanted}, 'clips': {}}
    jobs, sem = [], asyncio.Semaphore(2)
    for lang, texts in wanted.items():
        manifest['clips'][lang] = texts
        prev = {cid: text for text, cid in old.get(lang, {}).items()}
        for text, cid in texts.items():
            for short, voice in VOICES[lang].items():
                path = OUT / short / f'{cid}.mp3'
                path.parent.mkdir(parents=True, exist_ok=True)
                # A file with no manifest entry yet comes from an interrupted run: keep it.
                if force or not path.exists() or (cid in prev and prev[cid] != text):
                    jobs.append((lang, text, path, make(text, voice, path, sem)))

    print(f'{len(phrases)} phrases in {len(wanted) - 1} languages, {len(jobs)} clips to make')
    results = await asyncio.gather(*(j[3] for j in jobs), return_exceptions=True)
    failed = [(lang, text, path) for (lang, text, path, _), r in zip(jobs, results) if isinstance(r, Exception)]
    for lang, text, path in failed:
        path.unlink(missing_ok=True)
        print('FAILED, run again to retry:', lang, path.parent.name, text)
    # Keep a line in the manifest while at least one voice has it: the app tries the
    # language's other voices when one file is missing.
    for lang, texts in manifest['clips'].items():
        for text, cid in list(texts.items()):
            if not any((OUT / v / f'{cid}.mp3').exists() for v in VOICES[lang]):
                del texts[text]
    mf.write_text(json.dumps(manifest, ensure_ascii=False, indent=0) + '\n', encoding='utf-8')
    print('done:', mf.relative_to(ROOT), f'({len(failed)} failed)' if failed else '')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    asyncio.run(main(ap.parse_args().force))
