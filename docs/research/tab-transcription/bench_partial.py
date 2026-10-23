"""量即時字幕的單次延遲：把 3／8／15 秒的未完成段落各轉 5 次（beam 1，跟即時字幕的設定一樣）。

用法：python docs/research/tab-transcription/bench_partial.py <音檔> <模型> <cpu|cuda> [--lang en]
"""
import argparse
import json
import statistics
import time

from faster_whisper import WhisperModel, decode_audio

ap = argparse.ArgumentParser()
ap.add_argument("audio")
ap.add_argument("model")
ap.add_argument("device", choices=["cpu", "cuda"])
ap.add_argument("--lang", default="en")
args = ap.parse_args()
audio = decode_audio(args.audio, sampling_rate=16000)[60 * 16000:]
if args.device == "cuda":
    model = WhisperModel(args.model, device="cuda", compute_type="float16")
else:
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=8)
out = {"model": args.model, "device": args.device, "lang": args.lang}
for secs in (3, 8, 15):
    clip = audio[: secs * 16000]
    runs = []
    for _ in range(5):
        t = time.perf_counter()
        segs, _ = model.transcribe(clip, language=args.lang, beam_size=1, vad_filter=True)
        text = " ".join(s.text.strip() for s in segs)
        runs.append(time.perf_counter() - t)
    out[f"{secs}s"] = {"median": round(statistics.median(runs), 2), "max": round(max(runs), 2)}
print(json.dumps(out, ensure_ascii=False))
