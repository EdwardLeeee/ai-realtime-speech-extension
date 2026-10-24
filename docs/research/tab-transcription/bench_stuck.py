"""Whisper 卡在重複時要轉多久，以及改版前後的 transcribe() 在正常錄音上的文字是否相同。

卡住的情況：25 秒合成配樂中間只有 1 秒日文，並禁止 end-of-text，讓 Whisper 停不下來，一直產生到上限。
真實的卡住是模型自己一直重複同一句，效果一樣：每次都解碼到上限，再換溫度重試。
正常錄音：英文、日文、泰文各取前 3 分鐘，照插件的方式切成 6–20 秒，定稿和即時字幕都比。

用法：git show <改版前的 commit>:host/transcriber_host.py > /tmp/old_host.py
      host/.venv/bin/python docs/research/tab-transcription/bench_stuck.py /tmp/old_host.py
（顯示卡要照 host/run_host.sh 設好 LD_LIBRARY_PATH）
"""

import argparse
import base64
import importlib.util
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
CORPUS = Path(__file__).resolve().parent / "corpus"
RATE = 16000
OUT = sys.stdout  # 載入 host 會把 sys.stdout 換成 stderr
# 即時字幕的溫度組合；t6 是 faster-whisper 的預設
VARIANTS = {"t3": (0.0, 0.4, 0.8), "t6": (0.0, 0.2, 0.4, 0.6, 0.8, 1.0), "t2": (0.0, 0.6)}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def bgm(seconds, seed=0, level=0.08):
    """合成配樂：和弦（鋸齒波）每 2 秒換一次，加鼓點與噪音。"""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * RATE)) / RATE
    out = np.zeros_like(t)
    chords = [(220, 277, 330), (196, 247, 294), (175, 220, 262), (196, 247, 311)]
    for i in range(int(seconds // 2) + 1):
        sl = slice(i * 2 * RATE, (i + 1) * 2 * RATE)
        for f in chords[i % len(chords)]:
            out[sl] += (2 * ((t[sl] * f) % 1.0) - 1) * 0.3
    out += (np.sin(2 * np.pi * 2 * t) > 0.95) * rng.normal(0, 1, t.size) * 0.5 + rng.normal(0, 0.05, t.size)
    return (out / np.abs(out).max() * level).astype(np.float32)


def msg(pcm):
    return {"pcm": base64.b64encode((np.clip(pcm, -1, 1) * 32767).astype("<i2").tobytes()).decode(), "offset": 0.0}


class Stuck:
    """禁止 end-of-text，模擬 Whisper 卡在重複。"""

    def __init__(self, model):
        self.model = model

    def transcribe(self, *args, **kwargs):
        return self.model.transcribe(*args, suppress_tokens=[-1, 50257], **kwargs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("old_host")
    args = ap.parse_args()

    from faster_whisper import WhisperModel, decode_audio

    old = load("old_host", args.old_host)
    new = load("new_host", ROOT / "host" / "transcriber_host.py")
    model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")
    config = new.load_config()
    list(model.transcribe(np.zeros(RATE, np.float32), language="ja")[0])  # 暖機

    def run_old(m, pcm, lang, prompt, partial):
        return old.transcribe(m, config, lang, msg(pcm), prompt, config["partial_beam_size"] if partial else None)

    def make_new(temps):
        def run_new(m, pcm, lang, prompt, partial):
            new.PARTIAL_TEMPERATURES = temps
            return new.transcribe(m, config, lang, msg(pcm), prompt, partial=partial)[0]
        return run_new

    fns = {"old": run_old, **{k: make_new(v) for k, v in VARIANTS.items()}}

    ja = decode_audio(str(CORPUS / "gongitsune-01.mp3"), sampling_rate=RATE)
    clip = bgm(25, 1)
    clip[10 * RATE:11 * RATE] += ja[12 * RATE:13 * RATE]
    prompt = "昔は、私たちの村の近くに、中山という小さなお城があって、中山様というお殿様がおられたそうです。" * 2
    for partial in (False, True):
        for name, fn in fns.items():
            t = time.perf_counter()
            segs = fn(Stuck(model), clip, "ja", prompt, partial)
            print(json.dumps({"case": "stuck", "partial": partial, "ver": name,
                              "elapsed": round(time.perf_counter() - t, 2),
                              "text": " ".join(s["text"] for s in segs)[:60]}, ensure_ascii=False), file=OUT, flush=True)

    diff = {k: 0 for k in VARIANTS}
    total = 0
    times = {k: [] for k in fns}
    for name, lang in (("alice-one-syllable-ch02.mp3", "en"), ("gongitsune-01.mp3", "ja"), ("fleurs-th-dev.mp3", "th")):
        audio = decode_audio(str(CORPUS / name), sampling_rate=RATE)[:RATE * 180]
        prompt, pos, i = "", 0, 0
        while pos < len(audio) - RATE:
            n = (6, 12, 20, 9, 15)[i % 5] * RATE
            chunk = audio[pos:pos + n]
            pos, i = pos + n, i + 1
            for partial in (False, True):
                res = {}
                for k, fn in fns.items():
                    t = time.perf_counter()
                    res[k] = [s["text"] for s in fn(model, chunk, lang, prompt, partial)]
                    times[k].append(time.perf_counter() - t)
                total += 1
                changed = [k for k in VARIANTS if res[k] != res["old"]]
                for k in changed:
                    diff[k] += 1
                if changed:
                    print(json.dumps({"case": "diff", "lang": lang, "partial": partial, "changed": changed, **res},
                                     ensure_ascii=False), file=OUT, flush=True)
                if not partial:
                    prompt = (prompt + " " + " ".join(res["old"]))[-200:]
    print(json.dumps({"case": "summary", "chunks": total, "different": diff,
                      "median": {k: round(float(np.median(v)), 3) for k, v in times.items()},
                      "p95": {k: round(float(np.percentile(v, 95)), 3) for k, v in times.items()}}), file=OUT, flush=True)


if __name__ == "__main__":
    main()
