#!/usr/bin/env python3
"""Pre-generate natural neural voice clips for every phrase.

Writes audio/<voice>/<phrase-id>.mp3 and audio/manifest.json. The app plays these
files first, so every device gets the same natural Slovak and Spanish voices with
no API key, works offline once cached, and keeps playing with the screen locked.

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
VOICES = {
    'es-ES': {'elvira': 'es-ES-ElviraNeural', 'alvaro': 'es-ES-AlvaroNeural', 'ximena': 'es-ES-XimenaNeural'},
    'sk-SK': {'viktoria': 'sk-SK-ViktoriaNeural'},
}
FIELD = {'es-ES': 'es', 'sk-SK': 'sk'}

# Behind a TLS-inspecting proxy, point SSL_CERT_FILE at its CA bundle.
if os.environ.get('SSL_CERT_FILE'):
    ec._SSL_CTX = ssl.create_default_context(cafile=os.environ['SSL_CERT_FILE'])


def load_phrases():
    js = "import('./js/phrases.js').then(m => console.log(JSON.stringify(m.PHRASES)))"
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
        for attempt in range(4):
            try:
                tmp = path.with_suffix('.part')
                await edge_tts.Communicate(text, voice).save(str(tmp))
                if tmp.stat().st_size < 1000:
                    raise RuntimeError('empty clip')
                tmp.replace(path)
                await asyncio.to_thread(trim, path)
                return
            except Exception as e:  # network hiccups: back off and retry
                if attempt == 3:
                    raise RuntimeError(f'{voice} {text!r}: {e}') from e
                await asyncio.sleep(1.5 * (attempt + 1))


async def main(force):
    phrases = load_phrases()
    old = {}
    mf = OUT / 'manifest.json'
    if mf.exists() and not force:
        old = json.loads(mf.read_text(encoding='utf-8')).get('clips', {})

    manifest = {'voices': {lang: list(v) for lang, v in VOICES.items()}, 'clips': {}}
    jobs, sem = [], asyncio.Semaphore(6)
    for lang, voices in VOICES.items():
        clips = manifest['clips'].setdefault(lang, {})
        prev = {pid: text for text, pid in old.get(lang, {}).items()}
        for p in phrases:
            text = p[FIELD[lang]]
            clips[text] = p['id']
            for short, voice in voices.items():
                path = OUT / short / f"{p['id']}.mp3"
                path.parent.mkdir(parents=True, exist_ok=True)
                if force or not path.exists() or prev.get(p['id']) != text:
                    jobs.append(make(text, voice, path, sem))

    print(f'{len(phrases)} phrases, {len(jobs)} clips to make')
    await asyncio.gather(*jobs)
    mf.write_text(json.dumps(manifest, ensure_ascii=False, indent=0) + '\n', encoding='utf-8')
    print('done:', mf.relative_to(ROOT))


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    asyncio.run(main(ap.parse_args().force))
