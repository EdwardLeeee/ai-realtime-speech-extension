"""用插件實際的轉文字流程（host 的 transcribe()：示範句提示、產生上限、溫度重試、狀聲詞處理）轉 FLEURS 的每一句，
記下轉出的文字、花了多久、顯示記憶體和系統記憶體最高用多少。算分用 score_accuracy.py。

設定用 host 的預設值（DEFAULT_CONFIG），不讀使用者的 config.json；每句從頭開始轉（沒有上一段的提示），和剛開始錄音時一樣。

用法：host/.venv/bin/python -I docs/research/tab-transcription/bench_accuracy.py <FLEURS 語言資料夾> <en|ja|th> \
        [--model large-v3-turbo] [--device cuda|cpu] [--out bench-accuracy.jsonl]
  語言資料夾：test.tsv 加上 wav/（解壓好的音檔；同一句只取第一個人念的、25 秒以內，見研究筆記第 17 節）
  顯示卡要照 host/run_host.sh 設好 LD_LIBRARY_PATH。
FLEURS：https://huggingface.co/datasets/google/fleurs（CC BY 4.0）
"""

import argparse
import base64
import importlib.util
import json
import os
import resource
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
RATE = 16000
OUT = sys.stdout  # 載入 host 會把 sys.stdout 換成 stderr


def load_host():
    spec = importlib.util.spec_from_file_location("transcriber_host", ROOT / "host" / "transcriber_host.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class VramPeak:
    """每 0.2 秒問一次 nvidia-smi 這個程序用了多少顯示記憶體，記最高值（MiB）。"""

    def __init__(self):
        self.peak = 0
        self.stop = threading.Event()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        pid = str(os.getpid())
        while not self.stop.wait(0.2):
            try:
                out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
                                     capture_output=True, text=True, timeout=5).stdout
            except (OSError, subprocess.TimeoutExpired):
                return
            for line in out.splitlines():
                p, _, mib = line.partition(",")
                if p.strip() == pid and mib.strip().isdigit():
                    self.peak = max(self.peak, int(mib))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", type=Path)
    ap.add_argument("lang", choices=("en", "ja", "th"))
    ap.add_argument("--model", default=None, help="預設：顯示卡 large-v3-turbo，CPU 照 host 的 models")
    ap.add_argument("--device", default="cuda", choices=("cuda", "cpu"))
    ap.add_argument("--limit", type=int, default=0, help="只轉前幾句（試跑用）")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "bench-accuracy.jsonl")
    args = ap.parse_args()

    host = load_host()
    from faster_whisper import WhisperModel, decode_audio

    config = json.loads(json.dumps(host.DEFAULT_CONFIG))
    name = args.model or config["gpu_models" if args.device == "cuda" else "models"][args.lang]
    vram = VramPeak() if args.device == "cuda" else None
    t0 = time.perf_counter()
    # 和 host 的 load_model() 一樣的參數
    if args.device == "cuda":
        model = WhisperModel(name, device="cuda", compute_type="float16")
    else:
        model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=config["cpu_threads"])
    list(model.transcribe(np.zeros(RATE, dtype=np.float32), language=args.lang)[0])  # 暖機，host 載入時也會先轉一秒靜音
    load_s = time.perf_counter() - t0

    wavs = args.folder / "wav"
    joiner = host.JOINERS.get(args.lang, " ")
    rows, seen = [], set()
    for line in (args.folder / "test.tsv").read_text(encoding="utf-8").splitlines():
        sid, fname, raw, *_ = line.split("\t")
        if sid in seen or not (wavs / fname).exists():
            continue
        seen.add(sid)
        if args.limit and len(rows) >= args.limit:
            break
        audio = decode_audio(str(wavs / fname), sampling_rate=RATE)
        msg = {"pcm": base64.b64encode((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()).decode(), "offset": 0.0}
        t = time.perf_counter()
        segments, speech_s, temperature, vocal = host.transcribe(model, config, args.lang, msg, "")
        secs = time.perf_counter() - t
        rows.append({"id": sid, "audio_s": round(len(audio) / RATE, 2), "speech_s": round(speech_s, 2),
                     "seconds": round(secs, 3), "temperature": temperature,
                     "ref": raw, "hyp": joiner.join(s["text"] for s in segments)})
    if vram:
        vram.stop.set()

    commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    secs = [r["seconds"] for r in rows]
    summary = {
        "type": "summary", "lang": args.lang, "model": name, "device": args.device,
        "compute": "float16" if args.device == "cuda" else f"int8 x{config['cpu_threads']}",
        "clips": len(rows), "audio_s": round(sum(r["audio_s"] for r in rows), 1),
        "load_s": round(load_s, 1), "rtf": round(sum(secs) / sum(r["audio_s"] for r in rows), 4),
        "median_s": round(statistics.median(secs), 3), "max_s": round(max(secs), 3),
        "vram_peak_mib": vram.peak if vram else None,
        "rss_peak_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024),
        "host_commit": commit, "date": time.strftime("%Y-%m-%d"),
    }
    with args.out.open("a", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps({"type": "row", "lang": args.lang, "model": name, "device": args.device, **r},
                               ensure_ascii=False) + "\n")
        f.write(json.dumps(summary, ensure_ascii=False) + "\n")
    print(json.dumps(summary, ensure_ascii=False), file=OUT)


if __name__ == "__main__":
    main()
