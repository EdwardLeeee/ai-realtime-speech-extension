"""量 faster-whisper 在本機 CPU 轉 60 秒錄音的速度。

用法：uv run --project host python docs/research/tab-transcription/bench_whisper.py <音檔> [--lang ja] [--device cuda] [模型...]
用 GPU 時要先設好 LD_LIBRARY_PATH（見 host/run_host.sh）。
"""
import argparse
import json
import statistics
import time

from faster_whisper import WhisperModel, decode_audio

SR = 16000
parser = argparse.ArgumentParser()
parser.add_argument("audio")
parser.add_argument("models", nargs="*", default=["base.en", "small.en"])
parser.add_argument("--lang", default="en")
parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
args = parser.parse_args()
models = args.models
audio = decode_audio(args.audio, sampling_rate=SR)
clip = audio[60 * SR:120 * SR]  # 跳過片頭，取第 60–120 秒
results = []
for name in models:
    t0 = time.perf_counter()
    if args.device == "cuda":
        model = WhisperModel(name, device="cuda", compute_type="float16")
    else:
        model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=8)
    load = time.perf_counter() - t0
    runs = []
    text = ""
    for _ in range(3):
        t0 = time.perf_counter()
        segs, _info = model.transcribe(clip, language=args.lang, beam_size=5, vad_filter=True)
        text = " ".join(s.text.strip() for s in segs)
        runs.append(time.perf_counter() - t0)
    row = {
        "model": name,
        "lang": args.lang,
        "device": args.device,
        "load_s": round(load, 2),
        "clip_s": 60,
        "runs_s": [round(r, 2) for r in runs],
        "median_s": round(statistics.median(runs), 2),
        "max_s": round(max(runs), 2),
        "realtime_x": round(60 / statistics.median(runs), 1),
        "text": text,
    }
    results.append(row)
    print(json.dumps(row, ensure_ascii=False), flush=True)
