"""連續狀聲詞（一直重複的短音）要轉多久、輸出多長，以及改版前後在正常錄音和卡住的錄音上是否一樣。

狀聲詞：從朗讀切出一小段音節一直重複到約 14 秒，模擬「うん、うん、うん…」。
  有一段 VAD 判定講話很少（重複的間隔較長），另外兩段整段都算講話（和使用者 2026-10-25 卡住的段落一樣）。
卡住：同 bench_stuck.py，禁止 end-of-text 讓 Whisper 停不下來；分講話 1 秒（配樂）與講話 14 秒（朗讀）兩種。
正常錄音：英文、日文、泰文各取前 3 分鐘，照插件的方式切成 6–20 秒，定稿和即時字幕都比。

用法：git show <改版前的 commit>:host/transcriber_host.py > /tmp/old_host.py
      host/.venv/bin/python docs/research/tab-transcription/bench_repeat.py /tmp/old_host.py
（顯示卡要照 host/run_host.sh 設好 LD_LIBRARY_PATH）
"""

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from bench_stuck import CORPUS, OUT, RATE, ROOT, Stuck, bgm, load, msg  # noqa: E402

# 拿來重複的音節：(語言, 音檔, 開始秒數, 長度秒數, 間隔秒數)
SYLLABLES = [
    ("ja", "gongitsune-01.mp3", 12.0, 0.3, 0.12),  # 「ボラボラ…」，講話約 1 秒
    ("ja", "gongitsune-01.mp3", 0.73, 0.45, 0.05),  # 整段 14 秒都算講話
    ("en", "alice-one-syllable-ch02.mp3", 0.2, 0.25, 0.05),  # 「chat, chat…」，整段都算講話
]


def looped(audio, start, length, total=14.0, gap=0.12):
    piece = audio[int(start * RATE):int((start + length) * RATE)]
    piece = piece * np.hanning(len(piece))  # 前後淡入淡出，接起來才不會有爆音
    unit = np.concatenate([piece, np.zeros(int(gap * RATE), np.float32)])
    return np.tile(unit, int(total / (length + gap)) + 1)[:int(total * RATE)].astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("old_host")
    args = ap.parse_args()

    from faster_whisper import WhisperModel, decode_audio
    from faster_whisper.vad import get_speech_timestamps

    old = load("old_host", args.old_host)
    new = load("new_host", ROOT / "host" / "transcriber_host.py")
    model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")
    config = new.load_config()
    list(model.transcribe(np.zeros(RATE, np.float32), language="ja")[0])  # 暖機

    def run(ver, m, pcm, lang, prompt, partial):
        host = old if ver == "old" else new
        res = host.transcribe(m, config, lang, msg(pcm), prompt, partial=partial)
        return res[0], (res[3] if len(res) > 3 else None), res[2]

    def report(case, m, clip, lang, prompt=""):
        speech = round(sum(s["end"] - s["start"] for s in get_speech_timestamps(clip)) / RATE, 1)
        for partial in (False, True):
            for ver in ("old", "new"):
                t = time.perf_counter()
                segs, vocal, _ = run(ver, m, clip, lang, prompt, partial)
                text = " ".join(s["text"] for s in segs)
                print(json.dumps({"case": case, "speech": speech, "partial": partial, "ver": ver,
                                  "elapsed": round(time.perf_counter() - t, 2), "segments": len(segs),
                                  "chars": len(text), "vocal": vocal, "text": text[:80]},
                                 ensure_ascii=False), file=OUT, flush=True)

    for lang, name, start, length, gap in SYLLABLES:
        audio = decode_audio(str(CORPUS / name), sampling_rate=RATE)
        report(f"vocal-{lang}@{start}", model, looped(audio, start, length, gap=gap), lang)

    ja = decode_audio(str(CORPUS / "gongitsune-01.mp3"), sampling_rate=RATE)

    clip = bgm(25, 1)
    clip[10 * RATE:11 * RATE] += ja[12 * RATE:13 * RATE]
    prompt = "昔は、私たちの村の近くに、中山という小さなお城があって、中山様というお殿様がおられたそうです。" * 2
    report("stuck-music", Stuck(model), clip, "ja", prompt)
    report("stuck-speech", Stuck(model), ja[40 * RATE:54 * RATE], "ja")

    total, diff = 0, 0
    times = {"old": [], "new": []}
    for name, lang in (("alice-one-syllable-ch02.mp3", "en"), ("gongitsune-01.mp3", "ja"), ("fleurs-th-dev.mp3", "th")):
        audio = decode_audio(str(CORPUS / name), sampling_rate=RATE)[:RATE * 180]
        prompt, pos, i = "", 0, 0
        while pos < len(audio) - RATE:
            n = (6, 12, 20, 9, 15)[i % 5] * RATE
            chunk = audio[pos:pos + n]
            pos, i = pos + n, i + 1
            for partial in (False, True):
                res, temps = {}, {}
                for ver in ("old", "new"):
                    t = time.perf_counter()
                    segs, _, temps[ver] = run(ver, model, chunk, lang, prompt, partial)
                    res[ver] = [s["text"] for s in segs]
                    times[ver].append(time.perf_counter() - t)
                total += 1
                if res["old"] != res["new"]:
                    diff += 1
                    # 最高重試溫度大於 0：這段要靠隨機的溫度重試才轉得出來，改前的程式自己連跑兩次也常不一樣
                    print(json.dumps({"case": "diff", "lang": lang, "partial": partial, "temperature": temps, **res},
                                     ensure_ascii=False), file=OUT, flush=True)
                if not partial:
                    prompt = (prompt + " " + " ".join(res["old"]))[-200:]
    print(json.dumps({"case": "summary", "chunks": total, "different": diff,
                      "median": {k: round(float(np.median(v)), 3) for k, v in times.items()},
                      "p95": {k: round(float(np.percentile(v, 95)), 3) for k, v in times.items()}}), file=OUT, flush=True)


if __name__ == "__main__":
    main()
