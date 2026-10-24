"""雙語字幕的最壞情況：Whisper 和翻譯模型（llama-server）同時用顯示卡時，即時字幕和翻譯各要多久、顯示記憶體夠不夠。

做法：先載入 llama-server 和 Whisper；另開一條執行緒不停翻譯，同時主執行緒反覆轉 3／8／15 秒的即時字幕（beam 1）。
再停掉翻譯、只轉即時字幕當對照。

用法：python3 docs/research/tab-transcription/bench_bilingual.py <llama-server> <模型.gguf> <音檔> \
        [--whisper large-v3-turbo] [--lang en] [--compute float16] [--ctx 1024]
（顯示卡要照 host/run_host.sh 設好 LD_LIBRARY_PATH）
"""

import argparse
import json
import statistics
import subprocess
import threading
import time
import urllib.request

from bench_translate import SENTENCES, free_port, post, prompt_for


def vram_mib():
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout
    return int(out.split()[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("server")
    ap.add_argument("model")
    ap.add_argument("audio")
    ap.add_argument("--whisper", default="large-v3-turbo")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--compute", default="float16")
    ap.add_argument("--ctx", default="1024")
    ap.add_argument("--start", type=float, default=60)
    args = ap.parse_args()

    from faster_whisper import WhisperModel, decode_audio

    base = vram_mib()
    port = free_port()
    proc = subprocess.Popen(
        [args.server, "-m", args.model, "-ngl", "99", "--port", str(port), "-c", args.ctx, "--jinja"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(600):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as r:
                    if r.status == 200:
                        break
            except Exception:
                time.sleep(0.2)
        after_llm = vram_mib()
        model = WhisperModel(args.whisper, device="cuda", compute_type=args.compute)
        audio = decode_audio(args.audio, sampling_rate=16000)
        start = int(args.start * 16000)
        after_both = vram_mib()

        stop = threading.Event()
        tr_secs = []
        texts = [t for items in SENTENCES.values() for t in items]

        def translate_forever():
            i = 0
            while not stop.is_set():
                t = time.perf_counter()
                post(port, {"messages": [{"role": "user", "content": prompt_for("hymt", texts[i % len(texts)])}],
                            "temperature": 0.7, "top_p": 0.6, "top_k": 20, "repeat_penalty": 1.05,
                            "max_tokens": 256})
                tr_secs.append(time.perf_counter() - t)
                i += 1

        def partials():
            out = {}
            for secs in (3, 8, 15):
                clip = audio[start:start + secs * 16000]
                times = []
                for _ in range(5):
                    t = time.perf_counter()
                    list(model.transcribe(clip, language=args.lang, beam_size=1, vad_filter=True)[0])
                    times.append(time.perf_counter() - t)
                out[f"{secs}s"] = round(statistics.median(times), 2)
            return out

        partials()  # 暖機
        worker = threading.Thread(target=translate_forever)
        worker.start()
        time.sleep(1)
        busy = partials()
        peak = vram_mib()
        stop.set()
        worker.join()
        idle = partials()
        summary = {
            "whisper": args.whisper, "compute": args.compute, "lang": args.lang,
            "llm": args.model.rsplit("/", 1)[-1], "ctx": args.ctx,
            "vram_base_mib": base, "vram_llm_mib": after_llm - base, "vram_whisper_mib": after_both - after_llm,
            "vram_peak_mib": peak,
            "partial_with_translation": busy, "partial_alone": idle,
            "translation_median_s": round(statistics.median(tr_secs), 2), "translations": len(tr_secs),
        }
        print(json.dumps(summary, ensure_ascii=False))
    finally:
        proc.terminate()
        proc.wait(timeout=10)


if __name__ == "__main__":
    main()
