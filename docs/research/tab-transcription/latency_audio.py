"""bench_latency.mjs 用的音檔：從 FLEURS 挑句子接成一個 wav，記下每句第一個字開始、最後一個字結束的時間。

挑句子：先找出講話部分 RMS 至少 0.02（-34 dBFS）的句子，再從裡面平均取 n 句。FLEURS 有些錄音非常小聲
（最大音量只有 0.003–0.01），低於錄音頁判斷「有人聲」的門檻（RMS 0.003）；硬放大的話背景雜音也跟著放大，
句子之間的停頓會被當成有聲音。挑到的句子把講話部分的 RMS 調到 0.1（-20 dBFS），最大不超過 0.95。
句子之間插靜音，開頭留 1 秒。

開始和結束用 Whisper 的字詞時間（word_timestamps）：VAD 會把句尾的呼吸、雜音也算成講話，有的句子結尾晚了 1 秒以上
（例如 FLEURS en 1901）；字詞時間看的是最後一個字。

用法：host/.venv/bin/python -I docs/research/tab-transcription/latency_audio.py <FLEURS 語言資料夾> <語言> <句數> <靜音秒數> [輸出.wav]
  印出 {"duration": 秒數, "clips": [{"id", "ref", "start", "end", "audio_s", "gain"}]}；沒給輸出檔就只算時間（重算舊紀錄用）
"""

import json
import sys
import wave
from pathlib import Path

import numpy as np

RATE = 16000
LEAD = 1.0
MIN_LEVEL = 0.02
TARGET = 0.1


def select(folder, n):
    from faster_whisper import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    rows, seen = [], set()
    for line in (folder / "test.tsv").read_text(encoding="utf-8").splitlines():
        sid, name, raw, *_ = line.split("\t")
        if sid in seen or not (folder / "wav" / name).exists():
            continue
        seen.add(sid)
        rows.append((sid, name, raw))
    loud = []
    for sid, name, raw in rows:
        audio = decode_audio(str(folder / "wav" / name), sampling_rate=RATE)
        speech = get_speech_timestamps(audio, VadOptions(speech_pad_ms=0, min_silence_duration_ms=300))
        voiced = np.concatenate([audio[s["start"]:s["end"]] for s in speech]) if speech else audio[:0]
        level = float(np.sqrt((voiced ** 2).mean())) if len(voiced) else 0.0
        if level >= MIN_LEVEL:
            loud.append((sid, raw, audio, level))
    print(f"{len(loud)}/{len(rows)} 句夠大聲", file=sys.stderr)
    picked = []
    for k in range(min(n, len(loud))):
        sid, raw, audio, level = loud[k * len(loud) // min(n, len(loud))]
        gain = min(TARGET / level, 0.95 / float(np.abs(audio).max()))
        picked.append((sid, raw, (audio * gain).astype(np.float32), round(gain, 2)))
    return picked


def word_span(model, audio, lang):
    """第一個字開始、最後一個字結束（秒，從這句音檔開頭算）。"""
    segments, _ = model.transcribe(audio, language=lang, beam_size=5, word_timestamps=True, vad_filter=True)
    words = [w for s in segments for w in (s.words or [])]
    return (words[0].start, words[-1].end) if words else (None, None)


def main():
    folder, lang, n, gap = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
    out = sys.argv[5] if len(sys.argv) > 5 else None
    from faster_whisper import WhisperModel

    picked = select(folder, n)
    model = WhisperModel("large-v3-turbo", device="cuda", compute_type="float16")
    parts, clips, t = [np.zeros(int(LEAD * RATE), np.float32)], [], LEAD
    for sid, raw, audio, gain in picked:
        start, end = word_span(model, audio, lang)
        if start is not None:
            clips.append({"id": sid, "ref": raw, "start": round(t + start, 2), "end": round(t + end, 2),
                          "audio_s": round(len(audio) / RATE, 2), "gain": gain})
        parts += [audio, np.zeros(int(gap * RATE), np.float32)]
        t += len(audio) / RATE + gap
    pcm = (np.clip(np.concatenate(parts), -1, 1) * 32767).astype("<i2")
    if out:
        with wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(pcm.tobytes())
    print(json.dumps({"duration": round(len(pcm) / RATE, 2), "clips": clips}, ensure_ascii=False))


if __name__ == "__main__":
    main()
