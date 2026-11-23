"""bench_accuracy.py 的結果算分：英文算 WER（字詞錯誤率），日文、泰文算 CER（字元錯誤率）。數字越低越準。

正規化（兩邊都做，只拿掉寫法差異，不拿掉真的聽錯）：
- 英文：Whisper 論文用的 EnglishTextNormalizer（whisper-normalizer 套件，MIT）：小寫、去標點、
  「twentieth」→「20th」、英式／美式拼法統一等。它會把括號裡的字整段刪掉（原本是為了「(laughs)」這類註記），
  但 FLEURS 括號裡的字是有念出來的，所以先把括號換成空白再正規化；不換的話，模型轉對了括號裡的字反而算成多出來的錯。
- 日文、泰文：NFKC（全形英數字變半形）、小寫、去掉標點符號與空白。不用 Whisper 的 BasicTextNormalizer：
  它會把組合字元（Unicode M 類）也刪掉，泰文的母音和聲調符號就不見了。
- 日文另外把單一個漢字數字「〇一二…九」換成阿拉伯數字（兩邊都換），「二つ」和「2つ」才算一樣；
  「十」「百」這類位數字不換，所以「十」和「10」還是算錯。

日文、泰文另外算「排除寫法不同的句子」的錯誤率：阿拉伯數字或拉丁字母只出現在參考答案和轉出文字的其中一邊
（例如泰文「หนึ่งในเจ็ด」轉成「1 ใน 7」、人名寫成拉丁字母或片假名），這種句子的錯誤有一部分只是寫法不同。

用法：uv run --no-project --with whisper-normalizer==1.0.1 python -I docs/research/tab-transcription/score_accuracy.py \
        [bench-accuracy.jsonl] [--worst 5]
"""

import argparse
import json
import re
import unicodedata
from collections import defaultdict
from pathlib import Path

KANJI_DIGITS = str.maketrans("〇一二三四五六七八九", "0123456789")


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def chars(text, lang):
    text = unicodedata.normalize("NFKC", text).lower()
    if lang == "ja":
        text = text.translate(KANJI_DIGITS)
    return [c for c in text if not c.isspace() and unicodedata.category(c)[0] not in "PS"]


def format_differs(ref, hyp):
    """阿拉伯數字或拉丁字母只出現在其中一邊（ref、hyp 是正規化後的字元）。"""
    digit = lambda cs: any(c.isdigit() for c in cs)
    latin = lambda cs: any("a" <= c <= "z" for c in cs)
    return digit(ref) != digit(hyp) or latin(ref) != latin(hyp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file", nargs="?", type=Path, default=Path(__file__).resolve().parent / "bench-accuracy.jsonl")
    ap.add_argument("--worst", type=int, default=5, help="每組列出錯最多的幾句")
    args = ap.parse_args()

    from whisper_normalizer.english import EnglishTextNormalizer

    english = EnglishTextNormalizer()

    def units(text, lang):
        return english(re.sub(r"[()\[\]{}]", " ", text)).split() if lang == "en" else chars(text, lang)

    groups = defaultdict(list)
    summaries = {}
    for line in args.file.read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        key = (r["lang"], r["model"], r["device"])
        if r["type"] == "summary":
            summaries[key] = r
            continue
        ref, hyp = units(r["ref"], r["lang"]), units(r["hyp"], r["lang"])
        groups[key].append({**r, "errors": edit_distance(ref, hyp), "units": len(ref),
                            "format": r["lang"] != "en" and format_differs(ref, hyp)})

    print("| 語言 | 模型 | 裝置 | 句數 | 錯誤率 | 指標 | 寫法不同的句數 | 排除後錯誤率 | 比播放快 | 每句中位數 | 每句最慢 "
          "| 顯示記憶體 | 系統記憶體 |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for key, rows in groups.items():
        lang, model, device = key
        s = summaries.get(key, {})
        rate = sum(r["errors"] for r in rows) / sum(r["units"] for r in rows)
        same = [r for r in rows if not r["format"]]
        rest = sum(r["errors"] for r in same) / sum(r["units"] for r in same)
        vram = f"{s['vram_peak_mib']} MiB" if s.get("vram_peak_mib") else "-"
        speed = f"{1 / s['rtf']:.0f} 倍" if s.get("rtf") else "-"
        print(f"| {lang} | {model} | {device} | {len(rows)} | {rate:.1%} | {'WER' if lang == 'en' else 'CER'} | "
              f"{'-' if lang == 'en' else len(rows) - len(same)} | {'-' if lang == 'en' else f'{rest:.1%}'} | "
              f"{speed} | {s.get('median_s', '-')} | {s.get('max_s', '-')} | {vram} | {s.get('rss_peak_mib', '-')} MiB |")
    for key, rows in groups.items():
        print(f"\n## {' / '.join(key)}：錯最多的 {args.worst} 句（錯誤數／長度）")
        for r in sorted(rows, key=lambda r: r["errors"] / max(r["units"], 1), reverse=True)[:args.worst]:
            print(f"- {r['id']} {r['errors']}/{r['units']}\n  ref: {r['ref']}\n  hyp: {r['hyp']}")


if __name__ == "__main__":
    main()
