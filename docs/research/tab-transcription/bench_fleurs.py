"""用 FLEURS（有人工逐字稿）量 Whisper 的字元錯誤率（CER）與速度，主要給泰文用：泰文詞和詞之間不空格，看 CER 比 WER 準。

用法：python3 docs/research/tab-transcription/bench_fleurs.py <FLEURS 的 tsv> <wav 資料夾> <模型> \
        [--lang th] [--device cuda|cpu] [--compute float16] [--limit 40] [--prompt "示範句"]
FLEURS：https://huggingface.co/datasets/google/fleurs（CC-BY-4.0），tsv 欄位：id、檔名、原文、正規化原文、…
"""

import argparse
import json
import statistics
import sys
import time
import unicodedata
from pathlib import Path


def normalize(text):
    # 去掉空白和標點，只比對字元本身（FLEURS 的正規化原文也沒有標點）。
    return "".join(
        ch for ch in unicodedata.normalize("NFC", text.lower())
        if not ch.isspace() and not unicodedata.category(ch).startswith("P")
    )


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tsv")
    ap.add_argument("wavs")
    ap.add_argument("model")
    ap.add_argument("--lang", default="th")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--compute", default=None, help="預設顯示卡 float16、CPU int8")
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--prompt", default=None)
    args = ap.parse_args()

    from faster_whisper import WhisperModel, decode_audio

    compute = args.compute or ("float16" if args.device == "cuda" else "int8")
    t0 = time.perf_counter()
    model = WhisperModel(args.model, device=args.device, compute_type=compute, cpu_threads=8)
    load_s = time.perf_counter() - t0

    rows = []
    wavs = {p.name: p for p in Path(args.wavs).rglob("*.wav")}
    seen = set()
    for line in Path(args.tsv).read_text(encoding="utf-8").splitlines():
        sid, name, raw, norm, *_ = line.split("\t")
        if sid in seen or name not in wavs:
            continue  # 同一句有好幾個人念，只取第一個
        seen.add(sid)
        audio = decode_audio(str(wavs[name]), sampling_rate=16000)
        t = time.perf_counter()
        segments, _ = model.transcribe(audio, language=args.lang, beam_size=5, vad_filter=True,
                                       initial_prompt=args.prompt)
        hyp = "".join(s.text for s in segments).strip()
        secs = time.perf_counter() - t
        ref_n, hyp_n = normalize(norm), normalize(hyp)
        rows.append({"id": sid, "audio_s": round(len(audio) / 16000, 1), "seconds": round(secs, 2),
                     "errors": edit_distance(ref_n, hyp_n), "chars": len(ref_n), "ref": raw, "hyp": hyp})
        if len(rows) >= args.limit:
            break

    summary = {
        "model": args.model, "device": args.device, "compute": compute, "lang": args.lang, "prompt": bool(args.prompt),
        "clips": len(rows), "load_s": round(load_s, 1),
        "cer": round(sum(r["errors"] for r in rows) / sum(r["chars"] for r in rows), 4),
        "rtf": round(sum(r["seconds"] for r in rows) / sum(r["audio_s"] for r in rows), 3),
        "median_s": round(statistics.median(r["seconds"] for r in rows), 2),
    }
    print(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False))
    print(json.dumps(summary, ensure_ascii=False), file=sys.stderr)


if __name__ == "__main__":
    main()
