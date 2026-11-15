"""Slovak-friendly transliteration of Russian, matching the style of js/lang/ru.js.

ч č, ш š, щ šč, ж ž, ц c, х ch, ы y, й j, е je/e, ё jo, ю ju, я ja,
ь softens н л т д (ň ľ ť ď) and is dropped elsewhere, -ого/-его endings read -ovo/-evo.
"""
import re

BASE = {'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ж': 'ž', 'з': 'z', 'и': 'i', 'й': 'j',
        'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't',
        'у': 'u', 'ф': 'f', 'х': 'ch', 'ц': 'c', 'ч': 'č', 'ш': 'š', 'щ': 'šč', 'ы': 'y', 'э': 'e',
        'ъ': '', 'ё': 'jo', 'ю': 'ju', 'я': 'ja'}
VOWELS = set('аеёиоуыэюяъь')
SOFT = {'н': 'ň', 'л': 'ľ', 'т': 'ť', 'д': 'ď'}
# whole words read differently from their spelling
WORDS = {'что': 'što', 'чтобы': 'štoby', 'что-то': 'što-to', 'что-нибудь': 'što-nibuď', 'конечно': 'konešno',
         'сегодня': 'sevodňa', 'скучно': 'skušno', 'его': 'jevo', 'меня': 'menja', 'ничего': 'ničevo', 'сегодняшний': 'sevodňašnij'}
NOT_GENITIVE = {'много', 'немного', 'дорого', 'недорого', 'долго', 'недолго', 'строго', 'убого', 'ого', 'полого'}


def word(w):
    low = w.lower()
    if low in WORDS:
        out = WORDS[low]
    else:
        out = []
        for i, ch in enumerate(low):
            prev = low[i - 1] if i else ''
            nxt = low[i + 1] if i + 1 < len(low) else ''
            if ch in 'яюё' and prev and prev in 'лн':
                out[-1] = SOFT[prev]
                out.append({'я': 'a', 'ю': 'u', 'ё': 'o'}[ch])
            elif ch == 'ё' and prev and prev in 'жчшщ':
                out.append('o')
            elif ch == 'ч' and prev == 'с':
                out[-1] = 'š'
                out.append('č')
            elif ch == 'е':
                out.append('je' if (not prev or prev in VOWELS) else 'e')
            elif ch == 'ь':
                if out and prev in SOFT and not (nxt and nxt in 'еёюяи'):
                    out[-1] = SOFT[prev]
            elif ch in SOFT and nxt == 'ь':
                out.append(BASE[ch])  # softened when the ь comes
            else:
                out.append(BASE.get(ch, ch))
        out = ''.join(out)
        if len(low) > 3 and low.endswith(('ого', 'его')) and low not in NOT_GENITIVE:
            out = out[:-2] + 'vo'
    if w[:1].isupper():
        out = out[:1].upper() + out[1:]
    return out


def translit(text):
    return re.sub(r"[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*", lambda m: '-'.join(word(p) for p in m.group(0).split('-')) if m.group(0).lower() not in WORDS else word(m.group(0)), text)


if __name__ == '__main__':
    import json, sys
    pairs = json.load(open(sys.argv[1]))
    same = 0
    for tl, tr in pairs:
        got = translit(tl)
        if got == tr:
            same += 1
        else:
            print(f'{tl}\n  file: {tr}\n  auto: {got}')
    print(same, '/', len(pairs))
